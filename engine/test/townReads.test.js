// Town reads (Frontier Justice): public evidence -> suspicion, no-lynch on contested claims, Sheriff and
// investigator targeting, and the "every living seat votes" fallbacks for scum seats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, decide, townReads, townDayPick, sheriffReadTarget, proposeNightAction, TOWN_READS } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);

function town(role, events = [], { phase = "Day 2", self = "p1" } = {}) {
  const day = /^day/i.test(phase);
  return reduceAll([
    { event: "self", data: self },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role } },
    ...events.filter((e) => e.pre),
    { event: "state", data: { id: 3, name: phase } },
    day
      ? { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== self), "*"], votes: {} } }
      : { event: "meeting", data: { id: "act", name: role, voting: true, canVote: true, amMember: true, targets: ids.filter((i) => i !== self), votes: {} } },
    ...events.filter((e) => !e.pre),
  ]);
}
const say = (from, content, pre = false) => ({ pre, event: "message", data: { meetingId: "vil", senderId: from, content } });
const dies = (id, role) => [{ pre: true, event: "death", data: id }, { pre: true, event: "reveal", data: { playerId: id, role } }];
const vil = (v) => v.meetings.vil;

test("two Cop claims: both contested, and town votes no-lynch instead of either claimant's target", () => {
  const v = town("Villager", [say("p2", "im cop, cal is guilty"), say("p4", "im cop, eli is guilty")]);
  const r = townReads(v);
  assert.deepEqual([...r.contested.Cop].sort(), ["p2", "p4"]);
  assert.equal(r.score.p2, r.score.p4, "no claimant is favoured without evidence");
  const pick = townDayPick(v, vil(v));
  assert.equal(pick.target, "*", pick.why);
});

test("a guilty that flips town makes the claimer a proven liar, and town lynches him", () => {
  const v = town("Villager", [say("p2", "im cop, cal is guilty", true), ...dies("p3", "Villager")]);
  const r = townReads(v);
  assert.ok(r.score.p2 >= TOWN_READS.provenLiar, JSON.stringify(r.reasons.p2));
  assert.equal(townDayPick(v, vil(v)).target, "p2");
});

test("a seat holding a unique role reads anyone claiming it as mafia", () => {
  const v = town("Cop", [say("p5", "im cop, dot is guilty")]);
  assert.ok(townReads(v).score.p5 >= TOWN_READS.claimsMyRole);
  assert.equal(townDayPick(v, vil(v)).target, "p5");
});

test("a Journalist report settles a Cop claim: no report = fake Cop", () => {
  const v = town("Villager", [say("p2", "im cop, cal is guilty"), say("p6", "im journalist. bea got no report, fake cop")]);
  const r = townReads(v);
  assert.ok(r.score.p2 >= TOWN_READS.fakeCopReport, JSON.stringify(r.reasons.p2));
  assert.equal(townDayPick(v, vil(v)).target, "p2");
});

test("voters on a Day death that flipped town earn suspicion, the first voters most", () => {
  const v = reduceAll([
    { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "vote", data: { meetingId: "vil1", voterId: "p2", target: "p3" } },
    { event: "vote", data: { meetingId: "vil1", voterId: "p4", target: "p3" } },
    { event: "vote", data: { meetingId: "vil1", voterId: "p5", target: "p3" } },
    { event: "death", data: "p3" }, { event: "reveal", data: { playerId: "p3", role: "Villager" } },
    { event: "state", data: { id: 4, name: "Day 2" } },
  ]);
  const r = townReads(v);
  assert.equal(r.score.p2, TOWN_READS.lynchPusher + TOWN_READS.firstPusher);
  assert.equal(r.score.p4, TOWN_READS.lynchPusher + TOWN_READS.firstPusher);
  assert.equal(r.score.p5, TOWN_READS.lynchPusher);
  assert.equal(r.score.p6, undefined);
});

test("credibility transfers: an accuser of a mafia flip is credible, so a rival claim of his role is the liar", () => {
  const v = town("Villager", [
    say("p2", "im cop", true), say("p2", "cal is lying", true), ...dies("p3", "Mafioso"),
    say("p4", "im cop, bea is guilty"),
  ]);
  const r = townReads(v);
  assert.ok(r.score.p2 < 0, JSON.stringify(r.reasons.p2));
  assert.ok(r.score.p4 >= TOWN_READS.strong, JSON.stringify(r.reasons.p4));
  assert.equal(townDayPick(v, vil(v)).target, "p4");
});

test("unverified evidence alone is not a lynch: the sole Cop claimer's guilty is a test, not a vote", () => {
  const v = town("Villager", [say("p2", "im cop, cal is guilty")]);
  const r = townReads(v);
  assert.equal(r.score.p3, TOWN_READS.soleCopGuilty);
  assert.equal(townDayPick(v, vil(v)), null, "falls back to the ordinary vote rules");
});

test("the Sheriff's read target needs a clear lead; a proven liar is shot", () => {
  const liar = town("Sheriff", [say("p2", "im cop, cal is guilty", true), ...dies("p3", "Villager")]);
  assert.equal(sheriffReadTarget(liar, ids).target, "p2");
  const tied = town("Sheriff", [say("p2", "im cop, cal is guilty"), say("p4", "im cop, eli is guilty")]);
  assert.equal(sheriffReadTarget(tied, ids), null, "two equal claimants: no read shot");
});

test("Journalist visits the Cop claimer from Night 2; Cop checks its top read", () => {
  const j = town("Journalist", [say("p4", "im cop, eli is guilty", true)], { phase: "Night 2" });
  const jv = proposeNightAction(j, { rng: () => 0 });
  assert.equal(jv.data.selection, "p4");
  const c = town("Cop", [say("p2", "im cop, cal is guilty", true)], { phase: "Night 2" });
  assert.equal(proposeNightAction(c, { rng: () => 0 }).data.selection, "p2", "the rival Cop claimer is the top read");
});
