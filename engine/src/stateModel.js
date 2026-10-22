// Deterministic game-state model: the whole table as the server runs it, one event at a time.
// stepModel(model, event) -> { ok, model, reason }. A refused event leaves the model unchanged (same object).
//
// It tracks the phase (Pregame, Night N, Day N, ended), who is alive and dead (with cause, phase and flip),
// public claims, revealed results (Cop / Journalist / Janitor reports, the Sheriff's reveal by gunshot, cleaned
// flips), votes per phase and meeting, each Day's outcome (lynch or no lynch) and the winner. modelLegalActions
// lists what one seat may do now. It reuses the server rules already in the engine: resolve.js (tally, winnerOf),
// legal.js (MEETING_DEFS: which meeting runs in which phase, its targets), claims.js (extractClaim), faction.js.
//
// The model is the server's truth, not one seat's view (reducer.js is that). roles may be omitted, or a seat's
// role null (unknown): then that seat's role checks (who holds a meeting, whose report it is) are skipped, and
// the win check runs only while every living seat's role is known.
//
// Events (type, then fields):
//   phase   name                     "Night 1", "Day 1", ...: Pregame -> Night 1 | Day 1; Night N -> Day N; Day N -> Night N+1
//   vote    voter, meeting, target   meeting is a MEETING_DEFS name ("Village", "Mafia Kill", "Investigate", ...)
//   unvote  voter, meeting
//   speak   by, text, meeting        meeting "Village" (public) or a faction chat ("Mafia"); public claims are read here
//   shot    by, target               the Sheriff's gun (Day only, once); reveals the shooter as Sheriff
//   death   id, cause, [role]        cause "night" | "condemn" | "gun" | "meteor" | "leave"; role = the flip (null: cleaned)
//   result  kind, to, target, result kind "cop" | "journalist" | "janitor": a night's private report, delivered by Day N
//   reveal  id, role                 a public flip after a death
//   end     winner                   "Village" | "Mafia" | "No one"
import { tally, winnerOf } from "./resolve.js";
import { MEETING_DEFS } from "./legal.js";
import { extractClaim } from "./claims.js";
import { ALIGNMENT } from "./faction.js";
import { NO_ONE } from "./types.js";

export const MODEL_CAUSES = Object.freeze(["night", "condemn", "gun", "meteor", "leave"]);
// Which role holds each role meeting (resolve.js HOLDER, plus the faction kill and the gun).
const HOLDS = {
  Village: () => true,
  "Mafia Kill": (role) => ALIGNMENT[role] === "Mafia",
  Investigate: (role) => role === "Cop",
  "Receive Reports": (role) => role === "Journalist",
  Litigate: (role) => /Lawyer$/.test(role || ""),
  "Clean Death": (role) => role === "Janitor",
  Save: (role) => role === "Doctor",
  "Shoot Gun": (role) => role === "Sheriff",
};
const REPORT_ROLE = { cop: "Cop", journalist: "Journalist", janitor: "Janitor" };
const isPlayerTarget = (t) => t != null && t !== NO_ONE && t !== "Yes" && t !== "No";

/** players: { id: name } or [id]. roles: { id: role } (optional, the hidden truth). */
export function createStateModel({ players, roles = null } = {}) {
  const ids = Array.isArray(players) ? players.map(String) : Object.keys(players || roles || {});
  const names = Array.isArray(players) ? Object.fromEntries(ids.map((id) => [id, id])) : { ...(players || {}) };
  for (const id of ids) if (names[id] == null || typeof names[id] !== "string") names[id] = id;
  return {
    phase: { name: "Pregame", kind: "Pregame", n: 0 },
    players: names, roles: roles ? { ...roles } : null,
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    deaths: [], flips: {}, claims: {}, results: [], sheriff: null,
    gunUsed: {}, cleanUsed: {},
    votes: {}, // { phaseName: { meeting: { voter: target } } }
    days: {},  // { "Day N": { lynched: id|null, expected: id|"*"|null, shots: [{by, target}] } }
    nights: {}, // { "Night N": { killed: [id], expected: id|"*"|null } }
    winner: null, ended: false, decided: null, log: 0,
  };
}

