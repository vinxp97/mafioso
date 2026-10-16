import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allies } from "mafioso-engine";
import { HostNotAllowedError } from "../src/client.js";
import { createArenaScorer, createMockComplete, readMetrics, runArena } from "../src/arena.js";

const FIELDS = [
  "seed", "game", "winner", "winRate", "mislynchRate", "townVoteAccuracy", "nightActionUsage",
  "checkUsefulness", "killPriorityAdherence", "illegal", "fallback", "seats", "speech",
];

test("an arena run with a mock model is reproducible and writes metrics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mafioso-arena-"));
  const opts = {
    games: 2, seed: 7, mafiosoSeats: 2, complete: createMockComplete(), maxDays: 3,
    outDir: dir, write: true, mode: "offline",
  };
  const first = await runArena(opts);
  const second = await runArena({ ...opts, file: "arena-7-again.jsonl" });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.length, 2);
  const saved = await readMetrics(path.join(dir, "arena-7.jsonl"));
  assert.equal(JSON.stringify(saved), JSON.stringify(first));
  for (const record of saved) {
    for (const field of FIELDS) assert.ok(Object.prototype.hasOwnProperty.call(record, field), field);
    assert.equal(record.seed, 7);
    assert.equal(record.setup, "Frontier Justice");
    assert.ok(["Village", "Mafia", "draw"].includes(record.winner));
    assert.equal(typeof record.winRate.byAlignment.Village.rate, "number");
    assert.equal(typeof record.winRate.byRole, "object");
    assert.ok("rate" in record.mislynchRate);
    assert.ok("rate" in record.townVoteAccuracy);
    assert.ok("rate" in record.nightActionUsage);
    assert.ok("rate" in record.checkUsefulness.cop);
    assert.ok("rate" in record.checkUsefulness.journalist);
    assert.ok("rate" in record.killPriorityAdherence);
    assert.equal(typeof record.illegal.proposed, "number");
    assert.equal(typeof record.illegal.blocked, "number");
    assert.equal(typeof record.fallback.candidate, "number");
    assert.equal(typeof record.fallback.llm, "number");
    assert.equal(typeof record.fallback.rules, "number");
    assert.ok(record.fallback.candidate + record.fallback.llm + record.fallback.rules > 0);
    assert.equal(record.seats.length, 9);
    for (const seat of record.seats) {
      assert.equal(typeof seat.messages, "number");
      assert.equal(typeof seat.messageRate, "number");
      assert.equal(typeof seat.speechAllowed, "number");
    }
    assert.ok(Array.isArray(record.speech));
    const blob = JSON.stringify(record);
    assert.equal(blob.includes("DEV_API_CLIENT_SECRET"), false);
    assert.equal(blob.includes("sk-"), false);
  }
});

test("seats do not share notes, and mafia plans stay out of town chat", async () => {
  const { views } = await runArena({
    games: 1, seed: 3, mafiosoSeats: 1, complete: createMockComplete(), maxDays: 2,
    write: false, keepViews: true,
  });
  const town = Object.values(views).find((view) => view.role === "Villager");
  const mafia = Object.values(views).find((view) => view.role === "Mafioso");
  assert.ok(town && mafia);
  assert.equal(allies(town).size, 0);
  assert.equal(town.messages.some((message) => String(message.content || "").startsWith("PLAN ")), false);
  assert.notEqual(town, mafia);
  assert.notEqual(town.notes, mafia.notes);
  assert.notEqual(town.ledger, mafia.ledger);
});

test("the live path refuses any host outside the dev allowlist and does not connect", async () => {
  let called = false;
  const fetch = async () => { called = true; throw new Error("network"); };
  await assert.rejects(
    () => runArena({ mode: "live", baseUrl: "https://ultimafia.gg", fetch, write: false, games: 1 }),
    HostNotAllowedError,
  );
  await assert.rejects(
    () => runArena({ mode: "live", baseUrl: "https://www.ultimafia.com", fetch, write: false }),
    HostNotAllowedError,
  );
  await assert.rejects(
    () => runArena({ mode: "live", baseUrl: "https://dev.ultimafia.gg", lobby: "Ranked", fetch, write: false }),
    /Testing/,
  );
  await assert.rejects(
    () => runArena({ mode: "live", baseUrl: "https://dev.ultimafia.gg", private: false, fetch, write: false }),
    /private/,
  );
  await assert.rejects(
    () => runArena({ mode: "live", baseUrl: "https://dev.ultimafia.gg", fetch, write: false, games: 1 }),
    /does not open a live socket/,
  );
  await assert.rejects(
    () => runArena({ mode: "live", baseUrl: "http://127.0.0.1:3000", fetch, lobby: "Testing", private: true, write: false }),
    /does not open a live socket/,
  );
  assert.equal(called, false);
});

test("arena scores for one seed stay put", async () => {
  const score = createArenaScorer({ seed: 11, games: 1, mafiosoSeats: 1, complete: createMockComplete(), maxDays: 2 });
  const first = await score({ prompt: { text: "baseline" }, label: "baseline" });
  const second = await score({ prompt: { text: "baseline" }, label: "baseline" });
  assert.equal(first.seed, 11);
  assert.equal(first.games, 1);
  assert.equal(first.mean, second.mean);
  assert.equal(first.se, second.se);
  assert.equal(Number.isFinite(first.mean), true);
});
