// Day ballot: who has how many votes, and which switches would lynch someone.
// Given to every seat (town and mafia) and to the model prompt. Pure: one seat's view.
import { busCheck } from "./bus.js";
import { allies } from "./faction.js";
import { hammerSheriff, hammerState } from "./hammer.js";
import { dayFraction } from "./sheriffGate.js";
import { noCondemnDanger } from "./lynchMath.js";
import { agreedPlan, scumFaction } from "./scumPlan.js";
import { townReads, TOWN_READS } from "./townReads.js";
import { revealedSheriff, trustedClaimers } from "./legal.js";
import { confirmedLead } from "./townVote.js";
import { defang } from "./sanitize.js";
import { NO_ONE } from "./types.js";

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const livingIds = (view) => Object.keys(view?.players || {}).filter((id) => alive(view, id));
const nm = (view, id) => defang(id === NO_ONE ? "no one" : String(view?.players?.[id]?.name || id), 30);

export function villageMeeting(view) {
  return Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.voting) || null;
}

const cast = (meeting, id) => {
  const v = meeting?.votes?.[id];
  const t = Array.isArray(v) ? v[0] : v;
  return t == null || t === "" ? null : String(t);
};

/** Current village ballots among the living, plus the strict plurality (null when tied or the leader is no-one). */
export function voteCounts(view, meeting = villageMeeting(view)) {
  const votes = {};
  const counts = {};
  if (!meeting) return { votes, counts, leader: null, tied: false, living: livingIds(view) };
  for (const id of livingIds(view)) {
    const t = cast(meeting, id);
    votes[id] = t;
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [top, next] = ranked;
  const tied = !top || top[1] === next?.[1];
  const leader = !tied && top[0] !== NO_ONE ? top[0] : null;
  return { votes, counts, leader, tied: !leader, living: livingIds(view) };
}

/** Split or stuck: two or more player-targets have votes and nobody is a strict lynch. */
export function ballotStuck(view, meeting = villageMeeting(view)) {
  const { counts, leader } = voteCounts(view, meeting);
  const players = Object.keys(counts).filter((t) => t !== NO_ONE && counts[t] > 0);
  return !leader && players.length >= 2;
}

/**
 * For one voter, the player-targets they would lynch by moving their ballot.
 * @returns {{vote:string, lynches:string}[]} `vote` is what they cast; `lynches` is who that condemns.
 * At 2–2–1 the singleton, and anyone on a 2, can lynch the other 2 by switching onto it.
 */
export function switchesFor(counts, voter, current, extra = []) {
  const base = { ...counts };
  if (current) base[current] = (base[current] || 0) - 1;
  const options = new Set(Object.keys(base));
  options.add(NO_ONE);
  for (const id of Object.keys(counts)) options.add(id);
  for (const id of extra) if (id) options.add(id);
  const out = [];
  for (const vote of options) {
    if (vote === current) continue;
    const next = { ...base, [vote]: (base[vote] || 0) + 1 };
    const ranked = Object.entries(next).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const [top, second] = ranked;
    if (!top || top[0] === NO_ONE || top[1] === second?.[1]) continue;
    out.push({ vote, lynches: top[0] });
  }
  out.sort((a, b) => (a.lynches < b.lynches ? -1 : a.lynches > b.lynches ? 1 : a.vote < b.vote ? -1 : 1));
  return out;
}

/**
 * The whole day's ballot, from this seat: counts, and for every living player the switches that lynch.
 */
export function ballotBoard(view, meeting = villageMeeting(view)) {
  const { votes, counts, leader, tied, living } = voteCounts(view, meeting);
  const perPlayer = {};
  for (const id of living) perPlayer[id] = { current: votes[id] ?? null, switches: switchesFor(counts, id, votes[id] ?? null, living) };
  return { votes, counts, leader, tied, living, perPlayer, danger: noCondemnDanger(view) };
}

/** Prompt block. Names, never ids. Null when it is not a voting day. */
export function formatBallot(view) {
  const meeting = villageMeeting(view);
  if (!meeting || view?.phase?.phase !== "Day" || !view?.selfId) return null;
  const b = ballotBoard(view, meeting);
  const tally = Object.entries(b.counts).filter(([, n]) => n > 0).sort((a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1));
  const countText = tally.length ? tally.map(([id, n]) => `${nm(view, id)} ${n}`).join(", ") : "no votes yet";
  const mine = b.perPlayer[view.selfId];
  const lines = [`BALLOT: ${countText}. ${b.leader ? `${nm(view, b.leader)} would be lynched` : b.tied ? "no lynch if the day ended now (tie or no-one)" : "no lynch yet"}.`];
  if (b.danger) lines.push(`A tie or no-lynch here, then the night kill, is ${b.danger === "autoloss" ? "an autoloss" : "lynch-or-lose tomorrow"}. Do not leave it that way.`);
  if (!mine) return lines.join("\n");
  lines.push(`You are on ${mine.current ? nm(view, mine.current) : "nothing"}.`);
  if (!mine.switches.length) lines.push("No single switch of yours lynches anyone.");
  else lines.push(`Switching your vote: ${mine.switches.map((s) => `to ${nm(view, s.vote)} lynches ${nm(view, s.lynches)}`).join("; ")}.`);
  return lines.join("\n");
}

const CONSOLIDATE_AT = { fraction: 0.72, remainingMs: 50_000 };

/** Late enough to re-check a stuck day before the deadline, or the vote-kick warning is up. */
export function consolidateDue(view, { now = view?.clock } = {}) {
  if (view?.voteKickWarning) return true;
  if (Object.values(view?.meetings || {}).some((m) => /^vote ?kick$/i.test(String(m?.name || "")))) return true;
  const f = dayFraction({ ...view, clock: now }, { now });
  if (f != null && f >= CONSOLIDATE_AT.fraction) return true;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  return !!(tm?.last != null && tm.first != null && tm.last < tm.first && tm.last <= CONSOLIDATE_AT.remainingMs);
}

/** One deterministic pile target when town must not leave a tie. Higher read, then a clear's push, then a stable id. */
function pileTarget(view, meeting, board) {
  const lead = confirmedLead(view, meeting);
  const reads = townReads(view);
  const trusted = trustedClaimers(view);
  const sheriff = revealedSheriff(view);
  const legal = new Set((meeting?.targets || []).map(String));
  const ok = (id) => id && id !== NO_ONE && id !== view.selfId && id !== sheriff && legal.has(id) && !view.dead?.[id]
    && !trusted.has(id) && !reads.verified.includes(id) && (reads.score[id] || 0) > TOWN_READS.credible;
  if (lead && ok(lead.target)) return lead.target;
  const tied = Object.entries(board.counts).filter(([id, n]) => id !== NO_ONE && n > 0 && n === Math.max(...Object.values(board.counts)));
  const pool = (tied.length ? tied.map(([id]) => id) : Object.keys(board.counts).filter((id) => id !== NO_ONE)).filter(ok);
  const ranked = (pool.length ? pool : [...legal].filter(ok))
    .map((id) => [id, reads.score[id] || 0])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return ranked[0]?.[0] || null;
}

function hammerOwns(view) {
  if (hammerState(view)) return true;
  const sheriff = hammerSheriff(view);
  return !!(sheriff && livingIds(view).length === 5);
}

/**
 * This seat's vote change, or null to stay.
 * Town: while split, unsure seats follow a clear's push; before a dangerous deadline, everyone piles
 * onto one target so the day cannot end tied.
 * Mafia: swing a lynch onto the plan target, and get off a teammate the bus rules do not allow.
 */
export function ballotSwitch(view, { now = view?.clock } = {}) {
  const meeting = villageMeeting(view);
  if (!meeting || view?.phase?.phase !== "Day" || !view?.selfId || !alive(view, view.selfId)) return null;
  if (view?.config?.hammer !== "off" && hammerOwns(view)) return null;
  const board = ballotBoard(view, meeting);
  const mine = board.votes[view.selfId] ?? null;
  const me = board.perPlayer[view.selfId];
  if (!me) return null;
  if (scumFaction(view)) return mafiaSwitch(view, meeting, board, mine, me);
  return townSwitch(view, meeting, board, mine, { now });
}

function townSwitch(view, meeting, board, mine, { now }) {
  const reads = townReads(view);
  const myTop = Math.max(0, ...Object.entries(reads.score).filter(([id]) => id !== view.selfId).map(([, s]) => s));
  const lead = confirmedLead(view, meeting, reads);
  const stuck = ballotStuck(view, meeting);
  const late = consolidateDue(view, { now }) && board.danger && !board.leader;
  if (late) {
    const pile = pileTarget(view, meeting, board);
    if (pile && pile !== mine) return { target: pile, why: `deadline: a ${board.danger} tie, consolidate on ${nm(view, pile)}` };
    return null;
  }
  if (!stuck || !lead || lead.target === mine) return null;
  if (myTop >= TOWN_READS.strong) return null;
  const readsOk = !reads.verified.includes(lead.target) && (reads.score[lead.target] || 0) > TOWN_READS.credible && !trustedClaimers(view).has(lead.target);
  if (!readsOk) return null;
  return { target: lead.target, why: `split: follow ${nm(view, lead.by)} onto ${nm(view, lead.target)}` };
}

function mafiaSwitch(view, meeting, board, mine, me) {
  const mates = allies(view);
  const plan = agreedPlan(view)?.lynchTarget || null;
  const canBus = (id) => busCheck(view, meeting.id, id).ok;
  const onto = (id) => me.switches.find((s) => s.lynches === id);
  if (mine && mates.has(mine) && !canBus(mine)) {
    const swing = plan && !mates.has(plan) ? onto(plan) : null;
    const other = swing || me.switches.find((s) => !mates.has(s.lynches) && s.vote !== mine);
    if (other) return { target: other.vote, why: `ballot: off a teammate, onto ${nm(view, other.lynches)}` };
    if (meeting.targets?.includes(NO_ONE)) return { target: NO_ONE, why: "ballot: off a teammate" };
  }
  if (plan && !mates.has(plan)) {
    const swing = onto(plan);
    if (swing && !mates.has(swing.vote)) return { target: swing.vote, why: `ballot: switching lynches ${nm(view, plan)}` };
  }
  // A switch that would lynch a teammate is not taken unless the bus rules allow that vote.
  return null;
}
