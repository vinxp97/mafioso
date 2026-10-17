// Offline self-play for Frontier Justice 9p. No server, no network, no model.
//
// A small in-process server stands in for Ultimafia: it deals FJ, sends live-shaped frames (state,
// meeting, vote, message, death, reveal, time) to the REAL harness table (onGameEntry, fast mode),
// takes the table's proposals (immediate and deferred), checks each one against server truth and the
// engine's validateAction, applies the legal ones, resolves nights and days and checks wins.
// Every seat runs the live decision path: rulesSeatActions -> decide (incl. bus) -> shapeDayVotes,
// scum faction chatter, the role-claim rule, and proposeSeatActions (candidates -> selector, rules
// fallback). The "model" is an offline enumerator: candidate prompts get every legal option so the
// selector's heuristics choose; speech prompts throw so the rules public line is used.
// Time is a virtual clock; randomness is one seeded rng per game. Same seed -> same games.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptiveClaimLine, agreedPlan, claimedRoleIn, mafiaModeOf, createSeededRng, scoreGame, summarizeMetrics, validateAction } from "mafioso-engine";
import { FJ_ROLES, alignOf, mixSeed, plurality, shuffle, winnerFor } from "./arena.js";
import { createBotTable, createLlmLimiter, onGameEntry } from "./live.js";
import { createVirtualClock } from "./clock.js";

export const SELFPLAY_DIR = fileURLToPath(new URL("../../logs/selfplay", import.meta.url));
export const SELFPLAY_DEFAULTS = Object.freeze({ dayMs: 300_000, nightMs: 60_000, tickMs: 5_000, maxDays: 8, vegKickMs: 60_000, speech: "prescribed", copRule: "vinman", lawyer: "loyal", mafia: "adaptive" });
const NAMES = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const T0 = 1_760_000_000_000;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Offline stand-in for the model. No language model, no network.
 * - Candidate prompts: every legal target of every open decision becomes an option, so the selector's
 *   ruleScore and anchors choose. Claim decisions get "no claim" (claims come from the rules below).
 * - Speech prompts ("prescribed" mode, the default): the line is said only when the engine already
 *   prescribes its content: the Sheriff-out aim ("im sheriff ..."), and the agreed faction PLAN's fake
 *   claim for the PLAN speaker ("im cop. <lynch target> guilty ..."). Everything else throws, so the
 *   harness uses its no-model rules line (usually silence). speech: "none" throws on every speech prompt.
 * viewByName(name) returns that seat's own view (the same view the real prompt was built from).
 */
export function createOfflineComplete({ speech = "prescribed", viewByName = null } = {}) {
  return async ({ user, purpose } = {}) => {
    const text = String(user || "");
    if (purpose === "speech") return prescribedSpeech(text, speech, viewByName);
    if (purpose !== "candidates" && !text.includes("OPEN DECISIONS:")) throw new Error("offline: no model");
    const decisions = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^- id=(\S+?):/);
      if (!m) continue;
      const id = m[1];
      if (id === "claim") { decisions.push({ id, options: [{ action: "no-claim", claim: false, reason: "no claim yet" }] }); continue; }
      if (id === "speech") { decisions.push({ id, options: [{ action: "goal", goal: "push the vote on the top suspect", reason: "pressure" }, { action: "goal", goal: "ask the quiet players for reads", reason: "information" }] }); continue; }
      const meeting = (line.match(/meeting=(\S+)/) || [])[1] || "";
      const targets = ((line.match(/targets=\[([^\]]*)\]/) || [])[1] || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!targets.length) continue;
      decisions.push({ id, options: targets.map((target) => ({ action: "vote", meeting, target, reason: `consider ${target}` })) });
    }
    return JSON.stringify({ decisions });
  };
}

