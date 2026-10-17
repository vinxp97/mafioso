import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, COPY_VOTE } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { seats, players, MAFIA } from "./fixtures/smu-night1.mjs";

// Deterministic: virtual clock (timers fire only when drained), seeded rng, entry times fixed.
const T0 = 1_800_000_000_000;
const village = (s) => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(players).filter((i) => i !== s.pid), "*"], votes: {} });

async function setupDay(seed = 1) {
  const clock = createVirtualClock(T0);
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })), { clock, rng: createSeededRng(seed) });
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1) };
  const feed = (s, event, data, t = T0) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  for (const s of seats) { await feed(s, "state", { id: 3, name: "Day 1" }); await feed(s, "meeting", village(s)); }
  return { table, feed, clock };
}
const dayVotes = (table) => table.proposed.filter((p) => p.event === "vote" && p.data.meetingId === "vil");

/** Play a 5-minute day to the 60% mark and collect the village votes with the virtual time each one went out. */
async function lateDayVotes(seed) {
  const { table, feed, clock } = await setupDay(seed);
  const at = new Map();
  table.onDeferred = (p) => { if (p.data?.meetingId === "vil") at.set(p, clock.now()); };
  for (let k = 1; k <= 30; k++) for (const s of seats) await feed(s, "time", { time: 300000 - k * 5000 }, T0 + k * 5000);
  await drainUpgrades(table);
  const early = dayVotes(table).length;
  const t0 = clock.now();
  for (const s of seats) await feed(s, "time", { time: 110000 }, T0 + 190000);
  await drainUpgrades(table);
  const votes = dayVotes(table);
  return { early, t0, votes, at, role: (v) => seats.find((s) => s.acc === v.accountId).role };
}

test("no day vote in the first part of the day; then every seat votes once, staggered 2-15s", async () => {
  const { early, t0, votes, at, role } = await lateDayVotes(1);
  assert.equal(early, 0, "no village vote before 60% of the day");
  assert.equal(new Set(votes.map((v) => v.accountId)).size, 9, "every seat votes once");
  assert.equal(votes.length, 9);
  assert.ok(votes.every((v) => /delay/.test(v.source)), "all staggered");
  for (const v of votes) {
    const wait = at.get(v) - t0;
    assert.ok(wait >= COPY_VOTE.minMs && wait <= COPY_VOTE.maxMs, `${role(v)} waited ${wait}ms`);
    assert.notEqual(v.data.selection, seats.find((s) => s.acc === v.accountId).pid);
  }
  const waits = votes.map((v) => at.get(v) - t0);
  assert.ok(Math.max(...waits) - Math.min(...waits) >= 6000, `spread out: ${waits.join(",")}`);
  // Same seed, same run.
  const again = await lateDayVotes(1);
  assert.deepEqual(again.votes.map((v) => [v.accountId, v.data.selection, again.at.get(v) - again.t0]), votes.map((v) => [v.accountId, v.data.selection, at.get(v) - t0]));
});

// The old test asserted "scum never vote first". That was a leftover from scumExtraMs (scum waited +10s),
// which PR10 removed on purpose: every seat draws the same 2-15s stagger, so vote order is not a tell.
// A Janitor/Lawyer/Mafioso leading the vote is legit; what must hold is that order does not track team.
test("vote order does not track team: over many seeds scum lead about their share (3 of 9), never always or never", async () => {
  let scumFirst = 0;
  const N = 30;
  for (let seed = 1; seed <= N; seed++) {
    const { votes, role } = await lateDayVotes(seed);
    assert.equal(votes.length, 9, `seed ${seed}`);
    if (MAFIA.has(role(votes[0]))) scumFirst++;
  }
  assert.ok(scumFirst > 0 && scumFirst < N, `scum led ${scumFirst}/${N}`);
  assert.ok(scumFirst >= 3 && scumFirst <= 20, `scum led ${scumFirst}/${N}, expected near ${N / 3}`);
});

test("8 lines from others are not enough until the Sheriff has had his window", async () => {
  const { table, feed } = await setupDay(2);
  const sheriff = seats.find((s) => s.role === "Sheriff");
  const talkers = seats.filter((s) => s !== sheriff);
  let t = T0 + 1000;
  for (let i = 0; i < 9; i++) for (const s of seats) await feed(s, "message", { meetingId: "vil", senderId: talkers[i % talkers.length].pid, content: `i think line ${i} matters` }, (t += 100));
  for (const s of seats) await feed(s, "time", { time: 280000 }, T0 + 20000);
  await drainUpgrades(table);
  assert.equal(dayVotes(table).length, 0, "Sheriff has not spoken and his window is open");
  for (const s of seats) await feed(s, "message", { meetingId: "vil", senderId: sheriff.pid, content: "I'm the Sheriff. Holding my shot." }, T0 + 30000);
  for (const s of seats) await feed(s, "time", { time: 270000 }, T0 + 36000);
  await drainUpgrades(table);
  assert.ok(dayVotes(table).length >= 8, "after the Sheriff speaks, discussion is enough");
});
