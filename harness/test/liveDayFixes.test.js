// Speech floor, day openers, and scorecard fields for the live-day fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySpeechFloor, createBotTable, drainUpgrades, onGameEntry, paceSpeech, DAY_SPEECH, SPEECH_FLOOR, SPEECH_PACE } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { buildScorecard } from "../src/selfplay.js";
import { reduceAll, validateAction } from "mafioso-engine";

const players = { p1: { id: "p1", name: "Ash" }, p2: { id: "p2", name: "Bea" } };

test("a seat blocked over and over still gets a short valid line, up to a few per day", () => {
  const view = reduceAll([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 4, name: "Day 2" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "*"], votes: {} } },
  ]);
  const table = createBotTable([{ accountId: "A" }], { pace: "off" });
  table.views.A = view;
  assert.equal(applySpeechFloor(table, "A", view), null);
  table.speechBlocks = { "A|Day 2": SPEECH_FLOOR.blockStreak };
  const line = applySpeechFloor(table, "A", view);
  assert.ok(SPEECH_FLOOR.lines.includes(line.data.content), line.data.content);
  assert.equal(validateAction(view, line).ok, true);
  table.daySaid = { "A|Day 2": SPEECH_FLOOR.minLines };
  assert.equal(applySpeechFloor(table, "A", view), null, "the daily floor is met");
  const stale = { event: "speak", data: { meetingId: "vil", content: "watching the votes" } };
  table.speechBlocks = { "A|Day 2": 1 };
  table.daySaid = { "A|Day 2": 0 };
  view.messages = [{ meetingId: "vil", senderId: "p2", content: "hi", t: 1_000 }];
  assert.equal(paceSpeech(table, "A", view, stale, 40_000, { entry: { t: 1_200 }, source: "llm" }).drop, undefined);
});

test("scorecard reports tie no-lynches and autoloss-by-tie, and tolerates older stats", () => {
  const stats = { townBallots: [], voteOrder: [], lynches: [], noLynchDays: 1, tieNoLynch: 2, autolossByTie: 1, shots: [], kills: [], cleans: 0, litigates: [], copChecks: [], journalistChecks: [], claims: [], buses: [], vegs: [], scumChat: 0, publicLines: 0, illegal: [], copGuiltyFollowUp: [], dayOutcomes: [], killVoteMoves: [] };
  const card = buildScorecard([{ game: 0, seed: 1, winner: "Mafia", error: null, days: 2, minutes: 1, harnessErrors: 0, record: { winner: "Mafia" }, log: [], stats }], { seed: 1, games: 1 });
  assert.equal(card.lynches.tieNoLynch, 2);
  assert.equal(card.lynches.autolossByTie, 1);
  const bare = { ...stats, tieNoLynch: undefined, autolossByTie: undefined };
  const card2 = buildScorecard([{ game: 0, seed: 1, winner: "Village", error: null, days: 1, minutes: 1, harnessErrors: 0, record: { winner: "Village" }, log: [], stats: bare }], { seed: 1, games: 1 });
  assert.equal(card2.lynches.tieNoLynch, 0);
  assert.equal(card2.lynches.autolossByTie, 0);
});

test("each living seat opens the day within 20s, and a quiet day does not stay silent", async () => {
  const clock = createVirtualClock(0);
  const table = createBotTable([{ accountId: "A" }, { accountId: "B" }], { clock, rng: () => 0 });
  const people = { p1: { id: "p1", name: "Ash" }, p2: { id: "p2", name: "Bea" } };
  const seq = { A: 0, B: 0 };
  const feed = async (id, event, data, t) => {
    if (t > clock.now()) clock.advance(t - clock.now());
    seq[id] += 1;
    return onGameEntry(table, { accountId: id, seq: seq[id], t, event, data }, { dryRun: true, fast: true });
  };
  for (const [id, pid, role] of [["A", "p1", "Villager"], ["B", "p2", "Villager"]]) {
    await feed(id, "self", pid, 0);
    await feed(id, "players", people, 0);
    await feed(id, "roleReveal", { playerId: pid, role }, 0);
    await feed(id, "state", { id: 2, name: "Day 1" }, 0);
    await feed(id, "meeting", { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "*"], votes: {} }, 0);
  }
  for (let step = 5_000; step <= DAY_SPEECH.openWithinMs; step += 5_000) {
    await feed("A", "time", { time: 1 }, step);
    await feed("B", "time", { time: 1 }, step);
    await drainUpgrades(table);
  }
  const lines = table.proposed.filter((p) => p.event === "speak" && p.data?.meetingId === "vil").sort((a, b) => a.t - b.t);
  assert.ok(lines.some((p) => p.accountId === "A"), JSON.stringify(lines));
  assert.ok(lines.some((p) => p.accountId === "B"), JSON.stringify(lines));
  for (const p of lines) assert.ok(p.t <= DAY_SPEECH.openWithinMs + SPEECH_PACE.tableGapMs, `${p.accountId} at ${p.t}`);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].t - lines[i - 1].t >= SPEECH_PACE.tableGapMs - 1, `${lines[i].t - lines[i - 1].t}ms`);
  const before = lines.length;
  const quietAt = Math.max(...lines.map((p) => p.t)) + DAY_SPEECH.silenceMs;
  clock.advance(Math.max(0, quietAt - clock.now()));
  await feed("A", "time", { time: 1 }, clock.now());
  await feed("B", "time", { time: 1 }, clock.now());
  await drainUpgrades(table);
  const later = table.proposed.filter((p) => p.event === "speak" && p.data?.meetingId === "vil" && p.t >= quietAt - 1);
  assert.ok(later.length >= 1, "a day with two alive seats speaks again after the silence window");
  assert.equal(later[0].accountId, "A");
  assert.ok(later[0].source === "day-speech" || String(later[0].source || "").includes("day-speech"));
  assert.ok(table.proposed.filter((p) => p.event === "speak").length > before);
});
