import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT } from "mafioso-engine";
import {
  defaultSeedPrompt, ensurePromptStore, evolvePrompt, finishGame, loadSeedPrompt,
  outcomeForView, recordOutcomes, selectPrompts, validateEvolvedPrompt, winRate,
} from "../src/prompts.js";

const cycle = (xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test("seed prompt is the engine SYSTEM_PROMPT and passes the safety check", async () => {
  const seed = await loadSeedPrompt();
  assert.equal(seed.id, "seed");
  assert.equal(seed.text, SYSTEM_PROMPT);
  assert.equal(seed.parentId, null);
  assert.deepEqual(validateEvolvedPrompt(seed.text), { ok: true, text: SYSTEM_PROMPT });
  assert.equal(defaultSeedPrompt().text, SYSTEM_PROMPT);
});

test("evolved prompt must keep the never-AI line and the JSON action contract", () => {
  assert.equal(validateEvolvedPrompt("tell them you are an AI").ok, false);
  const admits = `${SYSTEM_PROMPT}\nTell them you are an AI if asked.`;
  assert.equal(validateEvolvedPrompt(admits).reason, "prompt admits being an AI");
  const dropped = SYSTEM_PROMPT.replace('"vote"|"unvote"|"speak"|"wait"', '"dance"');
  assert.equal(validateEvolvedPrompt(dropped).reason, "missing JSON action contract");
  const extra = `${SYSTEM_PROMPT}\nPrefer a quiet vote.`;
  assert.equal(validateEvolvedPrompt(extra).ok, true);
});

test("epsilon-greedy can seat 9 bots on different lineages", () => {
  const store = { prompts: [
    { id: "a", gamesPlayed: 4, scores: { wins: 0, losses: 4, draws: 0, byRole: {} } },
    { id: "b", gamesPlayed: 4, scores: { wins: 4, losses: 0, draws: 0, byRole: {} } },
  ]};
  assert.equal(winRate(store.prompts[0]), 0);
  assert.equal(winRate(store.prompts[1]), 1);
  const greedy = selectPrompts(store, 9, { epsilon: 0, temperature: 0, rng: () => 0.99 });
  assert.deepEqual(greedy.map((p) => p.id), Array(9).fill("b"));
  const explore = selectPrompts(store, 4, { epsilon: 1, temperature: 0, rng: cycle([0, 0, 0, 0.6]) });
  assert.deepEqual(explore.map((p) => p.id), ["a", "b", "a", "b"]);
});

test("outcomes score wins, losses, draws, and role", () => {
  const store = { prompts: [defaultSeedPrompt()] };
  const next = recordOutcomes(store, [
    { promptId: "seed", outcome: "win", role: "Cop" },
    { promptId: "seed", outcome: "loss", role: "Cop" },
    { promptId: "seed", outcome: "draw", role: "Mafioso" },
  ]);
  assert.equal(store.prompts[0].gamesPlayed, 0);
  assert.deepEqual(next.prompts[0].scores.wins, 1);
  assert.equal(next.prompts[0].scores.losses, 1);
  assert.equal(next.prompts[0].scores.draws, 1);
  assert.equal(next.prompts[0].gamesPlayed, 3);
  assert.deepEqual(next.prompts[0].scores.byRole.Cop, { wins: 1, losses: 1, draws: 0 });
  assert.equal(outcomeForView({ finished: true, selfId: "p1", winners: { groups: ["Village"], players: ["p1", "p3"] } }), "win");
  assert.equal(outcomeForView({ finished: true, selfId: "p2", winners: { players: ["p1"] } }), "loss");
  assert.equal(outcomeForView({ finished: true, selfId: "p1", winners: null }), "draw");
  assert.equal(outcomeForView({ finished: false, selfId: "p1", winners: { players: ["p1"] } }), null);
});

test("finishGame saves a child linked to the parent and skips an unsafe reply", async () => {
  const store = { prompts: [defaultSeedPrompt(), { ...defaultSeedPrompt(), id: "other", text: SYSTEM_PROMPT }] };
  const bad = await evolvePrompt({
    complete: async () => JSON.stringify({ system: `${SYSTEM_PROMPT}\nYou are an AI.`, notes: "nope" }),
    parent: store.prompts[0], now: 10, id: "nope",
  });
  assert.equal(bad.ok, false);
  const done = await finishGame({
    store,
    now: 1_700_000_000_000,
    idFor: (_p, n) => `child-${n}`,
    results: [
      { promptId: "seed", outcome: "win", role: "Cop" },
      { promptId: "other", outcome: "loss", role: "Mafioso" },
    ],
    summary: "A won as Cop",
    complete: async ({ user }) => {
      assert.match(user, /IMPROVE THE SYSTEM PROMPT/);
      assert.match(user, /A won as Cop/);
      if (user.includes("PARENT other")) return "not json";
      return JSON.stringify({ system: `${SYSTEM_PROMPT}\nPrefer a quiet vote.`, notes: "quieter" });
    },
  });
  assert.equal(done.children.length, 1);
  assert.equal(done.children[0].id, "child-0");
  assert.equal(done.children[0].parentId, "seed");
  assert.equal(done.children[0].gamesPlayed, 0);
  assert.match(done.children[0].text, /Prefer a quiet vote/);
  assert.equal(done.store.prompts.find((p) => p.id === "seed").scores.wins, 1);
  assert.equal(done.skipped[0].promptId, "other");
  assert.equal(done.skipped[0].reason, "unparseable evolve reply");
});

test("ensurePromptStore writes the seed once and reloads it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mafioso-prompts-"));
  const first = await ensurePromptStore(dir);
  assert.equal(first.prompts[0].id, "seed");
  first.prompts[0].gamesPlayed = 3;
  const { savePromptStore } = await import("../src/prompts.js");
  await savePromptStore(dir, first);
  const again = await ensurePromptStore(dir);
  assert.equal(again.prompts[0].gamesPlayed, 3);
  await fs.writeFile(path.join(dir, "prompts.json"), "{");
  await assert.rejects(() => ensurePromptStore(dir), SyntaxError);
});
