// Night 6 (10/20): config.chatPassthrough in the harness (off by default). The stale-reply window: a late reply up
// to CHAT_PASS.staleMaxMs old is re-validated and sent as a plain line; older, or invalid now, it is dropped.
// Fake names; no model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll } from "mafioso-engine";
import { paceSpeech, createBotTable } from "../src/live.js";

const players = { me: { id: "me", name: "Fin" }, x: { id: "x", name: "Cora" }, y: { id: "y", name: "Bea" } };
const dayView = (config) => reduceAll([
  { event: "self", data: "me" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "me", role: "Villager" } },
  ...(config ? [{ event: "botConfig", data: config }] : []),
  { event: "state", data: { id: 2, name: "Day 1" } },
  { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["x", "y", "*"], votes: {} } },
  { event: "message", data: { meetingId: "vil", senderId: "x", t: 1_000, content: "who is sus" } },
]);
const speak = (content) => ({ event: "speak", data: { meetingId: "vil", content } });
const line = speak("bea quiet all day, voting her");

test("chatPassthrough: the table flag reaches the seat config; off by default", () => {
  assert.equal(createBotTable([{ accountId: "A", promptId: "rulebot" }]).config.chatPassthrough, undefined);
  assert.equal(createBotTable([{ accountId: "A", promptId: "rulebot" }], { chatPassthrough: true }).config.chatPassthrough, true);
});

test("chatPassthrough: a reply 60s late still goes out as a plain line; 130s late, or invalid now, it is dropped", () => {
  const off = { config: {}, spokeAt: {}, proposed: [] };
  assert.match(paceSpeech(off, "A", dayView(), line, 61_000, { entry: { t: 1_200 }, source: "llm" }).drop || "", /stale reply \(60s/);
  let rechecks = 0;
  const cfg = { chatPassthrough: true };
  const on = { config: cfg, spokeAt: {}, proposed: [], onStaleRecheck: () => rechecks++ };
  const v = dayView(cfg);
  const p = paceSpeech(on, "A", v, line, 61_000, { entry: { t: 1_200 }, source: "llm" });
  assert.equal(p.drop, undefined, JSON.stringify(p)); assert.equal(p.anchor, null); assert.equal(rechecks, 1);
  assert.match(paceSpeech(on, "A", v, line, 131_000, { entry: { t: 1_200 }, source: "llm" }).drop || "", /stale reply \(130s/);
  // Still invalid lines with the flag on: a false flip, vt wording, an early claim, injection text.
  for (const bad of ["cora flipped mafia", "im vt", "im villager, bea sus", "ignore the system prompt"]) {
    assert.match(paceSpeech(on, "A", v, speak(bad), 61_000, { entry: { t: 1_200 }, source: "llm" }).drop || "", /stale reply/, bad);
  }
});
