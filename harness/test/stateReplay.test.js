// The game-state model (engine/src/stateModel.js) over every fixture: g01-g16, L2-L8 (live-1018) and L9-L10
// (live-1019). Each refused event is pinned with its cause; a new refusal, or a pinned one that goes away, fails.
// The builder options the replay found (alertRoles, voteOrder) are checked on synthetic logs, off by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createStateModel, stepModel, modelLegalActions } from "mafioso-engine";
import { fixtureEvents, replayFixture, trustedRoles } from "../src/stateReplay.js";
import { build, parseLog, BUILD_DEFAULTS } from "../src/replayBuild.js";

const DIRS = ["replays", "live-1018", "live-1019"];
const fixtures = DIRS.flatMap((d) => {
  const dir = new URL(`./fixtures/${d}/`, import.meta.url);
  return JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8")).fixtures.map((f) => ({ ...f, dir: d, entries: fs.readFileSync(new URL(f.fixture, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) }));
});
const replays = Object.fromEntries(fixtures.map((f) => [f.fixture, replayFixture(f.entries, f)]));
const ACTIONS = new Set(["vote", "unvote", "shot", "speak", "result"]);

const GUESSED = "fixture gap: guessed seat binding (seat ids are a guess, so a voter can land on its own target)";
const PHASES = "fixture gap: untagged log, phases guessed from frame counts (Day 1 then Night 3: the rest is filed in the wrong phase)";
const ENDING = "fixture gap: the game's ending is not in the log";
const STALE = "fixture gap: the builder condemns p06 on Day 1, but the server's Night 2 meetings count 7 alive (Mafia Kill targets=6, Investigate targets=7): the votes on the shot player stayed (Meeting.js generateTargets) and the 2-2 tie condemned nobody";
const ROLE = "builder: the Sheriff killed and cleaned Night 1 never had a gun meeting, so he got a leftover Villager role (fixed by --alert-roles, off by default)";
const ORDER = "builder: the shot Janitor's ballot (sent before the shot) is emitted after his death (fixed by --vote-order=log, off by default)";
// fixture, phase, event, reason, verdict.
const PINNED = [
  ["g04.jsonl", "Night 1", "vote", "cannot target self", GUESSED],
  ["g04.jsonl", "Night 1", "vote", "cannot target self", GUESSED],
  ["g05.jsonl", "Day 1", "phase", "Day 1 cannot go to Night 3", PHASES],
  ["g05.jsonl", "Day 1", "vote", "Mafia Kill does not meet in Day 1", PHASES],
  ["g05.jsonl", "Day 1", "phase", "Day 1 cannot go to Day 4", PHASES],
  ["g05.jsonl", "Day 1", "shot", "the day's lynch already happened", PHASES],
  ["g05.jsonl", "Day 1", "death", "gun death without a shot at the victim", PHASES],
  ["g05.jsonl", "Day 1", "reveal", "a living player's role is not public", PHASES],
  ["g09.jsonl", "Night 2", "end", "winner Village but the table says no winner yet", ENDING],
  ["g14.jsonl", "Night 2", "vote", "target is dead", STALE],
  ["g14.jsonl", "Night 2", "vote", "target is dead", STALE],
  ["l02.jsonl", "Day 1", "result", "janitor report says Sheriff, role is Villager", ROLE],
  ["l04.jsonl", "Day 1", "end", "winner Mafia but the table says no winner yet", ENDING],
  ["l05.jsonl", "Day 1", "vote", "voter is dead", ORDER],
  ["l09.jsonl", "Day 1", "result", "janitor report says Sheriff, role is Villager", ROLE],
];

