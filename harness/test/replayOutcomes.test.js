// Replay g01-g16 through the engine's phase resolver and compare with what each fixture recorded.
// Compared at the level each fixture supports (helper: "named" / "unnamed" / "none"). Every difference is
// pinned below with a verdict; a new difference, or a pinned one that goes away, fails the test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { newGame, resolvePhase } from "mafioso-engine";
import { REPLAY_DIR, compareFixture, mismatches, readRecorded } from "./replayOutcomes.helper.js";

const FIXTURES = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, "manifest.json"), "utf8")).fixtures.map((f) => f.fixture);
const ENDING = "fixture gap: the game's ending is not in the log";

// fixture, phase, field, expected (recorded) -> got (resolver), verdict.
const KNOWN = [
  // "No one wins" (the meteor's or a lobby close's winner) with no death in the log: the ending is the server's, not a phase's.
  ["g07.jsonl", "end", "winner", "No one", null, ENDING],
  // The log stops after Night 2's sends (no kill sent) and the server later names the Village: nothing logged decides it.
  ["g09.jsonl", "end", "winner", "Village", null, ENDING],
];

test("g01-g16: every recorded phase matches the resolver, except the pinned fixture gaps", () => {
  const got = FIXTURES.flatMap((f) => mismatches(f)).map((m) => [m.fixture, m.phase, m.field, m.expected, m.got]);
  assert.deepEqual(got, KNOWN.map((k) => k.slice(0, 5)));
  assert.ok(KNOWN.every((k) => !/engine bug/.test(k[5])), "no open engine bug");
});

test("each fixture is compared at the level it supports; the matched phases are real comparisons", () => {
  const levels = Object.fromEntries(FIXTURES.map((f) => [f, readRecorded(f).level]));
  const at = (lvl) => Object.entries(levels).filter(([, l]) => l === lvl).map(([f]) => f);
  assert.deepEqual(at("named"), ["g07", "g08", "g09", "g10", "g11", "g12", "g14", "g15", "g16"].map((g) => `${g}.jsonl`));
  assert.deepEqual(at("none"), ["g01.jsonl", "g13.jsonl"]);
  let compared = 0; let reports = 0;
  for (const f of FIXTURES) for (const r of compareFixture(f).rows.filter((x) => !x.skipped)) {
    compared += 1;
    if (r.recordedReports?.length) reports += 1;
  }
  assert.ok(compared >= 30, `compared ${compared}`);
  assert.equal(reports, 3, "g15 Night 1, g16 Nights 1-2 carry the live reports");
});

test("named fixtures put the server's winning Mafia in the Mafia's seats", () => {
  for (const f of FIXTURES.filter((x) => readRecorded(x).level === "named")) {
    const { roles, winners } = readRecorded(f);
    if (!winners.Mafia) continue;
    const mafiaSeats = Object.keys(roles).filter((id) => /Mafioso|Janitor|Lawyer/.test(roles[id])).sort();
    assert.deepEqual([...winners.Mafia].sort(), mafiaSeats, f);
  }
});

