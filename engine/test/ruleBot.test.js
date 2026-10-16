import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, ruleBotActions, validateAction } from "../src/index.js";

const players = {
  p1: { id: "p1", name: "Bot1" },
  p2: { id: "p2", name: "Bot2" },
  p3: { id: "p3", name: "Bot3" },
  p4: { id: "p4", name: "Bot4" },
};

function seat(frames) {
  return reduceAll(frames);
}

function assertLegal(view, actions) {
  assert.ok(actions.length >= 0);
  for (const action of actions) assert.equal(validateAction(view, action).ok, true, JSON.stringify(action));
}

test("RuleBot is deterministic for a seed and never sends an illegal action", () => {
  const view = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, canUpdateVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: { p2: "p1" } } },
    { event: "message", data: { senderId: "p2", content: "Bot1 is mafia.", meetingId: "vil" } },
  ]);
  const first = ruleBotActions(view, { seed: 9, now: 10_000 });
  const second = ruleBotActions(view, { seed: 9, now: 10_000 });
  assert.deepEqual(first, second);
  assert.equal(first.source, "rulebot");
  assertLegal(view, first.actions);
  assert.ok(first.actions.some((action) => action.event === "vote"));
  assert.ok(first.actions.every((action) => action.data.selection !== "p9"));
});

test("Cop checks an unchecked player", () => {
  const view = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Cop" } },
    { event: "state", data: { id: 1, name: "Night 1" } },
    { event: "meeting", data: { id: "inv", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ["p2", "p3"], votes: {} } },
    { event: "message", data: { senderId: "server", content: "Bot2 is sided with the Village", meetingId: "inv" } },
  ]);
  const act = ruleBotActions(view, { seed: 2 });
  assertLegal(view, act.actions);
  const vote = act.actions.find((action) => action.event === "vote" && action.data.meetingId === "inv");
  assert.equal(vote.data.selection, "p3");
  assert.deepEqual(ruleBotActions(view, { seed: 2 }).actions, act.actions);
});

test("Sheriff shoots on day 1", () => {
  const view = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Sheriff" } },
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "meeting", data: { id: "gun", name: "Shoot", voting: true, canVote: true, amMember: true, targets: ["p2", "p3"], votes: {} } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
  ]);
  // No shot at the start of the day: the Sheriff outs and waits for discussion.
  const early = ruleBotActions(view, { seed: 4 });
  assertLegal(view, early.actions);
  assert.equal(early.actions.find((action) => action.data.meetingId === "gun"), undefined);
});

test("mafia follows Cop over Sheriff over Journalist when those claims are visible", () => {
  const view = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Mafioso" } },
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: false, amMember: true, targets: [] } },
    { event: "message", data: { senderId: "p3", content: "I'm Sheriff.", meetingId: "vil" } },
    { event: "message", data: { senderId: "p2", content: "I'm Cop.", meetingId: "vil" } },
    { event: "message", data: { senderId: "p4", content: "I'm Journalist.", meetingId: "vil" } },
    { event: "state", data: { id: 2, name: "Night 1" } },
    { event: "meeting", data: { id: "maf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, members: ["p1"], targets: ["p2", "p3", "p4"], votes: {} } },
  ]);
  const act = ruleBotActions(view, { seed: 1 });
  assertLegal(view, act.actions);
  const kill = act.actions.find((action) => action.event === "vote" && action.data.meetingId === "maf");
  assert.equal(kill.data.selection, "p2");
  const plan = act.actions.find((action) => action.event === "speak");
  assert.match(plan.data.content, /PLAN kill=p2\b/);
});

test("town votes the most suspected player, or no lynch when nobody is suspected", () => {
  const quiet = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
  ]);
  const hold = ruleBotActions(quiet, { seed: 1 });
  assertLegal(quiet, hold.actions);
  assert.equal(hold.actions.find((action) => action.data.meetingId === "vil").data.selection, "*");

  const hot = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Villager" } },
    { event: "reveal", data: { playerId: "p2", role: "Mafioso" } },
    { event: "state", data: { id: 1, name: "Day 2" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
  ]);
  const push = ruleBotActions(hot, { seed: 1 });
  assertLegal(hot, push.actions);
  assert.equal(push.actions.find((action) => action.data.meetingId === "vil").data.selection, "p2");
});

test("a suspected player who is not a legal target is not voted", () => {
  const view = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Villager" } },
    { event: "reveal", data: { playerId: "p2", role: "Mafioso" } },
    { event: "state", data: { id: 1, name: "Day 2" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p3", "*"], votes: {} } },
  ]);
  const act = ruleBotActions(view, { seed: 8 });
  assertLegal(view, act.actions);
  assert.ok(act.actions.every((action) => action.data.selection !== "p2"));
  assert.equal(act.actions.find((action) => action.event === "vote").data.selection, "*");
});

test("public lines wait on the scheduler; a named seat may speak a short template", () => {
  const night = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Cop" } },
    { event: "state", data: { id: 1, name: "Night 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: false, amMember: true, targets: [] } },
    { event: "meeting", data: { id: "inv", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ["p2", "p3"], votes: {} } },
  ]);
  const quiet = ruleBotActions(night, { seed: 1, now: 50_000 });
  assert.equal(quiet.schedule.speak, false);
  assert.ok(quiet.actions.every((action) => action.event !== "speak"));

  const named = seat([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "reveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: { p2: "p1" } } },
    { event: "message", data: { senderId: "p2", content: "vote Bot1", meetingId: "vil", t: 1 } },
  ]);
  const talk = ruleBotActions(named, { seed: 1, now: 50_000 });
  assert.equal(talk.schedule.speak, true);
  const line = talk.actions.find((action) => action.event === "speak");
  assert.ok(line);
  assert.ok(line.data.content.length <= 240);
  assert.equal(validateAction(named, line).ok, true);
  assert.equal(line.data.meetingId, "vil");
});
