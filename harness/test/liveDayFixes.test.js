// Speech floor and scorecard fields for the live-day fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySpeechFloor, createBotTable, paceSpeech, SPEECH_FLOOR } from "../src/live.js";
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
