import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT } from "mafioso-engine";
import {
  beatsBaseline, defaultSeedPrompt, ensurePromptStore, evolvePrompt, finishGame, loadSeedPrompt,
  outcomeForView, recordOutcomes, selectPrompts, validateEvolvedPrompt, winRate,
  MIN_PROMPT_GAMES, REQUIRED_JSON_ACTIONS, buildEvolveBriefing,
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

test("prompt evolve rejects a candidate inside the noise and keeps one that clears it", async () => {
  const store = { prompts: [defaultSeedPrompt()] };
  const results = [{ promptId: "seed", outcome: "loss", role: "Mafioso" }];
  const complete = async () => JSON.stringify({ system: `${SYSTEM_PROMPT}\nPrefer a quiet vote.`, notes: "quieter" });
  const close = await finishGame({
    store, results, complete, now: 50, idFor: () => "child-close",
    scorePrompt: async ({ label }) => label === "candidate"
      ? { mean: 0.52, se: 0.05, games: 20, seed: 4 }
      : { mean: 0.5, se: 0.05, games: 20, seed: 4 },
  });
  assert.equal(beatsBaseline({ mean: 0.5, se: 0.05 }, { mean: 0.52, se: 0.05 }).accept, false);
  assert.equal(close.children.length, 0);
  assert.equal(close.skipped[0].reason, "does not beat baseline");
  assert.equal(close.store.prompts.length, 1);
  assert.equal(close.store.history.length, 1);
  assert.equal(close.store.history[0].accepted, false);
  assert.equal(close.store.history[0].baseline.seed, 4);
  assert.equal(close.store.history[0].candidate.seed, 4);
  assert.equal(close.store.prompts[0].scores.arena.mean, 0.5);

  const clear = await finishGame({
    store, results, complete, now: 60, idFor: () => "child-clear",
    scorePrompt: async ({ label }) => label === "candidate"
      ? { mean: 0.8, se: 0.02, games: 20, seed: 4 }
      : { mean: 0.4, se: 0.02, games: 20, seed: 4 },
  });
  assert.equal(beatsBaseline({ mean: 0.4, se: 0.02 }, { mean: 0.8, se: 0.02 }).accept, true);
  assert.equal(clear.children.length, 1);
  assert.equal(clear.children[0].id, "child-clear");
  assert.equal(clear.children[0].parentId, "seed");
  assert.equal(clear.children[0].scores.arena.mean, 0.8);
  assert.equal(clear.store.history[0].accepted, true);
  assert.ok(clear.store.history[0].diff > clear.store.history[0].noise);
  assert.equal(clear.store.prompts.some((prompt) => prompt.id === "child-clear"), true);
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

// Live run: an untried evolved prompt (p-mvciticw-0) read 0.5 against the seed's 0.39, so it was favoured,
// and it had a weaker JSON instruction ({"action":..., ...} without meeting/target/text).
test("an untried or barely played evolved prompt is never favoured over the seed", () => {
  const seed = { ...defaultSeedPrompt(), gamesPlayed: 18, scores: { wins: 7, losses: 11, draws: 0, byRole: {} } };
  const fresh = { ...defaultSeedPrompt(), id: "p-mvciticw-0", parentId: "seed", gamesPlayed: 0, scores: { wins: 0, losses: 0, draws: 0, byRole: {} } };
  const lucky = { ...fresh, id: "p-lucky", gamesPlayed: 2, scores: { wins: 2, losses: 0, draws: 0, byRole: {} } };
  const picks = selectPrompts({ prompts: [seed, fresh, lucky] }, 9, { epsilon: 0, temperature: 0, rng: () => 0.5 });
  assert.deepEqual([...new Set(picks.map((p) => p.id))], ["seed"]);
  // Once it has played enough and still beats the seed, it is preferred.
  const proven = { ...lucky, gamesPlayed: MIN_PROMPT_GAMES, scores: { wins: 4, losses: MIN_PROMPT_GAMES - 4, draws: 0, byRole: {} } };
  assert.equal(selectPrompts({ prompts: [seed, proven] }, 1, { epsilon: 0, temperature: 0, rng: () => 0.5 })[0].id, "p-lucky");
  // Exploration still seats untried prompts.
  assert.equal(selectPrompts({ prompts: [seed, fresh] }, 1, { epsilon: 1, temperature: 0, rng: cycle([0, 0.9]) })[0].id, "p-mvciticw-0");
});

test("an evolved prompt that drops the full JSON action schema is rejected; the evolve brief asks for the full line", () => {
  const schema = SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("Reply with ONE JSON object"));
  const weak = SYSTEM_PROMPT.replace(schema, `Reply with ONE JSON object and nothing else: {"action":${REQUIRED_JSON_ACTIONS}, ...}`);
  assert.equal(validateEvolvedPrompt(weak).reason, "missing full JSON action schema");
  assert.equal(validateEvolvedPrompt(SYSTEM_PROMPT.replace(schema, schema.replace(/,/g, ",\n  "))).ok, true, "reflowed whitespace is fine");
  assert.ok(buildEvolveBriefing({ parent: defaultSeedPrompt(), summary: "" }).includes(schema));
});
