import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, decide, buildBriefing, llmDecide } from "../src/index.js";

const players = {
  p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" },
  p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Carol" },
};

function cop(extra) {
  return reduceAll([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Cop" } },
    ...extra,
  ]);
}

test("the next briefing keeps a claim, a soft claim, a vote, and a death", () => {
  const v = cop([
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "message", data: { senderId: "p2", content: "I'm cop" } },
    { event: "message", data: { senderId: "p4", content: "maybe doctor" } },
    { event: "vote", data: { meetingId: "mVil", voterId: "p3", target: "p2" } },
    { event: "death", data: "p4" },
  ]);
  const notes = buildBriefing(v);
  assert.match(notes, /NOTES:/);
  assert.match(notes, /p2 claim Cop/);
  assert.match(notes, /p4 soft Doctor/);
  assert.match(notes, /p3->p2/);
  assert.match(notes, /deaths: p4/);
  const other = cop([]);
  assert.equal(other.notes.deaths.length, 0);
  assert.equal(buildBriefing(other).includes("p2 claim Cop"), false);
});

test("a check result on this seat changes the next investigate and the next vote", async () => {
  const night = cop([
    { event: "state", data: { id: 4, name: "Night 2" } },
    { event: "message", data: { senderId: "server", content: "Alice is sided with the Village" } },
    { event: "message", data: { senderId: "server", content: "Bob is sided with the Mafia" } },
    { event: "meeting", data: { id: "mCop", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "*"], votes: {} } },
  ]);
  assert.equal(night.notes.checks.p2.detail, "Village");
  assert.equal(night.notes.checks.p3.result, "Mafia");
  assert.match(buildBriefing(night), /cleared: p2/);
  assert.match(buildBriefing(night), /suspects: p3/);
  assert.deepEqual(decide(night), [{ event: "vote", data: { meetingId: "mCop", selection: "p4" } }]);
  const wasted = await llmDecide(night, { complete: async () => '{"action":"vote","meeting":"mCop","target":"p2"}', maxRetries: 0 });
  assert.equal(wasted.source, "fallback");
  assert.equal(wasted.actions[0].data.selection, "p4");
  const day = cop([
    { event: "state", data: { id: 5, name: "Day 2" } },
    { event: "message", data: { senderId: "server", content: "Alice is sided with the Village" } },
    { event: "message", data: { senderId: "server", content: "Bob is sided with the Mafia" } },
    { event: "meeting", data: { id: "mVil", name: "Village", voting: true, canVote: true, amMember: true, targets: ["p4", "p2", "p3", "*"], votes: {} } },
  ]);
  assert.deepEqual(decide(day), [{ event: "vote", data: { meetingId: "mVil", selection: "p3" } }]);
});

test("wait is rejected while a night ability is still open", async () => {
  const night = cop([
    { event: "state", data: { id: 4, name: "Night 2" } },
    { event: "meeting", data: { id: "mCop", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "*"], votes: {} } },
  ]);
  const waited = await llmDecide(night, { complete: async () => '{"action":"wait"}', maxRetries: 0 });
  assert.equal(waited.source, "fallback");
  assert.deepEqual(waited.actions, [{ event: "vote", data: { meetingId: "mCop", selection: "p2" } }]);
});
