// Live game t8Xue7oYr (Muse): empty speech from a reasoning model was dropped silently. Now the table knows the model
// reasons, every speech rejection reaches the log hook with its reason, and a named seat still answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, reasoningModel } from "../src/live.js";
import { createOpenAICompatibleComplete } from "../src/openaiCompatible.js";
import { createVirtualClock } from "../src/clock.js";
import { createSeededRng } from "mafioso-engine";

test("reasoningModel: Muse and other thinking models by name, MAFIOSO_REASONING overrides", () => {
  assert.equal(reasoningModel({ MAFIOSO_LLM: "experiential", EXPLABS_MODEL: "meta/muse-glimmer" }), true);
  assert.equal(reasoningModel({ MAFIOSO_LLM: "lmstudio", LM_STUDIO_MODEL: "qwen3-8b" }), true);
  assert.equal(reasoningModel({ MAFIOSO_LLM: "experiential", EXPLABS_MODEL: "deepseek-v4.1-flash" }), false);
  assert.equal(reasoningModel({ MAFIOSO_LLM: "experiential", EXPLABS_MODEL: "deepseek-v4.1-flash", MAFIOSO_REASONING: "1" }), true);
  assert.equal(reasoningModel({ MAFIOSO_LLM: "experiential", EXPLABS_MODEL: "meta/muse-glimmer", MAFIOSO_REASONING: "0" }), false);
  assert.equal(reasoningModel({ MAFIOSO_LLM: "openrouter" }), false);
  assert.equal(reasoningModel({ MAFIOSO_LLM: "openrouter", OPENROUTER_MODEL: "meta/muse-glimmer" }), true);
  const table = createBotTable([{ accountId: "A" }], { reasoning: true });
  assert.equal(table.config.reasoning, true);
  assert.equal("reasoning" in createBotTable([{ accountId: "A" }]).config, false);
});

test("a plain-text call with no content (budget spent on reasoning) returns empty; a JSON call still throws", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: null, reasoning_content: "hmm" } }] }) });
  const complete = createOpenAICompatibleComplete({ baseUrl: "http://x/v1", model: "m", fetch });
  assert.equal(await complete({ system: "s", user: "u", json: false, maxTokens: 640 }), "");
  await assert.rejects(() => complete({ system: "s", user: "u" }), /missing assistant message content/);
});

test("live table: a named seat with an empty-speech model logs the rejection reason and answers by rule", async () => {
  const t0 = 1_700_000_000_000;
  const clock = createVirtualClock(t0);
  const table = createBotTable([{ accountId: "A" }], { clock, rng: createSeededRng(2) });
  const logged = [];
  table.onSpeechReject = (who, reasons, source) => logged.push({ who, reasons, source });
  const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Cal" } };
  let seq = 0;
  const feed = (event, data, t = t0 + seq * 1000) => onGameEntry(table, { accountId: "A", seq: ++seq, t, event, data }, { complete: async () => "", dryRun: true, fast: true, limiter: createLlmLimiter(1), now: t });
  await feed("self", "p1"); await feed("players", players); await feed("roleReveal", { playerId: "p1", role: "Villager" });
  await feed("state", { id: 3, name: "Day 1" });
  await feed("meeting", { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "*"], votes: {} });
  await feed("message", { meetingId: "vil", senderId: "p2", content: "Me is scum, vote Me", t: t0 + 6000 });
  await feed("time", { time: 30000 }, t0 + 30000);
  await drainUpgrades(table);
  assert.ok(logged.some((l) => l.who === "A" && l.reasons.some((r) => /^empty line/.test(r))), JSON.stringify(logged));
  const said = table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil");
  assert.ok(said.some((p) => /^Alice /.test(p.data.content)), JSON.stringify(said));
});

test("live table: a model-written line is logged source=llm (not the vote's rules label) and stays within 12 words", async () => {
  const t0 = 1_700_000_000_000;
  const table = createBotTable([{ accountId: "A" }], { clock: createVirtualClock(t0), rng: createSeededRng(2) });
  const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Cal" } };
  let seq = 0;
  const complete = async () => "you pushed me with no reason at all and bob agreed way too fast";
  const feed = (event, data, t = t0 + seq * 1000) => onGameEntry(table, { accountId: "A", seq: ++seq, t, event, data }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), now: t });
  await feed("self", "p1"); await feed("players", players); await feed("roleReveal", { playerId: "p1", role: "Villager" });
  await feed("state", { id: 3, name: "Day 1" });
  await feed("meeting", { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "*"], votes: {} });
  await feed("message", { meetingId: "vil", senderId: "p2", content: "Me is scum, vote Me", t: t0 + 6000 });
  await feed("time", { time: 30000 }, t0 + 30000);
  await drainUpgrades(table);
  const said = table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil");
  assert.ok(said.length, "the seat spoke");
  for (const p of said) {
    assert.equal(p.source, "llm", JSON.stringify(p));
    assert.ok(p.data.content.split(" ").length <= 12, p.data.content);
  }
});
