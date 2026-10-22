// townVote: the suspicion model's day vote (townReads over the seat's legalActions picks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, townReads, townVote, meetingActions, noLynchLoses, TOWN_READS } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const day = (events = [], { pre = [], role = "Villager" } = {}) => reduceAll([
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } },
  ...pre,
  { event: "state", data: { id: 4, name: "Day 2" } },
  { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  ...events,
]);
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
const vote = (voterId, target) => ({ event: "vote", data: { meetingId: "vil", voterId, target } });
const dies = (id, role) => [{ event: "death", data: id }, { event: "reveal", data: { playerId: id, role } }];
const pick = (v) => townVote(v, v.meetings.vil);

test("no evidence and no wagon: no lynch", () => {
  assert.equal(pick(day()).target, "*");
});

test("a proven liar is the vote, and the vote is always a legal pick", () => {
  const v = day([], { pre: [say("p2", "im cop, cal is guilty"), ...dies("p3", "Villager")] });
  const r = pick(v);
  assert.equal(r.target, "p2", r.why);
  assert.ok(meetingActions(v, v.meetings.vil).picks.includes(r.target));
});

test("a wagon from players I don't suspect is worth joining; a verified claimer is never voted", () => {
  assert.equal(pick(day([vote("p4", "p5")])).target, "p5");
  const pre = [say("p2", "im cop, cal is guilty"), ...dies("p3", "Mafioso")];
  const v = day([vote("p4", "p2"), vote("p5", "p2"), vote("p6", "p2")], { pre });
  assert.ok(townReads(v).verified.includes("p2"));
  assert.notEqual(pick(v).target, "p2");
});

test("wagon starts: today's voters on a verified claimer earn suspicion, the first two more", () => {
  const pre = [say("p2", "im cop, cal is guilty"), ...dies("p3", "Mafioso")];
  const r = townReads(day([vote("p4", "p2"), vote("p5", "p2"), vote("p6", "p2")], { pre }));
  assert.equal(r.score.p4, TOWN_READS.votedVerified + TOWN_READS.firstPusher, JSON.stringify(r.reasons.p4));
  assert.equal(r.score.p6, TOWN_READS.votedVerified);
});

test("when no-lynch would lose the game, the top read is voted instead of '*'", () => {
  const v = day([], { pre: [...dies("p4", "Villager"), ...dies("p5", "Villager")] });
  v.meetings.vil.targets = ["p1", "p2", "p3", "p6", "*"];
  assert.equal(noLynchLoses(v), true);
  const allowed = meetingActions(v, v.meetings.vil).allowed;
  assert.ok(!allowed.includes("*"));
  assert.ok(allowed.includes(pick(v).target));
});
