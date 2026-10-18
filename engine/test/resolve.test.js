import test from "node:test";
import assert from "node:assert/strict";
import { newGame, resolvePhase, startPhase, tally, winnerOf } from "../src/resolve.js";

// Frontier Justice: m1 Mafioso, j1 Janitor, l1 Lawyer | c1 Cop, n1 Journalist, s1 Sheriff, v1..v3 Villager.
const FJ = { m1: "Mafioso", j1: "Janitor", l1: "Lawyer", c1: "Cop", n1: "Journalist", s1: "Sheriff", v1: "Villager", v2: "Villager", v3: "Villager" };
const night = (g, ballots, name = "Night 1") => resolvePhase(g, name, ballots);
const report = (out, to) => out.reports.find((r) => r.to === to);

test("tally follows Meeting.js: '*' counts, a tie or a no-lynch plurality is nobody, no ballots is null", () => {
  assert.equal(tally({ a: "x", b: "x", c: "y" }), "x");
  assert.equal(tally({ a: "x", b: "*", c: "*" }), "*");
  assert.equal(tally({ a: "x", b: "y" }), "*");
  assert.equal(tally({ a: "Yes", b: "No" }, { boolean: true }), "No");
  assert.equal(tally({}), null);
});

test("mafia kill: plurality of living mafia; flips the role; a non-mafia or dead voter is ignored", () => {
  const { out } = night(newGame(FJ), { "Mafia Kill": { m1: "v1", j1: "v1", l1: "v2", c1: "v2", v3: "v2" } });
  assert.deepEqual(out.deaths, [{ id: "v1", cause: "mafia" }]);
  assert.deepEqual(out.flips, [{ id: "v1", role: "Villager" }]);
  const tie = night(newGame(FJ), { "Mafia Kill": { m1: "v1", j1: "v2" } }).out;
  assert.deepEqual(tie.deaths, [], "tied kill vote: no kill");
  const onTeam = night(newGame(FJ), { "Mafia Kill": { m1: "l1" } }).out;
  assert.deepEqual(onTeam.deaths, [], "a teammate is not a kill target");
});

test("doctor save beats the kill (priority -90 < -1) and a saved kill cannot be cleaned", () => {
  const g = newGame({ ...FJ, v3: "Doctor" });
  const { game, out } = night(g, { "Mafia Kill": { m1: "c1" }, Save: { v3: "c1" }, "Clean Death": { j1: "Yes" } });
  assert.deepEqual(out.deaths, []);
  assert.deepEqual(out.saved, ["c1"]);
  assert.equal(report(out, "j1"), undefined);
  assert.equal(game.cleaned.j1, undefined, "the clean is not spent");
});

test("cop: Guilty/Innocent by alignment; a loyal Lawyer makes a teammate read Innocent but cannot frame town", () => {
  let out = night(newGame(FJ), { Investigate: { c1: "m1" } }).out;
  assert.deepEqual(report(out, "c1"), { to: "c1", kind: "cop", target: "m1", result: "Guilty" });
  out = night(newGame(FJ), { Investigate: { c1: "m1" }, Litigate: { l1: "m1" } }).out;
  assert.equal(report(out, "c1").result, "Innocent");
  out = night(newGame(FJ), { Investigate: { c1: "v1" }, Litigate: { l1: "v1" } }).out;
  assert.equal(report(out, "c1").result, "Innocent", "loyal: litigating town does nothing");
  out = night(newGame(FJ, { lawyer: "plain" }), { Investigate: { c1: "v1" }, Litigate: { l1: "v1" } }).out;
  assert.equal(report(out, "c1").result, "Guilty", "plain FlipAlignment frames town");
  out = night(newGame(FJ), { Investigate: { c1: "l1" }, Litigate: { l1: "l1" } }).out;
  assert.equal(report(out, "c1").result, "Guilty", "a Lawyer cannot litigate itself");
});

