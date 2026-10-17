// Live game t8Xue7oYr: a rival claimed the bot's own unique role and the bot stayed quiet. Cop and Journalist are
// unique in FJ: a rival claim gets an immediate counterclaim, today or from an earlier day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, claimAllowed, roleClaimLine } from "../src/index.js";

const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Bea" }, p3: { id: "p3", name: "Cal" }, p4: { id: "p4", name: "Dot" } };
const vil = { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "*"], votes: {} } };
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
function seat(role, events) {
  return reduceAll([{ event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } }, ...events]);
}
const day = (n) => [{ event: "state", data: { id: n * 2 + 1, name: `Day ${n}` } }, vil];

test("a rival Journalist claim today: the Journalist counterclaims at once", () => {
  const v = seat("Journalist", [...day(1), say("p2", "im journalist, trust me")]);
  assert.equal(claimAllowed(v), true);
  assert.match(roleClaimLine(v), /^bea is lying, im journalist/);
});

test("a rival Cop claim from yesterday still triggers the Cop's counterclaim today", () => {
  const v = seat("Cop", [...day(1), say("p3", "im cop, dot inno"), { event: "state", data: { id: 4, name: "Night 1" } }, ...day(2)]);
  assert.equal(claimAllowed(v), true);
  assert.match(roleClaimLine(v), /^cal is lying, im the real cop/);
});

test("a dead rival, or a rival claim of another role, is no trigger", () => {
  const dead = seat("Journalist", [...day(1), say("p2", "im journalist"), { event: "state", data: { id: 4, name: "Night 1" } }, { event: "death", data: "p2" }, ...day(2)]);
  assert.equal(claimAllowed(dead), false);
  assert.equal(claimAllowed(seat("Journalist", [...day(1), say("p2", "im cop, dot inno")])), false);
});
