// Deterministic phase resolution for the Frontier Justice core roles, after the Ultimafia server
// (github.com/UltiMafia/Ultimafia, Games/types/Mafia). Pure: every call returns a new game state.
//
// Night order is the server's action priority (const/Priority.js, lowest first): Doctor Save -90,
// Lawyer Litigate -80, Janitor Clean Death -14, Mafia Kill -1, Cop Investigate 250, Journalist
// Receive Reports 352. Every action queued at phase end runs, so a seat killed tonight still acts.
// Day: the Sheriff's gun is instant (a shot ends the game at once when it decides it), then the Village
// vote. Stalemate: the Meteor (events/Meteor.js, effects/Meteor.js, Game.js inactivityCheck).
import { ALIGNMENT } from "./faction.js";

const ALIAS = { Cop: "Investigate", "Learn Alignment": "Investigate", Journalist: "Receive Reports", "House Call": "Save", Shoot: "Shoot Gun" };
const HOLDER = { Save: /^Doctor$/, Litigate: /Lawyer$/, "Clean Death": /^Janitor$/, Investigate: /^Cop$/, "Receive Reports": /^Journalist$/ };
const isPlayer = (t) => t != null && t !== "*" && t !== "Yes" && t !== "No";

/**
 * Games/core/Meeting.js finish(): every ballot counts ("*" too); one top choice wins, a tie is "*"
 * ("No" for a Yes/No meeting); no ballots at all is null.
 */
export function tally(ballots, { boolean = false } = {}) {
  const count = new Map();
  for (const t of Object.values(ballots || {})) count.set(t ?? "*", (count.get(t ?? "*") || 0) + 1);
  let top = []; let n = 0;
  for (const [t, c] of count) { if (c > n) { top = [t]; n = c; } else if (c === n) top.push(t); }
  if (!top.length) return null;
  return top.length > 1 ? (boolean ? "No" : "*") : top[0];
}

/** roles: { playerId: role }. noDeathLimit: the setup's stalemate limit (none by default). lawyer: "loyal" | "plain". */
export function newGame(roles, { noDeathLimit = Infinity, lawyer = "loyal" } = {}) {
  const ids = Object.keys(roles);
  return {
    roles: { ...roles }, alive: Object.fromEntries(ids.map((id) => [id, true])),
    guns: Object.fromEntries(ids.filter((id) => roles[id] === "Sheriff").map((id) => [id, true])),
    cleaned: {}, phase: null, winner: null, landed: false,
    stalemate: { since: 0, reset: false, warn: null, lastKind: null, effect: false },
    opts: { noDeathLimit, lawyer },
  };
}

const alignOf = (g, id) => ALIGNMENT[g.roles[id]] || "Village";
const living = (g) => Object.keys(g.alive).filter((id) => g.alive[id]);

/** Game.js checkWinConditions + WinWithFaction: "Village" | "Mafia" | "No one" | null. */
export function winnerOf(g) {
  if (g.landed) return "No one";
  const live = living(g);
  if (!live.length) return "No one";
  const mafia = live.filter((id) => alignOf(g, id) === "Mafia").length;
  if (live.every((id) => alignOf(g, id) === "Village")) return "Village";
  if (mafia > 0 && mafia >= live.length / 2) return "Mafia";
  return null;
}

/** Game.js getMeteorActingPhase: the phase a stalemate warning lands in. */
function actingPhase(g) {
  if (g.stalemate.lastKind === "night") return "Day";
  return living(g).some((id) => alignOf(g, id) === "Mafia") ? "Night" : "Day";
}

/**
 * Game.js inactivityCheck, at the start of each Day/Night: a death last phase resets the count; else
 * after noDeathLimit-1 quiet phases the warning goes out in the acting phase. Returns { game, warning }.
 */
export function startPhase(game, name) {
  const g = structuredClone(game);
  const kind = String(name).split(" ")[0];
  const s = g.stalemate;
  g.phase = name;
  let warning = null;
  if (s.reset) Object.assign(s, { since: 0, reset: false, warn: null });
  else {
    s.since += 1;
    if (s.since >= g.opts.noDeathLimit - 1 && !s.warn && kind === actingPhase(g)) {
      s.warn = kind; s.effect = true; warning = kind;
    }
  }
  return { game: g, warning };
}

function emptyOut() { return { deaths: [], saved: [], flips: [], reports: [], shots: [], meteor: false, winner: null }; }

function die(g, out, id, cause, cleaned = false) {
  g.alive[id] = false;
  out.deaths.push(cleaned ? { id, cause, cleaned } : { id, cause });
  out.flips.push({ id, role: cleaned ? null : g.roles[id] });
  const s = g.stalemate;
  // Player.kill + shouldCountDeathForStalemate: a condemn or any night death resets the count.
  if (cause === "condemn" || /^Night/.test(g.phase)) { s.reset = true; s.lastKind = cause === "condemn" ? "condemn" : "night"; }
  // effects/Meteor.js death listener: a Day warning is lifted only by a condemn, a Night one by any death.
  if (s.effect && !g.landed && (s.warn !== "Day" || cause === "condemn")) s.effect = false;
}

/** effects/Meteor.js afterActions, then the win check. */
function endPhase(g, out) {
  const s = g.stalemate;
  if (s.effect && !g.landed && String(g.phase).split(" ")[0] === s.warn) {
    g.landed = true; s.effect = false; out.meteor = true;
    for (const id of living(g)) die(g, out, id, "meteor");
  }
  g.winner = out.winner = winnerOf(g);
  return { game: g, out };
}

