// Mixed-table mode (Night 6): one bot seat, eight scripted human-like seats, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playSelfplayGame } from "../src/selfplay.js";
import { STYLES, render } from "../src/mixedTable.js";
import { scoreMixedGame, summarizeMixed } from "../src/mixedEval.js";

const play = (botRole, extra = {}) => playSelfplayGame({ seed: 6901, game: 0, mixed: { botRole }, ...extra });
const pubLines = (r) => r.log.map((l) => /^Day \d+ (\w+): (.*)$/.exec(l)).filter(Boolean).map(([, who, text]) => ({ who, text }));

test("mixed: the bot holds the requested role and is the only table seat; the game finishes", async () => {
  for (const role of ["Sheriff", "Mafioso", "Villager"]) {
    const r = await play(role);
    assert.equal(r.error, null); assert.ok(["Village", "Mafia"].includes(r.winner));
    assert.equal(r.mixed.botRole, role); assert.equal(r.roles[r.mixed.bot], role);
    assert.equal(r.server, undefined);
    assert.equal(r.stats.humanIllegal || 0, 0, String(r.stats.humanIllegalWhy));
    assert.equal(r.stats.illegal.length, 0);
  }
});

test("mixed: scripted seats talk in varied styles, claim villager or blue (never vt), and the run is deterministic", async () => {
  const a = await play("Cop"); const b = await play("Cop");
  assert.deepEqual(a.log, b.log);
  const human = pubLines(a).filter((x) => x.who !== a.mixed.bot);
  assert.ok(human.length >= 20);
  assert.ok(Object.keys(a.mixed.humans.byStyle).length >= 2);
  assert.ok(new Set(human.map((x) => x.text)).size >= 10);
  for (const x of human) assert.doesNotMatch(x.text, /\b(vt|v\/t|vanilla town)\b/i);
  for (const s of Object.values(STYLES)) for (const c of s.claim) assert.match(c, /villager|blue/i);
});

test("mixed: templates only name players through placeholders, and render fills them", () => {
  for (const s of Object.values(STYLES)) for (const list of Object.values(s)) if (Array.isArray(list)) for (const t of list) if (typeof t === "string") assert.doesNotMatch(t.replace(/\{[XR]\}/g, ""), /[A-Z][a-z]+\d|player\d|seat\d/i);
  assert.equal(render(STYLES.terse, "{X} is sus", { X: "Bea" }), "bea is sus");
  assert.equal(render(STYLES.proper, "I'm cop. {X} is {R}.", { X: "Bea", R: "guilty" }), "I'm cop. Bea is guilty.");
});

test("mixed: a fake Cop appears in some games (scum human), answers come late or never", async () => {
  let fake = 0; let none = 0;
  for (let seed = 6901; seed < 6921; seed++) {
    const r = await playSelfplayGame({ seed, game: 0, mixed: { botRole: "Villager" } });
    fake += r.mixed.humans.claims.fakeCop; none += r.mixed.humans.claims.none;
    for (const c of r.stats.claims.filter((x) => x.seat !== r.mixed.bot && x.claimed === "cop" && x.role !== "Cop")) assert.ok(["Mafioso", "Janitor", "Lawyer"].includes(c.role));
  }
  assert.ok(fake >= 1, "no fake Cop in 20 games"); assert.ok(none >= 5);
});

test("mixed: scoring reads the bot seat only (ballots, filler, Sheriff and Cop fields)", async () => {
  const sh = scoreMixedGame(await play("Sheriff"));
  assert.equal(sh.role, "Sheriff"); assert.ok("sheriffClaimS" in sh && "shotsOnTown" in sh);
  const cop = scoreMixedGame(await play("Cop"));
  assert.ok("copClaims" in cop && cop.copExtraLines === 0);
  const maf = scoreMixedGame(await play("Mafioso"));
  assert.ok("ccOpp" in maf); assert.equal(maf.ballots, 0);
  const s = summarizeMixed([sh, { ...sh, seed: 2, botWon: !sh.botWon }], [sh, sh]);
  assert.equal(s.games, 2); assert.ok(s.pairedBotWin.n >= 1);
});

test("mixed: off by default (plain self-play is unchanged: nine bot seats, no mixed field)", async () => {
  const r = await playSelfplayGame({ seed: 6901, game: 0 });
  assert.equal(r.mixed, undefined);
  assert.equal(r.stats.humanIllegal, undefined);
  assert.equal(r.stats.lineTimes, undefined);
});
