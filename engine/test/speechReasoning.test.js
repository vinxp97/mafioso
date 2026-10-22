// Live game t8Xue7oYr (Muse): a reasoning model spent the 40-token speech budget on hidden thinking, every line came
// back empty and was dropped, and a named seat said nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, generatePublicSpeech, proposeSeatActions, decideSpeech, SPEECH_TOKENS, stripReasoning } from "../src/index.js";

const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" } };
/** A Villager seat named by Alice on Day 1 (the scheduler says speak at t=20s). */
function named({ reasoning = false } = {}) {
  return reduceAll([
    ...(reasoning ? [{ event: "botConfig", data: { reasoning: true } }] : []),
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
    { event: "message", t: 5_000, data: { senderId: "p2", meetingId: "mVil", content: "vote Me", t: 5_000 } },
  ]);
}

test("a reasoning model gets the large speech budget and its <think> block is stripped", async () => {
  const v = named({ reasoning: true });
  assert.equal(decideSpeech(v, { now: 20_000 }).speak, true);
  const budgets = [];
  const out = await generatePublicSpeech(v, { now: 20_000, maxRetries: 0, complete: async (p) => { budgets.push(p.maxTokens); return "<think>alice voted me first, so push back on her</think>Alice why push me, Bob is quieter"; } });
  assert.deepEqual(budgets, [SPEECH_TOKENS.reasoning]);
  assert.equal(out.action.data.content, "Alice why push me, Bob is quieter");
});

test("an empty reply at the plain budget retries once with the reasoning budget, and says why", async () => {
  const budgets = [];
  const replies = ["", "Alice thats a reach, why me"];
  const out = await generatePublicSpeech(named(), { now: 20_000, maxRetries: 0, complete: async (p) => { budgets.push(p.maxTokens); return replies.shift(); } });
  assert.deepEqual(budgets, [SPEECH_TOKENS.plain, SPEECH_TOKENS.reasoning]);
  assert.deepEqual(out.rejections, ["empty line"]);
  assert.equal(out.action.data.content, "Alice thats a reach, why me");
  const cut = await generatePublicSpeech(named({ reasoning: true }), { now: 20_000, maxRetries: 0, complete: async () => "<think>let me think about who to blame here and" });
  assert.equal(cut.action, null);
  assert.deepEqual(cut.rejections, ["empty line (only reasoning)"]);
});

test("model lines are cut to 12 words; stripReasoning handles open, closed and orphan-close blocks", async () => {
  const words = "alice you voted me with no reason at all and bob agreed so who is next";
  const out = await generatePublicSpeech(named(), { now: 20_000, maxRetries: 0, complete: async () => words });
  assert.equal(out.action.data.content.split(" ").length, 12);
  assert.equal(stripReasoning("<thinking>x</thinking>hi").trim(), "hi");
  assert.equal(stripReasoning("<think>never closed").trim(), "");
  assert.equal(stripReasoning("thinking out loud...</think>ok").trim(), "ok");
});

test("named seat whose model returns nothing answers with a rules reply, and the reasons are returned", async () => {
  const v = named();
  const out = await proposeSeatActions(v, { now: 20_000, maxRetries: 0, speechFirst: true, llmFallback: false, memory: false, complete: async () => "" });
  const line = out.actions.find((a) => a.event === "speak");
  assert.ok(line, "a named seat is never silent");
  assert.match(line.data.content, /^Alice /);
  assert.ok(out.speechRejections.length >= 1 && out.speechRejections.every((r) => /^empty line/.test(r)), out.speechRejections.join("; "));
  // Once per accuser per day: Alice names me again, the model is still empty, no second rules reply to her.
  v.messages.push({ senderId: "p1", meetingId: "mVil", content: line.data.content, t: 21_000, phase: "Day 1" });
  v.messages.push({ senderId: "p2", meetingId: "mVil", content: "Me is lying", t: 40_000, phase: "Day 1" });
  const again = await proposeSeatActions(v, { now: 60_000, maxRetries: 0, speechFirst: true, llmFallback: false, memory: false, complete: async () => "" });
  assert.equal(again.actions.some((a) => a.event === "speak" && /^alice /i.test(a.data.content)), false);
});

test("a mention that is not an accusation gets no rules reply", async () => {
  const v = named();
  v.messages = v.messages.map((m) => (m.senderId === "p2" ? { ...m, content: "Me not me, look elsewhere" } : m));
  const out = await proposeSeatActions(v, { now: 20_000, maxRetries: 0, speechFirst: true, llmFallback: false, memory: false, complete: async () => "" });
  assert.equal(out.actions.some((a) => a.event === "speak" && /^alice /.test(a.data.content)), false);
});