// g15 and g16 against the live server record. Their source logs (not in the repo: real names) prove the seat
// binding: a seat's scheduler logs "seat is dead" right after the phase it died in, the Litigate/Clean Death/
// Investigate/Receive Reports sends name each role's seat, and "winners" lists the Mafia's real ids. Ids are the
// fixtures' fake ids. Where the log cannot tell two seats of one alignment apart, either choice gives the same
// outcomes. Expected outcomes are the log's alerts (cop "Village" = Innocent), dead seats, and winner.
const LIVE = {
  "g15.jsonl": {
    roles: { p01: "Mafioso", p03: "Lawyer", p05: "Janitor", p02: "Villager", p04: "Villager", p06: "Journalist", p07: "Villager", p08: "Sheriff", p09: "Cop" },
    phases: [
      ["Night 1", { "Mafia Kill": { p01: "p02", p03: "p02", p05: "p02" }, "Clean Death": { p05: "Yes" }, Litigate: { p03: "p01" }, "Receive Reports": { p06: "p01" }, Investigate: { p09: "p02" } },
        { deaths: ["p02"], cleaned: ["p02"], reports: [["p05", "janitor", "p02", "Villager"], ["p09", "cop", "p02", "Innocent"], ["p06", "journalist", "p01", "no reports"]] }],
      ["Day 1", { Village: { p09: "p03", p03: "p04", p05: "p04", p06: "p04", p04: "p05", p01: "p06", p07: "p03", p08: "p07" } }, { deaths: ["p04"] }],
      ["Night 2", { "Mafia Kill": { p05: "p08", p01: "p08", p03: "p08" }, Litigate: { p03: "p01" }, "Receive Reports": { p06: "p08" }, Investigate: { p09: "p01" } }, { deaths: ["p08"], winner: "Mafia" }],
    ],
  },
  "g16.jsonl": {
    roles: { p01: "Janitor", p06: "Lawyer", p08: "Mafioso", p02: "Sheriff", p03: "Villager", p04: "Journalist", p05: "Cop", p07: "Villager", p09: "Villager" },
    phases: [
      ["Night 1", { "Mafia Kill": { p08: "p03", p01: "p03", p06: "p03" }, "Clean Death": { p01: "Yes" }, Litigate: { p06: "p01" }, Investigate: { p05: "p02" }, "Receive Reports": { p04: "p03" } },
        { deaths: ["p03"], cleaned: ["p03"], reports: [["p01", "janitor", "p03", "Villager"], ["p05", "cop", "p02", "Innocent"], ["p04", "journalist", "p03", "no reports"]] }],
      // The Sheriff shoots the Janitor: votes on him are cleared and the rest tie, so nobody is condemned.
      ["Day 1", { "Shoot Gun": { p02: "p01" }, Village: { p06: "p04", p04: "p01", p02: "p01", p09: "p01", p01: "p05", p08: "p07", p05: "p06", p07: "p08" } }, { deaths: ["p01"], shots: 1 }],
      ["Night 2", { "Mafia Kill": { p06: "p02", p08: "p02" }, Litigate: { p06: "p08" }, Investigate: { p05: "p08" }, "Receive Reports": { p04: "p06" } },
        { deaths: ["p02"], reports: [["p05", "cop", "p08", "Innocent"], ["p04", "journalist", "p06", "no reports"]] }],
      ["Day 2", { Village: { p06: "p07", p09: "p07", p04: "p06", p08: "p07", p05: "p07", p07: "p08" } }, { deaths: ["p07"] }],
      ["Night 3", { "Mafia Kill": { p06: "p04", p08: "p04" }, Litigate: { p06: "p08" }, Investigate: { p05: "p06" }, "Receive Reports": { p04: "p09" } }, { deaths: ["p04"], winner: "Mafia" }],
    ],
  },
};

test("g15/g16 fixtures agree with the live binding on every seat the builder did not mark ambiguous", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, "manifest.json"), "utf8")).fixtures;
  for (const [file, live] of Object.entries(LIVE)) {
    const { ambiguousSeats } = manifest.find((f) => f.fixture === file);
    const rows = fs.readFileSync(path.join(REPLAY_DIR, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sure = rows.filter((r) => r.event === "roleReveal" && !ambiguousSeats.includes(r.accountId));
    assert.ok(sure.length >= 3, `${file}: ${sure.length} seats recovered`);
    for (const r of sure) assert.equal(live.roles[r.data.playerId], r.data.role, `${file} ${r.accountId}`);
  }
});

test("g15/g16 with the seat binding their live logs prove: deaths, cleans, reports and winner all match the server", () => {
  for (const [file, live] of Object.entries(LIVE)) {
    // The live winners name the same Mafia as these roles, and every target the fixture kept is in these ballots.
    const rec = readRecorded(file);
    assert.deepEqual([...rec.winners.Mafia].sort(), Object.keys(live.roles).filter((id) => /Mafioso|Janitor|Lawyer/.test(live.roles[id])).sort());
    for (const [name, ballots] of live.phases) {
      for (const [meeting, kept] of Object.entries(rec.phases.find((p) => p.name === name).ballots)) {
        const pool = Object.values(ballots[meeting] || {});
        for (const t of Object.values(kept)) { const i = pool.indexOf(t); assert.ok(i >= 0, `${file} ${name} ${meeting}: ${t} not in the live ballots`); pool.splice(i, 1); }
      }
    }
    let game = newGame(live.roles);
    for (const [name, ballots, want] of live.phases) {
      const r = resolvePhase(game, name, ballots);
      game = r.game;
      const at = `${file} ${name}`;
      assert.deepEqual(r.out.deaths.map((d) => d.id), want.deaths, `${at} deaths`);
      assert.deepEqual(r.out.deaths.filter((d) => d.cleaned).map((d) => d.id), want.cleaned || [], `${at} cleans`);
      assert.deepEqual(r.out.flips.filter((x) => x.role === null).map((x) => x.id), want.cleaned || [], `${at} hidden flips`);
      assert.equal(r.out.shots.length, want.shots || 0, `${at} shots`);
      if (want.reports) assert.deepEqual(r.out.reports.map((x) => [x.to, x.kind, x.target, x.result]), want.reports, `${at} reports`);
      assert.equal(r.out.winner, want.winner || null, `${at} winner`);
    }
  }
});