export const parseModelPhase = (name) => {
  const m = /^(Night|Day)\s+(\d+)$/.exec(String(name || ""));
  return m ? { name: `${m[1]} ${m[2]}`, kind: m[1], n: Number(m[2]) } : null;
};

/** The phase that may follow `phase` (Pregame may open on Night 1 or Day 1). */
export function nextPhases(phase) {
  if (phase.kind === "Pregame") return ["Night 1", "Day 1"];
  if (phase.kind === "Night") return [`Day ${phase.n}`];
  if (phase.kind === "Day") return [`Night ${phase.n + 1}`];
  return [];
}

const roleOf = (m, id) => (m.roles ? m.roles[id] ?? null : null);
/** A role check applies: roles are given and this seat's is known. */
const roleKnown = (m, id) => roleOf(m, id) != null;
const known = (m, id) => Object.prototype.hasOwnProperty.call(m.alive, id);
const living = (m) => Object.keys(m.alive).filter((id) => m.alive[id]);
const phaseVotes = (m) => (m.votes[m.phase.name] ||= {});

/** Who wins now by the server's check (Game.js checkWinConditions), or null; null when roles are unknown. */
export function modelWinner(m) {
  if (!m.roles || living(m).some((id) => !roleKnown(m, id))) return null;
  return winnerOf({ alive: m.alive, roles: m.roles, landed: false });
}

/** Living ballots of one meeting this phase, ballots on the dead cleared (Meeting.js: the dead lose their vote). */
function liveBallots(m, phaseName, meeting) {
  const b = m.votes[phaseName]?.[meeting] || {};
  return Object.fromEntries(Object.entries(b).filter(([v, t]) => m.alive[v] && (!isPlayerTarget(t) || m.alive[t])));
}

