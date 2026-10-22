// GAME01: the Sheriff claimed on D1 and stayed alive, yet the Cop never claimed (Vinman rule: the Cop claims
// once the Sheriff is out and alive). Replay of the live order: the Cop has just spoken (chat cooldown running)
// or has a model call in flight when "im sheriff" lands. The claim must go out, not be dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, onGameEntry, drainUpgrades, createLlmLimiter } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { createSeededRng } from "mafioso-engine";

const t0 = 1_700_000_000_000;
const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Hap" }, p4: { id: "p4", name: "Cal" }, p5: { id: "p5", name: "Dot" } };

function copTable(complete) {
  const clock = createVirtualClock(t0);
  const table = createBotTable([{ accountId: "A" }], { clock, rng: createSeededRng(3) });
  let seq = 0;
  const feed = (event, data, t) => { if (t > clock.now()) clock.advance(t - clock.now()); return onGameEntry(table, { accountId: "A", seq: ++seq, t, event, data }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), now: t }); };
  return { table, clock, feed };
}
async function dayOne(feed) {
  await feed("self", "p1", t0); await feed("players", players, t0); await feed("roleReveal", { playerId: "p1", role: "Cop" }, t0);
  await feed("state", { id: 3, name: "Day 1" }, t0);
  await feed("meeting", { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p5", "*"], votes: {} }, t0);
}
const copSpeech = (table) => table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil");
const isClaim = (p) => /\bim (the real )?cop\b/.test(p.data.content);

test("Cop spoke a second ago (cooldown) when the Sheriff claims: the claim is queued and sent when the cooldown ends", async () => {
  const { table, feed } = copTable(async () => "who here has actually read anything yet");
  await dayOne(feed);
  await feed("message", { meetingId: "vil", senderId: "p2", content: "quiet day so far", t: t0 + 4000 }, t0 + 4000);
  await drainUpgrades(table);
  assert.ok(copSpeech(table).length >= 1 && !copSpeech(table).some(isClaim), "spoke, no claim before the Sheriff");
  const spokeAt = Math.max(...table.spokeAt.A);
  await feed("message", { meetingId: "vil", senderId: "p3", content: "im sheriff", t: spokeAt + 1000 }, spokeAt + 1000);
  await drainUpgrades(table);
  const claim = copSpeech(table).find(isClaim);
  assert.ok(claim, JSON.stringify(copSpeech(table)));
  assert.equal(claim.source, "claim-rule");
  assert.ok(Math.max(...table.spokeAt.A) >= spokeAt + 3500, "sent after the cooldown, not through it");
});

test("a model call in flight when the Sheriff claims: its stale line does not take the slot, the claim goes first", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let gated = false;
  // The call that sees Alice's line (and not yet the Sheriff's) is slow; it returns after "im sheriff" landed.
  const { table, feed } = copTable(async (p) => { if (!gated && /quiet day/.test(p.user || "")) { gated = true; await gate; } return "who here has actually read anything yet"; });
  await dayOne(feed);
  await drainUpgrades(table);
  await feed("message", { meetingId: "vil", senderId: "p2", content: "quiet day so far", t: t0 + 4000 }, t0 + 4000);
  for (let i = 0; i < 20 && !gated; i++) await new Promise((r) => setImmediate(r));
  assert.ok(gated, "the slow call is in flight");
  await feed("message", { meetingId: "vil", senderId: "p3", content: "im sheriff", t: t0 + 5000 }, t0 + 5000);
  release();
  await drainUpgrades(table);
  const said = copSpeech(table);
  assert.ok(said.length && isClaim(said[0]), JSON.stringify(said));
});

test("no Sheriff out: the Cop with no guilty stays quiet about its role", async () => {
  const { table, feed } = copTable(async () => "who here has actually read anything yet");
  await dayOne(feed);
  await feed("message", { meetingId: "vil", senderId: "p2", content: "quiet day so far", t: t0 + 4000 }, t0 + 4000);
  await feed("message", { meetingId: "vil", senderId: "p3", content: "anyone have info", t: t0 + 9000 }, t0 + 9000);
  await drainUpgrades(table);
  assert.ok(!copSpeech(table).some(isClaim), JSON.stringify(copSpeech(table)));
});
