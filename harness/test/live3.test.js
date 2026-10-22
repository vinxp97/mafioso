// Live game L3-1018 fixes and Vinman's 11:05 rules on the live path: reactive lines wait a human beat, the
// hammer ask runs end to end (self-votes, the Sheriff's deciding vote), the ask reply is logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, REACT } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { seats, players, meetingsFor } from "./fixtures/smu-night1.mjs";

const T0 = 1_800_000_000_000;
const seat = (name) => seats.find((s) => s.name === name);
const village = () => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(players), "*"], votes: {} });

async function day(seed, plan) {
  const clock = createVirtualClock(T0 - 60_000);
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })), { clock, rng: createSeededRng(seed), mafia: "adaptive" });
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1) };
  const feed = (s, event, data, t) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  const all = async (event, data, t) => { for (const s of seats) await feed(s, event, data, t); };
  for (const s of seats) { await feed(s, "self", s.pid, T0 - 60_000); await feed(s, "players", players, T0 - 60_000); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role }, T0 - 60_000);
  for (const s of seats) { await feed(s, "state", { id: 1, name: "Night 1" }, T0 - 60_000); for (const m of meetingsFor(s)) await feed(s, "meeting", m, T0 - 60_000); }
  const maf = meetingsFor(seat("Hap")).find((m) => m.name === "Mafia").id;
  for (const s of seats.filter((x) => ["Cal", "Hap", "Ivo"].includes(x.name))) await feed(s, "message", { senderId: seat("Hap").pid, meetingId: maf, content: plan }, T0 - 50_000);
  await drainUpgrades(table);
  table.proposed.length = 0;
  for (const s of seats) { await feed(s, "state", { id: 2, name: "Day 1" }, T0); await feed(s, "meeting", village(), T0); }
  await all("death", seat("Dot").pid, T0);
  const msg = (who, content, at) => all("message", { senderId: who === "server" ? "server" : seat(who).pid, meetingId: "vil", content, t: T0 + at }, T0 + at);
  return { table, all, msg, clock };
}
const spoke = (table, name) => table.proposed.filter((p) => p.event === "speak" && p.accountId === seat(name).acc && p.data.meetingId === "vil");

test("item 8: the answer to the Sheriff's ask waits REACT.minMs..maxMs after the ask, never the same second", async () => {
  const notes = [];
  const { table, msg, clock } = await day(3, "kill dot tonight, no fake claims tmrw, lay low and lean bea, lawyer go on me");
  table.onPlanClaim = (who, what) => notes.push([who, what]);
  await msg("Gil", "im sheriff", 1_000);
  await msg("Gil", "cal claim?", 2_000);
  await drainUpgrades(table);
  const reply = spoke(table, "Cal").find((p) => /\bvillager\b|\bim\b/.test(p.data.content));
  assert.ok(reply, "Cal answered");
  const at = Number(reply.t ?? reply.at ?? reply.clock ?? NaN);
  if (Number.isFinite(at)) {
    assert.ok(at - (T0 + 2_000) >= REACT.minMs && at - (T0 + 2_000) <= REACT.maxMs + 1_000, `answered ${at - (T0 + 2_000)}ms after the ask`);
  } else assert.ok(clock.now() - (T0 + 2_000) >= REACT.minMs, "the virtual clock had to move past the beat");
  // Item 6: a no-fake-claim plan answers villager, and the log says why.
  assert.match(reply.data.content, /\bvillager\b/);
  assert.doesNotMatch(reply.data.content, /\bvt\b|v\/t/i);
  assert.ok(notes.some(([who, what]) => who === seat("Cal").acc && /ask-reply: plan has no fake claim/.test(what)), JSON.stringify(notes));
});

test("item 12: without a read the Sheriff never asks for hammer", async () => {
  const { table, msg, all } = await day(5, "kill dot tonight, no fake claims tmrw, lay low and lean bea, lawyer go on me");
  await msg("Gil", "im sheriff", 1_000);
  await msg("server", ":gun: Gil pulls a gun and shoots at Ivo!", 3_000);
  await all("death", seat("Ivo").pid, T0 + 3_000);
  await all("reveal", { playerId: seat("Ivo").pid, role: "Janitor" }, T0 + 3_000);
  await all("time", { time: 250_000 }, T0 + 25_000);
  await drainUpgrades(table);
  assert.equal(spoke(table, "Gil").some((p) => /self-vote/.test(p.data.content)), false);
});

test("item 12: after the shot the revealed Sheriff asks for self-votes; seats comply and he casts the deciding vote", async () => {
  const hammer = [];
  const { table, msg, all } = await day(5, "kill dot tonight, no fake claims tmrw, lay low and lean bea, lawyer go on me");
  table.onHammer = (who, hv) => hammer.push([who, hv.target, hv.why]);
  await msg("Gil", "im sheriff", 1_000);
  await msg("Ash", "im cop. hap guilty", 2_000); // Vinman 11:47: the ask needs a real read
  await msg("server", ":gun: Gil pulls a gun and shoots at Ivo!", 3_000);
  await all("death", seat("Ivo").pid, T0 + 3_000);
  await all("reveal", { playerId: seat("Ivo").pid, role: "Janitor" }, T0 + 3_000);
  await all("time", { time: 250_000 }, T0 + 25_000);
  await drainUpgrades(table);
  const ask = spoke(table, "Gil").find((p) => /self-vote/.test(p.data.content));
  assert.ok(ask, spoke(table, "Gil").map((p) => p.data.content).join(" | "));
  // Every proposal is replayed into the views as the server would: speech, then votes.
  for (let round = 0; round < 6; round++) {
    const fresh = table.proposed.splice(0);
    for (const p of fresh) {
      const s = seats.find((x) => x.acc === p.accountId);
      if (p.event === "speak" && p.data.meetingId === "vil") await msg(s.name, p.data.content, 26_000 + round * 10_000);
      if (p.event === "vote" && p.data.meetingId === "vil") await all("vote", { meetingId: "vil", voterId: s.pid, target: p.data.selection }, T0 + 26_000 + round * 10_000);
    }
    await all("time", { time: 200_000 - round * 10_000 }, T0 + 30_000 + round * 10_000);
    await drainUpgrades(table);
  }
  const selfVotes = hammer.filter(([who, t]) => seats.find((x) => x.acc === who)?.pid === t);
  assert.ok(selfVotes.length >= 4, JSON.stringify(hammer));
  const deciding = hammer.find(([who, , why]) => who === seat("Gil").acc && /deciding vote|refused/.test(why));
  assert.ok(deciding, JSON.stringify(hammer));
  assert.equal(deciding[1], seat("Hap").pid, `the deciding vote goes to the read: ${deciding[2]}`);
  assert.ok(seats.some((x) => x.pid === deciding[1] && x.name !== "Dot" && x.name !== "Ivo"), "a living player");
});