/** Why this event is illegal now, or null. Pure. */
export function modelCheck(m, ev) {
  if (!ev || typeof ev.type !== "string") return "malformed event";
  const ph = m.phase;
  const over = m.ended || m.decided;
  const actor = (id, what = "actor") => {
    if (!known(m, id)) return `${what} is not seated`;
    if (!m.alive[id]) return `${what} is dead`;
    return null;
  };
  switch (ev.type) {
    case "phase": {
      if (m.ended) return "game over";
      if (m.decided) return `game decided (${m.decided}): no phase after a win`;
      const p = parseModelPhase(ev.name);
      if (!p) return `unknown phase ${ev.name}`;
      if (!nextPhases(ph).includes(p.name)) return `${ph.name} cannot go to ${p.name}`;
      return null;
    }
    case "vote": case "unvote": {
      if (over) return "game over";
      const def = MEETING_DEFS[ev.meeting];
      if (!def) return `unknown meeting ${ev.meeting}`;
      if (def.kick) return "vote kick is not a game action";
      if (!def.states.includes(ph.kind)) return `${ev.meeting} does not meet in ${ph.name}`;
      const a = actor(ev.voter, "voter"); if (a) return a;
      if (roleKnown(m, ev.voter) && !HOLDS[ev.meeting]?.(roleOf(m, ev.voter))) return `${roleOf(m, ev.voter) || "this seat"} does not hold ${ev.meeting}`;
      if (ph.kind === "Day" && m.days[ph.name]?.lynched) return "the day's lynch already happened";
      if (ev.meeting === "Shoot Gun" && m.gunUsed[ev.voter]) return "the gun is spent";
      if (ev.meeting === "Clean Death" && m.cleanUsed[ev.voter]) return "the clean is spent";
      if (ev.type === "unvote") return m.votes[ph.name]?.[ev.meeting]?.[ev.voter] === undefined ? "no vote to take back" : null;
      return targetCheck(m, ev.meeting, def, ev.voter, ev.target);
    }
    case "shot": {
      if (over) return "game over";
      if (ph.kind !== "Day") return `no gun in ${ph.name}`;
      const a = actor(ev.by, "shooter"); if (a) return a;
      if (roleKnown(m, ev.by) && roleOf(m, ev.by) !== "Sheriff") return `${roleOf(m, ev.by)} has no gun`;
      if (m.gunUsed[ev.by]) return "the gun is spent";
      if (m.days[ph.name]?.lynched) return "the day's lynch already happened";
      const t = actor(ev.target, "target"); if (t) return t;
      return ev.target === ev.by ? "cannot shoot self" : null;
    }
    case "speak": {
      if (m.ended) return null; // postgame chat
      const a = actor(ev.by, "speaker"); if (a) return a;
      const meeting = ev.meeting || "Village";
      if (meeting === "Village" && ph.kind !== "Day") return `no public chat in ${ph.name}`;
      if (/^(Mafia|Cult)$/.test(meeting) && roleKnown(m, ev.by) && ALIGNMENT[roleOf(m, ev.by)] !== meeting) return `${roleOf(m, ev.by)} is not in the ${meeting} chat`;
      if (typeof ev.text !== "string" || !ev.text.trim()) return "empty speech";
      return null;
    }
    case "death": {
      if (m.ended) return "game over";
      const a = actor(ev.id, "victim"); if (a) return a;
      if (!MODEL_CAUSES.includes(ev.cause)) return `unknown cause ${ev.cause}`;
      if (ev.cause === "night" && ph.kind !== "Night") return `night kill in ${ph.name}`;
      if ((ev.cause === "condemn" || ev.cause === "gun") && ph.kind !== "Day") return `${ev.cause} in ${ph.name}`;
      if (ev.cause === "condemn" && m.days[ph.name]?.lynched) return "two lynches in one day";
      if (ev.cause === "gun" && !(m.days[ph.name]?.shots || []).some((s) => s.target === ev.id)) return "gun death without a shot at the victim";
      if (ev.cause === "night" && roleKnown(m, ev.id) && ALIGNMENT[roleOf(m, ev.id)] === "Mafia") return "the mafia kill never lands on the mafia";
      return null;
    }
    case "result": {
      const role = REPORT_ROLE[ev.kind];
      if (!role) return `unknown result kind ${ev.kind}`;
      if (!known(m, ev.to)) return "report holder is not seated";
      if (roleKnown(m, ev.to) && roleOf(m, ev.to) !== role) return `${roleOf(m, ev.to)} gets no ${ev.kind} report`;
      if (!known(m, ev.target)) return "report target is not seated";
      if (ev.target === ev.to) return "a report on self";
      // Reports for Night N land during Night N's end or Day N; a seat killed tonight still acted (resolve.js).
      const night = ph.kind === "Night" ? ph.n : ph.kind === "Day" ? ph.n : 0;
      if (!night) return `no report in ${ph.name}`;
      const diedBefore = (id) => m.deaths.some((d) => d.id === id && d.n < night);
      if (diedBefore(ev.to)) return "report holder was dead before the night";
      if (ev.kind === "janitor") {
        if (m.cleanUsed[ev.to] && m.cleanUsed[ev.to] !== `Night ${night}`) return "the clean is spent";
        const d = m.deaths.find((x) => x.id === ev.target);
        if (!d || d.cause !== "night" || d.n !== night) return "janitor report on a player not killed tonight";
        if (roleKnown(m, ev.target) && ev.result && ev.result !== roleOf(m, ev.target)) return `janitor report says ${ev.result}, role is ${roleOf(m, ev.target)}`;
        return null;
      }
      if (diedBefore(ev.target)) return "report on a player dead before the night";
      return null;
    }
    case "reveal": {
      if (!known(m, ev.id)) return "not seated";
      if (m.alive[ev.id]) return ev.role === "Sheriff" && m.sheriff === ev.id ? null : "a living player's role is not public";
      const d = m.deaths.find((x) => x.id === ev.id);
      if (d?.cleaned && !m.ended) return "a cleaned death has no flip";
      if (roleKnown(m, ev.id) && ev.role && String(ev.role).split(":")[0] !== roleOf(m, ev.id)) return `flip ${ev.role} is not the role (${roleOf(m, ev.id)})`;
      return null;
    }
    case "end": {
      if (m.ended) return "game already ended";
      const w = modelWinner(m);
      // Checked only when the table's roles are all known (an unknown seat could be either side).
      if (m.roles && !living(m).some((id) => !roleKnown(m, id)) && w !== ev.winner) return `winner ${ev.winner} but the table says ${w || "no winner yet"}`;
      return null;
    }
    default: return `unknown event ${ev.type}`;
  }
}

