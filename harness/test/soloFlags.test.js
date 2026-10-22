// Night 5 solo flags (10/20): each flag on the live table path, in the single-bot replay of the timed fixtures
// (one seat on the rules path, the rest the log). Off by default; each test shows the flag changes what it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tableFacts, soloReplay, scoreSolo } from "../src/soloEval.js";
import { createBotTable } from "../src/live.js";
import { isFiller, wilson, SOLO_CONFIGS } from "../src/soloFlagsEval.js";

const timed = (n) => fs.readFileSync(new URL(`./fixtures/solo-timeline/${n}.jsonl`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const accOf = (facts, pid) => Object.keys(facts.pidOf).find((a) => facts.pidOf[a] === pid);
const villageVotes = (run, facts) => run.proposals.filter((p) => p.event === "vote" && facts.meetings[p.data.meetingId] === "Village");

test("solo flags are off by default: the table config is unchanged unless a flag is exactly \"on\"", () => {
  const base = createBotTable([{ accountId: "a" }]).config;
  assert.deepEqual(createBotTable([{ accountId: "a" }], { voteHold: "off", soloCounterclaim: null, groundedSpeech: "yes", voteKickGuard: undefined }).config, base);
  for (const k of ["voteHold", "soloCounterclaim", "groundedSpeech", "voteKickGuard"]) assert.ok(!(k in base), k);
  assert.deepEqual(createBotTable([{ accountId: "a" }], SOLO_CONFIGS.all).config, { ...base, ...SOLO_CONFIGS.all });
});

test("(a) voteHold: every town ballot before 60% of the day is a confident read or the Sheriff's hammer ask", async () => {
  // L6: the default gate let unconfident ballots out early, the hold keeps them. L10: the default gate held
  // ballots the hold now casts early, each on a confident read (it waits for a read, not for the clock).
  const expect = { l06: (off, on) => off > on, l10: (off, on) => on > off };
  for (const n of ["l06", "l10"]) {
    const E = timed(n); const facts = tableFacts(E);
    let earlyOff = 0; let earlyOn = 0; let ballotsOn = 0;
    for (const acc of Object.keys(facts.pidOf).sort()) {
      if (facts.align[facts.pidOf[acc]] !== "Village") continue;
      const off = await soloReplay(E, acc, { seed: 7, facts });
      const on = await soloReplay(E, acc, { seed: 7, facts, config: { voteHold: "on" } });
      earlyOff += villageVotes(off, facts).filter((p) => p.dayFrac < 0.6 && !/^(hammer|ballot-switch)/.test(p.source)).length;
      for (const p of villageVotes(on, facts)) {
        ballotsOn += 1;
        if (!(p.dayFrac < 0.6) || /^(hammer|ballot-switch)/.test(p.source)) continue;
        const h = on.holds.filter((x) => x.t <= p.t && x.target === p.data.selection).at(-1);
        assert.ok(h?.confident, `${n} ${acc} ${p.phase} ballot at ${p.dayFrac.toFixed(2)} of the day without a confident read (${p.source})`);
        earlyOn += 1;
      }
      // Hard rules hold under the flag: never the revealed Sheriff, every send legal.
      assert.deepEqual(scoreSolo(E, on, facts).illegal, [], `${n} ${acc}`);
    }
    assert.ok(ballotsOn > 0, n);
    assert.ok(expect[n](earlyOff, earlyOn), `${n}: off ${earlyOff} early ballots, on ${earlyOn} (confident only)`);
  }
});

test("(b) soloCounterclaim: L8, the mafia seats whose human teammate held the counterclaim now make it themselves, 3-7s later", async () => {
  const E = timed("l08"); const facts = tableFacts(E);
  for (const pid of ["p02", "p07"]) {
    const acc = accOf(facts, pid);
    const off = scoreSolo(E, await soloReplay(E, acc, { seed: 7, facts }), facts).rules.r2_mafiaCounterclaim;
    assert.equal(off.sent, 0, `${pid} off: leaves it to the teammate`);
    assert.equal(off.opportunities[0].mine, false);
    const on = scoreSolo(E, await soloReplay(E, acc, { seed: 7, facts, config: { soloCounterclaim: "on" } }), facts).rules.r2_mafiaCounterclaim;
    assert.equal(on.sent, 1, `${pid} on: exactly one counterclaim`);
    const o = on.opportunities[0];
    assert.equal(o.mine, true);
    assert.match(o.cc.text, /^\S+ is lying, im the real journalist$/);
    assert.doesNotMatch(o.cc.text, /sheriff/i);
    assert.ok(o.cc.delayMs >= 3_000 && o.cc.delayMs <= 7_000 + 2_500, `${pid} delay ${o.cc.delayMs}`); // + one replay tick
    assert.equal(on.ok, true);
  }
  // The seat that already held the pick is unchanged.
  const p01 = accOf(facts, "p01");
  const a = scoreSolo(E, await soloReplay(E, p01, { seed: 7, facts }), facts).rules.r2_mafiaCounterclaim;
  const b = scoreSolo(E, await soloReplay(E, p01, { seed: 7, facts, config: { soloCounterclaim: "on" } }), facts).rules.r2_mafiaCounterclaim;
  assert.deepEqual(b.opportunities.map((o) => o.cc), a.opportunities.map((o) => o.cc));
});

test("(c) groundedSpeech: no filler line from any seat; what it says is a fact or a read", async () => {
  const E = timed("l07"); const facts = tableFacts(E);
  let off = 0; let on = 0; let onLines = 0;
  for (const acc of Object.keys(facts.pidOf).sort()) {
    off += scoreSolo(E, await soloReplay(E, acc, { seed: 7, facts }), facts).lines.filter(isFiller).length;
    const lines = scoreSolo(E, await soloReplay(E, acc, { seed: 7, facts, config: { groundedSpeech: "on" } }), facts).lines;
    on += lines.filter(isFiller).length; onLines += lines.length;
    for (const l of lines) assert.match(l, /^(my read is |votes so far: |claims so far: )|flipped |\bis lying\b|claim|\bim\b|self-vote|cop|journalist|lawyer|inno|guilty|villager|blue/i, `${acc}: ${l}`);
  }
  assert.ok(off > 0, "default speech has filler");
  assert.equal(on, 0);
  assert.ok(onLines > 0, "grounded seats still talk");
});

test("(d) voteKickGuard: L6 with the Vote Kick replayed, the Sheriff no longer shoots the second it opens", async () => {
  const E = timed("l06"); const facts = tableFacts(E);
  const acc = Object.keys(facts.pidOf).find((a) => facts.roles[facts.pidOf[a]] === "Sheriff");
  const shots = async (config) => scoreSolo(E, await soloReplay(E, acc, { seed: 7, facts, voteKick: "keep", config }), facts).gun.bot;
  const off = await shots({});
  assert.ok(off.some((g) => g.ms < 5_000), `default fires at once: ${JSON.stringify(off)}`);
  const on = await shots({ voteKickGuard: "on" });
  assert.ok(on.every((g) => g.ms >= 5_000), `guard: ${JSON.stringify(on)}`);
  // Without the Vote Kick in the stream the guard changes nothing.
  const plain = async (config) => scoreSolo(E, await soloReplay(E, acc, { seed: 7, facts, config }), facts).gun.bot;
  assert.deepEqual(await plain({ voteKickGuard: "on" }), await plain({}));
});

test("wilson: 95% interval", () => {
  const w = wilson(30, 50);
  assert.ok(Math.abs(w.lo - 0.4618) < 0.001 && Math.abs(w.hi - 0.7239) < 0.001, JSON.stringify(w));
  assert.equal(wilson(0, 0).p, null);
});
