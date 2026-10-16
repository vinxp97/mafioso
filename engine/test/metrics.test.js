import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreGame, summarizeMetrics } from "../src/index.js";

const mislynchGame = {
  seed: 1,
  game: 0,
  winner: "Mafia",
  seats: [
    { id: "p1", role: "Villager", alignment: "Village", kind: "rule", messages: 2, dayPhases: 2, speechAllowed: 1, speechSent: 1, won: false },
    { id: "p2", role: "Cop", alignment: "Village", kind: "rule", messages: 1, dayPhases: 2, speechAllowed: 1, speechSent: 1, won: false },
    { id: "p3", role: "Mafioso", alignment: "Mafia", kind: "mafioso", messages: 0, dayPhases: 2, speechAllowed: 0, speechSent: 0, won: true },
    { id: "p4", role: "Sheriff", alignment: "Village", kind: "rule", messages: 1, dayPhases: 1, speechAllowed: 1, speechSent: 0, won: false },
  ],
  lynches: [{ targetRole: "Villager", targetAlignment: "Village" }],
  townVotes: [
    { targetAlignment: "Mafia" },
    { targetAlignment: "Village" },
    { targetAlignment: "Mafia" },
  ],
  nightActions: [
    { open: true, taken: true },
    { open: true, taken: true },
    { open: true, taken: false },
  ],
  checks: [
    { actorRole: "Cop", targetAlignment: "Mafia", targetRole: "Mafioso" },
    { actorRole: "Cop", targetAlignment: "Village", targetRole: "Villager" },
    { actorRole: "Journalist", targetRole: "Cop" },
    { actorRole: "Journalist", targetRole: "Villager" },
  ],
  kills: [
    { targetRole: "Cop", living: ["Cop", "Sheriff", "Journalist", "Villager"] },
    { targetRole: "Villager", living: ["Sheriff", "Journalist", "Villager"] },
  ],
  decisions: [
    { source: "selector" },
    { source: "llm" },
    { source: "fallback" },
    { source: "rules" },
  ],
  illegal: { proposed: 3, blocked: 2 },
  speech: [{ seat: "p2", phase: "Day 1", text: "Bot3 is sided with the Mafia.", allowed: true }],
};

test("fixture metrics: a mislynch and a correct town vote", () => {
  const scored = scoreGame(mislynchGame);
  assert.equal(scored.winner, "Mafia");
  assert.equal(scored.winRate.byAlignment.Mafia.rate, 1);
  assert.equal(scored.winRate.byAlignment.Village.rate, 0);
  assert.equal(scored.winRate.byAlignment.Mafia.trials, 1);
  assert.equal(scored.winRate.byRole.Mafioso.rate, 1);
  assert.equal(scored.winRate.byRole.Cop.rate, 0);
  assert.equal(scored.winRate.byRole.Villager.trials, 1);
  assert.equal(scored.mislynchRate.rate, 1);
  assert.equal(scored.mislynchRate.successes, 1);
  assert.equal(scored.townVoteAccuracy.rate, 2 / 3);
  assert.equal(scored.townVoteAccuracy.successes, 2);
  assert.equal(scored.townVoteAccuracy.trials, 3);
  assert.equal(scored.nightActionUsage.rate, 2 / 3);
  assert.equal(scored.checkUsefulness.cop.rate, 0.5);
  assert.equal(scored.checkUsefulness.journalist.rate, 0.5);
  assert.equal(scored.killPriorityAdherence.rate, 0.5);
  assert.equal(scored.illegal.proposed, 3);
  assert.equal(scored.illegal.blocked, 2);
  assert.deepEqual(
    { candidate: scored.fallback.candidate, llm: scored.fallback.llm, rules: scored.fallback.rules, rate: scored.fallback.rate },
    { candidate: 1, llm: 1, rules: 2, rate: 0.75 },
  );
  assert.equal(scored.seats.find((seat) => seat.id === "p1").messageRate, 1);
  assert.equal(scored.seats.find((seat) => seat.id === "p2").messageRate, 0.5);
  assert.equal(scored.speech[0].text, "Bot3 is sided with the Mafia.");
  assert.equal(scored.speech[0].seat, "p2");
});

test("a correct lynch of scum is not a mislynch and town votes on scum count", () => {
  const scored = scoreGame({
    winner: "Village",
    seats: [
      { id: "p1", role: "Villager", alignment: "Village", kind: "rule", messages: 0, dayPhases: 1, won: true },
      { id: "p3", role: "Mafioso", alignment: "Mafia", kind: "mafioso", messages: 0, dayPhases: 1, won: false },
    ],
    lynches: [{ targetRole: "Mafioso", targetAlignment: "Mafia" }],
    townVotes: [{ targetAlignment: "Mafia" }, { targetAlignment: "Mafia" }],
    kills: [{ targetRole: "Villager", living: ["Villager", "Mafioso"] }],
  });
  assert.equal(scored.mislynchRate.rate, 0);
  assert.equal(scored.townVoteAccuracy.rate, 1);
  assert.equal(scored.winRate.byAlignment.Village.rate, 1);
  assert.equal(scored.killPriorityAdherence.rate, null);
  assert.equal(scored.killPriorityAdherence.trials, 0);
});

test("summary pools games and reports a confidence interval", () => {
  const correct = scoreGame({
    winner: "Village",
    seats: [{ id: "a", role: "Cop", alignment: "Village", kind: "rule", messages: 1, dayPhases: 1, won: true }],
    lynches: [{ targetAlignment: "Mafia", targetRole: "Mafioso" }],
    townVotes: [{ targetAlignment: "Mafia" }],
    nightActions: [{ open: true, taken: true }],
    checks: [{ actorRole: "Cop", targetAlignment: "Mafia", targetRole: "Mafioso" }],
    kills: [{ targetRole: "Cop", living: ["Cop"] }],
    decisions: [{ source: "selector" }],
    illegal: { proposed: 1, blocked: 1 },
    speech: [{ seat: "a", phase: "Day 1", text: "Voting Bot3.", allowed: true }],
  });
  const summary = summarizeMetrics([scoreGame(mislynchGame), correct]);
  assert.equal(summary.games, 2);
  assert.equal(summary.mislynchRate.successes, 1);
  assert.equal(summary.mislynchRate.trials, 2);
  assert.equal(summary.mislynchRate.rate, 0.5);
  assert.ok(summary.mislynchRate.low <= summary.mislynchRate.rate);
  assert.ok(summary.mislynchRate.high >= summary.mislynchRate.rate);
  assert.equal(summary.townVoteAccuracy.successes, 3);
  assert.equal(summary.townVoteAccuracy.trials, 4);
  assert.equal(summary.winRate.byAlignment.Mafia.successes, 1);
  assert.equal(summary.winRate.byAlignment.Mafia.trials, 2);
  assert.equal(summary.killPriorityAdherence.rate, 2 / 3);
  assert.equal(summary.fallback.candidate, 2);
  assert.equal(summary.fallback.llm, 1);
  assert.equal(summary.fallback.rules, 2);
  assert.equal(summary.illegal.proposed, 4);
  assert.equal(summary.illegal.blocked, 3);
  assert.ok(summary.messageRate.n >= 2);
  assert.equal(summary.speechAllowed, 2);
});
