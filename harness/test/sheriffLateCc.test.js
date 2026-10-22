// Night 6 part 4 (mixed table, offline): the Sheriff's late-answer grace, and the counterclaim scenarios with the
// mafia team claim guard. Seeds come from the scored runs (docs/sheriff-late-cc.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { playSelfplayGame } from "../src/selfplay.js";
import { scoreMixedGame } from "../src/mixedEval.js";
import { scoreCcGame } from "../src/ccScenario.js";

const sheriff = (seed, extra = {}) => playSelfplayGame({ seed, game: 0, simLatency: "live1018", mixed: { botRole: "Sheriff" }, ...extra });
const scenario = (seed, cc, extra = {}, teamReveal = true) => playSelfplayGame({ seed, game: 0, simLatency: "live1018", mixed: { botRole: "Mafioso", teamReveal, human: { scenario: { cc, power: seed % 2 ? "Cop" : "Journalist" } } }, ...extra });

test("late grace (seed 8002): off, the bot Sheriff shoots a town seat with its answer still pending; on, he waits and shoots scum", async () => {
  const off = await sheriff(8002); const on = await sheriff(8002, { sheriffLateGrace: "on" });
  const a = off.stats.shots.find((s) => s.bySeat === "bot"); const b = on.stats.shots.find((s) => s.bySeat === "bot");
  assert.equal(a.hit, false); assert.notEqual(a.pendingAnswer, null, "off: shot before the scheduled answer");
  assert.equal(b.hit, true); assert.ok(b.t > a.t, `on shoots later (${b.t}s vs ${a.t}s)`);
  assert.equal(off.table, undefined);
  for (const r of [off, on]) assert.equal(r.error, null);
});

test("late grace: the bot Sheriff still always shoots on Day 1 while alive, flag on (seeds 8001-8010)", async () => {
  for (let seed = 8001; seed <= 8010; seed++) {
    const r = await sheriff(seed, { sheriffLateGrace: "on" });
    const g = scoreMixedGame(r);
    const d1 = r.stats.day1;
    if (d1?.sheriffAlive && !r.log.some((l) => /^Day 1 .*\(Sheriff\) dies/.test(l) && l.includes(r.mixed.bot))) assert.equal(r.stats.shots.filter((s) => s.day === 1 && s.bySeat === "bot").length, 1, `seed ${seed}`);
    assert.equal(g.illegal, 0);
  }
});

test("scenario: the scripted Sheriff claims, asks the real power seat, which answers with a power claim; deterministic", async () => {
  const a = await scenario(9006, "team"); const b = await scenario(9006, "team");
  assert.deepEqual(a.log, b.log);
  const sc = a.mixed.scenario;
  assert.deepEqual(sc.events.map((e) => e.kind), ["ask", "powerAnswer", "ask", "shoot"]);
  assert.equal(sc.events[0].target, sc.powerSeat); assert.equal(sc.events[2].bot, true);
  const g = scoreCcGame(a);
  assert.equal(g.opp, true);
  assert.equal(g.ccCount, 1); assert.equal(g.ccByBot, true);
  assert.ok(g.ccDelayS >= 3 && g.ccDelayS <= 12, `counterclaim ${g.ccDelayS}s after the answer, not the same second`);
});

test("scenario lone: the scripted mafia seats leave at Day 1 start; the bot is the only mafia", async () => {
  const r = await scenario(9001, "lone");
  const gone = r.log.filter((l) => /dies: scenario: removed/.test(l));
  assert.equal(gone.length, 2);
  for (const l of gone) assert.match(l, /\((Janitor|Lawyer)\)/);
});

test("teamReveal: a lone mafia bot learns its scripted teammates at game start only with the option", async () => {
  // teamCop, Journalist asked (seed 9006): with teammates known, the bot's "no plan claim (cop)" fallback
  // double-claims the teammate's Cop; without them, the bot doesn't know the Cop claim was a teammate's.
  const known = scoreCcGame(await scenario(9006, "teamCop"));
  assert.deepEqual(known.botPowerClaims, ["cop"]);
  assert.equal(known.doubleAny, true);
  const unknown = scoreCcGame(await scenario(9006, "teamCop", {}, false));
  assert.equal(unknown.doubleAny, false, "off: the teammate's Cop claim reads as an outsider's");
});

test("team claim guard: off, the asked bot double-claims its teammate's Cop; on, it says villager (teamCop seeds 9004-9008 even)", async () => {
  for (const seed of [9004, 9006, 9008]) {
    const off = scoreCcGame(await scenario(seed, "teamCop"));
    const on = await scenario(seed, "teamCop", { teamClaimGuard: "on" });
    const g = scoreCcGame(on);
    assert.equal(off.doubleAny, true, `seed ${seed} off`);
    assert.equal(g.doubleAny, false, `seed ${seed} on`);
    assert.deepEqual(g.botPowerClaims, []);
    const bot = on.mixed.bot;
    assert.ok(on.log.some((l) => new RegExp(`^Day 1 ${bot}: .*\\b(villager|blue)\\b`, "i").test(l)), `seed ${seed}: the bot answers villager`);
  }
});
