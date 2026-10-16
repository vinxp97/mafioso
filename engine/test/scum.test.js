import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, decide, buildBriefing, llmDecide, validateAction } from "../src/index.js";

const players = {
  p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Ally" },
  p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Cat" },
};
const PLAN = "PLAN kill=p4 lynch=p3 claim=Cop lawyer=p4 speaker=p1";

function seat(self, role, extra = []) {
  return reduceAll([
    { event: "self", data: self },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: self === "p1" ? role : "Mafioso" } },
    { event: "roleReveal", data: { playerId: "p2", role: "Godfather" } },
    { event: "roleReveal", data: { playerId: self, role } },
    { event: "state", data: { id: 2, name: "Night 1" } },
    { event: "meeting", data: { id: "mMaf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, targets: ["p3", "p4", "*"], votes: {}, members: [{ id: "p1" }, { id: "p2" }] } },
    ...extra,
  ]);
}

const vote = (acts, meetingId) => acts.find((action) => action.event === "vote" && action.data.meetingId === meetingId);

test("each mafia seat votes the kill named in its own faction chat", () => {
  const chat = { event: "message", data: { senderId: "p2", meetingId: "mMaf", content: PLAN } };
  const a = seat("p1", "Mafioso", [chat]);
  const b = seat("p2", "Godfather", [chat]);
  assert.equal(a.notes.plan.killTarget, "p4");
  assert.equal(b.notes.plan.killTarget, "p4");
  assert.equal(vote(decide(a), "mMaf").data.selection, "p4");
  assert.equal(vote(decide(b), "mMaf").data.selection, "p4");
  assert.notEqual(a.notes, b.notes);
});

test("a seat that has not seen the plan does not inherit another seat's kill", () => {
  const heard = seat("p1", "Mafioso", [{ event: "message", data: { senderId: "p2", meetingId: "mMaf", content: PLAN } }]);
  const deaf = seat("p2", "Godfather");
  assert.equal(vote(decide(heard), "mMaf").data.selection, "p4");
  assert.equal(vote(decide(deaf), "mMaf").data.selection, "p3");
  assert.equal(deaf.notes.plan, null);
});

test("night without a plan announces one kill and votes it", () => {
  const acts = decide(seat("p1", "Mafioso"));
  assert.deepEqual(acts, [
    { event: "speak", data: { meetingId: "mMaf", content: "PLAN kill=p3 lynch=p4 claim=Cop lawyer=p3 speaker=p1" } },
    { event: "vote", data: { meetingId: "mMaf", selection: "p3" } },
  ]);
});

test("day vote and claim follow the plan this seat already saw", () => {
  let v = seat("p1", "Mafioso", [{ event: "message", data: { senderId: "p1", meetingId: "mMaf", content: PLAN } }]);
  v = reduce(v, { event: "state", data: { id: 3, name: "Day 2" } });
  v = reduce(v, { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p4", "p3", "p2", "*"], votes: {} } });
  assert.deepEqual(decide(v), [
    { event: "speak", data: { meetingId: "mVil", content: "I'm Cop. Vote p3." } },
    { event: "vote", data: { meetingId: "mVil", selection: "p3" } },
  ]);
  const other = seat("p2", "Godfather", [{ event: "message", data: { senderId: "p1", meetingId: "mMaf", content: PLAN } }]);
  let day = reduce(other, { event: "state", data: { id: 3, name: "Day 2" } });
  day = reduce(day, { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p4", "p3", "p2", "*"], votes: {} } });
  assert.deepEqual(decide(day), [{ event: "vote", data: { meetingId: "mVil", selection: "p3" } }]);
});

test("lawyer covers the teammate who asked, otherwise the kill", () => {
  const asked = seat("p1", "Lawyer", [
    { event: "message", data: { senderId: "p2", meetingId: "mMaf", content: "lawyer me" } },
    { event: "meeting", data: { id: "mLaw", name: "Lawyer", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4"], votes: {} } },
  ]);
  const acts = decide(asked);
  assert.equal(vote(acts, "mMaf").data.selection, "p3");
  assert.equal(vote(acts, "mLaw").data.selection, "p2");
  const planned = seat("p1", "Loyal Lawyer", [
    { event: "message", data: { senderId: "p2", meetingId: "mMaf", content: "PLAN kill=p4 lynch=p3 claim=Cop lawyer=p3 speaker=p2" } },
    { event: "meeting", data: { id: "mLaw", name: "Lawyer", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4"], votes: {} } },
  ]);
  assert.equal(vote(decide(planned), "mLaw").data.selection, "p3");
});

test("janitor cleans the agreed kill and never skips", () => {
  const yesNo = seat("p1", "Janitor", [
    { event: "message", data: { senderId: "p2", meetingId: "mMaf", content: PLAN } },
    { event: "meeting", data: { id: "mJan", name: "Clean", voting: true, canVote: true, amMember: true, targets: ["Yes", "No"], votes: {} } },
  ]);
  const yesActs = decide(yesNo);
  assert.equal(vote(yesActs, "mMaf").data.selection, "p4");
  assert.equal(vote(yesActs, "mJan").data.selection, "Yes");
  assert.equal(yesActs.some((action) => action.data.selection === "No" || action.data.selection === "*"), false);
  const playersMeet = seat("p1", "Janitor", [
    { event: "message", data: { senderId: "p2", meetingId: "mMaf", content: PLAN } },
    { event: "meeting", data: { id: "mJan", name: "Clean", voting: true, canVote: true, amMember: true, targets: ["p3", "p4", "*"], votes: {} } },
  ]);
  const cleaned = vote(decide(playersMeet), "mJan");
  assert.equal(cleaned.data.selection, "p4");
  assert.equal(validateAction(playersMeet, cleaned).ok, true);
});

test("town does not execute a plan line or a mafia kill", () => {
  const cop = reduceAll([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Cop" } },
    { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p4", "p3", "p2", "*"], votes: {} } },
    { event: "message", data: { senderId: "p2", meetingId: "mVil", content: PLAN } },
  ]);
  assert.equal(cop.notes.plan ?? null, null);
  assert.equal(buildBriefing(cop).includes("TEAM PLAN"), false);
  assert.deepEqual(decide(cop), [{ event: "vote", data: { meetingId: "mVil", selection: "p4" } }]);
});

test("llm briefing shows TEAM PLAN from this seat's chat and rejects a different kill", async () => {
  const v = seat("p1", "Mafioso", [{ event: "message", data: { senderId: "p2", meetingId: "mMaf", content: PLAN } }]);
  const briefing = buildBriefing(v);
  assert.match(briefing, /TEAM PLAN: kill=p4 lynch=p3 claim=Cop lawyer=p4 janitor=p4 speaker=p1 source=chat/);
  const off = await llmDecide(v, { complete: async () => '{"action":"vote","meeting":"mMaf","target":"p3"}', maxRetries: 0 });
  assert.equal(off.source, "fallback");
  assert.equal(vote(off.actions, "mMaf").data.selection, "p4");
  const on = await llmDecide(v, { complete: async () => '{"action":"vote","meeting":"mMaf","target":"p4"}' });
  assert.equal(on.source, "llm");
  assert.equal(on.actions[0].data.selection, "p4");
});
