import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, emptyView, validateAction, roleClaimLine, claimAllowed, sheriffShotReady, applySheriffRule, lineSimilarity, repeatBlock } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, townFollow, SCUM_CHAT } from "../src/live.js";
import { seats, players, meetingsFor, MAFIA } from "./fixtures/smu-night1.mjs";

const ME = "a0BHWAcOIlw"; // Ash
function seat(role, events = [], { day = true } = {}) {
  let v = reduce(emptyView(), { event: "self", data: ME });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "roleReveal", data: { playerId: ME, role } });
  for (const e of events.filter((x) => x.pre)) v = reduce(v, e);
  v = reduce(v, { event: "state", data: { id: 3, name: day ? "Day 2" : "Night 2" } });
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: Object.keys(players).filter((i) => i !== ME), votes: {} } });
  for (const e of events.filter((x) => !x.pre)) v = reduce(v, e);
  return v;
}
const msg = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
const check = (target, result, detail = "") => ({ pre: true, event: "message", data: { senderId: "server", content: `${players[target].name} is ${result}${detail ? ` ${detail}` : ""}`, meetingId: null } });

test("town night: no model call for town seats at night", { timeout: 30000 }, async () => {
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })));
  let calls = 0;
  const complete = async () => { calls++; return "{}"; };
  const seq = {};
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: Date.now(), event, data }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: Math.random }); };
  const town = seats.filter((s) => !MAFIA.has(s.role));
  for (const s of town) { await feed(s, "self", s.pid); await feed(s, "players", players); await feed(s, "roleReveal", { playerId: s.pid, role: s.role }); await feed(s, "state", { id: 4, name: "Night 2" }); for (const m of meetingsFor(s)) await feed(s, "meeting", m); }
  await drainUpgrades(table);
  assert.equal(calls, 0, "town nights use rules only");
  assert.ok(table.proposed.some((p) => p.data.meetingId === "C2rQUSIK4V6"), "Cop still acts");
  assert.ok(table.proposed.some((p) => p.data.meetingId === "b6EAvZBsoNa"), "Journalist still acts");
});

test("Cop claims only on a guilty and stays quiet on an innocent", () => {
  const quiet = seat("Cop");
  quiet.notes.checks.rhyFPKXcnH = { result: "innocent", detail: "Village" };
  assert.equal(roleClaimLine(quiet), null);
  assert.equal(claimAllowed(quiet), false);
  const guilty = seat("Cop");
  guilty.notes.checks.rhyFPKXcnH = { result: "Mafia", detail: "guilty" };
  assert.match(roleClaimLine(guilty), /^im cop\. bea is guilty$/);
});

test("Journalist claims only on the guide cases: found the Janitor or clears the real Cop", () => {
  const none = seat("Journalist");
  none.notes.checks.rhyFPKXcnH = { result: "Villager", detail: "Villager" };
  assert.equal(roleClaimLine(none), null);
  const jan = seat("Journalist");
  jan.notes.checks.kCMt06jKvBp = { result: "Janitor", detail: "Janitor" };
  assert.match(roleClaimLine(jan), /ivo is janitor/);
  const cop = seat("Journalist", [msg("rhyFPKXcnH", "im cop, no guilty yet")]);
  cop.claims.rhyFPKXcnH = { role: "Cop" };
  cop.notes.checks.rhyFPKXcnH = { result: "Cop", detail: "Cop" };
  assert.match(roleClaimLine(cop), /bea is the real cop/);
});

test("counterclaim: a fake guilty on me, or someone claiming my role, gets my real results", () => {
  const framed = seat("Cop", [msg("kCMt06jKvBp", "im cop, ash is guilty")]);
  framed.notes.checks.otU9CsNlbw = { result: "Mafia", detail: "guilty" };
  assert.equal(claimAllowed(framed), true);
  assert.match(roleClaimLine(framed), /^ivo is lying, im the real cop\. cal is guilty$/);
  const stolen = seat("Journalist", [msg("otU9CsNlbw", "im journalist, trust me")]);
  assert.match(roleClaimLine(stolen), /^cal is lying, im the journalist/);
});

