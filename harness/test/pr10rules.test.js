import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, emptyView, validateAction, roleClaimLine, claimAllowed, sheriffShotReady, applySheriffRule, lineSimilarity, repeatBlock, createSeededRng } from "mafioso-engine";
import { createBotTable as realTable, createLlmLimiter, drainUpgrades, onGameEntry, townFollow } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
// Every table here runs on a virtual clock and a seeded rng: deterministic, no wall-clock waits.
const T0 = 1_800_000_000_000;
let clock = createVirtualClock(T0);
const createBotTable = (accounts, seed = 1) => { clock = createVirtualClock(T0); return realTable(accounts, { clock, rng: createSeededRng(seed) }); };
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
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: clock.now(), event, data }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1) }); };
  const town = seats.filter((s) => !MAFIA.has(s.role));
  for (const s of town) { await feed(s, "self", s.pid); await feed(s, "players", players); await feed(s, "roleReveal", { playerId: s.pid, role: s.role }); await feed(s, "state", { id: 4, name: "Night 2" }); for (const m of meetingsFor(s)) await feed(s, "meeting", m); }
  await drainUpgrades(table);
  assert.equal(calls, 0, "town nights use rules only");
  assert.ok(table.proposed.some((p) => p.data.meetingId === "C2rQUSIK4V6"), "Cop still acts");
  assert.ok(table.proposed.some((p) => p.data.meetingId === "b6EAvZBsoNa"), "Journalist still acts");
});

const srv = (content) => ({ event: "message", data: { meetingId: null, senderId: "server", content } });

test("live report wording is parsed: Cop guilty/innocent, Journalist no-reports and reports", () => {
  const c = seat("Cop", [srv("Your investigation shows that Bea is Guilty"), srv("Your investigation shows that Cal is Innocent")]);
  assert.equal(c.notes.checks.rhyFPKXcnH.result, "Mafia");
  assert.equal(c.notes.checks.otU9CsNlbw.result, "Village");
  const j = seat("Journalist", [srv("You learn that Bea received no reports.")]);
  assert.equal(j.notes.checks.rhyFPKXcnH.detail, "no reports");
});

test("Cop claims (all results) if Sheriff outed and alive, or a guilty, or counterclaimed/guiltied; else quiet (copRule vinman, the default)", () => {
  const quiet = seat("Cop", [srv("Your investigation shows that Cal is Innocent")]);
  assert.equal(roleClaimLine(quiet), null);
  assert.equal(claimAllowed(quiet), false);
  const g = seat("Cop", [srv("Your investigation shows that Bea is Guilty")]);
  assert.equal(roleClaimLine(g), "im cop. Bea guilty");
  const sh = seat("Cop", [srv("Your investigation shows that Cal is Innocent"), msg("kCMt06jKvBp", "im sheriff btw")]);
  assert.equal(roleClaimLine(sh), "im cop. Cal inno");
  const shWait = reduce(seat("Cop", [srv("Your investigation shows that Cal is Innocent"), msg("kCMt06jKvBp", "im sheriff btw")]), { event: "botConfig", data: { copRule: "wait" } });
  assert.equal(roleClaimLine(shWait), null, "copRule wait: a Sheriff out alone is not a Cop trigger");
  const shDead = seat("Cop", [srv("Your investigation shows that Cal is Innocent"), msg("kCMt06jKvBp", "im sheriff btw")]);
  shDead.dead = { kCMt06jKvBp: true };
  assert.equal(roleClaimLine(shDead), null, "a dead Sheriff does not trigger it");
  const framed = seat("Cop", [srv("Your investigation shows that Cal is Innocent"), msg("kCMt06jKvBp", "im cop, ash is guilty")]);
  assert.equal(roleClaimLine(framed), "Ivo is lying, im the real cop. Cal inno");
});

test("Journalist claims if guiltied, or its report exposes a fake Cop or finds the Janitor; else quiet", () => {
  const none = seat("Journalist", [srv("You received all reports that Bea received: You were visited.")]);
  assert.equal(roleClaimLine(none), null);
  const stolen = seat("Journalist", [msg("otU9CsNlbw", "im journalist, trust me")]);
  assert.match(roleClaimLine(stolen), /^\w+ is lying, im journalist/, "a rival Journalist claim is countered at once");
  const fake = seat("Journalist", [srv("You learn that Bea received no reports.")]);
  fake.claims.rhyFPKXcnH = { role: "Cop" };
  assert.match(roleClaimLine(fake), /Bea got no report, fake cop/);
  const jan = seat("Journalist");
  jan.notes.checks.kCMt06jKvBp = { result: "", detail: "reports: You cleaned the body" };
  assert.match(roleClaimLine(jan), /Ivo is janitor/);
  const guiltied = seat("Journalist", [msg("kCMt06jKvBp", "im cop ash is guilty")]);
  assert.match(roleClaimLine(guiltied), /^Ivo is lying, im journalist/);
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
  for (let i = 0; i < 4; i++) await onGameEntry(table, { accountId: "S", seq: i + 1, t: clock.now() + i * 10000, event: "message", data: { meetingId: "vil", senderId: "rhyFPKXcnH", content: `line ${i} about bea and stuff` } }, opts);
  await drainUpgrades(table);
  const claims = table.proposed.filter((p) => p.event === "speak" && /sheriff/i.test(p.data.content));
  assert.ok(claims.length <= 1, `claims ${claims.length}`);
});