test("a cop killed tonight still gets the result (actions queued at night end all run)", () => {
  const { out } = night(newGame(FJ), { "Mafia Kill": { m1: "c1" }, Investigate: { c1: "j1" } });
  assert.equal(out.deaths[0].id, "c1");
  assert.equal(report(out, "c1").result, "Guilty");
});

test("janitor: the clean hides the flip, the janitor learns the role, once per game", () => {
  let { game, out } = night(newGame(FJ), { "Mafia Kill": { m1: "c1" }, "Clean Death": { j1: "Yes" } });
  assert.deepEqual(out.deaths, [{ id: "c1", cause: "mafia", cleaned: true }]);
  assert.deepEqual(out.flips, [{ id: "c1", role: null }]);
  assert.deepEqual(report(out, "j1"), { to: "j1", kind: "janitor", target: "c1", result: "Cop" });
  game = resolvePhase(game, "Day 1", {}).game;
  out = night(game, { "Mafia Kill": { m1: "v1" }, "Clean Death": { j1: "Yes" } }, "Night 2").out;
  assert.deepEqual(out.flips, [{ id: "v1", role: "Villager" }], "second clean: no meeting, normal flip");
  out = night(newGame(FJ), { "Clean Death": { j1: "Yes" } }).out;
  assert.equal(report(out, "j1"), undefined, "no kill, nothing to clean");
});

test("journalist: all reports the target got tonight, else 'no reports'", () => {
  let out = night(newGame(FJ), { Investigate: { c1: "m1" }, "Receive Reports": { n1: "c1" } }).out;
  assert.deepEqual(report(out, "n1").result, [{ kind: "cop", target: "m1", result: "Guilty" }]);
  out = night(newGame(FJ), { "Mafia Kill": { m1: "v1" }, "Clean Death": { j1: "Yes" }, "Receive Reports": { n1: "j1" } }).out;
  assert.deepEqual(report(out, "n1").result, [{ kind: "janitor", target: "v1", result: "Villager" }]);
  out = night(newGame(FJ), { "Receive Reports": { n1: "v2" } }).out;
  assert.equal(report(out, "n1").result, "no reports");
});

test("sheriff: one instant shot, the target flips, the win check runs before the vote", () => {
  let { game, out } = resolvePhase(newGame(FJ), "Day 1", { "Shoot Gun": { s1: "m1" }, Village: { v1: "m1", v2: "v3", v3: "v2" } });
  assert.deepEqual(out.shots, [{ by: "s1", target: "m1" }]);
  assert.deepEqual(out.deaths, [{ id: "m1", cause: "gun" }]);
  assert.deepEqual(out.flips, [{ id: "m1", role: "Mafioso" }]);
  assert.equal(game.guns.s1, false);
  out = resolvePhase(game, "Day 2", { "Shoot Gun": { s1: "j1" } }).out;
  assert.deepEqual(out.deaths, [], "the gun is spent");
  // 2 mafia vs 3 town: shooting a villager hands the mafia parity at once; the Village vote never resolves.
  const end = newGame({ m1: "Mafioso", j1: "Janitor", s1: "Sheriff", v1: "Villager", v2: "Villager" });
  out = resolvePhase(end, "Day 1", { "Shoot Gun": { s1: "v1" }, Village: { v2: "m1", s1: "m1", m1: "v2" } }).out;
  assert.deepEqual(out.deaths.map((d) => d.id), ["v1"]);
  assert.equal(out.winner, "Mafia");
});

