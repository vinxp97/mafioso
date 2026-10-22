// Night 5 (Vinman 10/20) on the real harness table: the send-time guards (one Cop line with its report, never
// vt, no line breaks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, onGameEntry, drainUpgrades, createLlmLimiter, sendGuardBlock, COP_REPORT_WAIT_MS } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { createSeededRng } from "mafioso-engine";

const t0 = 1_700_000_000_000;
const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Hap" }, p4: { id: "p4", name: "Cal" }, p5: { id: "p5", name: "Dot" }, p6: { id: "p6", name: "Eve" } };

function seatTable(complete = async () => "who here has actually read anything yet", opts = {}) {
  const clock = createVirtualClock(t0);
  const table = createBotTable([{ accountId: "A" }], { clock, rng: createSeededRng(3), ...opts });
  let seq = 0;
  const feed = (event, data, t) => { if (t > clock.now()) clock.advance(t - clock.now()); return onGameEntry(table, { accountId: "A", seq: ++seq, t, event, data }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), now: t }); };
  return { table, clock, feed };
}
const village = { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p5", "p6", "*"], votes: {} };
const speech = (table) => table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil");

test("3: a Cop with no report yet holds its claim briefly so claim and report are one line", async () => {
  const { table, feed } = seatTable();
  await feed("self", "p1", t0); await feed("players", players, t0); await feed("roleReveal", { playerId: "p1", role: "Cop" }, t0);
  await feed("state", { id: 3, name: "Day 1" }, t0);
  await feed("meeting", village, t0);
  // The Sheriff outs at once (trigger for the Cop claim); the report lands 2s into the day.
  await feed("message", { meetingId: "vil", senderId: "p3", content: "im sheriff", t: t0 + 500 }, t0 + 500);
  await feed("message", { senderId: "server", content: "Your investigation shows that Cal is Guilty", t: t0 + 2_000 }, t0 + 2_000);
  await drainUpgrades(table);
  const cop = speech(table).filter((p) => /\bcop\b/.test(p.data.content) || /\b(guilty|inno)\b/.test(p.data.content));
  assert.equal(cop.length, 1, JSON.stringify(cop));
  assert.match(cop[0].data.content, /^im cop\. cal guilty$/i);
  assert.ok(cop[0].t - t0 <= COP_REPORT_WAIT_MS + 8_000);
});

test("3+5: the send guard blocks a line break, a vt, and a second same-day Cop line; logs the reason", () => {
  const view = { selfId: "p1", phase: { phase: "Day", name: "Day 1" }, players, meetings: { vil: village }, messages: [], role: "Cop" };
  const rejects = [];
  const table = { proposed: [{ accountId: "A", event: "speak", phase: "Day 1", data: { meetingId: "vil", content: "im cop. cal inno" } }], onSpeechReject: (id, r) => rejects.push(r[0]) };
  const p = (content) => ({ accountId: "A", event: "speak", data: { meetingId: "vil", content } });
  assert.equal(sendGuardBlock(table, "A", view, p("im cop\ncal inno"), "llm"), true);
  assert.equal(sendGuardBlock(table, "A", view, p("im vt"), "llm"), true);
  assert.equal(sendGuardBlock(table, "A", view, p("results: cal inno"), "llm"), true);
  assert.equal(sendGuardBlock(table, "A", view, p("dot is sus, vote dot"), "llm"), false);
  assert.deepEqual(rejects.map((r) => r.replace(/:.*/, "")), ["send guard", "send guard", "cop claim is one line (already claimed cop today)"]);
});
