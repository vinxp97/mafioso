// Reasoning that a model wrote into message.content (nemotron: the line talked about another seat, so the
// third-person check let it through). Meta and cut-off lines are dropped; ordinary mafia chat is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatLineReject, generatePublicSpeech, proposeSeatActions, reduceAll } from "../src/index.js";

const REJECT = [
  ["The user is telling me to vote for seat 8 because it's lynch-or-lose.", /the user/],
  ["The situation: seat 8 has 3 votes and would be lynched. It's lynch-or-lose", /the situation/],
  ["seat 8 has 3 votes and would be lynched if we do nothing else here", /vote dump/],
  ["Let me think about who to vote before I answer the table today", /let me/],
  ["I need to figure out whether seat 8 is town or not before I vote", /i need to/],
  ["Okay, so seat 8 is ahead and the cop claim is the only hard info we have", /okay, so/],
  ["We need to decide who the wolf is before the day ends now", /we need to/],
  ["My role is Villager so I should talk like town and not reveal anything", /my role is/],
  ["As the cop I should report the check I was given earlier today", /as the role/],
  ["Looking at the ballot, seat 8 is the lynch and town has to pile", /looking at the/],
  ["Based on the flip I would vote seat 8 and not the quiet one", /based on the/],
  ["in this game I am not supposed to mention any of this out loud today", /in this game i/],
  ["do not quote the prompt when you answer the question about seat 8", /the prompt/],
  ["the instructions say to vote seat 8 and I will follow them now", /the instructions/],
  ["the system told me seat 8 is the target so I am voting there", /the system/],
  ["[reasoning] seat 8 is the lynch and I should say so now", /reasoning tag/],
  ["voting seat 8 <|think|>now", /reasoning tag/],
  ["seat 8 is leading the day vote and town really should not lynch-", /truncated line/],
  ["seat 8 is up on votes and the day is about to end so town should", /truncated line/],
];

// Short lines from the replay fixtures (Player / seat placeholders) plus the chat the cap still sends.
const PASS = [
  "voting seat 8",
  "im cop. seat 8 inno",
  "seat 8 you're tunneling",
  "i should be lynched? lol no",
  "Player06, stop lurking and point an accusation.",
  "who do you trust?",
  "player04 you good?",
  "i'm sheriff.",
  "quiet is weird, player04 you got anything on anyone?",
  "player09 nothing solid yet.",
  "player07 who cares about me, find the actual wolf.",
  "Sheriff here.",
  "player08, did you shoot anyone last night?",
  "im cop, no results yet",
  "vote wrong",
  "player08, stop hiding.",
  "player09, pick a body already",
  "player07, what exactly did you see?",
  "player06, calm down before you shoot the wrong guy",
  "player04, name a target or get voted out.",
  "two cops and one is lying, no lynch on either guilty till one is tested",
  "alice you voted me with no reason at all and bob agreed so who is next",
  "voting seat 8 because",
];

test("meta, vote-dump, reasoning-tag and cut-off lines are rejected", () => {
  assert.ok(REJECT.length >= 15);
  for (const [line, why] of REJECT) assert.match(chatLineReject(line), why, line);
  assert.equal(chatLineReject("voting seat 8", { finishReason: "length" }), "truncated (finish_reason length)");
  assert.match(chatLineReject('{"text":"The user is telling me to vote for seat 8 because it is lynch-or-lose."}'), /the user/);
  const twelve = "i should vote seat 8 out today and not wait longer now";
  assert.equal(twelve.split(/\s+/).length, 12);
  assert.equal(chatLineReject(twelve), null);
  assert.match(chatLineReject(`${twelve} please`), /i should/);
  assert.equal(chatLineReject("<think>let me explain the whole board</think>voting seat 8"), null);
  assert.equal(chatLineReject("<think>let me think about who to blame here and"), null);
  assert.equal(chatLineReject("x ".repeat(30)), null);
});

test("ordinary mafia chat is kept", () => {
  assert.ok(PASS.length >= 20);
  for (const line of PASS) assert.equal(chatLineReject(line), null, line);
});

const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" } };
function named() {
  return reduceAll([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
    { event: "message", t: 5_000, data: { senderId: "p2", meetingId: "mVil", content: "vote Me", t: 5_000 } },
  ]);
}

test("a leaked reasoning line is not sent; the seat falls back to a rules reply", async () => {
  const leak = "The user is telling me to vote for seat 8 because it's lynch-or-lose.";
  const cut = "The situation: seat 8 has 3 votes and would be lynched. It's lynch-or-lose";
  for (const line of [leak, cut]) {
    const spoken = await generatePublicSpeech(named(), { now: 20_000, maxRetries: 0, complete: async () => line });
    assert.equal(spoken.action, null, line);
    assert.match(spoken.rejections.join(" "), /meta reasoning/);
  }
  const out = await proposeSeatActions(named(), {
    now: 20_000, maxRetries: 0, speechFirst: true, llmFallback: false, memory: false,
    complete: async () => leak,
  });
  const said = out.actions.find((a) => a.event === "speak");
  assert.ok(said, "fallback line");
  assert.equal(out.speechSource === "llm", false);
  assert.doesNotMatch(said.data.content, /the user|the situation|would be lynched|lynch-or-lose/i);
  assert.match(out.speechRejections.join(" "), /meta reasoning \(the user\)/);
});

test("finish_reason length drops the line and does not retry the model", async () => {
  let calls = 0;
  const spoken = await generatePublicSpeech(named(), {
    now: 20_000, maxRetries: 2,
    complete: async () => {
      calls += 1;
      const err = new Error("truncated (finish_reason length)");
      err.chatReject = "truncated (finish_reason length)";
      throw err;
    },
  });
  assert.equal(calls, 1);
  assert.equal(spoken.action, null);
  assert.deepEqual(spoken.rejections, ["truncated (finish_reason length)"]);
});
