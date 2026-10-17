// One log record per parsed Cop / Journalist / Janitor result reaching a seat, so live parsing is verifiable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, onGameEntry } from "../src/live.js";

test("onGameEntry reports each parsed alert result once, and nothing for chat", async () => {
  const table = createBotTable([{ accountId: "A" }]);
  const seen = [];
  table.onAlert = (who, r) => seen.push({ who, kind: r.kind, target: r.target, result: r.result });
  const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Bea" }, p3: { id: "p3", name: "Cal" } };
  let seq = 0;
  const feed = (event, data) => onGameEntry(table, { accountId: "A", seq: ++seq, event, data }, { dryRun: true });
  await feed("self", "p1"); await feed("players", players); await feed("roleReveal", { playerId: "p1", role: "Cop" });
  await feed("state", { id: 2, name: "Night 1" });
  await feed("message", { senderId: "server", content: ":invest: After investigating, you learn that Bea is Mafia!" });
  await feed("message", { senderId: "p3", content: ":invest: After investigating, you learn that Bea is Mafia!" });
  assert.deepEqual(seen, [{ who: "A", kind: "cop", target: "Bea", result: "Mafia" }]);
});