function targetCheck(m, meeting, def, voter, target) {
  if (def.boolean) return target === "Yes" || target === "No" ? null : `${meeting} takes Yes or No`;
  if (target === NO_ONE) return def.noOne ? null : `${meeting} has no no-one option`;
  if (!known(m, target)) return "target is not seated";
  if (!m.alive[target]) return "target is dead";
  const ex = new Set(def.targets?.exclude || []);
  if ((ex.has("self") || ex.has("members")) && target === voter && meeting !== "Village") return "cannot target self";
  // Mafia Kill excludes the members of an open meeting: a teammate is not a target (FJ's kill meeting is open).
  if (ex.has("membersIfOpen") && roleKnown(m, target) && roleKnown(m, voter) && ALIGNMENT[roleOf(m, target)] === "Mafia") return "the kill cannot target a teammate";
  return null;
}

/** Apply one event. Returns { ok, model, reason }; a refused event returns the same model object. */
export function stepModel(model, ev) {
  const reason = modelCheck(model, ev);
  if (reason) return { ok: false, model, reason };
  const m = structuredClone(model);
  m.log += 1;
  const ph = m.phase;
  switch (ev.type) {
    case "phase": {
      closePhase(m);
      m.phase = parseModelPhase(ev.name);
      if (m.phase.kind === "Day") m.days[m.phase.name] = { lynched: null, expected: null, shots: [] };
      else m.nights[m.phase.name] = { killed: [], expected: null };
      break;
    }
    case "vote": {
      const pv = phaseVotes(m);
      (pv[ev.meeting] ||= {})[ev.voter] = ev.target;
      break;
    }
    case "unvote": delete phaseVotes(m)[ev.meeting][ev.voter]; break;
    case "speak": {
      if ((ev.meeting || "Village") === "Village" && !m.ended) {
        const c = extractClaim({ senderId: ev.by, content: ev.text });
        if (c && c.kind !== "soft") (m.claims[ev.by] ||= []).push({ role: c.kind === "retract" ? null : c.role, kind: c.kind, phase: ph.name });
      }
      break;
    }
    case "shot": {
      m.gunUsed[ev.by] = true; m.sheriff = ev.by;
      m.days[ph.name].shots.push({ by: ev.by, target: ev.target });
      (m.votes[ph.name] ||= {})["Shoot Gun"] = { ...(m.votes[ph.name]?.["Shoot Gun"] || {}), [ev.by]: ev.target };
      break;
    }
    case "death": {
      m.alive[ev.id] = false;
      const d = { id: ev.id, cause: ev.cause, phase: ph.name, kind: ph.kind, n: ph.n };
      if (ev.role === null) d.cleaned = true;
      m.deaths.push(d);
      if (ev.role !== undefined) m.flips[ev.id] = ev.role;
      if (ev.cause === "condemn") m.days[ph.name].lynched = ev.id;
      if (ev.cause === "night") m.nights[ph.name]?.killed.push(ev.id);
      // The gun's win check is instant; a condemn or night death is checked at phase end (resolve.js).
      const w = modelWinner(m);
      if (w && (ev.cause === "gun" || ev.cause === "condemn" || ev.cause === "meteor" || ev.cause === "leave" || ev.cause === "night")) m.decided = w;
      break;
    }
    case "result": {
      const night = ph.n;
      if (ev.kind === "janitor") {
        m.cleanUsed[ev.to] = `Night ${night}`;
        const d = m.deaths.find((x) => x.id === ev.target);
        if (d) d.cleaned = true;
        if (m.flips[ev.target] !== undefined) m.flips[ev.target] = null;
      }
      m.results.push({ kind: ev.kind, to: ev.to, target: ev.target, result: ev.result ?? null, night: `Night ${night}` });
      break;
    }
    case "reveal": if (!m.alive[ev.id]) m.flips[ev.id] = ev.role; break;
    case "end": closePhase(m); m.winner = ev.winner; m.ended = true; m.phase = { ...m.phase, kind: "Ended" }; break;
  }
  return { ok: true, model: m, reason: null };
}