test("mafia night: chatter first, then the kill votes", async () => {
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })));
  const seq = {};
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: clock.now(), event, data }, { dryRun: true, fast: true, limiter: createLlmLimiter(1) }); };
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

// 1fo007iEq-style: two mafia on a town target; follow-the-leader handed them the lynch.
const BEA = "rhyFPKXcnH", CAL = "otU9CsNlbw", DOT = "jVE7zbEozZZ", ELI = "k9xFo5YsB11", FIN = "BXHO_QetVp", HAP = "Hsd2JfBMtVt", IVO = "kCMt06jKvBp";
const vilM = (votes) => ({ targets: Object.keys(players), votes });

test("town skips a wagon whose voters are mostly players this seat suspects", () => {
  const v = seat("Villager");
  v.notes.suspects = [HAP, IVO];
  assert.equal(townFollow(v, vilM({ [HAP]: DOT, [IVO]: DOT })), null, "suspects-only wagon is not joined");
  assert.equal(townFollow(v, vilM({ [HAP]: DOT, [IVO]: DOT, [BEA]: DOT })), null, "2 of 3 voters suspected: skip");
  assert.equal(townFollow(v, vilM({ [HAP]: DOT, [BEA]: DOT, [ELI]: DOT, [FIN]: DOT })), DOT, "1 of 4 suspected: a real town wagon");
});

test("town skips a wagon on a claimed or cleared town player", () => {
  const claimed = seat("Villager", [msg(FIN, "im journalist btw")]);
  assert.equal(claimed.claims?.[FIN]?.role, "Journalist");
  assert.equal(townFollow(claimed, vilM({ [BEA]: FIN, [DOT]: FIN })), null);
  const cleared = seat("Villager");
  cleared.notes.cleared = [CAL];
  assert.equal(townFollow(cleared, vilM({ [BEA]: CAL, [DOT]: CAL })), null);
  const cc = seat("Villager", [msg(FIN, "im journalist"), msg(ELI, "im journalist, fin is lying")]);
  assert.ok(townFollow(cc, vilM({ [BEA]: FIN, [DOT]: FIN })), "a counterclaimed claim is not protection");
});

test("town prefers the wagon its own notes agree with, even when it is smaller", () => {
  const v = seat("Villager");
  v.notes.suspects = [CAL];
  assert.equal(townFollow(v, vilM({ [BEA]: DOT, [ELI]: DOT, [FIN]: DOT, [HAP]: CAL, [IVO]: CAL })), CAL);
  const tie = seat("Villager");
  tie.notes.suspects = [CAL];
  assert.equal(townFollow(tie, vilM({ [BEA]: DOT, [ELI]: DOT, [HAP]: CAL, [IVO]: CAL })), CAL, "a tie is broken by notes");
});

test("4-3 replay: the last town seat does not hammer town on a mafia-led wagon", () => {
  // Hap+Ivo (mafia) + Dot already on Eli; this seat suspected Hap and Ivo from their pushes.
  const v = seat("Villager", [msg(HAP, "eli is mafia lynch him"), msg(IVO, "yeah eli")]);
  v.notes.suspects = [HAP, IVO];
  assert.equal(townFollow(v, vilM({ [HAP]: ELI, [IVO]: ELI, [DOT]: ELI, [BEA]: CAL, [FIN]: CAL })), CAL);
});

test("Sheriff outs with a plain claim line (counterclaim adds 'the real one'); a claimed Cop calls out a later fake", () => {
  assert.equal(roleClaimLine(seat("Sheriff")), "im sheriff");
  assert.match(roleClaimLine(seat("Sheriff", [msg("otU9CsNlbw", "im sheriff")])) || "", /im sheriff, the real one/);
  const cop = seat("Cop", [srv("Your investigation shows that Bea is Guilty"), { event: "message", data: { meetingId: "vil", senderId: ME, content: "im cop. bea guilty" } }, msg("kCMt06jKvBp", "im cop, ash is guilty")]);
  assert.match(roleClaimLine(cop) || "", /Ivo is lying/);
});
