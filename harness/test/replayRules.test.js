// Every replay fixture, seat by seat, through the CURRENT engine: at each decision point (a seat with an open
// vote), the engine's own picks (decide / rulesSeatActions) and a model that always asks for "no one"
// (llmDecide, the path a model vote takes) are checked for legality and against Vinman's no-lynch / no-kill
// rules by an independent oracle. The historical live sends came from older code, so they are not judged;
// what the engine would choose now is.
//   - town no-lynch refused when no-lynch + the next night kill = immediate mafia win (mafia town must assume
//     alive: 3 in FJ 9p minus scum flipped dead; 6 alive with a mafia flipped dead may no-lynch into a 5-way);
//   - under a day meteor, no no-lynch; under a night meteor, mafia must kill;
//   - otherwise the mafia kill is optional, but not while a Cop / Journalist / Sheriff claimer is alive.
// Fixtures have no meteor and the server's kill meeting may not offer "no one", so each fixture is also run
// with "*" offered in kill meetings and with a meteor warning at the start of every phase (synthetic stress).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reduce, emptyView, decide, rulesSeatActions, llmDecide, validateAction, selfAlive, allies, scumFaction, factionKillMeeting, createSeededRng } from "mafioso-engine";

const dir = new URL("./fixtures/replays/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
const load = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const SCUM = /^(mafioso|janitor|lawyer|godfather)/i;
const living = (v) => Object.keys(v.players || {}).filter((id) => !v.dead?.[id] && !v.players[id].left);
const day = (v) => v.phase?.phase === "Day";
const isTown = (v) => !!v.role && !SCUM.test(String(v.role));
const isKill = (v, m) => !!m && m === factionKillMeeting(v);
const skipSel = (s) => /^(\*|no|none|skip)$/i.test(String(s));

/** Oracle, from what the seat can see. */
function oracle(v) {
  const alive = living(v);
  const setup = Math.floor(Object.keys(v.players || {}).length / 3);
  const scumDead = Object.keys(v.players || {}).filter((id) => v.dead?.[id] && SCUM.test(String(v.reveals?.[id] || ""))).length;
  const mafia = Math.max(0, setup - scumDead);
  const nlLoses = day(v) && mafia > 0 && mafia >= alive.length - 1 - mafia;
  const warn = [...(v.messages || [])].reverse().find((m) => m.senderId === "server" && /giant meteor/i.test(String(m.content)));
  const deathThisPhase = (v.notes?.deaths || []).some((d) => d.phase === v.phase?.name);
  const meteor = warn && warn.phase === v.phase?.name && !deathThisPhase ? (/tonight/i.test(warn.content) ? "Night" : "Day") : null;
  const mates = allies(v);
  const claimer = alive.some((id) => id !== v.selfId && !mates.has(id) && (
    /\b(cop|journalist|sheriff)\b/i.test(String(v.reveals?.[id] || ""))
    || (v.messages || []).some((m) => m.senderId === id && m.public !== false && /\b(i'?m|im|i am)\s+(the\s+)?(real\s+)?(cop|journalist|sheriff)\b/i.test(String(m.content || "")))));
  return { nlLoses, meteor, claimer };
}

/** Rule breaks in a seat's chosen actions. */
function breaks(v, actions) {
  const o = oracle(v); const out = [];
  for (const a of actions) {
    if (a.event !== "vote") continue;
    const m = v.meetings?.[a.data.meetingId];
    if (!skipSel(a.data.selection) || !m) continue;
    if (m.name === "Village" && isTown(v) && o.nlLoses) out.push("town no-lynch into an autoloss");
    if (m.name === "Village" && o.meteor === "Day") out.push("no-lynch under a day meteor");
    if (isKill(v, m) && o.meteor === "Night") out.push("no kill under a night meteor");
    if (isKill(v, m) && o.claimer) out.push("no kill while a power-role claimer lives");
  }
  return out;
}

/** The kill is owed now (night meteor, or a power-role claimer alive) and this seat has not voted it yet. */
function killOwed(v) {
  const kill = factionKillMeeting(v);
  if (!kill?.voting || kill.canVote === false || kill.votes?.[v.selfId] != null) return null;
  if (!(kill.targets || []).some((t) => !skipSel(t))) return null;
  const o = oracle(v);
  return o.meteor === "Night" ? "night meteor" : o.claimer ? "power-role claimer alive" : null;
}

function openVote(v) {
  return Object.values(v.meetings || {}).find((m) => m?.voting && m.amMember && m.canVote !== false && (m.targets || []).length && m.votes?.[v.selfId] == null);
}

/** Variant: offer "*" in kill meetings, and a meteor warning at the start of every phase. */
function stress(entries) {
  const out = [];
  for (const e of entries) {
    let x = e;
    if (e.event === "meeting" && /Mafia Kill|^Village$/.test(e.data?.name || "") && !e.data.targets.includes("*")) x = { ...e, data: { ...e.data, targets: [...e.data.targets, "*"] } };
    out.push(x);
    if (e.event === "state" && /^(Day|Night)/.test(e.data?.name || "")) {
      const content = /^Day/.test(e.data.name) ? "A giant meteor will land and end the game if nobody is condemned today!" : "A giant meteor will land and end the game if nobody dies tonight!";
      out.push({ ...e, event: "message", data: { id: `meteor-${e.data.id}`, senderId: "server", content } });
    }
  }
  return out;
}

async function audit(entries) {
  const views = {}; const report = { points: 0, illegal: [], ruleBreaks: [] };
  const seen = new Set();
  // phase -> { why, killed, seats }: some mafia seat (the leader, or a teammate on its plan) must vote the kill
  // at some point in the phase; non-leaders rightly wait for the leader's plan or vote.
  const owed = new Map();
  for (const e of entries) {
    const v = (views[e.accountId] = reduce(views[e.accountId] || emptyView(), e));
    if (!v.selfId || !selfAlive(v) || v.finished || !/^(Day|Night)$/.test(v.phase?.phase || "")) continue;
    const m = openVote(v);
    if (!m) continue;
    const key = `${e.accountId}|${v.stateId}|${(v.messages || []).length}|${Object.keys(v.dead || {}).length}|${JSON.stringify(Object.values(v.meetings).map((x) => x.votes))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.points++;
    const where = `${e.accountId} ${v.phase.name} ${v.role}`;
    const rng = createSeededRng(7);
    const raw = decide(v, { rng }) || [];
    for (const a of raw) { const ok = validateAction(v, a); if (!ok.ok && a.event === "vote") report.illegal.push(`${where}: decide ${JSON.stringify(a.data)} (${ok.reason})`); }
    const rules = rulesSeatActions(v, { rng: createSeededRng(7), now: e.t }).actions;
    for (const b of breaks(v, rules)) report.ruleBreaks.push(`${where}: rules: ${b}`);
    const why = killOwed(v);
    if (why) {
      const k = owed.get(v.phase.name) || { why, killed: false, seats: new Set() };
      k.seats.add(`${e.accountId} ${v.role}`);
      const kill = factionKillMeeting(v);
      if (rules.some((a) => a.event === "vote" && a.data.meetingId === kill.id && !skipSel(a.data.selection))) k.killed = true;
      owed.set(v.phase.name, k);
    }
    // A model that always wants "no one" in this meeting: what llmDecide lets through.
    const skip = (m.targets || []).find(skipSel);
    if (skip) {
      const res = await llmDecide(v, { complete: async () => JSON.stringify({ action: "vote", meeting: m.id, target: skip }), maxRetries: 0, memory: false, now: e.t, rng: createSeededRng(7) });
      for (const a of res.actions) { const ok = validateAction(v, a); if (!ok.ok) report.illegal.push(`${where}: llm ${JSON.stringify(a.data)} (${ok.reason})`); }
      for (const b of breaks(v, res.actions)) report.ruleBreaks.push(`${where}: llm(${res.source}): ${b}`);
    }
  }
  for (const [phase, k] of owed) if (!k.killed) report.ruleBreaks.push(`${phase} mafia (${[...k.seats].join(", ")}): rules: kill owed (${k.why}) but no seat voted it`);
  return report;
}

for (const f of manifest.fixtures) {
  test(`replay rules: ${f.fixture} (as recorded and with meteor/no-one stress): 0 illegal, 0 rule breaks`, async () => {
    for (const [label, entries] of [["recorded", load(f.fixture)], ["stress", stress(load(f.fixture))]]) {
      const r = await audit(entries);
      assert.deepEqual(r.illegal, [], `${f.fixture} ${label}: illegal`);
      assert.deepEqual(r.ruleBreaks, [], `${f.fixture} ${label}: rule breaks`);
    }
  });
}

test("the oracle itself: 6 alive with a mafia flipped dead may no-lynch, with none dead may not", () => {
  const players = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: `P${i + 1}` }]));
  const base = (deadRoles) => [{ event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role: "Villager" } },
    ...Object.entries(deadRoles).flatMap(([id, r]) => [{ event: "death", data: id }, { event: "reveal", data: { playerId: id, role: r } }]),
    { event: "state", data: { id: 7, name: "Day 3" } }];
  const fold = (es) => es.reduce((v, e) => reduce(v, e), emptyView());
  assert.equal(oracle(fold(base({ p1: "Mafioso", p2: "Villager", p3: "Villager" }))).nlLoses, false);
  assert.equal(oracle(fold(base({ p1: "Villager", p2: "Villager", p3: "Villager" }))).nlLoses, true);
});