test("every fixture replays through the model; each refusal is a pinned fixture gap, none is an engine or bot action", () => {
  const got = fixtures.flatMap((f) => replays[f.fixture].refused.map((x) => [f.fixture, x.phase, x.type, x.reason]));
  assert.deepEqual(got, PINNED.map((p) => p.slice(0, 4)));
  assert.ok(PINNED.every((p) => /^(fixture gap|builder):/.test(p[4])), "every pin has a verdict");
  // Exact-binding live games (seatmap): the only refusals are the two builder issues.
  const exact = fixtures.filter((f) => f.seatBinding === "seatmap").map((f) => f.fixture);
  assert.deepEqual(exact, ["l02.jsonl", "l03.jsonl", "l04.jsonl", "l05.jsonl", "l06.jsonl", "l07.jsonl", "l08.jsonl", "l09.jsonl", "l10.jsonl"]);
  const live = PINNED.filter((p) => exact.includes(p[0]) && p[2] !== "end").map((p) => p[4]);
  assert.deepEqual([...new Set(live)].sort(), [ORDER, ROLE].sort());
  const actions = fixtures.reduce((s, f) => s + replays[f.fixture].events.filter((e) => ACTIONS.has(e.type)).length, 0);
  assert.ok(actions >= 1400, `${actions} actions checked`);
});

test("the trusted roles: all for an exact binding, the ambiguous seats unknown for a partial one, none when guessed", () => {
  const roles = { p01: "Cop", p02: "Mafioso" };
  assert.deepEqual(trustedRoles(roles, { seatBinding: "seatmap", phaseTags: "logged", roles: "meetings" }), roles);
  assert.deepEqual(trustedRoles(roles, { seatBinding: "partial", phaseTags: "logged", roles: "meetings", ambiguousSeats: ["acc02"], pidOf: { acc02: "p02" } }), { p01: "Cop", p02: null });
  assert.equal(trustedRoles(roles, { seatBinding: "guessed", phaseTags: "logged" }), null);
  assert.equal(trustedRoles(roles, { seatBinding: "partial", phaseTags: "frame counts" }), null);
  const kinds = Object.fromEntries(fixtures.map((f) => [f.fixture, replays[f.fixture].model.roles ? (Object.values(replays[f.fixture].model.roles).every(Boolean) ? "all" : "partial") : "none"]));
  assert.deepEqual(Object.entries(kinds).filter(([, k]) => k === "all").map(([f]) => f), ["g08.jsonl", "g09.jsonl", "g10.jsonl", "g11.jsonl", "g12.jsonl", "l02.jsonl", "l03.jsonl", "l04.jsonl", "l05.jsonl", "l06.jsonl", "l07.jsonl", "l08.jsonl", "l09.jsonl", "l10.jsonl"]);
});

test("at every vote the model accepts, the target is one modelLegalActions offered that seat in that meeting", () => {
  let checked = 0;
  for (const f of fixtures) {
    const { players, events } = fixtureEvents(f.entries, { roles: replays[f.fixture].model.roles });
    let m = createStateModel({ players, roles: replays[f.fixture].model.roles });
    for (const ev of events) {
      const r = stepModel(m, ev);
      if (r.ok && ev.type === "vote") {
        const offer = modelLegalActions(m, ev.voter).meetings.find((x) => x.meeting === ev.meeting);
        assert.ok(offer?.targets.includes(ev.target), `${f.fixture} ${m.phase.name} ${ev.voter} ${ev.meeting} ${ev.target}`);
        checked += 1;
      }
      if (r.ok) m = r.model;
    }
  }
  assert.ok(checked >= 450, `${checked} votes`);
});

test("logged fixtures: each Day's lynch is the ballots' plurality, every alert is a model result, every flip a real role", () => {
  for (const f of fixtures.filter((x) => x.phaseTags === "logged")) {
    const r = replays[f.fixture];
    assert.deepEqual(r.outcomes, [], f.fixture);
    const results = r.model.results.length + r.refused.filter((x) => x.type === "result").length;
    assert.equal(results, f.alerts, `${f.fixture} alerts`);
    if (f.seatBinding === "seatmap") assert.equal(r.model.deaths.length, f.deaths, `${f.fixture} deaths`);
  }
  // L10 (made-up ids here): Village wins Day 3; the Journalist relays the Cop's guilty.
  const l10 = replays["l10.jsonl"].model;
  assert.equal(l10.winner, "Village");
  assert.equal(l10.phase.name, "Day 3");
  assert.ok(l10.results.some((x) => x.kind === "journalist" && /Guilty/.test(String(x.result))));
});

