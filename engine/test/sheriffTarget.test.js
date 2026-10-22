// Vinman 10/20 (12:29pm): "sheriff should not be just targeting 1 person and shooting them without considering
// anyone else. If there are multiple cop claims, sheriff should shoot in them." Mafia's early Cop claims are fine.
// (a) live xYGzM63iO and So2OKZ3td (sanitized, /workspace/restartq/live-night5): the Sheriff shot the asked
//     Villager claimer although a better candidate was there; (b) 2 Cop claimers; (c) 3; (d) a sole Cop claimer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, sheriffShotReady, validateAction, multiCopTarget, sheriffSuspicion } from "../src/index.js";

const seats = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i + 1}`, { id: `s${i + 1}`, name: `Seat${i + 1}` }]));
const say = (senderId, content, t, meetingId = "vil") => ({ event: "message", t, data: { senderId, meetingId, content, t } });
const at = (v, t) => reduce(v, { event: "time", t, data: {} });
const shoot = (sel) => ({ event: "vote", data: { meetingId: "gun", selection: sel } });

/** Day 1 from the Sheriff's seat. dead: killed N1. dayMs: the day timer. votes: the Village ballots. */
function day1(self, { n = 9, dead = [], dayMs = 600_000, votes = {}, frames = [] } = {}) {
  const players = seats(n);
  const ids = Object.keys(players);
  const alive = ids.filter((x) => !dead.includes(x));
  return reduceAll([
    { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role: "Sheriff" } },
    { event: "state", data: { id: 1, name: "Night 1" }, t: -60_000 }, { event: "state", data: { id: 2, name: "Day 1" }, t: 0 },
    { event: "timerInfo", t: 0, data: { name: "main", delay: dayMs } }, ...dead.map((d) => ({ event: "death", data: d, t: 0 })),
    { event: "meeting", data: { id: "gun", name: "Shoot Gun", actionName: "Shoot Gun", voting: true, instant: true, canVote: true, amMember: true, targets: alive.filter((x) => x !== self), votes: {} } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...alive, "*"], votes } },
    ...frames,
  ]);
}

// ---- (a) live games ----
// xYGzM63iO (Mafia won D1): s3 Sheriff, s1 Cop killed N1, s9 Janitor (silent), s4 Lawyer, s6 Mafioso.
// The Sheriff asked s8, s8 said villager, and 32s later he shot s8 (Villager). The table had been calling s9
// suspicious and quiet the whole time, and s8/s5 only traded "is lying".
const G1 = [say("s3", "im sheriff", 1_400), say("s4", "watching Seat8", 3_800), say("s8", "vote Seat9, suspiciously quiet", 6_500),
  say("s3", "Seat8 what are you", 275_000), say("s8", "Seat3 im villager", 282_400), say("s5", "im villager, Seat9 quiet feels suspicious", 295_300),
  say("s8", "Seat5 is lying", 298_700), say("s5", "Seat8 is lying", 301_900), say("s2", "im villager, voting Seat9", 306_100)];

test("(a) xYGzM63iO: after the Villager answer he does not shoot the asked s8; s9 (called sus by three) is asked next", () => {
  const v = at(day1("s3", { dead: ["s1"], frames: G1 }), 314_700); // the live shot came at ~315s
  const r = sheriffShotReady(v);
  assert.notEqual(r.ok && r.target, "s8", JSON.stringify(r));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.ask?.target, "s9", JSON.stringify(r));
  assert.match(validateAction(v, shoot("s8")).reason || "", /too early/);
  // s8 only ties s5 (they called each other liars), so he is not clearly the most suspicious; s9 is close behind.
  const sus = sheriffSuspicion(v).score;
  assert.ok(sus.s8 === sus.s5 && sus.s9 > sus.s8 - 1, JSON.stringify(sus));
  // s9 never answers: after the reply window he shoots s9, not s8.
  const asked = reduce(v, say("s3", r.ask.line, 315_000));
  const later = sheriffShotReady(at(asked, 331_000));
  assert.deepEqual([later.ok, later.target], [true, "s9"], JSON.stringify(later));
  // At the deadline (day nearly over) with no time to ask: the most suspicious, not the first asked.
  const late = sheriffShotReady(at(v, 560_000));
  assert.equal(late.ok, true, late.reason);
  assert.notEqual(late.target, "s8", JSON.stringify(late));
});

// So2OKZ3td (Mafia won D2): s5 Sheriff, s7 Cop killed N1, s1 Mafioso, s8 Janitor (fake Cop, guilty on the real
// Journalist s4), s9 Lawyer. The Sheriff asked s6, s6 said villager, and 12.6s later he shot s6 (Villager) while
// s1 was called a liar and suspicious, and had only just claimed villager himself.
const G3 = [say("s2", "Seat1, your silence looks suspiciously mafia-ish", 1_600), say("s5", "im sheriff", 3_900),
  say("s5", "Seat6 claim before i shoot", 14_400), say("s8", "im cop. Seat4 guilty", 18_000), say("s6", "Seat5 im villager", 22_100),
  say("s4", "Seat8 is lying, im journalist", 24_000), say("s1", "Seat2 i'm villager, just quiet.", 26_900),
  say("s3", "im villager. Seat4 is guilty, vote her", 30_600), say("s6", "Seat1 is lying", 33_600), say("s3", "Seat6 is lying", 34_600)];

test("(a) So2OKZ3td: he does not shoot the asked s6; he holds on s1's fresh villager claim, then shoots s1", () => {
  const v = at(day1("s5", { dead: ["s7"], dayMs: 300_000, votes: { s2: "s1" }, frames: G3 }), 35_000); // the live shot: 35s
  const r = sheriffShotReady(v);
  assert.notEqual(r.ok && r.target, "s6", JSON.stringify(r));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Seat1/);
  // s8 (the only Cop claim) and s4 (the only Journalist claim) are never the shot.
  const done = sheriffShotReady(at(v, 57_500));
  assert.deepEqual([done.ok, done.target], [true, "s1"], JSON.stringify(done));
  assert.equal(validateAction(at(v, 57_500), shoot("s1")).ok, true);
});

// ---- (b) two Cop claimers ----
const CHAT = [say("s1", "im sheriff", 1_000), say("s4", "hi", 2_000)];

test("(b) two Cop claimers, weak evidence: he waits for reads and votes, then shoots one of them (no discussion gate)", () => {
  const base = day1("s1", { frames: [...CHAT, say("s2", "im cop. Seat5 guilty", 5_000), say("s3", "no im the cop, Seat6 guilty", 9_000)] });
  const fresh = sheriffShotReady(at(base, 10_000));
  assert.equal(fresh.ok, false, JSON.stringify(fresh));
  assert.match(fresh.reason, /waiting on the Cop claims/);
  // Settled but still weak, and the village has not picked: he keeps waiting (no coin flip).
  assert.match(sheriffShotReady(at(base, 9_000 + 15_001)).reason, /waiting for the village vote/);
  // At the deadline Vinman's rule holds: he shoots one of them, the weaker (later, unprompted) claim.
  const v = at(base, 560_000);
  const r = sheriffShotReady(v);
  assert.deepEqual([r.ok, r.target], [true, "s3"], JSON.stringify(r));
  assert.match(r.why, /2 Cop claims/);
  assert.equal(validateAction(v, shoot("s3")).ok, true);
  assert.equal(sheriffShotReady(v).target, "s3"); // deterministic
  // The village vote lands on one of them: the lynch tests the pair, the gun goes elsewhere.
  const voted = at(day1("s1", { votes: { s4: "s2", s5: "s2" }, frames: [...CHAT, say("s2", "im cop. Seat5 guilty", 5_000), say("s3", "no im the cop, Seat6 guilty", 9_000)] }), 30_000);
  const g = sheriffShotReady(voted);
  assert.ok(!["s2", "s3"].includes(g.ok && g.target), JSON.stringify(g));
});

test("(b) two Cop claimers: a guilty on a likely townie (the sole Journalist claim) marks the earlier claimer weaker", () => {
  const v = at(day1("s1", { frames: [...CHAT, say("s6", "im journalist", 3_000), say("s2", "im cop. Seat6 guilty", 5_000), say("s3", "im cop, Seat7 guilty", 9_000)] }), 10_000);
  assert.deepEqual([sheriffShotReady(v).ok, sheriffShotReady(v).target], [true, "s2"]);
});

test("(b) two Cop claimers: the opener who called the other guilty before he claimed is the weaker (selfplay 15/1)", () => {
  const v = at(day1("s1", { frames: [...CHAT, say("s6", "im cop. Seat4 guilty", 5_000), say("s4", "im cop. Seat9 inno", 9_000)] }), 10_000);
  assert.deepEqual([sheriffShotReady(v).ok, sheriffShotReady(v).target], [true, "s6"]);
});

test("(b) two Cop claimers override a pending Villager ask: the shot goes to a Cop claimer", () => {
  const v = at(day1("s1", { frames: [...CHAT, say("s1", "Seat4 claim?", 3_000), say("s4", "im villager", 4_000),
    say("s2", "im cop. Seat4 guilty", 5_000), say("s3", "im cop", 9_000)] }), 560_000);
  const r = sheriffShotReady(v);
  assert.equal(r.ok, true, r.reason);
  assert.ok(["s2", "s3"].includes(r.target), JSON.stringify(r));
});

// ---- (c) three Cop claimers ----
test("(c) three Cop claimers: he shoots one of them; the vote leader is left to the lynch", () => {
  const frames = [...CHAT, say("s2", "im cop. Seat5 guilty", 5_000), say("s3", "im cop. Seat6 guilty", 7_000), say("s4", "im the cop, Seat7 guilty", 9_000)];
  const v = at(day1("s1", { frames }), 10_000);
  const r = sheriffShotReady(v);
  assert.deepEqual([r.ok, r.target], [true, "s4"], JSON.stringify(r));
  assert.match(r.why, /3 Cop claims/);
  // s4 leads the village vote: the gun takes the next weakest Cop claimer.
  const led = at(day1("s1", { frames, votes: { s5: "s4", s6: "s4" } }), 10_000);
  const r2 = sheriffShotReady(led);
  assert.equal(r2.ok, true, r2.reason);
  assert.ok(["s2", "s3"].includes(r2.target), JSON.stringify(r2));
  assert.equal(multiCopTarget(led)?.target, r2.target);
});

// ---- (d) a sole Cop claimer ----
test("(d) a sole Cop claimer is never shot, and the asked Villager claimer is not shot by default either", () => {
  const frames = [say("s1", "im sheriff", 1_000), say("s1", "Seat4 claim?", 20_000), say("s4", "im villager", 22_000),
    say("s2", "im cop, no guilty yet", 24_000), say("s5", "Seat2 is lying", 25_000), say("s6", "Seat2 is lying, vote Seat2", 26_000),
    say("s7", "Seat2 sus", 27_000), say("s8", "hm", 28_000), say("s9", "ok", 29_000), say("s3", "idk", 30_000)];
  const v = at(day1("s1", { frames }), 55_000);
  const r = sheriffShotReady(v);
  assert.notEqual(r.target, "s2", JSON.stringify(r));
  assert.notEqual(r.ok && r.target, "s4", JSON.stringify(r));
  assert.equal(multiCopTarget(v), null);
  assert.match(validateAction(v, shoot("s2")).reason || "", /sheriff shot/);
  // Even at the deadline the sole Cop claim stands.
  const late = sheriffShotReady(at(v, 570_000));
  assert.equal(late.ok, true, late.reason);
  assert.notEqual(late.target, "s2");
});

// ---- 10/20 2:02pm: fewer real Cops / Journalists shot (self-play games where c307e09 shot one) ----
const NINE = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
function fj(self, { dead = [], votes = {}, frames = [] } = {}) {
  const players = Object.fromEntries(NINE.map((n) => [n, { id: n, name: n }]));
  const alive = NINE.filter((x) => !dead.includes(x));
  return reduceAll([
    { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role: "Sheriff" } },
    { event: "state", data: { id: 1, name: "Night 1" }, t: -60_000 }, { event: "state", data: { id: 2, name: "Day 1" }, t: 0 },
    { event: "timerInfo", t: 0, data: { name: "main", delay: 300_000 } }, ...dead.map((d) => ({ event: "death", data: d, t: 0 })),
    { event: "meeting", data: { id: "gun", name: "Shoot Gun", actionName: "Shoot Gun", voting: true, instant: true, canVote: true, amMember: true, targets: alive.filter((x) => x !== self), votes: {} } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...alive, "*"], votes } },
    ...frames,
  ]);
}

test("selfplay 14/7: the asked Journalist answers, a mafia counterclaims unprompted: no instant shot on the Journalist; the counterclaimer at the deadline", () => {
  // Ash=Cop Gil=Journalist Eli=Mafioso Fin=Sheriff; Dot killed N1 (cleaned). c307e09 shot Gil (the real Journalist).
  const v = at(fj("Fin", { dead: ["Dot"], frames: [say("Fin", "im sheriff", 2_000), say("Ash", "im cop. Fin inno", 6_000), say("Ash", "watching Gil", 9_000),
    say("Ash", "watching the votes", 12_000), say("Fin", "Gil claim before i shoot", 20_000), say("Gil", "im journalist", 24_000), say("Fin", "Hap claim?", 27_000),
    say("Eli", "Gil is lying, im the real journalist", 29_000)] }), 31_000);
  const fresh = sheriffShotReady(v);
  assert.notEqual(fresh.ok && fresh.target, "Gil", JSON.stringify(fresh));
  assert.match(fresh.reason, /waiting on the Journalist claims/);
  // No village vote on either by the deadline: the unprompted counter is the weaker claim.
  const r = sheriffShotReady(at(v, 280_000));
  assert.deepEqual([r.ok, r.target], [true, "Eli"], JSON.stringify(r));
});

test("selfplay 15/13: a fake Cop opens with a guilty, the real Cop answers with an inno on the night kill: the opener is shot", () => {
  // Hap=Janitor (fake Cop, guilty on the Journalist Ash), Fin=Cop (inno on Eli, killed N1), Cal=Sheriff. c307e09 shot Fin.
  const frames = [say("Cal", "im sheriff", 2_000), say("Hap", "im cop. Ash guilty", 6_000), say("Fin", "im cop. Eli inno", 9_000)];
  const v = fj("Cal", { dead: ["Eli"], frames });
  const fresh = sheriffShotReady(at(v, 10_000));
  assert.notEqual(fresh.ok && fresh.target, "Fin", JSON.stringify(fresh));
  // The Journalist answers the guilty: Hap's guilty landed on a sole Journalist claim.
  const later = at(reduce(v, say("Ash", "Hap is lying, im journalist", 12_000)), 13_000);
  const r = sheriffShotReady(later);
  assert.deepEqual([r.ok, r.target], [true, "Hap"], JSON.stringify(r));
});

test("selfplay 18/28: a weak Cop pair is left to the lynch once the village votes one of them; the other Cop is not shot", () => {
  // Ash=Lawyer (fake Cop, guilty on Bea), Hap=Cop (inno on Cal, a lawyered Mafioso), Fin=Sheriff. c307e09 shot Hap.
  const frames = [say("Fin", "im sheriff", 2_000), say("Ash", "im cop. Bea guilty", 6_000), say("Hap", "im cop. Cal inno", 9_000)];
  const early = sheriffShotReady(at(fj("Fin", { dead: ["Dot"], frames }), 30_000));
  assert.notEqual(early.ok && early.target, "Hap", JSON.stringify(early));
  const voted = at(fj("Fin", { dead: ["Dot"], votes: { Bea: "Ash", Eli: "Ash", Ivo: "Ash" }, frames }), 40_000);
  const r = sheriffShotReady(voted);
  assert.ok(!(r.ok && ["Hap", "Ash"].includes(r.target)), JSON.stringify(r));
  assert.match(validateAction(voted, shoot("Hap")).reason || "", /sheriff shot/);
});
