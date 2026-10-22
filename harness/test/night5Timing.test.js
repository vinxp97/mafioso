// Night 5 (Vinman 10/20) on the real harness table: the Sheriff's day-start claim delay (1-10s, re-rolled per
// game, seedable) and the mafia counterclaim's beat (a few seconds after the claim, once, one seat).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, onGameEntry, drainUpgrades, createLlmLimiter, SHERIFF_CLAIM_DELAY, sheriffClaimDelayMs } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { createSeededRng } from "mafioso-engine";

const t0 = 1_700_000_000_000;
const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Hap" }, p4: { id: "p4", name: "Cal" }, p5: { id: "p5", name: "Dot" }, p6: { id: "p6", name: "Eve" } };

function seatTable(complete = async () => "who here has actually read anything yet", opts = {}) {
  const clock = createVirtualClock(t0);
  const table = createBotTable([{ accountId: "A" }], { clock, rng: createSeededRng(3), ...opts });
  let seq = 0;
  const feed = (event, data, t) => { if (t > clock.now()) clock.advance(t - clock.now()); return onGameEntry(table, { accountId: "A", seq: ++seq, t, event, data }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), now: t }); };
  return { table, clock, feed };
}
const village = { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p5", "p6", "*"], votes: {} };
const speech = (table) => table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil");

async function sheriffDayOne(seed) {
  const { table, feed } = seatTable(undefined, { sheriffDelayRng: createSeededRng(seed) });
  const logged = [];
  table.onSheriffClaimDelay = (who, ms, due) => logged.push({ who, ms, due });
  await feed("self", "p1", t0); await feed("players", players, t0); await feed("roleReveal", { playerId: "p1", role: "Sheriff" }, t0);
  await feed("state", { id: 3, name: "Day 1" }, t0);
  await feed("meeting", village, t0);
  await feed("meeting", { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p5", "p6"], votes: {} }, t0);
  await drainUpgrades(table);
  const claim = speech(table).find((p) => /\bim sheriff\b/.test(p.data.content));
  return { table, claim, logged };
}

test("4: the Sheriff's day-start claim waits a seeded 1-10s after the day starts, logged once", async () => {
  const { table, claim, logged } = await sheriffDayOne(11);
  assert.ok(claim, JSON.stringify(speech(table)));
  const delay = claim.t - t0;
  assert.equal(delay, table.sheriffClaimDelayMs);
  assert.ok(delay >= SHERIFF_CLAIM_DELAY.minMs && delay <= SHERIFF_CLAIM_DELAY.maxMs, `delay ${delay}`);
  assert.deepEqual(logged.map((l) => [l.who, l.ms, l.due]), [["A", delay, t0 + delay]]);
  // Same seed, same delay (tests); another seed, another game.
  assert.equal((await sheriffDayOne(11)).claim.t - t0, delay);
});

test("4: re-rolled per game: delays over many games span 1-10s (uniform, not fixed)", async () => {
  const ds = [];
  for (let seed = 1; seed <= 200; seed++) ds.push(sheriffClaimDelayMs({ sheriffDelayRng: createSeededRng(seed) }));
  assert.ok(Math.min(...ds) >= 1_000 && Math.max(...ds) <= 10_000);
  assert.ok(new Set(ds).size > 150, "not a fixed value");
  const lo = ds.filter((d) => d < 5_500).length;
  assert.ok(lo > 70 && lo < 130, `about half under 5.5s, got ${lo}/200`);
  // Stable within a game: drawn once per table.
  const table = { sheriffDelayRng: createSeededRng(5) };
  assert.equal(sheriffClaimDelayMs(table), sheriffClaimDelayMs(table));
  // Live tables (rng = Math.random) draw from Math.random: a fresh value every game.
  const live = createBotTable([{ accountId: "A" }]);
  assert.equal(live.sheriffDelayRng, Math.random);
  // Ends included: rng 0 -> 1000ms, rng ~1 -> 10000ms.
  assert.equal(sheriffClaimDelayMs({ sheriffDelayRng: () => 0 }), 1_000);
  assert.equal(sheriffClaimDelayMs({ sheriffDelayRng: () => 0.9999999 }), 10_000);
});

test("2: the chosen mafia seat counterclaims a few seconds after the asked target's Cop claim, once", async () => {
  // Me (p1) is the Mafioso; Eve (p6) is the Janitor teammate. Hap (p3) is the Sheriff, he asks Cal (p4).
  const { table, feed } = seatTable(async () => "who here has actually read anything yet", { mafia: "adaptive" });
  await feed("self", "p1", t0); await feed("players", players, t0); await feed("roleReveal", { playerId: "p1", role: "Mafioso" }, t0);
  await feed("teammates", [{ id: "p6", name: "Eve", role: "Janitor" }], t0);
  await feed("state", { id: 3, name: "Day 1" }, t0);
  await feed("meeting", village, t0);
  await feed("message", { meetingId: "vil", senderId: "p3", content: "im sheriff", t: t0 + 2_000 }, t0 + 2_000);
  await feed("message", { meetingId: "vil", senderId: "p3", content: "cal claim?", t: t0 + 40_000 }, t0 + 40_000);
  const claimAt = t0 + 41_000;
  await feed("message", { meetingId: "vil", senderId: "p4", content: "im cop", t: claimAt }, claimAt);
  await drainUpgrades(table);
  const cc = speech(table).filter((p) => /is lying, im the real cop/.test(p.data.content));
  assert.equal(cc.length, 1, JSON.stringify(speech(table)));
  assert.equal(cc[0].data.content, "Cal is lying, im the real cop");
  const beat = cc[0].t - claimAt;
  assert.ok(beat >= 3_000 && beat <= 7_500, `beat ${beat}ms: a few seconds, never the same second`);
  // More chatter: no second counterclaim.
  await feed("message", { meetingId: "vil", senderId: "p4", content: "Me is lying, i am the cop", t: cc[0].t + 2_000 }, cc[0].t + 2_000);
  await drainUpgrades(table);
  assert.equal(speech(table).filter((p) => /im the real cop/.test(p.data.content)).length, 1);
});