/** { meetingName: { voterId: selection } } with aliases folded, keeping only seats that hold the meeting now. */
function seatBallots(g, ballots) {
  const b = {};
  for (const [name, votes] of Object.entries(ballots || {})) {
    const meeting = ALIAS[name] || name;
    for (const [voter, sel] of Object.entries(votes || {})) {
      if (!g.alive[voter]) continue;
      const role = g.roles[voter];
      const holds = meeting === "Village" ? true
        : meeting === "Mafia Kill" ? alignOf(g, voter) === "Mafia"
          : meeting === "Shoot Gun" ? !!g.guns[voter]
            : meeting === "Clean Death" ? HOLDER[meeting].test(role) && !g.cleaned[voter]
              : HOLDER[meeting]?.test(role);
      if (holds) (b[meeting] ||= {})[voter] = sel;
    }
  }
  return b;
}

const solo = (b, meeting) => Object.entries(b[meeting] || {});

/** Resolve a night from its ballots. Returns { game, out } with out = { deaths, saved, flips, reports, meteor, winner }. */
export function resolveNight(game, ballots) {
  const g = structuredClone(game);
  const out = emptyOut();
  if (g.winner) return { game: g, out: { ...out, winner: g.winner } };
  const b = seatBallots(g, ballots);
  const was = { ...g.alive };
  const target = (actor, t) => isPlayer(t) && was[t] && t !== actor;
  // -90 NightSaver: heal(1) makes the target immune to this night's kill.
  const healed = new Set(solo(b, "Save").filter(([, t]) => isPlayer(t) && was[t]).map(([, t]) => t));
  // -80 FlipAlignment: the target investigates as the other alignment. A Loyal Lawyer only reaches teammates.
  const appear = {};
  for (const [lawyer, t] of solo(b, "Litigate")) {
    if (!target(lawyer, t)) continue;
    if (g.opts.lawyer === "loyal" && alignOf(g, t) !== "Mafia") continue;
    appear[t] = alignOf(g, t) === "Mafia" ? "Village" : "Mafia";
  }
  const pick = tally(b["Mafia Kill"]);
  const victim = isPlayer(pick) && was[pick] && alignOf(g, pick) !== "Mafia" ? pick : null;
  const dominates = victim && !healed.has(victim);
  // -14 CleanDeath: only when the mafia kill will land; once per game; the Janitor learns the role.
  let cleaned = false;
  for (const [janitor, sel] of solo(b, "Clean Death")) {
    if (sel !== "Yes" || !dominates || cleaned) continue;
    cleaned = true; g.cleaned[janitor] = true;
    out.reports.push({ to: janitor, kind: "janitor", target: victim, result: g.roles[victim] });
  }
  // -1 Mafia kill.
  if (victim && !dominates) out.saved.push(victim);
  if (dominates) die(g, out, victim, "mafia", cleaned);
  // 250 LearnAlignment (BinaryAlignmentInfo): Guilty when the target appears evil.
  for (const [cop, t] of solo(b, "Investigate")) {
    if (!target(cop, t)) continue;
    const evil = (appear[t] || alignOf(g, t)) !== "Village";
    out.reports.push({ to: cop, kind: "cop", target: t, result: evil ? "Guilty" : "Innocent" });
  }
  // 352 ReceiveReports (ReportsInfo): every report the target got tonight, else "no reports".
  for (const [journalist, t] of solo(b, "Receive Reports")) {
    if (!target(journalist, t)) continue;
    const got = out.reports.filter((r) => r.to === t).map(({ kind, target: x, result }) => ({ kind, target: x, result }));
    out.reports.push({ to: journalist, kind: "journalist", target: t, result: got.length ? got : "no reports" });
  }
  return endPhase(g, out);
}

/** Resolve a day: the gun first (instant), then the Village vote. */
export function resolveDay(game, ballots) {
  const g = structuredClone(game);
  const out = emptyOut();
  if (g.winner) return { game: g, out: { ...out, winner: g.winner } };
  const b = seatBallots(g, ballots);
  // items/Gun.js (Sheriff: reveal): one shot, the target dies at once; the win check runs immediately.
  for (const [shooter, t] of solo(b, "Shoot Gun")) {
    if (!isPlayer(t) || t === shooter || !g.alive[t] || !g.alive[shooter]) continue;
    g.guns[shooter] = false;
    out.shots.push({ by: shooter, target: t });
    die(g, out, t, "gun");
    const w = winnerOf(g);
    if (w) { g.winner = out.winner = w; return { game: g, out }; }
  }
  // Village: the dead lose their ballot and ballots on the dead are cleared.
  const votes = Object.fromEntries(Object.entries(b.Village || {}).filter(([v, t]) => g.alive[v] && (!isPlayer(t) || g.alive[t])));
  const lynch = tally(votes);
  if (isPlayer(lynch)) die(g, out, lynch, "condemn");
  return endPhase(g, out);
}

/** startPhase + resolveNight/resolveDay by phase name ("Night 2", "Day 2"). */
export function resolvePhase(game, name, ballots) {
  const { game: g, warning } = startPhase(game, name);
  const r = /^Night/.test(name) ? resolveNight(g, ballots) : resolveDay(g, ballots);
  return { game: r.game, out: { ...r.out, warning } };
}
