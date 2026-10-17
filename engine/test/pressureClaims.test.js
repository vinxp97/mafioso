// Claims under pressure (Vinman's FJ rule: no immediate claims; claim with real info or under pressure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, roleClaimLine, claimAllowed, underPressure, townReads, TOWN_READS, adaptivePressureLine } from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);

/** Seat p1 on Day 2 with these Village votes; extra frames before the meeting. */
function seat(role, votes = {}, pre = [], { team = null, mafia = null } = {}) {
  return reduceAll([
    { event: "self", data: "p1" }, { event: "players", data: players },
    ...(mafia ? [{ event: "botConfig", data: { mafia } }] : []),
    ...(team ? Object.entries(team).map(([id, r]) => ({ event: "roleReveal", data: { playerId: id, role: r } })) : []),
    { event: "roleReveal", data: { playerId: "p1", role } },
    ...pre,
    { event: "state", data: { id: 4, name: "Day 2" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== "p1"), "*"], votes } },
  ]);
}
const on = (n, target = "p1") => Object.fromEntries(["p2", "p3", "p4", "p5", "p6", "p7"].slice(0, n).map((v) => [v, target]));
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });

test("pressure: L-1 (one short of a majority) or the leading 2+ wagon; one vote is not pressure", () => {
  assert.equal(underPressure(seat("Villager", on(1))), false);
  assert.equal(underPressure(seat("Villager", on(4))), true, "9 alive: hammer 5, L-1 = 4");
  assert.equal(underPressure(seat("Villager", { ...on(2), p8: "p5", p9: "p5" })), true, "tied lead with 2");
  assert.equal(underPressure(seat("Villager", { ...on(2), p7: "p5", p8: "p5", p9: "p5" })), false, "another wagon leads");
});

test("no immediate claims: a quiet Journalist, Villager, or Cop without a trigger says nothing", () => {
  for (const role of ["Journalist", "Villager"]) assert.equal(roleClaimLine(seat(role, on(1))), null, role);
  assert.equal(claimAllowed(seat("Journalist", on(1))), false);
  assert.equal(claimAllowed(seat("Cop", on(1), [], {})), false, "no guilty, no Sheriff out, no counterclaim");
});

test("under pressure every town role claims: Journalist, Cop, and a Villager says it has no power", () => {
  assert.match(roleClaimLine(seat("Journalist", on(4))), /^im journalist/);
  assert.match(roleClaimLine(seat("Cop", on(4))), /^im cop/);
  assert.equal(roleClaimLine(seat("Villager", on(4))), "im just a villager, no power role. not me");
  // Once claimed, no second claim.
  const again = seat("Villager", on(4), [say("p1", "im just a villager, no power role. not me")]);
  assert.equal(roleClaimLine(again), null);
});

test("Journalist (fixed rule): a rival Journalist claim alone is no trigger; under pressure it claims and calls it out", () => {
  const pre = [{ event: "state", data: { id: 3, name: "Day 2" } }, say("p4", "im journalist, nothing useful yet")];
  assert.equal(roleClaimLine(seat("Journalist", {}, pre)), null);
  assert.match(roleClaimLine(seat("Journalist", on(4), pre)), /^dot is lying, im journalist/);
});

test("town weighs a pressure claim: contested by a living claimer, or the role already flipped", () => {
  const town = (pre) => reduceAll([
    { event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role: "Villager" } },
    ...pre, { event: "state", data: { id: 6, name: "Day 3" } },
  ]);
  const flipped = townReads(town([{ event: "death", data: "p5" }, { event: "reveal", data: { playerId: "p5", role: "Journalist" } }, say("p2", "im journalist, nothing useful yet. not me")]));
  assert.ok(flipped.score.p2 >= TOWN_READS.roleFlipped, JSON.stringify(flipped.reasons.p2));
  const both = townReads(town([say("p2", "im journalist, nothing useful yet. not me"), say("p3", "bea is lying, im journalist")]));
  assert.deepEqual([...both.contested.Journalist].sort(), ["p2", "p3"]);
  const sole = townReads(town([say("p2", "im journalist, nothing useful yet. not me")]));
  assert.equal(sole.score.p2, TOWN_READS.uncontestedPower);
});

test("adaptive scum under pressure claim Villager or an open Journalist, never Cop or Sheriff", () => {
  const team = { p1: "Mafioso", p2: "Janitor", p3: "Lawyer" };
  const roles = new Set();
  for (let sid = 1; sid <= 12; sid++) {
    const v = seat("Mafioso", { p4: "p1", p5: "p1", p6: "p1", p7: "p1" }, [], { team, mafia: "adaptive" });
    v.stateId = `s${sid}`;
    const c = adaptivePressureLine(v);
    assert.ok(["Villager", "Journalist"].includes(c.role)); roles.add(c.role);
    assert.doesNotMatch(c.line, /\bPLAN\b|=/);
  }
  assert.equal(roles.size, 2);
  const jTaken = seat("Mafioso", { p4: "p1", p5: "p1", p6: "p1", p7: "p1" }, [say("p8", "im journalist")], { team, mafia: "adaptive" });
  for (let sid = 1; sid <= 6; sid++) { jTaken.stateId = `t${sid}`; assert.equal(adaptivePressureLine(jTaken).role, "Villager"); }
  assert.equal(adaptivePressureLine(seat("Mafioso", { p4: "p1" }, [], { team, mafia: "adaptive" })), null, "no pressure, no claim");
});
