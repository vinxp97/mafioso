// Vinman 2026-10-18 rules, live path and selfplay: the Sheriff asks for a claim before shooting and the asked seat
// answers; stale votes on a dead player are replaced at once (server Meeting.generateTargets early return);
// selfplay keeps the server's stale votes by default; game-level invariants hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRng, parseClaimReply } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, claimLineFor } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { deadVotesCleared, runSelfplay, playSelfplayGame, SELFPLAY_DEFAULTS } from "../src/selfplay.js";
import { analyzeGame } from "../scripts/sheriff-eval.mjs";
import { seats, players } from "./fixtures/smu-night1.mjs";

const T0 = 1_800_000_000_000;
const seat = (name) => seats.find((s) => s.name === name);
const village = (s, votes = {}) => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(players).filter((i) => i !== s.pid), "*"], votes });

async function setupDay(seed = 1) {
  const clock = createVirtualClock(T0);
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })), { clock, rng: createSeededRng(seed), mafia: "adaptive" });
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1) };
  const feed = (s, event, data, t = T0) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  const all = async (event, data, t) => { for (const s of seats) await feed(s, event, data, t); };
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  for (const s of seats) { await feed(s, "state", { id: 3, name: "Day 1" }); await feed(s, "meeting", village(s)); }
  return { table, feed, all, clock };
}
const said = (table, name) => table.proposed.filter((p) => p.event === "speak" && p.accountId === seat(name).acc).map((p) => p.data.content);
const msg = (name, content, t) => ({ senderId: seat(name).pid, meetingId: "vil", content, t });

test("legacy stale-vote loop: 'server' mode stops at the first vote that is still valid, 'clear' clears them all", () => {
  const ballots = { a: "dead", b: "dead", c: "x", d: "dead" };
  assert.deepEqual(deadVotesCleared(ballots, "dead", "server"), ["a", "b"], "d's vote on the dead player stays (the live bug)");
  assert.deepEqual(deadVotesCleared(ballots, "dead", "clear"), ["a", "b", "d"]);
  assert.deepEqual(deadVotesCleared({ c: "x", a: "dead" }, "dead", "server"), []);
  // Pranay fixed the server bug on dev (2026-10-18 9:37 AM ET): emulation is off by default; --stale-votes server for legacy.
  assert.equal(SELFPLAY_DEFAULTS.staleVotes, "clear", "off by default so evals match dev");
});

test("live path: the Sheriff's ask reaches the asked seat, which answers with a claim the parser reads", async () => {
  for (const [name, kind, role] of [["Bea", "plain", "Villager"], ["Ash", "power", "Cop"]]) {
    const { table, all } = await setupDay(3);
    await all("message", msg("Gil", "im sheriff", T0 + 1_000), T0 + 1_000);
    await all("message", msg("Gil", `${name.toLowerCase()} claim?`, T0 + 120_000), T0 + 120_000);
    await all("time", { time: 170_000 }, T0 + 130_000);
    await drainUpgrades(table);
    const lines = said(table, name);
    const reply = lines.map(parseClaimReply).find(Boolean);
    assert.ok(reply, `${name} answered: ${JSON.stringify(lines)}`);
    assert.deepEqual([reply.kind, reply.role], [kind, role], lines.join(" | "));
    // A seat that was not asked does not answer the ask.
    assert.equal(said(table, "Dot").map(parseClaimReply).some((r) => r && r.role === "Villager"), false);
  }
});

test("live path: the asked mafia seat fake-claims instead of saying nothing (and not as Sheriff)", async () => {
  const { table, all } = await setupDay(5);
  await all("message", msg("Gil", "im sheriff", T0 + 1_000), T0 + 1_000);
  await all("message", msg("Gil", "cal claim?", T0 + 120_000), T0 + 120_000);
  await all("time", { time: 170_000 }, T0 + 130_000);
  await drainUpgrades(table);
  const reply = said(table, "Cal").map(parseClaimReply).find(Boolean);
  assert.ok(reply, `Cal answered: ${said(table, "Cal").join(" | ")}`);
  assert.notEqual(reply.role, "Sheriff");
});

