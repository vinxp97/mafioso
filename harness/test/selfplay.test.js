// Offline self-play: full FJ 9p games on the real harness path with an in-process server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable } from "../src/live.js";
import { buildScorecard, createOfflineComplete, mafiaKillTarget, playSelfplayGame, runSelfplay } from "../src/selfplay.js";

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

test("copRule reaches every seat's view, and the CLI-level option is recorded on the scorecard", async () => {
  for (const copRule of ["vinman", "wait"]) {
    const r = await playSelfplayGame({ seed: 3, game: 0, copRule, keepServer: true });
    const views = Object.values(r.server.table.views);
    assert.ok(views.length === 9 && views.every((v) => v.config?.copRule === copRule), copRule);
  }
  const plain = await playSelfplayGame({ seed: 3, game: 0, lawyer: "plain", keepServer: true });
  assert.ok(Object.values(plain.server.table.views).every((v) => v.config?.lawyer === "plain"), "the town's reads know a plain Lawyer can frame");
  const { scorecard } = await runSelfplay({ games: 1, seed: 3, copRule: "wait" });
  assert.equal(scorecard.copRule, "wait");
  assert.equal(scorecard.lawyer, "loyal");
});

test("Loyal Lawyer (FJ): Litigate on a town player is blocked, so every Cop Guilty is true", async () => {
  const { results } = await runSelfplay({ games: 12, seed: 2 });
  const checks = results.flatMap((r) => r.stats.copChecks);
  assert.ok(checks.some((c) => c.result === "Guilty"));
  assert.ok(checks.filter((c) => c.result === "Guilty").every((c) => c.correct), "no false Guilty under a Loyal Lawyer");
  assert.ok(checks.filter((c) => !c.correct).every((c) => c.result === "Innocent" && c.litigated), "only lawyered Innocents are wrong");
  for (const l of results.flatMap((r) => r.stats.litigates)) assert.equal(l.blocked, !l.teammate);
});

test("the offline server tallies the Mafia Kill like Meeting.js: a no-kill ballot counts, a tie kills nobody", () => {
  assert.equal(mafiaKillTarget({ m1: "v1", m2: "v1", m3: "*" }), "v1");
  assert.equal(mafiaKillTarget({ m1: "v1", m2: "*" }), null, "one for v1, one for no-kill: a tie");
  assert.equal(mafiaKillTarget({ m1: "v1", m2: "*", m3: "*" }), null);
  assert.equal(mafiaKillTarget({ m1: "v1", m2: "v2" }), null);
  assert.equal(mafiaKillTarget({}), null);
});

test("town vote arms (random legal, suspicion model) play full games with no illegal action", async () => {
  for (const town of ["random", "suspicion"]) {
    const { scorecard } = await runSelfplay({ games: 3, seed: 2, town });
    assert.equal(scorecard.town, town);
    assert.equal(scorecard.illegalActions.total, 0, `${town}: ${JSON.stringify(scorecard.illegalActions.samples)}`);
    assert.ok(scorecard.townVotes.ballots > 0, `${town}: town seats voted`);
  }
});

test("--plant-audit is a test-only positive control: off by default, never changes the game, reports recall", async () => {
  const plain = await runSelfplay({ games: 2, seed: 2 });
  assert.equal(plain.scorecard.plantAudit, undefined);
  assert.ok(plain.results.every((r) => r.stats.planted.length === 0));
  const planted = await runSelfplay({ games: 2, seed: 2, plantAudit: true });
  assert.deepEqual(planted.results.map((r) => strip(r.log)), plain.results.map((r) => strip(r.log)), "planted lines are audited, never sent");
  for (const [cat, r] of Object.entries(planted.scorecard.plantAudit)) {
    assert.ok(r.planted > 0, `${cat} planted`);
    if (r.expect === "CLEAN") assert.equal(r.falsePositives, 0, `${cat}: ${r.examples}`);
    else assert.equal(r.flagged, r.planted, `${cat}: ${r.examples}`);
  }
});

test("sheriffRule: vinman by default, evidence reaches every view and the scorecard, no illegal shot", async () => {
  assert.equal((await runSelfplay({ games: 1, seed: 3 })).scorecard.sheriffRule, "vinman");
  const r = await playSelfplayGame({ seed: 3, game: 0, sheriffRule: "evidence", keepServer: true });
  assert.ok(Object.values(r.server.table.views).every((v) => v.config?.sheriffRule === "evidence"));
  const { scorecard } = await runSelfplay({ games: 3, seed: 3, sheriffRule: "evidence" });
  assert.equal(scorecard.sheriffRule, "evidence");
  assert.equal(scorecard.illegalActions.total, 0, JSON.stringify(scorecard.illegalActions.samples));
});

test("vinman Day 1: the Sheriff alive with the gun always shoots, and no town seat votes no-one while he lives", async () => {
  const { results, scorecard } = await runSelfplay({ games: 10, seed: 5 });
  assert.equal(scorecard.town, "rules", "the suspicion model stays off by default");
  assert.equal(createBotTable([]).config.town, "rules", "live too");
  assert.ok(scorecard.day1.sheriffAlive > 0);
  assert.equal(scorecard.day1.shot, scorecard.day1.sheriffAlive, JSON.stringify(scorecard.day1));
  assert.equal(scorecard.day1.townNoOneSheriffAlive, 0);
  assert.equal(scorecard.illegalActions.total, 0, JSON.stringify(scorecard.illegalActions.samples));
  for (const r of results) assert.deepEqual(r.stats.vegs, [], `game ${r.game}: holding the Village vote for the shot never veg-kicks the Sheriff`);
});
