// Live game t8Xue7oYr: a Journalist relayed a Cop's guilty, but a rival Journalist claim made town ignore it even though
// the Cop was verified; and the relay was read as the Journalist's own "guilty on a power claimer" (no lynch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, townReads, townDayPick, publicRecord } from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
const RELAYED = "Journalist relayed a Cop's guilty report";
/** Villager Ivo (p9) on Day 2. */
function town(events, today = []) {
  return reduceAll([
    { event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 1" } }, ...events,
    { event: "state", data: { id: 5, name: "Day 2" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== "p9"), "*"], votes: {} } },
    ...today,
  ]);
}
const relayed = (v, id) => (townReads(v).reasons[id] || []).some((r) => r.endsWith(RELAYED));
const rivals = [say("p2", "im journalist"), say("p3", "im journalist")];

test("the relay records which Cop it came from", () => {
  const rec = publicRecord(town([say("p2", "im journalist. dot got a cop report, real cop, it said eli guilty")]));
  assert.deepEqual(rec.guilty.map(({ by, target, relay, cop }) => ({ by, target, relay, cop })), [{ by: "p2", target: "p5", relay: true, cop: "p4" }]);
});

test("contested Journalist: the relay counts when its Cop is verified (its guilty flipped mafia)", () => {
  const verifiedCop = [say("p4", "im cop. fin guilty"), { event: "death", data: "p6" }, { event: "reveal", data: { playerId: "p6", role: "Mafioso" } }];
  const line = say("p2", "dot got a cop report, real cop, it said eli guilty");
  assert.equal(relayed(town([...rivals, ...verifiedCop, line]), "p5"), true);
  assert.equal(relayed(town([...rivals, say("p4", "im cop"), say("p7", "im cop"), line]), "p5"), false, "contested Cop, other target: still ignored");
});

test("contested Journalist: a relay naming the rival Journalist claimer counts", () => {
  assert.equal(relayed(town([...rivals, say("p4", "im cop"), say("p2", "dot got a cop report, real cop, it said cal guilty")]), "p3"), true);
});

test("a relayed guilty on a power claimer is not the no-lynch trigger", () => {
  // Contested Journalists, contested Cops: Bea's relay on Fin (Sheriff claim) is ignored as evidence, and is not
  // Bea's own guilty on a power claimer either.
  const v = town([...rivals, say("p4", "im cop"), say("p7", "im cop"), say("p6", "im sheriff")], [say("p2", "dot got a cop report, real cop, it said fin guilty")]);
  assert.equal(relayed(v, "p6"), false);
  assert.notEqual(townDayPick(v, v.meetings.vil)?.why, "guilty on a power-role claimer: no lynch");
});