test("live path: the Sheriff seat proposes its own ask line before any shot", async () => {
  const { table, all, feed } = await setupDay(7);
  const gil = seat("Gil");
  await feed(gil, "meeting", { id: "gun", name: "Shoot Gun", actionName: "Shoot Gun", voting: true, canVote: true, amMember: true, instant: true, targets: Object.keys(players).filter((i) => i !== gil.pid), votes: {} });
  await all("message", msg("Gil", "im sheriff", T0 + 1_000), T0 + 1_000);
  await all("message", msg("Ash", "im cop. cal guilty", T0 + 2_000), T0 + 2_000);
  for (const s of ["Bea", "Dot", "Eli", "Fin", "Hap"]) await all("message", msg(s, "hmm", T0 + 3_000), T0 + 3_000);
  await all("time", { time: 170_000 }, T0 + 130_000);
  await drainUpgrades(table);
  const view = table.views[seat("Gil").acc];
  const line = claimLineFor(view);
  const asked = said(table, "Gil").find((l) => /^cal\b/.test(l)) || line;
  assert.match(String(asked), /^cal (claim|whats your role|what are you)/, `Gil: ${said(table, "Gil").join(" | ")} / due ${line}`);
  assert.equal(table.proposed.some((p) => p.accountId === seat("Gil").acc && p.event === "vote" && p.data.meetingId === "gun"), false, "no shot before Cal answers");
});

test("live path: when a seat's Village vote target dies, it re-votes a living player right away", async () => {
  const { table, feed, all } = await setupDay(9);
  const dot = seat("Dot");
  // Late in the day; Bea, Eli and Fin had voted Dot, then the Sheriff shoots Dot. The server may keep their votes.
  await all("time", { time: 100_000 }, T0 + 200_000);
  for (const s of seats) await feed(s, "meeting", village(s, { [seat("Bea").pid]: dot.pid, [seat("Eli").pid]: dot.pid, [seat("Fin").pid]: dot.pid }), T0 + 200_000);
  const before = table.proposed.length;
  await all("death", dot.pid, T0 + 201_000);
  await all("time", { time: 95_000 }, T0 + 205_000);
  await drainUpgrades(table);
  for (const name of ["Bea", "Eli", "Fin"]) {
    const votes = table.proposed.slice(before).filter((p) => p.event === "vote" && p.data.meetingId === "vil" && p.accountId === seat(name).acc);
    assert.ok(votes.length, `${name} re-voted`);
    const sel = votes.at(-1).data.selection;
    assert.notEqual(sel, dot.pid);
    assert.notEqual(sel, seat(name).pid);
  }
});

test("selfplay: asks happen, no shot on an uncontested claimed-PR townie, revealed Sheriff never lynched or accused, 0 illegal", async () => {
  const { results } = await runSelfplay({ games: 4, seed: 4 });
  const g = results.map(analyzeGame);
  assert.ok(g.reduce((a, x) => a + x.asks, 0) > 0, "the Sheriff asks");
  assert.equal(g.reduce((a, x) => a + x.illegal, 0), 0);
  assert.equal(g.reduce((a, x) => a + x.sheriffLynched, 0), 0);
  assert.equal(g.reduce((a, x) => a + x.townBallotsOnSheriff + x.scumBallotsOnSheriff, 0), 0);
  assert.equal(g.reduce((a, x) => a + x.accuse.length, 0), 0);
  const shots = g.flatMap((x) => x.shots);
  assert.equal(shots.filter((s) => s.claimedPower && !s.contested && !s.scum).length, 0, JSON.stringify(shots));
  for (const r of results) if (r.stats.day1?.sheriffAlive) assert.ok(r.stats.shots.some((s) => s.day === 1), "Day 1 always shoots");
});

test("selfplay: a fake cop who drafted a guilty on the (not yet outed) Sheriff holds it, sees his claim, and drops it", async () => {
  // Seed 10 game 14: the night plan was "ash fake cop tmrw and push dot"; Dot outs as Sheriff at the start of Day 1.
  const r = await playSelfplayGame({ seed: 10, game: 14 });
  assert.equal(r.roles.Dot, "Sheriff");
  const g = analyzeGame(r);
  assert.deepEqual(g.accuse, []);
  assert.equal(r.log.some((l) => /^Day 1 Ash: im cop\. dot guilty/.test(l)), false);
});
