import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, DAY_VOTE } from "../src/live.js";
import { seats, players } from "./fixtures/smu-night1.mjs";

const T0 = 1_800_000_000_000;
const village = (s) => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(players).filter((i) => i !== s.pid), "*"], votes: {} });

async function setupDay() {
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })));
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: Math.random };
  const feed = (s, event, data, t = T0) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  for (const s of seats) { await feed(s, "state", { id: 3, name: "Day 1" }); await feed(s, "meeting", village(s)); }
  return { table, feed };
}
const dayVotes = (table) => table.proposed.filter((p) => p.event === "vote" && p.data.meetingId === "vil");

test("no day vote in the first part of the day; votes come late and staggered, scum not first", { timeout: 30000 }, async () => {
  Object.assign(DAY_VOTE, { staggerMinMs: 50, staggerMaxMs: 600, scumExtraMs: 300 });
  const { table, feed } = await setupDay();
  // 5-minute day: ticks through the first 2.5 minutes send no village vote.
  for (let k = 1; k <= 30; k++) for (const s of seats) await feed(s, "time", { time: 300000 - k * 5000 }, T0 + k * 5000);
  await drainUpgrades(table);
  assert.equal(dayVotes(table).length, 0, "no village vote before 60% of the day");
  // Past 60%: votes go out, each seat once, spread over time.
  const t0 = Date.now();
  for (const s of seats) await feed(s, "time", { time: 110000 }, T0 + 190000);
  await drainUpgrades(table);
  const votes = dayVotes(table);
  assert.equal(new Set(votes.map((v) => v.accountId)).size, 9, "every seat votes once");
  assert.equal(votes.length, 9);
  assert.ok(votes.every((v) => /delay/.test(v.source)), "all staggered");
  const order = votes.map((v) => seats.find((s) => s.acc === v.accountId).role);
  assert.ok(!["Mafioso", "Lawyer", "Janitor"].includes(order[0]), `town leads: ${order.join(",")}`);
  assert.ok(Date.now() - t0 >= 50);
  for (const v of votes) assert.notEqual(v.data.selection, seats.find((s) => s.acc === v.accountId).pid);
});

test("8 lines from others are not enough until the Sheriff has had his window", { timeout: 30000 }, async () => {
  Object.assign(DAY_VOTE, { staggerMinMs: 10, staggerMaxMs: 50, scumExtraMs: 0 });
  const { table, feed } = await setupDay();
  const sheriff = seats.find((s) => s.role === "Sheriff");
  const talkers = seats.filter((s) => s !== sheriff);
  let t = T0 + 1000;
  for (let i = 0; i < 9; i++) for (const s of seats) await feed(s, "message", { meetingId: "vil", senderId: talkers[i % talkers.length].pid, content: `line ${i}` }, (t += 100));
  for (const s of seats) await feed(s, "time", { time: 280000 }, T0 + 20000);
  await drainUpgrades(table);
  assert.equal(dayVotes(table).length, 0, "Sheriff has not spoken and his window is open");
  for (const s of seats) await feed(s, "message", { meetingId: "vil", senderId: sheriff.pid, content: "I'm the Sheriff. Holding my shot." }, T0 + 30000);
  for (const s of seats) await feed(s, "time", { time: 270000 }, T0 + 36000);
  await drainUpgrades(table);
  assert.ok(dayVotes(table).length >= 8, "after the Sheriff speaks, discussion is enough");
});
