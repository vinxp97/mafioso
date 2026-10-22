// Night 6 part 5 (mixed table, offline): the wide claim parse (config.wideClaimParse, off by default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { playSelfplayGame } from "../src/selfplay.js";
import { scoreCcGame } from "../src/ccScenario.js";
import { MIXED_CONFIGS } from "../scripts/mixed-table.mjs";

const scenario = (seed, cc, cfg) => playSelfplayGame({ seed, game: 0, simLatency: "live1018", mixed: { botRole: "Mafioso", teamReveal: true, human: { scenario: { cc, rawAnswers: true, power: seed % 2 ? "Cop" : "Journalist" } } }, ...cfg });

test("wide claims (teamCop, raw answers, seed 11001): off, the bot misses its teammate's terse 'cop X guilty' and claims Cop too; on, it doesn't", async () => {
  const off = await scenario(11001, "teamCop", MIXED_CONFIGS.n6);
  const on = await scenario(11001, "teamCop", MIXED_CONFIGS.n6Wide);
  const a = scoreCcGame(off); const b = scoreCcGame(on);
  assert.ok(off.log.some((l) => /^Day 1 \w+: cop \w+ (guilty|inno)$/.test(l)), "the teammate's terse Cop claim is on the board");
  assert.deepEqual(a.botPowerClaims, ["cop"]); assert.equal(a.doubleAny, true);
  assert.deepEqual(b.botPowerClaims, []); assert.equal(b.doubleAny, false);
  for (const r of [off, on]) { assert.equal(r.error, null); assert.equal(r.stats.illegal.length, 0); }
});

test("wide claims: scripted lines carry their true claim role (ground truth for the parser eval)", async () => {
  const r = await playSelfplayGame({ seed: 10001, game: 0, simLatency: "live1018", mixed: { botRole: "Villager" } });
  const sp = r.mixed.humans.spoken;
  assert.ok(sp.length > 50);
  assert.ok(sp.some((x) => x.role === "villager") && sp.some((x) => x.role === null));
  for (const x of sp.filter((y) => y.role === null)) assert.doesNotMatch(x.text, /^(i'?m |im )?(villager|blue)\.?$/i, x.text);
});
