// Live game GAME01 (qwen3.8-27b): model-written lines were logged source=rules (the vote's label), so the scorecard's
// llm_share read 0; and a 13-word line got through because the addressee's name was added after the 12-word cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, proposeSeatActions, cleanChatReply, capSpeechWords } from "../src/index.js";

const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" } };
const named = () => reduceAll([
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
  { event: "state", data: { id: 1, name: "Day 1" } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
  { event: "message", t: 5_000, data: { senderId: "p2", meetingId: "mVil", content: "vote Me", t: 5_000 } },
]);
const opts = { now: 20_000, maxRetries: 0, speechFirst: true, llmFallback: false, memory: false };

test("the public line's author is reported apart from the vote's source", async () => {
  const llm = await proposeSeatActions(named(), { ...opts, complete: async () => "alice thats a reach, bob is quieter" });
  assert.equal(llm.source, "rules", "the vote came from rules");
  assert.equal(llm.speechSource, "llm");
  const fallback = await proposeSeatActions(named(), { ...opts, complete: async () => "" });
  assert.equal(fallback.speechSource, "accused-rule");
});

test("12 words is the cap even after the addressee's name is added", () => {
  const twelve = "you voted me with no reason at all and bob agreed fast";
  const line = cleanChatReply(twelve, named(), { name: "Alice" });
  assert.equal(line.split(" ").length, 12);
  assert.match(line, /^alice /);
  assert.equal(capSpeechWords("  a  b c "), "a b c");
});
