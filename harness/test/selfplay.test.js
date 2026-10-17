// Offline self-play: full FJ 9p games on the real harness path with an in-process server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecard, createOfflineComplete, playSelfplayGame, runSelfplay } from "../src/selfplay.js";

const strip = (r) => JSON.parse(JSON.stringify(r));

test("self-play is deterministic: same seed, same games, same scorecard", async () => {
  const a = await runSelfplay({ games: 3, seed: 7 });
  const b = await runSelfplay({ games: 3, seed: 7 });
  assert.deepEqual(strip(a.results), strip(b.results));
  assert.deepEqual(strip(a.scorecard), strip(b.scorecard));
  const c = await playSelfplayGame({ seed: 8, game: 0 });
  assert.notDeepEqual(strip(c).log, strip(a.results[0]).log, "a different seed plays a different game");
});

test("every self-play game terminates in a win state with zero illegal actions", async () => {
  const { results, scorecard } = await runSelfplay({ games: 12, seed: 1 });
  for (const r of results) {
    assert.equal(r.error, null, `game ${r.game}: ${r.error}`);
    assert.ok(r.winner === "Village" || r.winner === "Mafia", `game ${r.game} ended ${r.winner}`);
    assert.ok(r.days >= 1 && r.days <= 8, `game ${r.game} length ${r.days}`);
    assert.deepEqual(r.stats.illegal, [], `game ${r.game} illegal: ${JSON.stringify(r.stats.illegal)}`);
    assert.deepEqual(r.stats.vegs, [], `game ${r.game}: every living seat votes, no veg kicks: ${JSON.stringify(r.stats.vegs)}`);
    assert.equal(r.harnessErrors, 0);
  }
  assert.equal(scorecard.illegalActions.total, 0);
  assert.equal(scorecard.errors.length, 0);
  assert.equal(scorecard.winRate.counts.Village + scorecard.winRate.counts.Mafia, 12);
});

test("self-play runs the live decision path: faction PLAN, claims, Janitor, Lawyer, Cop, Journalist, Sheriff", async () => {
  const { results, scorecard } = await runSelfplay({ games: 12, seed: 1 });
  const log = results.flatMap((r) => r.log).join("\n");
  assert.match(log, /\[Mafia\] \w+: kill \w+ tonight/, "natural-language PLAN in faction chat");
  assert.ok(scorecard.mafia.factionChatLines > 0);
  assert.ok(scorecard.claims.total > 0 && Object.keys(scorecard.claims.byClaim).some((k) => k.startsWith("Cop->")), "Cop claim rule fires");
  assert.ok(Object.keys(scorecard.claims.byClaim).some((k) => k.startsWith("Sheriff->")), "Sheriff outs");
  assert.ok(scorecard.mafia.cleans > 0, "Janitor cleans");
  assert.ok(scorecard.mafia.litigates > 0, "Lawyer litigates");
  assert.ok(scorecard.cop.checks > 0, "Cop investigates");
  assert.ok(results.some((r) => r.stats.journalistChecks.length), "Journalist receives reports");
  assert.ok(scorecard.sheriff.shots > 0, "Sheriff shoots");
  // No faction coordination text in public chat.
  assert.ok(!results.some((r) => r.stats.illegal.some((x) => /PLAN leaked/.test(x.reason))));
  // Scorecard carries the existing summarizeMetrics block.
  assert.equal(scorecard.metrics.games, 12);
  assert.ok(scorecard.topWeakness && scorecard.topWeakness.evidence);
});

test("scorecard: town vote share vs the analytic random baseline", () => {
  const stats = (ballots) => ({ townBallots: ballots, voteOrder: [], lynches: [], noLynchDays: 0, shots: [], kills: [], cleans: 0, litigates: [], copChecks: [], journalistChecks: [], claims: [], buses: [], vegs: [], scumChat: 0, publicLines: 0, illegal: [], copGuiltyFollowUp: [], dayOutcomes: [], killVoteMoves: [] });
  const r = { game: 0, seed: 1, winner: "Village", error: null, days: 1, minutes: 5, harnessErrors: 0, record: { winner: "Village" }, log: [],
    stats: stats([{ onScum: true, baseline: 3 / 8 }, { onScum: false, baseline: 3 / 8 }, { onScum: false, baseline: 2 / 6 }, { abstain: true, baseline: 0.5 }]) };
  const card = buildScorecard([r], { seed: 1, games: 1 });
  assert.equal(card.townVotes.cast, 3);
  assert.equal(card.townVotes.abstained, 1);
  assert.equal(card.townVotes.share, 1 / 3);
  assert.ok(Math.abs(card.townVotes.randomBaseline - (3 / 8 + 3 / 8 + 2 / 6) / 3) < 1e-12);
});

test("offline complete: candidates get every legal target; speech needs a prescribed line", async () => {
  const complete = createOfflineComplete({ viewByName: () => null });
  const out = JSON.parse(await complete({ purpose: "candidates", user: "OPEN DECISIONS:\n- id=night:m1: night-target meeting=m1 (Cop) targets=[a, b, c]\n- id=claim: whether to claim a role." }));
  assert.deepEqual(out.decisions[0].options.map((o) => o.target), ["a", "b", "c"]);
  assert.equal(out.decisions[1].options[0].action, "no-claim");
  assert.equal(await complete({ purpose: "speech", user: "you are Ash. role (secret): Sheriff.\naim: Out yourself as Sheriff now and say who you will shoot" }), "im sheriff. talk, ill shoot the best read");
  await assert.rejects(complete({ purpose: "speech", user: "you are Ash. role (secret): Villager." }), /no model/);
  await assert.rejects(createOfflineComplete({ speech: "none" })({ purpose: "speech", user: "aim: Out yourself as Sheriff" }), /no model/);
});