function prescribedSpeech(text, mode, viewByName) {
  if (mode !== "prescribed") throw new Error("offline: no model");
  if (/aim: Out yourself as Sheriff/i.test(text)) return "im sheriff. talk, ill shoot the best read";
  const me = (text.match(/^you are (.+?)\. role \(secret\)/m) || [])[1];
  const view = me && viewByName ? viewByName(me) : null;
  const plan = view ? agreedPlan(view) : null;
  if (view && mafiaModeOf(view) === "adaptive") {
    const c = plan ? adaptiveClaimLine(view, plan) : null;
    if (c && !/don't say your role/.test(text)) return c.line;
    throw new Error("offline: no model");
  }
  if (plan && plan.speakerId === view.selfId && plan.claimRole && !/don't say your role/.test(text)) {
    const role = String(plan.claimRole).toLowerCase();
    const lynch = plan.lynchTarget && view.players?.[plan.lynchTarget] && !view.dead?.[plan.lynchTarget] ? String(view.players[plan.lynchTarget].name || "").toLowerCase() : "";
    if (role === "cop") return lynch ? `im cop. ${lynch} is guilty, vote ${lynch}` : "im cop, no guilty yet";
    return lynch ? `im ${role}. vote ${lynch}` : `im ${role}`;
  }
  throw new Error("offline: no model");
}

function makeId(rng, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += ID_CHARS[Math.floor(rng() * ID_CHARS.length)];
  return s;
}

const turn = () => new Promise((r) => setImmediate(r));

/** Let ready async work run until the set of pending upgrades stops changing (timers stay parked). */
async function settle(table) {
  let last = -1; let same = 0;
  for (let i = 0; i < 400; i++) {
    await turn();
    const n = table.upgrades?.size || 0;
    if (n === last) { if (++same >= 3) return; } else { same = 0; last = n; }
  }
}

function emptyStats() {
  return {
    townBallots: [], // final Village ballots by town seats: { day, voter, target, onScum, baseline, abstain }
    voteOrder: [], // per day: first-vote order with alignments
    lynches: [], noLynchDays: 0,
    shots: [], kills: [], cleans: 0, litigates: [], copChecks: [], journalistChecks: [],
    claims: [], buses: [], vegs: [], scumChat: 0, publicLines: 0, cannedOrRules: 0,
    illegal: [], copGuiltyFollowUp: [], dayOutcomes: [], stale: 0, vegKickWindows: 0, killVoteMoves: [],
  };
}

function createServer({ seed, game, opts }) {
  const gseed = mixSeed(seed, `selfplay:${game}`);
  const rng = createSeededRng(gseed);
  const roleList = shuffle(FJ_ROLES, rng);
  const ids = roleList.map(() => makeId(rng, 11));
  const roles = {}; const names = {}; const accOf = {}; const pidOf = {};
  ids.forEach((id, i) => {
    roles[id] = roleList[i]; names[id] = NAMES[i];
    const acc = makeId(rng, 10); accOf[id] = acc; pidOf[acc] = id;
  });
  const clock = createVirtualClock(T0);
  const table = createBotTable(ids.map((id) => ({ accountId: accOf[id], promptId: "rulebot" })), { clock, rng: createSeededRng(mixSeed(gseed, "table")), copRule: opts.copRule, mafia: opts.mafia });
  const S = {
    seed, game, gseed, opts, ids, roles, names, accOf, pidOf, clock, table,
    complete: null, limiter: createLlmLimiter(4),
    alive: new Set(ids), seq: {}, stateId: 1, phase: "", day: 0, meetings: new Map(),
    gunUsed: false, cleansLeft: 1, pastMeetings: new Set(), cursor: 0, winner: null, events: [], errors: [],
    stats: emptyStats(), trace: emptyTraceFor(seed, game), mseq: 0,
  };
  // Stamp each proposal with what the server would have said the moment the seat sent it. A proposal
  // that was legal when sent but is overtaken before it is applied (its target or sender died in the
  // same instant) is a network race the server drops, not an illegal action.
  const stamps = new WeakMap();
  const push = table.proposed.push.bind(table.proposed);
  table.proposed.push = (...items) => {
    for (const p of items) if (p && typeof p === "object") stamps.set(p, serverVerdict(S, p) ?? "ok");
    return push(...items);
  };
  S.stampOf = (p) => stamps.get(p) || null;
  const byName = Object.fromEntries(ids.map((id) => [names[id].toLowerCase(), accOf[id]]));
  S.complete = createOfflineComplete({ speech: opts.speech, viewByName: (n) => table.views[byName[String(n).toLowerCase()]] || null });
  return S;
}

function emptyTraceFor(seed, game) {
  return {
    seed, game, setup: "Frontier Justice", winner: null, seats: [], lynches: [], townVotes: [],
    nightActions: [], checks: [], kills: [], decisions: [], illegal: { proposed: 0, blocked: 0 }, speech: [],
    messages: {}, dayPhases: {}, speechAllowed: {}, speechSent: {},
  };
}

const living = (S) => S.ids.filter((id) => S.alive.has(id));
const isScum = (S, id) => alignOf(S.roles[id]) === "Mafia";

async function deliver(S, pid, event, data) {
  const acc = S.accOf[pid];
  S.seq[acc] = (S.seq[acc] || 0) + 1;
  await onGameEntry(S.table, { accountId: acc, seq: S.seq[acc], t: S.clock.now(), event, data }, {
    complete: S.complete, dryRun: true, fast: true, limiter: S.limiter,
    onError: (err) => S.errors.push(`${S.names[pid]}: ${String(err?.message || err).slice(0, 160)}`),
    onSchedule: S.opts.onSchedule ? (acc, sch) => S.opts.onSchedule(S, S.pidOf[acc], sch) : undefined,
  });
}

async function deliverMany(S, pids, event, data) {
  for (const pid of pids) await deliver(S, pid, event, data);
}

function meetingFrame(S, m, pid) {
  const member = m.members.includes(pid);
  return {
    id: m.id, name: m.name, actionName: m.actionName, speech: !!m.speech && member, voting: !!m.voting,
    canVote: !!m.voting && member && S.alive.has(pid), canUpdateVote: !m.instant, instant: !!m.instant,
    amMember: member, targets: member ? [...(m.targets || [])] : [], members: m.members.map((id) => ({ id, canVote: !!m.voting })),
    votes: { ...m.ballots },
  };
}

function newMeeting(S, spec) {
  S.mseq += 1;
  const m = { id: `${S.phase.replace(/\s+/g, "").toLowerCase()}-${S.mseq}-${makeId(createSeededRng(mixSeed(S.gseed, `${S.phase}:${S.mseq}`)), 6)}`, ballots: {}, closed: false, noVeg: false, ...spec };
  S.meetings.set(m.id, m);
  return m;
}

async function openPhase(S, name, specs) {
  for (const id of S.meetings.keys()) S.pastMeetings.add(id);
  S.stateId += 1; S.phase = name; S.meetings = new Map();
  await deliverMany(S, S.ids, "state", { id: S.stateId, name });
  const made = specs.map((spec) => newMeeting(S, spec));
  for (const m of made) {
    const viewers = m.members;
    for (const pid of viewers) await deliver(S, pid, "meeting", meetingFrame(S, m, pid));
    if (name.startsWith("Night") && m.voting && m.name !== "Mafia Action") {
      for (const pid of m.members) S.trace.nightActions.push({ playerId: pid, role: S.roles[pid], meeting: m.name, open: true, taken: false, key: `${m.id}:${pid}` });
    }
  }
  return made;
}

function nightSpecs(S) {
  const live = living(S);
  const mafia = live.filter((id) => isScum(S, id));
  const others = (self) => live.filter((id) => id !== self);
  const specs = [];
  if (mafia.length) {
    specs.push({ name: "Mafia", speech: true, voting: false, members: mafia, noVeg: true });
    // Server MeetingFaction: Kill targets the living minus members, plus "*" (not mustAct); Action is mustAct + noVeg.
    specs.push({ name: "Mafia Kill", actionName: "Mafia Kill", voting: true, members: mafia, targets: [...live.filter((id) => !isScum(S, id)), "*"] });
    specs.push({ name: "Mafia Action", actionName: "End Meeting?", voting: true, noVeg: true, members: mafia, targets: ["Yes", "No"] });
  }
  // Single-actor night meetings are plain "voting" (not mustAct), so the server adds "*" to player targets.
  const one = (role, spec) => { const pid = live.find((id) => S.roles[id] === role); if (pid) specs.push({ ...spec, members: [pid], targets: spec.targets || [...others(pid), "*"], role }); };
  one("Cop", { name: "Cop", actionName: "Learn Alignment", voting: true });
  one("Journalist", { name: "Journalist", actionName: "Receive Reports", voting: true });
  one("Lawyer", { name: "Litigate", voting: true });
  if (S.cleansLeft > 0) one("Janitor", { name: "Clean Death", voting: true, targets: ["Yes", "No"] });
  return specs;
}

function daySpecs(S) {
  const live = living(S);
  const specs = [{ name: "Village", speech: true, voting: true, members: live, targets: [...live, "*"] }];
  const sheriff = live.find((id) => S.roles[id] === "Sheriff");
  if (sheriff && !S.gunUsed) specs.push({ name: "Shoot Gun", actionName: "Shoot Gun", voting: true, instant: true, noVeg: true, members: [sheriff], targets: [...live.filter((id) => id !== sheriff), "*"], role: "Sheriff" });
  return specs;
}

function illegal(S, p, pid, reason) {
  S.trace.illegal.proposed += 1; S.trace.illegal.blocked += 1;
  S.stats.illegal.push({ phase: S.phase, seat: S.names[pid] || p.accountId, role: S.roles[pid], event: p.event, source: p.source, reason });
}

/** Take every new proposal from the table, check it, apply it. Applying can wake seats; loop until quiet. */
async function pump(S) {
  for (let guard = 0; guard < 50 && S.cursor < S.table.proposed.length && !S.winner; guard++) {
    while (S.cursor < S.table.proposed.length && !S.winner) {
      const p = S.table.proposed[S.cursor++];
      await applyProposal(S, p);
    }
    await settle(S.table);
  }
}

/** Server truth plus engine validation for one proposal, now. null when legal. */
function serverVerdict(S, p) {
  const pid = S.pidOf[p.accountId];
  const view = S.table.views[p.accountId];
  if (!pid) return "unknown account";
  if (p.event !== "vote" && p.event !== "unvote" && p.event !== "speak") return `unsupported event ${p.event}`;
  if (!S.alive.has(pid)) return "dead seat acted";
  const m = S.meetings.get(p.data?.meetingId);
  if (!m && S.pastMeetings.has(p.data?.meetingId)) return "stale:phase over";
  if (!m || m.closed) return `unknown meeting ${p.data?.meetingId}`;
  if (!m.members.includes(pid)) return `not a member of ${m.name}`;
  const engine = validateAction(view, { event: p.event, data: p.data });
  if (!engine.ok) return `engine: ${engine.reason}`;
  if (p.event === "speak") {
    if (!m.speech) return `cannot speak in ${m.name}`;
    if (!String(p.data.content || "").trim()) return "empty content";
    return null;
  }
  if (!m.voting) return `cannot vote in ${m.name}`;
  if (p.event === "unvote") return m.instant ? "unvote not allowed" : null;
  const sel = p.data.selection;
  if (m.kick && !m.kickers.includes(pid)) return "cannot vote in Vote Kick (not voted everywhere)";
  if (!m.targets.includes(sel)) return `selection not in targets (${m.name})`;
  if (m.ballots[pid] != null && m.ballots[pid] !== sel && m.instant) return "vote locked";
  return null;
}

async function applyProposal(S, p) {
  const pid = S.pidOf[p.accountId];
  const why = serverVerdict(S, p);
  if (why) {
    const atSend = S.stampOf(p);
    // Phase already over, or legal when sent and overtaken since: the server drops it (a race).
    if (why.startsWith("stale:") || atSend === "ok" || atSend?.startsWith?.("stale:")) { S.stats.stale += 1; (S.stats.staleWhy ||= {})[why.replace(/\(.*|[A-Za-z0-9_-]{6,}$/g, "").trim()] = ((S.stats.staleWhy || {})[why.replace(/\(.*|[A-Za-z0-9_-]{6,}$/g, "").trim()] || 0) + 1; return; }
    return illegal(S, p, pid, atSend || why);
  }
  const m = S.meetings.get(p.data.meetingId);
  if (p.event === "speak") return speak(S, pid, m, String(p.data.content), p);
  if (p.event === "unvote") {
    delete m.ballots[pid];
    await deliverMany(S, viewersOf(S, m), "unvote", { meetingId: m.id, voterId: pid, target: p.data.selection });
    return;
  }
  const sel = p.data.selection;
  if (m.ballots[pid] === sel) return;
  const first = m.ballots[pid] == null;
  if (!first && m.name === "Mafia Kill") S.stats.killVoteMoves.push({ day: S.day, seat: S.names[pid], from: S.names[m.ballots[pid]] || m.ballots[pid], to: S.names[sel] || sel, source: p.source });
  m.ballots[pid] = sel;
  m.order ||= [];
  if (first) m.order.push({ voter: pid, target: sel, t: S.clock.now() });
  const tn = S.trace.nightActions.find((a) => a.key === `${m.id}:${pid}`);
  if (tn) tn.taken = sel !== "*" && sel !== "No";
  await deliverMany(S, viewersOf(S, m), "vote", { meetingId: m.id, voterId: pid, target: sel });
  if (m.instant) await resolveInstant(S, m, pid, sel);
}

function viewersOf(S, m) {
  return m.name === "Village" ? S.ids : m.members;
}

async function speak(S, pid, m, content, p) {
  const pub = m.name === "Village";
  if (pub) {
    S.stats.publicLines += 1;
    S.trace.messages[pid] = (S.trace.messages[pid] || 0) + 1;
    S.trace.speechSent[pid] = (S.trace.speechSent[pid] || 0) + 1;
    S.trace.speech.push({ seat: pid, phase: S.phase, text: content, allowed: true });
    const claimed = claimedRoleIn(content);
    if (claimed) S.stats.claims.push({ phase: S.phase, seat: S.names[pid], role: S.roles[pid], claimed, truthful: claimed === S.roles[pid], text: content.slice(0, 160) });
    if (/\bPLAN\b/.test(content)) S.stats.illegal.push({ phase: S.phase, seat: S.names[pid], role: S.roles[pid], event: "speak", source: p.source, reason: "faction PLAN leaked to public" });
  } else S.stats.scumChat += 1;
  S.events.push(`${S.phase} ${pub ? "" : `[${m.name}] `}${S.names[pid]}: ${content.slice(0, 200)}`);
  await deliverMany(S, viewersOf(S, m), "message", { meetingId: m.id, senderId: pid, content, t: S.clock.now() });
}

async function kill(S, pid, { reveal = true, how }) {
  S.alive.delete(pid);
  S.events.push(`${S.phase} ${S.names[pid]} (${S.roles[pid]}) dies: ${how}${reveal ? "" : " [cleaned]"}`);
  await deliverMany(S, S.ids, "death", pid);
  if (reveal) await deliverMany(S, S.ids, "reveal", { playerId: pid, role: S.roles[pid] });
  // Open meetings drop the dead as member and target; votes on them are cleared and the meeting is re-sent.
  for (const m of S.meetings.values()) {
    if (m.closed) continue;
    const touched = m.members.includes(pid) || (m.targets || []).includes(pid);
    if (!touched) continue;
    delete m.ballots[pid];
    const cleared = Object.entries(m.ballots).filter(([, target]) => target === pid).map(([voter]) => voter);
    for (const voter of cleared) { delete m.ballots[voter]; (m.clearedVoters ||= new Set()).add(voter); }
    m.members = m.members.filter((id) => id !== pid);
    m.targets = (m.targets || []).filter((id) => id !== pid);
    for (const voter of cleared) await deliverMany(S, viewersOf(S, m), "unvote", { meetingId: m.id, voterId: voter, target: pid });
    for (const member of m.members) await deliver(S, member, "meeting", meetingFrame(S, m, member));
  }
}

async function resolveInstant(S, m, shooter, target) {
  m.closed = true; S.gunUsed = true;
  const hit = isScum(S, target);
  const pool = living(S).filter((id) => id !== shooter);
  S.stats.shots.push({ day: S.day, sheriff: S.names[shooter], target: S.names[target], targetRole: S.roles[target], hit, baseline: pool.filter((id) => isScum(S, id)).length / pool.length, t: Math.round((S.clock.now() - S.phaseStart) / 1000) });
  await deliverMany(S, S.ids, "message", { senderId: "server", content: `${S.names[shooter]} pulls a gun and shoots ${S.names[target]}!` });
  await deliverMany(S, S.ids, "reveal", { playerId: shooter, role: S.roles[shooter] });
  await deliver(S, shooter, "leftMeeting", m.id);
  await kill(S, target, { how: "shot by the Sheriff" });
  checkWin(S);
}

function checkWin(S) {
  if (S.winner) return S.winner;
  const w = winnerFor(S.roles, living(S));
  if (w) S.winner = w;
  return w;
}

/** Tick a phase on the virtual clock: time frames, settle, take proposals. */
async function runPhase(S, ms, { endEarly, timer = "main" } = {}) {
  if (timer === "main") S.phaseStart = S.clock.now();
  await deliverMany(S, living(S), "timerInfo", { name: timer, delay: ms });
  await settle(S.table); await pump(S);
  for (let left = ms - S.opts.tickMs; left >= 0 && !S.winner; left -= S.opts.tickMs) {
    S.clock.advance(S.opts.tickMs);
    await settle(S.table); await pump(S);
    await deliverMany(S, living(S), "time", { name: timer, time: left });
    await settle(S.table); await pump(S);
    if (S.opts.onTick) S.opts.onTick(S, left);
    if (endEarly && endEarly()) break;
  }
}

/** Server Meeting.ready: every living member voted and the top choice is not tied. */
function meetingReady(S, m) {
  if (!m.voting || m.closed || m.instant) return true;
  const voters = m.members.filter((id) => S.alive.has(id));
  if (voters.some((id) => m.ballots[id] == null)) return false;
  const counts = {};
  for (const id of voters) counts[m.ballots[id]] = (counts[m.ballots[id]] || 0) + 1;
  const sorted = Object.values(counts).sort((a, b) => b - a);
  return sorted.length <= 1 || sorted[0] > sorted[1];
}

/** Night: every meeting ready ends the phase early (checkAllMeetingsReady). */
function nightReady(S) {
  for (const m of S.meetings.values()) if (!meetingReady(S, m)) return false;
  return true;
}

/** Day: only Important meetings count (Village); the gun is not Important. */
function dayReady(S) {
  const v = byName(S, "Village");
  return !v || meetingReady(S, v);
}

/** Members of a must-act meeting who never voted get veg-kicked at phase end (server VegKick). */
function vegs(S) {
  const out = new Map();
  for (const m of S.meetings.values()) {
    if (!m.voting || m.noVeg || m.closed) continue;
    for (const pid of m.members) if (S.alive.has(pid) && m.ballots[pid] == null && !out.has(pid)) out.set(pid, m);
  }
  for (const [pid, m] of out) S.stats.vegs.push({ phase: S.phase, seat: S.names[pid], role: S.roles[pid], meeting: m.name, cause: vegCause(S, pid, m) });
  return [...out.keys()];
}

/**
 * Server checkVeg: the main timer ran out with meetings not ready. A "Vote Kick" meeting opens (seats
 * that voted everywhere may kick; the rest are warned) and the phase ends when everything is ready, all
 * kickers kick, or the countdown runs out. Non-voters in must-vote meetings are then vegged.
 */
async function vegKickWindow(S, ready) {
  const voted = (pid) => [...S.meetings.values()].every((m) => !m.voting || m.noVeg || m.instant || m.closed || !m.members.includes(pid) || m.ballots[pid] != null);
  const live = living(S);
  const kickers = live.filter(voted);
  const kick = newMeeting(S, { name: "Vote Kick", voting: true, noVeg: true, members: live, targets: ["Kick"], kick: true, kickers });
  S.stats.vegKickWindows = (S.stats.vegKickWindows || 0) + 1;
  for (const pid of live) {
    await deliver(S, pid, "meeting", { ...meetingFrame(S, kick, pid), canVote: kickers.includes(pid) });
    if (!kickers.includes(pid)) await deliver(S, pid, "youAreBeingVoteKicked", { status: true });
  }
  const allKicked = () => kickers.length > 0 && kickers.every((pid) => kick.ballots[pid] === "Kick" || !S.alive.has(pid));
  await runPhase(S, S.opts.vegKickMs, { endEarly: () => ready() || allKicked(), timer: "vegKickCountdown" });
  kick.closed = true;
}

/** Why a seat never voted: its vote was wiped when the target died, the PLAN's lynch target died, or other. */
function vegCause(S, pid, m) {
  const proposed = S.table.proposed.some((p) => p.accountId === S.accOf[pid] && p.event === "vote" && p.data?.meetingId === m.id);
  if (m.clearedVoters?.has(pid)) return `${m.name}: vote cleared when its target died; never re-voted`;
  if (m.name === "Litigate") {
    const plan = agreedPlan(S.table.views[S.accOf[pid]]);
    if (plan && !plan.lawyerTarget) return "Litigate: PLAN names no lawyer target; Lawyer never voted";
  }
  if (isScum(S, pid) && S.phase.startsWith("Day")) {
    const plan = agreedPlan(S.table.views[S.accOf[pid]]);
    if (plan?.speakerId === pid && plan.lynchTarget && !S.alive.has(plan.lynchTarget)) return `${m.name}: PLAN speaker whose PLAN lynch target died (shot) before the vote`;
    if (plan?.lynchTarget && !S.alive.has(plan.lynchTarget)) return `${m.name}: PLAN lynch target died before the vote`;
  }
  return `${m.name}: ${proposed ? "proposed a vote that never landed" : "never proposed a vote"}`;
}

/** The mafia's agreed PLAN as a living mafia seat sees it (null when none). */
function mafiaPlan(S) {
  for (const id of living(S)) if (isScum(S, id)) { const plan = agreedPlan(S.table.views[S.accOf[id]]); if (plan) return plan; }
  return null;
}

const byName = (S, name) => S.meetings && [...S.meetings.values()].find((m) => m.name === name);

async function playNight(S) {
  S.day += 1;
  await openPhase(S, `Night ${S.day}`, nightSpecs(S));
  await runPhase(S, S.opts.nightMs, { endEarly: () => nightReady(S) });
  if (!S.winner && !nightReady(S)) await vegKickWindow(S, () => nightReady(S));
  if (S.winner) return { deaths: [], alerts: [] };
  const vegged = vegs(S);
  const live = living(S);
  const mk = byName(S, "Mafia Kill");
  const killTarget = mk ? plurality(mk.members.filter((id) => S.alive.has(id)).map((id) => mk.ballots[id])) : null;
  const victim = killTarget && S.alive.has(killTarget) && !isScum(S, killTarget) ? killTarget : null;
  const lit = byName(S, "Litigate");
  const lawyer = lit?.members[0];
  const litTarget = lit && S.alive.has(lawyer) ? lit.ballots[lawyer] : null;
  // FJ's Lawyer is Loyal (restartq Role.js): an action on a player of the other alignment is blocked. The
  // Litigate (FlipAlignment card) sets the target's investigate appearance to the opposite alignment, so a
  // Loyal Lawyer can only make a teammate read Innocent; a Cop's Guilty can never be faked.
  const blocked = !!(litTarget && litTarget !== "*" && S.opts.lawyer === "loyal" && !isScum(S, litTarget));
  const flipped = litTarget && litTarget !== "*" && !blocked ? litTarget : null;
  if (litTarget && litTarget !== "*") S.stats.litigates.push({ day: S.day, target: S.names[litTarget], targetRole: S.roles[litTarget], teammate: isScum(S, litTarget), blocked });
  const clean = byName(S, "Clean Death");
  const janitor = clean?.members[0];
  const cleaned = !!(victim && clean && S.alive.has(janitor) && clean.ballots[janitor] === "Yes" && S.cleansLeft > 0);
  const reports = {}; // pid -> [text] alerts this night
  const add = (pid, text) => (reports[pid] ||= []).push(text);
  if (cleaned) { S.cleansLeft -= 1; S.stats.cleans += 1; add(janitor, `You learn that ${S.names[victim]}'s role is ${S.roles[victim]}.`); }
  const cop = byName(S, "Cop");
  const copId = cop?.members[0];
  const copTarget = cop && S.alive.has(copId) ? cop.ballots[copId] : null;
  if (copTarget) {
    const scum = isScum(S, copTarget) !== (flipped === copTarget);
    add(copId, `Your investigation shows that ${S.names[copTarget]} is ${scum ? "Guilty" : "Innocent"}.`);
    S.stats.copChecks.push({ day: S.day, target: copTarget, name: S.names[copTarget], targetRole: S.roles[copTarget], result: scum ? "Guilty" : "Innocent", litigated: flipped === copTarget, correct: scum === isScum(S, copTarget) });
    S.trace.checks.push({ actorRole: "Cop", targetRole: S.roles[copTarget], targetAlignment: scum ? "Mafia" : "Village" });
  }
  const jo = byName(S, "Journalist");
  const joId = jo?.members[0];
  const joTarget = jo && S.alive.has(joId) ? jo.ballots[joId] : null;
  if (joTarget) {
    const got = reports[joTarget] || [];
    add(joId, got.length ? `You received all reports that ${S.names[joTarget]} received: ${got.join(" ")}` : `You learn that ${S.names[joTarget]} received no reports.`);
    S.stats.journalistChecks.push({ day: S.day, target: S.names[joTarget], targetRole: S.roles[joTarget], sawReport: got.length > 0 });
    S.trace.checks.push({ actorRole: "Journalist", targetRole: S.roles[joTarget], sawReport: got.length > 0 });
  }
  if (victim) {
    S.stats.kills.push({ day: S.day, target: S.names[victim], role: S.roles[victim], cleaned });
    S.trace.kills.push({ living: live.map((id) => S.roles[id]), targetRole: S.roles[victim] });
  }
  return { victim, cleaned, vegged, reports };
}

async function playDay(S, night) {
  await openPhase(S, `Day ${S.day}`, []);
  for (const pid of night.vegged || []) await kill(S, pid, { how: "veg-kicked" });
  if (night.victim) await kill(S, night.victim, { reveal: !night.cleaned, how: "killed by the Mafia" });
  for (const [pid, lines] of Object.entries(night.reports || {})) {
    for (const content of lines) await deliver(S, pid, "message", { senderId: "server", content });
  }
  if (checkWin(S)) return;
  const made = [];
  for (const spec of daySpecs(S)) made.push(newMeeting(S, spec));
  for (const m of made) for (const pid of m.members) await deliver(S, pid, "meeting", meetingFrame(S, m, pid));
  for (const pid of living(S)) S.trace.dayPhases[pid] = (S.trace.dayPhases[pid] || 0) + 1;
  await runPhase(S, S.opts.dayMs, { endEarly: () => dayReady(S) });
  if (!S.winner && !dayReady(S)) await vegKickWindow(S, () => dayReady(S));
  if (S.winner) return recordDayVotes(S, made[0]);
  const vegged = vegs(S);
  recordDayVotes(S, made[0]);
  const village = made[0];
  const ballots = village.members.filter((id) => S.alive.has(id)).map((id) => village.ballots[id]).filter((t) => t != null);
  const lynch = pluralityWithNoOne(ballots);
  const tally = {};
  for (const id of village.members.filter((x) => S.alive.has(x))) { const t = village.ballots[id]; if (t != null) (tally[t] ||= []).push(S.names[id]); }
  S.events.push(`${S.phase} votes: ${Object.entries(tally).map(([t, vs]) => `${S.names[t] || "no one"} <- ${vs.join(",")}`).join("; ") || "none"}`);
  const plan = mafiaPlan(S);
  const liveNow = living(S);
  S.stats.dayOutcomes.push({
    day: S.day, lynch: lynch ? S.names[lynch] : null, lynchScum: lynch ? isScum(S, lynch) : null,
    randomLynchBaseline: liveNow.filter((id) => isScum(S, id)).length / liveNow.length,
    planTarget: plan?.lynchTarget ? S.names[plan.lynchTarget] || null : null,
    planTargetAlive: !!(plan?.lynchTarget && S.alive.has(plan.lynchTarget)),
    lynchOnPlan: !!(lynch && plan?.lynchTarget === lynch),
    scumVotesOnLynch: lynch ? village.members.filter((id) => S.alive.has(id) && isScum(S, id) && village.ballots[id] === lynch).length : 0,
    townVotesOnLynch: lynch ? village.members.filter((id) => S.alive.has(id) && !isScum(S, id) && village.ballots[id] === lynch).length : 0,
    townTargets: new Set(village.members.filter((id) => S.alive.has(id) && !isScum(S, id) && village.ballots[id] && village.ballots[id] !== "*").map((id) => village.ballots[id])).size,
    scumFakeClaim: S.stats.claims.some((c) => c.phase === S.phase && !c.truthful && alignOf(c.role) === "Mafia"),
  });
  if (lynch) {
    S.stats.lynches.push({ day: S.day, target: S.names[lynch], role: S.roles[lynch], scum: isScum(S, lynch), votes: ballots.filter((t) => t === lynch).length });
    S.trace.lynches.push({ targetAlignment: alignOf(S.roles[lynch]), targetRole: S.roles[lynch] });
    await kill(S, lynch, { how: "lynched" });
  } else S.stats.noLynchDays += 1;
  for (const pid of vegged) if (S.alive.has(pid)) await kill(S, pid, { how: "veg-kicked" });
  checkWin(S);
}

function pluralityWithNoOne(votes) {
  const counts = new Map();
  for (const v of votes) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let n = 0; let tie = false;
  for (const [id, c] of counts) { if (c > n) { best = id; n = c; tie = false; } else if (c === n) tie = true; }
  return tie || best === "*" ? null : best;
}

function recordDayVotes(S, village) {
  if (!village || village.recorded) return;
  village.recorded = true;
  const live = village.members.filter((id) => S.alive.has(id) || village.ballots[id] != null);
  const mafiaAlive = village.members.filter((id) => S.alive.has(id) && isScum(S, id));
  for (const voter of village.members) {
    if (isScum(S, voter)) {
      const t = village.ballots[voter];
      if (t && t !== "*" && isScum(S, t)) S.stats.buses.push({ day: S.day, voter: S.names[voter], target: S.names[t], targetRole: S.roles[t] });
      continue;
    }
    if (!S.alive.has(voter)) continue;
    const t = village.ballots[voter];
    const pool = village.members.filter((id) => id !== voter && S.alive.has(id));
    const baseline = pool.length ? mafiaAlive.length / pool.length : 0;
    if (t == null || t === "*") { S.stats.townBallots.push({ day: S.day, voter: S.names[voter], abstain: true, baseline }); continue; }
    const onScum = isScum(S, t);
    S.stats.townBallots.push({ day: S.day, voter: S.names[voter], role: S.roles[voter], target: S.names[t], onScum, baseline });
    S.trace.townVotes.push({ targetAlignment: alignOf(S.roles[t]) });
  }
  const order = (village.order || []).filter((o) => o.target !== "*");
  S.stats.voteOrder.push({
    day: S.day,
    order: order.map((o) => ({ voter: S.names[o.voter], scum: isScum(S, o.voter), t: Math.round((o.t - S.phaseStart) / 1000) })),
    scumShare: live.length ? mafiaAlive.length / village.members.filter((id) => S.alive.has(id)).length : 0,
  });
  // Cop found scum: was that player lynched or shot today?
  for (const c of S.stats.copChecks.filter((x) => x.day === S.day && x.result === "Guilty")) {
    const dead = !S.alive.has(c.target);
    const copAlive = S.ids.some((id) => S.roles[id] === "Cop" && S.alive.has(id));
    S.stats.copGuiltyFollowUp.push({ day: S.day, target: c.name, actedOn: dead || (village.ballots && pluralityWithNoOne(Object.values(village.ballots)) === c.target), copAlive });
  }
}

/** Play one seeded FJ game end to end. Never throws: errors land on the result. */
export async function playSelfplayGame({ seed = 1, game = 0, ...rest } = {}) {
  const opts = { ...SELFPLAY_DEFAULTS, ...rest };
  const S = createServer({ seed, game, opts });
  let error = null;
  try {
    const players = Object.fromEntries(S.ids.map((id) => [id, { id, name: S.names[id] }]));
    for (const pid of S.ids) { await deliver(S, pid, "self", pid); await deliver(S, pid, "players", players); }
    for (const pid of S.ids) await deliver(S, pid, "roleReveal", { playerId: pid, role: S.roles[pid] });
    await settle(S.table);
    while (!S.winner && S.day < opts.maxDays) {
      const night = await playNight(S);
      if (S.winner) break;
      await playDay(S, night);
    }
    if (!S.winner) error = `no winner after ${opts.maxDays} days`;
    else await deliverMany(S, S.ids, "winners", { groups: [S.winner], players: S.ids.filter((id) => alignOf(S.roles[id]) === S.winner) });
  } catch (err) {
    error = `${err?.name || "Error"}: ${err?.message || err}`;
  }
  return finish(S, error);
}

function finish(S, error) {
  const winner = S.winner || (error ? "error" : "draw");
  S.trace.winner = S.winner || "draw";
  S.trace.seats = S.ids.map((id) => ({
    id, role: S.roles[id], alignment: alignOf(S.roles[id]), kind: "rule", promptId: "rulebot",
    messages: S.trace.messages[id] || 0, dayPhases: S.trace.dayPhases[id] || 0,
    speechAllowed: S.trace.dayPhases[id] || 0, speechSent: S.trace.speechSent[id] || 0,
    won: alignOf(S.roles[id]) === S.winner,
  }));
  for (const p of S.table.proposed) S.trace.decisions.push({ source: String(p.source || "").replace(/\+delay$/, "") });
  const record = scoreGame(S.trace);
  const out = {
    seed: S.seed, game: S.game, winner, error, days: S.day,
    minutes: Math.round((S.clock.now() - T0) / 600) / 100,
    roles: Object.fromEntries(S.ids.map((id) => [S.names[id], S.roles[id]])),
    survivors: living(S).map((id) => `${S.names[id]} (${S.roles[id]})`),
    proposals: S.table.proposed.length, harnessErrors: S.errors.length, stats: S.stats, record,
    log: S.events,
  };
  if (S.opts.keepServer) Object.defineProperty(out, "server", { value: S, enumerable: false });
  return out;
}

/** Run N games from one seed. Game i uses mixSeed(seed, "selfplay:i"). */
export async function runSelfplay({ games = 50, seed = 1, onGame, ...rest } = {}) {
  const results = [];
  for (let game = 0; game < games; game++) {
    const r = await playSelfplayGame({ seed, game, ...rest });
    results.push(r);
    if (onGame) onGame(r);
  }
  return { results, scorecard: buildScorecard(results, { seed, games, ...rest }) };
}

const pct = (x) => (x == null ? "n/a" : `${(100 * x).toFixed(1)}%`);
const rate = (a, b) => (b ? a / b : null);

export function buildScorecard(results, { seed, games, ...rest } = {}) {
  const all = (key) => results.flatMap((r) => r.stats[key]);
  const n = results.length;
  const wins = { Village: 0, Mafia: 0, draw: 0, error: 0 };
  for (const r of results) wins[r.winner] = (wins[r.winner] || 0) + 1;
  const ballots = all("townBallots");
  const cast = ballots.filter((b) => !b.abstain);
  const onScum = cast.filter((b) => b.onScum).length;
  const baseline = cast.length ? cast.reduce((s, b) => s + b.baseline, 0) / cast.length : null;
  const lynches = all("lynches");
  const shots = all("shots");
  const checks = all("copChecks");
  const claims = all("claims");
  const order = all("voteOrder");
  const firstVoter = order.filter((d) => d.order.length);
  const scumFirst = firstVoter.filter((d) => d.order[0].scum).length;
  const scumFirstBase = firstVoter.length ? firstVoter.reduce((s, d) => s + d.scumShare, 0) / firstVoter.length : null;
  const scumPos = []; const townPos = [];
  for (const d of firstVoter) d.order.forEach((o, i) => (o.scum ? scumPos : townPos).push(d.order.length > 1 ? i / (d.order.length - 1) : 0.5));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const guilty = all("copGuiltyFollowUp");
  const illegalList = all("illegal");
  const days = results.map((r) => r.days);
  const errors = results.filter((r) => r.error).map((r) => ({ game: r.game, error: r.error }));
  const card = {
    seed, games: games ?? n, copRule: rest.copRule || SELFPLAY_DEFAULTS.copRule, lawyer: rest.lawyer || SELFPLAY_DEFAULTS.lawyer, mafiaMode: rest.mafia || SELFPLAY_DEFAULTS.mafia, setup: "Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)",
    path: "harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)",
    winRate: { Village: rate(wins.Village, n), Mafia: rate(wins.Mafia, n), draw: rate(wins.draw, n), error: rate(wins.error, n), counts: wins },
    townVotes: {
      ballots: ballots.length, cast: cast.length, abstained: ballots.length - cast.length,
      onScum, share: rate(onScum, cast.length), randomBaseline: baseline,
      lift: cast.length ? rate(onScum, cast.length) - baseline : null,
      baselineMethod: "analytic: for each final town ballot, living mafia / living players other than the voter, under the same state; averaged",
    },
    lynches: { total: lynches.length, scum: lynches.filter((l) => l.scum).length, accuracy: rate(lynches.filter((l) => l.scum).length, lynches.length), noLynchDays: all("noLynchDays").reduce?.((a, b) => a + b, 0) ?? results.reduce((s, r) => s + r.stats.noLynchDays, 0) },
    illegalActions: { total: illegalList.length, byReason: countBy(illegalList, (x) => x.reason.replace(/\(.*\)|[A-Za-z0-9_-]{6,}$/g, "").trim()), samples: illegalList.slice(0, 10) },
    gameLength: { meanDays: mean(days), minDays: Math.min(...days), maxDays: Math.max(...days), histogram: countBy(days, (d) => String(d)), meanVirtualMinutes: mean(results.map((r) => r.minutes)) },
    sheriff: { randomBaseline: mean(shots.map((x) => x.baseline)), shots: shots.length, hits: shots.filter((s) => s.hit).length, accuracy: rate(shots.filter((s) => s.hit).length, shots.length), byDay: countBy(shots, (s) => `Day ${s.day}`), misses: shots.filter((s) => !s.hit).map((s) => `${s.targetRole}`) },
    cop: { checks: checks.length, guilty: checks.filter((c) => c.result === "Guilty").length, wrongFromLitigate: checks.filter((c) => !c.correct).length, guiltyActedOnSameDay: guilty.filter((g) => g.actedOn).length, guiltyTotal: guilty.length,
      guiltyActedOnSameDayCopAlive: guilty.filter((g) => g.actedOn && g.copAlive).length, guiltyCopAlive: guilty.filter((g) => g.copAlive).length,
      innocentOnScum: checks.filter((c) => c.result === "Innocent" && c.litigated).length },
    claims: { total: claims.length, byClaim: countBy(claims, (c) => `${c.role}->${c.claimed}`), fake: claims.filter((c) => !c.truthful).length },
    mafia: {
      buses: all("buses").length, kills: all("kills").length, killsByRole: countBy(all("kills"), (k) => k.role),
      cleans: all("cleans").reduce?.((a, b) => a + b, 0) ?? results.reduce((s, r) => s + r.stats.cleans, 0),
      litigates: all("litigates").length, litigateOnTeammate: all("litigates").filter((l) => l.teammate).length,
      factionChatLines: results.reduce((s, r) => s + r.stats.scumChat, 0),
      voteTiming: { daysWithVotes: firstVoter.length, scumVotedFirst: scumFirst, scumFirstRate: rate(scumFirst, firstVoter.length), scumFirstBaseline: scumFirstBase, meanScumPosition: mean(scumPos), meanTownPosition: mean(townPos) },
    },
    vegs: all("vegs").length,
    vegCauses: countBy(all("vegs"), (v) => v.cause),
    vegKickWindows: results.reduce((s, r) => s + (r.stats.vegKickWindows || 0), 0),
    staleProposals: results.reduce((s, r) => s + (r.stats.stale || 0), 0),
    lynchSteering: steering(all("dayOutcomes")),
    publicLines: results.reduce((s, r) => s + r.stats.publicLines, 0),
    harnessErrors: results.reduce((s, r) => s + r.harnessErrors, 0),
    errors,
    metrics: summarizeMetrics(results.map((r) => r.record)),
  };
  card.cleans = results.reduce((s, r) => s + r.stats.cleans, 0);
  card.mafia.cleans = card.cleans;
  card.lynches.noLynchDays = results.reduce((s, r) => s + r.stats.noLynchDays, 0);
  card.weaknesses = rankWeaknesses(card, results);
  card.topWeakness = card.weaknesses[0] || null;
  card.mafia.killVoteMoves = all("killVoteMoves").length;
  card.examples = exampleFor(card.topWeakness, results);
  return card;
}

/** A short game log that shows the top weakness (first game where it happens). */
function exampleFor(top, results) {
  if (!top) return [];
  const pick = (pred) => results.find(pred);
  let r = null; let upTo = null;
  if (top.id === "lynch-steered-by-mafia") {
    r = pick((x) => x.stats.dayOutcomes.some((d) => d.lynchOnPlan && !d.lynchScum));
    const d = r?.stats.dayOutcomes.find((o) => o.lynchOnPlan && !o.lynchScum);
    if (d) upTo = (line) => line.startsWith(`Day ${d.day} `) && /dies: lynched/.test(line);
  } else if (top.id === "vegs") {
    r = pick((x) => x.stats.vegs.length);
    upTo = (line) => /veg-kicked/.test(line);
  } else if (top.id === "sheriff-misfires") {
    r = pick((x) => x.stats.shots.some((s) => !s.hit));
    upTo = (line) => /shot by the Sheriff/.test(line);
  }
  if (!r) return [];
  const end = upTo ? r.log.findIndex(upTo) : 20;
  return [`game ${r.game} (seed ${r.seed}); roles: ${Object.entries(r.roles).map(([n, role]) => `${n}=${role}`).join(", ")}`, ...r.log.slice(0, end < 0 ? 20 : end + 1)];
}

function countBy(list, key) {
  const out = {};
  for (const x of list) { const k = key(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

function steering(days) {
  const lynched = days.filter((d) => d.lynch);
  const withPlan = lynched.filter((d) => d.planTarget);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    days: days.length, lynchDays: lynched.length,
    randomLynchBaseline: mean(lynched.map((d) => d.randomLynchBaseline)),
    lynchOnPlanTarget: withPlan.filter((d) => d.lynchOnPlan).length, lynchDaysWithPlan: withPlan.length,
    mislynchOnPlanTarget: lynched.filter((d) => d.lynchOnPlan && !d.lynchScum).length,
    mislynches: lynched.filter((d) => !d.lynchScum).length,
    meanScumVotesOnMislynch: mean(lynched.filter((d) => !d.lynchScum).map((d) => d.scumVotesOnLynch)),
    meanTownVotesOnMislynch: mean(lynched.filter((d) => !d.lynchScum).map((d) => d.townVotesOnLynch)),
    meanDistinctTownTargets: mean(days.map((d) => d.townTargets)),
    daysWithScumFakeClaim: days.filter((d) => d.scumFakeClaim).length,
    mislynchAfterScumFakeClaim: lynched.filter((d) => d.scumFakeClaim && !d.lynchScum).length,
    lynchDaysAfterScumFakeClaim: lynched.filter((d) => d.scumFakeClaim).length,
  };
}

/**
 * Candidate weaknesses, highest severity first. Severity = shortfall x coverage, in [0, 1]:
 * shortfall is how far a rate falls below its random baseline (relative), or the failure share;
 * coverage is the share of games where the situation came up. Evidence is plain numbers.
 */
export function rankWeaknesses(card, results) {
  const n = Math.max(1, results.length);
  const games = (pred) => results.filter(pred).length / n;
  const w = [];
  const add = (id, title, shortfall, coverage, evidence) => w.push({ id, title, severity: Math.max(0, Math.min(1, shortfall * coverage)), shortfall: round3(shortfall), coverage: round3(coverage), evidence });
  const ls = card.lynchSteering;
  if (ls.lynchDays && ls.randomLynchBaseline) {
    const acc = card.lynches.accuracy ?? 0;
    add("lynch-steered-by-mafia", "Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch",
      Math.max(0, (ls.randomLynchBaseline - acc) / ls.randomLynchBaseline), games((r) => r.stats.lynches.length > 0),
      `lynch accuracy ${pct(acc)} (${card.lynches.scum}/${card.lynches.total}) vs ${pct(ls.randomLynchBaseline)} for a random lynch; ${ls.lynchOnPlanTarget}/${ls.lynchDaysWithPlan} lynches hit the mafia PLAN's push target; on mislynches scum put ${fmt(ls.meanScumVotesOnMislynch)} votes and town ${fmt(ls.meanTownVotesOnMislynch)} on the lynched player; town spread over ${fmt(ls.meanDistinctTownTargets)} targets a day; ${ls.mislynchAfterScumFakeClaim}/${ls.lynchDaysAfterScumFakeClaim} lynch days with a scum fake claim ended in a mislynch; town ballots on scum ${pct(card.townVotes.share)} vs random ${pct(card.townVotes.randomBaseline)}; ${card.lynches.noLynchDays} no-lynch days`);
  }
  const tv = card.townVotes;
  if (tv.cast && tv.randomBaseline) {
    add("town-votes-near-random", "Town ballots barely beat a random voter", Math.max(0, 1 - (tv.share / tv.randomBaseline - 1) * 5) * 0.5, 1,
      `${tv.onScum}/${tv.cast} final town ballots on scum (${pct(tv.share)}) vs random ${pct(tv.randomBaseline)}; lift ${(tv.lift * 100).toFixed(1)} pts`);
  }
  const sh = card.sheriff;
  if (sh.shots && sh.randomBaseline) {
    add("sheriff-misfires", "Sheriff shoots town at about (or worse than) random", Math.max(0, (sh.randomBaseline - sh.accuracy) / sh.randomBaseline) + (1 - sh.accuracy) * 0.25, games((r) => r.stats.shots.length > 0),
      `${sh.shots - sh.hits}/${sh.shots} shots hit town (${countSummary(countBy(sh.misses, (x) => x))}); accuracy ${pct(sh.accuracy)} vs ${pct(sh.randomBaseline)} random; shots by day ${countSummary(sh.byDay)}`);
  }
  const cop = card.cop;
  if (cop.guiltyTotal) {
    const ignored = cop.guiltyTotal - cop.guiltyActedOnSameDay;
    add("cop-guilty-ignored", "Cop guilties are not acted on", ignored / cop.guiltyTotal, games((r) => r.stats.copGuiltyFollowUp.length > 0),
      `${ignored}/${cop.guiltyTotal} Guilty results not lynched or shot that day; ${cop.wrongFromLitigate}/${cop.checks} Cop results flipped by the Lawyer`);
  }
  if (card.vegs) {
    add("vegs", "Seats veg (never cast a must-act vote)", Math.min(1, card.vegs / n), games((r) => r.stats.vegs.length > 0),
      `${card.vegs} veg kicks in ${results.filter((r) => r.stats.vegs.length).length}/${n} games; causes: ${countSummary(card.vegCauses)}`);
  }
  const vt = card.mafia.voteTiming;
  if (vt.daysWithVotes && vt.scumFirstBaseline != null) {
    const tell = Math.abs((vt.meanTownPosition ?? 0.5) - (vt.meanScumPosition ?? 0.5)) * 2 + Math.max(0, vt.scumFirstRate - vt.scumFirstBaseline);
    add("mafia-vote-timing", "Mafia vote timing is a tell", tell, 1,
      `scum cast the first Village vote on ${vt.scumVotedFirst}/${vt.daysWithVotes} days (${pct(vt.scumFirstRate)} vs ${pct(vt.scumFirstBaseline)} if order were random); mean vote position scum ${fmt(vt.meanScumPosition)} vs town ${fmt(vt.meanTownPosition)} (0 = first)`);
  }
  if (card.illegalActions.total) add("illegal-actions", "Illegal actions reach the server", 1, 1, `${card.illegalActions.total} illegal: ${countSummary(card.illegalActions.byReason)}`);
  return w.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id)).map((x) => ({ ...x, severity: round3(x.severity) }));
}

const round3 = (x) => Math.round(x * 1000) / 1000;
const fmt = (x) => (x == null ? "n/a" : x.toFixed(2));
const countSummary = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

export function scorecardMarkdown(card) {
  const L = [];
  L.push(`# Self-play scorecard: ${card.games} games, seed ${card.seed}`, "");
  L.push(`Setup: ${card.setup}`, `Decision path: ${card.path}`, `Cop rule: ${card.copRule}; Lawyer: ${card.lawyer}; Mafia: ${card.mafiaMode}`, "");
  L.push("| Metric | Value |", "|---|---|");
  L.push(`| Village win rate | ${pct(card.winRate.Village)} (${card.winRate.counts.Village}) |`);
  L.push(`| Mafia win rate | ${pct(card.winRate.Mafia)} (${card.winRate.counts.Mafia}) |`);
  L.push(`| Draw / error | ${card.winRate.counts.draw || 0} / ${card.winRate.counts.error || 0} |`);
  L.push(`| Town ballots on scum | ${pct(card.townVotes.share)} (${card.townVotes.onScum}/${card.townVotes.cast}) |`);
  L.push(`| Random-vote baseline | ${pct(card.townVotes.randomBaseline)} |`);
  L.push(`| Lift over random | ${card.townVotes.lift == null ? "n/a" : (card.townVotes.lift * 100).toFixed(1) + " pts"} |`);
  L.push(`| Town abstains (no vote / no one) | ${card.townVotes.abstained} |`);
  L.push(`| Lynch accuracy | ${pct(card.lynches.accuracy)} (${card.lynches.scum}/${card.lynches.total}), ${card.lynches.noLynchDays} no-lynch days |`);
  L.push(`| Illegal actions | ${card.illegalActions.total} |`);
  L.push(`| Game length | mean ${fmt(card.gameLength.meanDays)} days (min ${card.gameLength.minDays}, max ${card.gameLength.maxDays}); ${countSummary(card.gameLength.histogram)} |`);
  L.push(`| Sheriff shots | ${card.sheriff.hits}/${card.sheriff.shots} hit scum (${pct(card.sheriff.accuracy)} vs ${pct(card.sheriff.randomBaseline)} random) |`);
  L.push(`| Cop checks | ${card.cop.checks}, ${card.cop.guilty} Guilty, ${card.cop.wrongFromLitigate} flipped by Lawyer; Guilty acted on same day ${card.cop.guiltyActedOnSameDay}/${card.cop.guiltyTotal} (Cop alive that day: ${card.cop.guiltyActedOnSameDayCopAlive}/${card.cop.guiltyCopAlive}) |`);
  L.push(`| Public claims | ${card.claims.total} (${countSummary(card.claims.byClaim)}) |`);
  L.push(`| Mafia kills | ${card.mafia.kills} (${countSummary(card.mafia.killsByRole)}) |`);
  L.push(`| Janitor cleans / Lawyer litigates (on teammate) | ${card.mafia.cleans} / ${card.mafia.litigates} (${card.mafia.litigateOnTeammate}) |`);
  L.push(`| Buses (scum voting scum) | ${card.mafia.buses} |`);
  L.push(`| Mafia kill votes moved after the first vote | ${card.mafia.killVoteMoves} |`);
  L.push(`| Scum first Village vote | ${card.mafia.voteTiming.scumVotedFirst}/${card.mafia.voteTiming.daysWithVotes} (${pct(card.mafia.voteTiming.scumFirstRate)} vs ${pct(card.mafia.voteTiming.scumFirstBaseline)} random) |`);
  L.push(`| Faction chat lines / public lines | ${card.mafia.factionChatLines} / ${card.publicLines} |`);
  L.push(`| Lynches on the mafia PLAN target | ${card.lynchSteering.lynchOnPlanTarget}/${card.lynchSteering.lynchDaysWithPlan} (random lynch would hit scum ${pct(card.lynchSteering.randomLynchBaseline)}) |`);
  L.push(`| Veg kicks | ${card.vegs} (${countSummary(card.vegCauses)}) |`);
  L.push(`| Stale proposals (phase over) | ${card.staleProposals} |`);
  L.push(`| Harness onError calls | ${card.harnessErrors} |`);
  L.push("");
  if (card.topWeakness) {
    L.push("## Top weakness", "", `**${card.topWeakness.title}** (severity ${card.topWeakness.severity})`, "", card.topWeakness.evidence, "");
    if (card.examples?.length) { L.push("Example (first game where it shows):", "", "```", ...card.examples, "```", ""); }
  }
  L.push("## All weaknesses, ranked", "");
  for (const x of card.weaknesses) L.push(`- ${x.title} (severity ${x.severity} = shortfall ${x.shortfall} x coverage ${x.coverage}): ${x.evidence}`);
  L.push("");
  if (card.errors.length) { L.push("## Errors", ""); for (const e of card.errors) L.push(`- game ${e.game}: ${e.error}`); L.push(""); }
  L.push("## Existing metrics (summarizeMetrics)", "", "```json", JSON.stringify(card.metrics, null, 2), "```", "");
  return L.join("\n");
}

/** Write scorecard JSON + markdown and per-game records (JSONL, the summarizeMetrics format). */
export async function writeSelfplay({ results, scorecard }, { outDir = SELFPLAY_DIR } = {}) {
  await mkdir(outDir, { recursive: true });
  const rule = scorecard.copRule && scorecard.copRule !== SELFPLAY_DEFAULTS.copRule ? `-${scorecard.copRule}` : "";
  const law = scorecard.lawyer && scorecard.lawyer !== SELFPLAY_DEFAULTS.lawyer ? `-${scorecard.lawyer}lawyer` : "";
  const maf = scorecard.mafiaMode && scorecard.mafiaMode !== SELFPLAY_DEFAULTS.mafia ? `-${scorecard.mafiaMode}mafia` : "";
  const base = `selfplay-seed${scorecard.seed}-n${scorecard.games}${rule}${law}${maf}`;
  const json = join(outDir, `${base}.json`);
  const md = join(outDir, `${base}.md`);
  const jsonl = join(outDir, `${base}.records.jsonl`);
  const games = join(outDir, `${base}.games.jsonl`);
  await writeFile(json, JSON.stringify(scorecard, null, 2) + "\n");
  await writeFile(md, scorecardMarkdown(scorecard));
  await writeFile(jsonl, results.map((r) => JSON.stringify(r.record)).join("\n") + "\n");
  await writeFile(games, results.map((r) => JSON.stringify({ ...r, record: undefined })).join("\n") + "\n");
  return { json, md, jsonl, games };
}