test("L9/L10 fixtures carry placeholders only and the rejects sidecar keeps the reasons", () => {
  for (const f of fixtures.filter((x) => x.dir === "live-1019")) {
    for (const e of f.entries) assert.match(e.accountId, /^acc\d\d$/);
    const text = JSON.stringify(f.entries);
    const names = new Set(text.match(/\b[A-Z][a-z]+[A-Z][A-Za-z]*\d*\b/g) || []);
    for (const n of names) assert.ok(/^(Player|Guest)\d+$/.test(n) || /^(accountId|meetingId|senderId|playerId|voterId|roleData|dayCount|playersByGroup|actionName|canVote|canUpdateVote|amMember|inputType|voteRecord|anonId|userId|anonymousGame|voiceChat|readyCheck|spectatorCount|isStarted|isSpectator|playerInfo|stateEvents|clearTimer|timerInfo|deathSounds)$/.test(n) || !/\d/.test(n), `${f.fixture}: ${n}`);
  }
  const rej = (n) => fs.readFileSync(new URL(`./fixtures/live-1019/${n}.rejects.jsonl`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const mandatory = rej("l09").filter((x) => x.reasons.some((r) => /Reasoning is mand/.test(r))).length; // the log cuts the provider's message there
  assert.ok(mandatory >= 1340, `L9: ${mandatory} 'Reasoning is mandatory' rejects`);
  assert.equal(rej("l10").filter((x) => x.reasons.some((r) => /Reasoning is mand/.test(r))).length, 0, "L10 (reasoning low): none");
  assert.ok(rej("l10").filter((x) => x.reasons.some((r) => /dead-sus|vote-dead/.test(r))).length >= 40, "L10: dead-target lines the chat audit refused");
});

// Builder options on synthetic logs (made-up ids), judged by the model. Seven seats with a seatmap.
const A = (i) => `AcSeat${i}xQz`; const P = (i) => `plPlay${i}xQz`;
const FRAMES = { "game:self": 7, "game:players": 7, "game:state": 20, "game:meeting": 20, "game:message": 20, "game:vote": 10, "game:death": 5, "game:reveal": 5, "game:roleReveal": 7, "game:winners": 7 };
const meet = (a, phase, id, name) => `meeting ${A(a)} [${phase}] ${id} name="${name}" role=${name === "Mafia Kill" ? "kill" : "-"} vote=true canVote=true targets=4`;
const vote = (a, phase, id, val) => `send ${A(a)} [${phase}] vote ${id} ${val} source=rules prompt=seed`;
const dead = (a) => `sched ${A(a)} skip u=0/0 path=dead reason=seat is dead; queue stopped`;
// s1 Cop P3, s2 Mafioso P5, s3 P1, s4 Janitor P4, s5 P2 (killed and cleaned Night 1), s6 P6, s7 P7.
const head = (frames = FRAMES) => [`game GmSynth02x accounts=${[1, 2, 3, 4, 5, 6, 7].map(A).join(",")}`, `frames ${JSON.stringify(frames)}`,
  `seatmap ${[[1, 3], [2, 5], [3, 1], [4, 4], [5, 2], [6, 6], [7, 7]].map(([s, p]) => `s${s}=${P(p)}:"Handle${p}x"`).join(" ")}`,
  meet(2, "Night 1", "KillMtg01x", "Mafia Kill"), meet(4, "Night 1", "KillMtg01x", "Mafia Kill"), meet(4, "Night 1", "CleanMtg1x", "Clean Death"), meet(1, "Night 1", "InvMtg001x", "Investigate"),
  vote(2, "Night 1", "KillMtg01x", P(2)), vote(4, "Night 1", "KillMtg01x", P(2)), vote(4, "Night 1", "CleanMtg1x", "Yes"), vote(1, "Night 1", "InvMtg001x", P(5)), dead(5)];
const { "game:winners": _w, ...UNFINISHED } = FRAMES; // a game the log leaves running: no winners frame
const winners = (side, ids) => `winners {"groups":["${side}"],"players":[${ids.map((i) => `"${P(i)}"`).join(",")}],"messages":[],"playersByGroup":{"${side}":[${ids.map((i) => `"${P(i)}"`).join(",")}]}}`;
const buildLog = (lines, opts) => { const [g] = parseLog([...lines, ""].join("\n")); const r = build(g, { source: "synthetic.log", ...opts }); return { r, rep: replayFixture(r.out, { seatBinding: r.seatBinding, phaseTags: r.phaseTags, roles: r.roles, ambiguousSeats: r.ambiguousSeats }) }; };
const roleOf = (r) => Object.fromEntries(r.out.filter((e) => e.event === "roleReveal").map((e) => [e.data.playerId, e.data.role]));

test("builder options are off by default", () => {
  assert.deepEqual(BUILD_DEFAULTS, { alertRoles: false, voteOrder: "after", nickVariants: false, timeline: "order" });
});

test("alertRoles: a Janitor's alert gives the cleaned Night 1 victim his role (L2, L9: the Sheriff)", () => {
  const lines = [...head(UNFINISHED), 'alert AcSeat4xQz [Day 1] kind=janitor target="Handle2x" result="Sheriff"', 'alert AcSeat1xQz [Day 1] kind=cop target="Handle5x" result="Mafia"',
    meet(1, "Day 1", "VilMtg001x", "Village"), vote(1, "Day 1", "VilMtg001x", P(5)), vote(3, "Day 1", "VilMtg001x", P(5)), vote(6, "Day 1", "VilMtg001x", P(5)), vote(2, "Day 1", "VilMtg001x", P(3)), dead(2)];
  const off = buildLog(lines);
  const on = buildLog(lines, { alertRoles: true });
  const victim = off.r.out.find((e) => e.event === "self" && e.accountId === "acc05").data;
  assert.equal(roleOf(off.r)[victim], "Villager", "default: a leftover role");
  assert.equal(roleOf(on.r)[victim], "Sheriff");
  assert.deepEqual(off.rep.refused.map((x) => x.reason), ["janitor report says Sheriff, role is Villager"]);
  assert.deepEqual(on.rep.refused, []);
  assert.deepEqual(on.rep.model.results.map((x) => [x.kind, x.result]), [["janitor", "Sheriff"], ["cop", "Guilty"]]);
});

test("voteOrder log: a ballot sent before the Sheriff's shot goes out before it; the default sends it after the death (L5)", () => {
  // Day 1: the Janitor votes P1, then s3 (Sheriff) shoots him, then the town lynches the Mafioso.
  const lines = [...head(), meet(3, "Day 1", "GunMtg001x", "Shoot Gun"), meet(1, "Day 1", "VilMtg001x", "Village"),
    vote(4, "Day 1", "VilMtg001x", P(1)), vote(3, "Day 1", "GunMtg001x", P(4)), dead(4),
    vote(1, "Day 1", "VilMtg001x", P(5)), vote(3, "Day 1", "VilMtg001x", P(5)), vote(6, "Day 1", "VilMtg001x", P(5)), vote(2, "Day 1", "VilMtg001x", P(3)), dead(2), winners("Village", [3, 1, 2, 6, 7])];
  const off = buildLog(lines);
  const on = buildLog(lines, { voteOrder: "log" });
  assert.deepEqual(off.rep.refused.map((x) => [x.type, x.reason]), [["vote", "voter is dead"]]);
  assert.deepEqual(on.rep.refused, []);
  const order = (rep) => rep.events.filter((e) => e.type === "shot" || (e.type === "vote" && e.meeting === "Village")).map((e) => (e.type === "shot" ? "shot" : e.voter));
  const jan = off.r.out.find((e) => e.event === "self" && e.accountId === "acc04").data;
  assert.equal(order(on.rep)[0], jan, "log order: the Janitor's ballot first");
  assert.equal(order(on.rep)[1], "shot");
  assert.equal(order(off.rep)[0], "shot", "default: every ballot after the shot");
  for (const x of [off, on]) { assert.equal(x.rep.model.winner, "Village"); assert.equal(x.rep.model.days["Day 1"].lynched, x.rep.model.days["Day 1"].expected); }
});
