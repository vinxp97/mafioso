// Every living seat casts a legal day vote, and a must-vote night meeting never goes unvoted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, decide, validateAction } from "../src/index.js";

const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Ally" }, p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Cat" }, p5: { id: "p5", name: "Dan" } };
const PLAN = "PLAN kill=p4 lynch=p3 claim=Cop lawyer=p4 speaker=p1";
const mafia = { event: "meeting", data: { id: "mMaf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, targets: ["p3", "p4", "p5", "*"], votes: {}, members: [{ id: "p1" }, { id: "p2" }] } };

function scum(role, extra = []) {
  return reduceAll([
    { event: "self", data: "p1" }, { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role } }, { event: "roleReveal", data: { playerId: "p2", role: "Godfather" } },
    { event: "state", data: { id: 2, name: "Night 1" } }, mafia, ...extra,
  ]);
}
const dayVote = (v) => decide(v).find((a) => a.event === "vote" && a.data.meetingId === "mVil");
const village = (targets) => ({ event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets, votes: {} } });

test("fake-claimer whose PLAN lynch target was shot still casts a legal day vote", () => {
  let v = scum("Mafioso", [{ event: "message", data: { senderId: "p1", meetingId: "mMaf", content: PLAN } }]);
  v = reduce(v, { event: "state", data: { id: 3, name: "Day 1" } });
  v = reduce(v, village(["p3", "p4", "p5", "p2", "*"]));
  assert.equal(dayVote(v).data.selection, "p3", "PLAN target while alive");
  v = reduce(v, { event: "death", data: "p3" });
  v = reduce(v, village(["p4", "p5", "p2", "*"]));
  const a = dayVote(v);
  assert.ok(a, "still votes after the PLAN target is shot");
  assert.ok(validateAction(v, a).ok);
  assert.ok(!["p2", "p1", "p3"].includes(a.data.selection), `votes a non-teammate: ${a.data.selection}`);
});

test("Lawyer with no PLAN target uses the teammate rule; with no teammate left it passes rather than vegging", () => {
  const law = (targets) => ({ event: "meeting", data: { id: "mLaw", name: "Litigate", voting: true, canVote: true, amMember: true, targets, votes: {} } });
  const withMate = scum("Lawyer", [law(["p2", "p3", "p4", "p5", "*"])]);
  const a = decide(withMate).find((x) => x.data?.meetingId === "mLaw");
  assert.equal(a?.data.selection, "p2", "covers the living teammate");
  const alone = scum("Lawyer", [{ event: "death", data: "p2" }, law(["p3", "p4", "p5", "*"])]);
  const b = decide(alone).find((x) => x.data?.meetingId === "mLaw");
  assert.equal(b?.data.selection, "*", "no teammate: pass, still a vote");
});

test("a Village seat with nothing to go on still votes", () => {
  const v = reduceAll([
    { event: "self", data: "p3" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p3", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 1" } }, village(["p1", "p2", "p4", "p5", "*"]),
  ]);
  const a = dayVote(v);
  assert.ok(a && validateAction(v, a).ok);
});