test("village: plurality condemns; a tie or a no-lynch plurality is nobody; ballots on the dead are cleared", () => {
  let out = resolvePhase(newGame(FJ), "Day 1", { Village: { v1: "m1", v2: "m1", m1: "v1" } }).out;
  assert.deepEqual(out.deaths, [{ id: "m1", cause: "condemn" }]);
  out = resolvePhase(newGame(FJ), "Day 1", { Village: { v1: "m1", m1: "v1" } }).out;
  assert.deepEqual(out.deaths, []);
  out = resolvePhase(newGame(FJ), "Day 1", { Village: { v1: "m1", v2: "*", v3: "*" } }).out;
  assert.deepEqual(out.deaths, []);
  out = resolvePhase(newGame(FJ), "Day 1", { "Shoot Gun": { s1: "v1" }, Village: { v1: "m1", v2: "v1", v3: "v1", m1: "c1" } }).out;
  assert.deepEqual(out.deaths.map((d) => d.id), ["v1", "c1"], "shot v1 loses its ballot and the two on v1 are cleared: m1's lone ballot condemns c1");
});

test("win checks: Village when no mafia is left, Mafia at half or more, No one when everyone is dead", () => {
  const g = newGame({ m1: "Mafioso", v1: "Villager", v2: "Villager" });
  assert.equal(winnerOf(g), null);
  assert.equal(resolvePhase(g, "Day 1", { Village: { v1: "m1", v2: "m1" } }).out.winner, "Village");
  assert.equal(resolvePhase(g, "Night 1", { "Mafia Kill": { m1: "v1" } }).out.winner, "Mafia");
});

test("meteor: warned in the acting phase after noDeathLimit-1 quiet phases; lands if that phase ends with no death", () => {
  const g0 = newGame(FJ, { noDeathLimit: 2 });
  // Night 1 is quiet phase 1 = limit-1, mafia alive and no death yet: the acting phase is Night -> warned now.
  let r = resolvePhase(g0, "Night 1", { "Mafia Kill": { m1: "*" } });
  assert.equal(r.out.warning, "Night");
  assert.equal(r.out.meteor, true);
  assert.equal(r.out.winner, "No one");
  assert.equal(r.out.deaths.length, 9);
  r = resolvePhase(g0, "Night 1", { "Mafia Kill": { m1: "v1" } });
  assert.equal(r.out.meteor, false, "a night death lifts a Night warning");
  // The night death resets the count at Day 1, and the next warning is for a Day (last death was a night kill).
  r = resolvePhase(r.game, "Day 1", {}); // count 0
  assert.equal(r.out.warning, null);
  r = resolvePhase(r.game, "Night 2", { "Mafia Kill": { m1: "*" } }); // quiet 1 = limit-1, but acting phase is Day
  assert.equal(r.out.warning, null);
  r = resolvePhase(r.game, "Day 2", { "Shoot Gun": { s1: "v2" }, Village: { v3: "*" } });
  assert.equal(r.out.warning, "Day");
  assert.equal(r.out.meteor, true, "a gun death does not lift a Day warning; only a condemn does");
  assert.equal(r.out.winner, "No one");
});

test("meteor: a condemn lifts a Day warning; after a condemn with mafia alive the warning is for the night", () => {
  let g = newGame(FJ, { noDeathLimit: 3 });
  g = resolvePhase(g, "Night 1", { "Mafia Kill": { m1: "v1" } }).game;
  g = resolvePhase(g, "Day 1", {}).game; // reset; count 0
  g = resolvePhase(g, "Night 2", {}).game; // quiet 1
  let r = resolvePhase(g, "Day 2", { Village: { v2: "c1", v3: "c1" } }); // quiet 2 = limit-1, acting Day -> warned
  assert.equal(r.out.warning, "Day");
  assert.equal(r.out.meteor, false);
  r = resolvePhase(r.game, "Night 3", {}); // reset by the condemn
  r = resolvePhase(r.game, "Day 3", {}); // quiet 1
  r = resolvePhase(r.game, "Night 4", {}); // quiet 2, last death a condemn, mafia alive -> Night
  assert.equal(r.out.warning, "Night");
  assert.equal(r.out.meteor, true);
});

test("startPhase alone never warns with no stalemate limit", () => {
  let g = newGame(FJ);
  for (const name of ["Night 1", "Day 1", "Night 2", "Day 2"]) { const r = startPhase(g, name); assert.equal(r.warning, null); g = r.game; }
});
