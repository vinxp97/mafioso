// Replay g16: the lowest-id teammate was not in the Mafia Kill meeting, so the seat that was waited on as leader
// could never vote and the kill (owed: a Sheriff claimer was alive) never came. The leader must be a member.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, factionLeader, decide } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const night = (members) => reduceAll([
  { event: "self", data: "p3" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p3", role: "Mafioso" } },
  { event: "reveal", data: { playerId: "p1", role: "Janitor" } },
  { event: "state", data: { id: 2, name: "Night 2" } },
  { event: "meeting", data: { id: "k", name: "Mafia Kill", factionRole: "kill", voting: true, canVote: true, amMember: true, targets: ["p2", "p4", "p5"], votes: {}, ...(members ? { members: members.map((id) => ({ id })) } : {}) } },
]);

test("the faction leader is a kill-meeting member when the meeting lists its members", () => {
  assert.equal(factionLeader(night()), "p1", "no member list: lowest living id");
  assert.equal(factionLeader(night(["p1", "p3"])), "p1");
  const alone = night(["p3"]);
  assert.equal(factionLeader(alone), "p3", "the Janitor is not in the kill meeting");
  assert.ok(decide(alone).some((a) => a.event === "vote" && a.data.meetingId === "k" && a.data.selection !== "*"), "so this seat votes the kill");
});