test("Sheriff shoots whoever calls him guilty or counterclaims Sheriff, overriding the timing gate", () => {
  const gun = { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: Object.keys(players).filter((i) => i !== ME), votes: {} } };
  const called = seat("Sheriff", [gun, msg("kCMt06jKvBp", "ash is guilty, i checked him")]);
  const ready = sheriffShotReady(called);
  assert.equal(ready.ok, true, ready.reason);
  assert.equal(ready.target, "kCMt06jKvBp");
  assert.deepEqual(applySheriffRule(called, [{ event: "vote", data: { meetingId: "gun", selection: "rhyFPKXcnH" } }])[0].data.selection, "kCMt06jKvBp");
  const cc = seat("Sheriff", [gun, msg("otU9CsNlbw", "im the real sheriff lol")]);
  assert.equal(sheriffShotReady(cc).target, "otU9CsNlbw");
  const calm = seat("Sheriff", [gun, msg("otU9CsNlbw", "ash seems fine to me")]);
  assert.equal(sheriffShotReady(calm).ok, false, "no threat: normal gate applies");
});

test("town consolidates on a 2+ vote leader unless it believes that player is town", () => {
  const m = { targets: Object.keys(players), votes: { rhyFPKXcnH: "otU9CsNlbw", jVE7zbEozZZ: "otU9CsNlbw", k9xFo5YsB11: "BXHO_QetVp" } };
  const v = seat("Villager");
  assert.equal(townFollow(v, m), "otU9CsNlbw");
  assert.equal(townFollow(v, { ...m, votes: { rhyFPKXcnH: "otU9CsNlbw" } }), null, "one vote is not a wagon");
  assert.equal(townFollow(v, { ...m, votes: { ...m.votes, q7Rt2LmXw0a: "BXHO_QetVp" } }), null, "a tie is not a wagon");
  const cleared = seat("Villager");
  cleared.notes.checks.otU9CsNlbw = { result: "innocent", detail: "Village" };
  cleared.notes.cleared = ["otU9CsNlbw"];
  const strong = seat("Villager", [{ pre: true, event: "reveal", data: { playerId: "otU9CsNlbw", role: "Villager" } }]);
  assert.equal(townFollow(strong, m), null, "confirmed town is not followed");
});

test("one role claim per seat, and no line too similar to recent chat", async () => {
  assert.ok(lineSimilarity("stop hiding and talk", "Stop hiding, talk!") >= 0.6);
  assert.ok(lineSimilarity("who u voting", "bea feels off") < 0.3);
  const v = seat("Villager", [msg("rhyFPKXcnH", "stop hiding and actually talk")]);
  assert.match(repeatBlock(v, "vil", "stop hiding and talk already") || "", /too similar/);
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "vil", content: "budepa stop hiding and actually talk" } }).ok, false);
  const s = seat("Sheriff");
  const table = createBotTable([{ accountId: "S" }]);
  table.views.S = s;
  table.fastMode = true;
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1), complete: async ({ purpose }) => (purpose === "speech" ? "im sheriff, holding my shot" : "{}") };
  for (let i = 0; i < 4; i++) await onGameEntry(table, { accountId: "S", seq: i + 1, t: Date.now() + i * 10000, event: "message", data: { meetingId: "vil", senderId: "rhyFPKXcnH", content: `line ${i} about bea and stuff` } }, opts);
  await drainUpgrades(table);
  const claims = table.proposed.filter((p) => p.event === "speak" && /sheriff/i.test(p.data.content));
  assert.ok(claims.length <= 1, `claims ${claims.length}`);
});

test("mafia night: chatter first, then the kill votes", { timeout: 30000 }, async () => {
  Object.assign(SCUM_CHAT, { minDelayMs: 20, maxDelayMs: 60, gapMs: 20, killAfterMs: 300, killJitterMs: 50 });
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })));
  const seq = {};
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: Date.now(), event, data }, { dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: Math.random }); };
  const mafia = seats.filter((s) => MAFIA.has(s.role));
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  for (const s of mafia) { await feed(s, "state", { id: 2, name: "Night 1" }); for (const m of meetingsFor(s)) await feed(s, "meeting", m); }
  await drainUpgrades(table);
  const P = table.proposed;
  const firstKill = P.findIndex((p) => p.data.meetingId === "zbABCg9YSTU");
  const talk = P.map((p, i) => [p, i]).filter(([p]) => p.event === "speak" && p.data.meetingId === "38S8qkzPMKC");
  assert.ok(firstKill > 0);
  for (const s of mafia) assert.ok(talk.some(([p, i]) => p.accountId === s.acc && i < firstKill), `${s.role} talks before the first kill vote`);
});