/** At a phase's end: the outcome the ballots call for (the lynch or no lynch; the night kill), next to what happened. */
function closePhase(m) {
  const ph = m.phase;
  if (ph.kind === "Day" && m.days[ph.name]) {
    const day = m.days[ph.name];
    // Ballots cast by players alive at the end, on players alive before the lynch.
    const b = m.votes[ph.name]?.Village || {};
    const alive = (id) => m.alive[id] || id === day.lynched;
    day.expected = tally(Object.fromEntries(Object.entries(b).filter(([v, t]) => alive(v) && (!isPlayerTarget(t) || alive(t)))));
    day.noLynch = !day.lynched;
  }
  if (ph.kind === "Night" && m.nights[ph.name]) {
    const night = m.nights[ph.name];
    const killed = new Set(night.killed);
    const b = m.votes[ph.name]?.["Mafia Kill"] || {};
    night.expected = tally(Object.fromEntries(Object.entries(b).filter(([v]) => m.alive[v] || killed.has(v))));
  }
}

/** Fold a list of events; refused ones are collected, not applied. */
export function replayModel(model, events) {
  let m = model; const refused = [];
  events.forEach((ev, i) => {
    const r = stepModel(m, ev);
    if (r.ok) m = r.model; else refused.push({ i, ev, reason: r.reason, phase: m.phase.name });
  });
  return { model: m, refused };
}

/**
 * What one seat may do now: { seat, phase, alive, meetings: [{ meeting, targets }], speak: [meetings] }.
 * Dead seats, an ended or decided game: nothing. A seat whose role is unknown gets every meeting of the phase.
 */
export function modelLegalActions(m, seat) {
  const out = { seat, phase: m.phase.name, alive: !!m.alive[seat], meetings: [], speak: [] };
  if (!m.alive[seat] || m.ended || m.decided || !known(m, seat)) return out;
  const role = roleOf(m, seat);
  for (const [name, def] of Object.entries(MEETING_DEFS)) {
    if (def.kick || !def.states.includes(m.phase.kind)) continue;
    if (role != null && !HOLDS[name]?.(role)) continue; // an unknown role may hold any meeting of the phase
    if (name === "Shoot Gun" && m.gunUsed[seat]) continue;
    if (name === "Clean Death" && m.cleanUsed[seat]) continue;
    if (m.phase.kind === "Day" && m.days[m.phase.name]?.lynched) continue;
    const opts = def.boolean ? ["Yes", "No"] : [...living(m), NO_ONE];
    const targets = opts.filter((t) => !targetCheck(m, name, def, seat, t));
    out.meetings.push({ meeting: name, targets });
  }
  if (m.phase.kind === "Day") out.speak.push("Village");
  if (role != null && m.phase.kind === "Night" && /^(Mafia|Cult)$/.test(ALIGNMENT[role] || "")) out.speak.push(ALIGNMENT[role]);
  return out;
}

/** Public facts for one phase, as a short block: the living, the dead with flips, the revealed Sheriff, public claims. */
export function modelPublicFacts(m) {
  const name = (id) => m.players[id] || id;
  const dead = m.deaths.map((d) => `${name(d.id)} (${d.cleaned ? "cleaned" : m.flips[d.id] || "no flip"}, ${d.cause === "night" ? "killed" : d.cause === "condemn" ? "lynched" : d.cause === "gun" ? "shot" : d.cause} ${d.phase})`);
  const sheriff = m.sheriff && m.alive[m.sheriff] ? name(m.sheriff) : null;
  const claims = Object.entries(m.claims).filter(([id, l]) => m.alive[id] && l.at(-1)?.role).map(([id, l]) => `${name(id)}: ${l.at(-1).role}`);
  return { phase: m.phase.name, alive: living(m).map(name), dead, sheriff, claims };
}
