// Frontier Justice Sheriff: out on Day 1, then shoot after discussion, at the best read.
// Hard rule: no shot before the Sheriff has outed, others have talked (or the day is well along),
// and there is a read or claim to act on.
import { NO_ONE } from "./types.js";
import { memoryOf } from "./notes.js";
import { beliefAlign } from "./beliefs.js";
import { TOWN_READS, sheriffReadTarget, townReads } from "./townReads.js";
import { copGuiltyResult } from "./townReads.js";
import { SHERIFF_ASK, askLineFor, askReplyWindowMs, parseClaimReply, roleCounterclaimed, sheriffAsks } from "./sheriffAsk.js";
import { claimedRoleIn, claimOpts } from "./chatStyle.js";
import { splitAppearance } from "./reducer.js";

export const SHERIFF_RULES = Object.freeze({ minOtherMessages: 6, minElapsedMs: 120_000, lateFraction: 0.85, lateElapsedMs: 180_000, lateRemainingMs: 60_000, lateVoteShare: 0.5, lastCallFraction: 0.93, lastCallRemainingMs: 20_000 });
const POWER_ROLES = new Set(["Cop", "Journalist", "Sheriff", "Doctor"]);

export function isGunMeeting(meeting) {
  return /\b(shoot|gun)\b/i.test(`${meeting?.name || ""} ${meeting?.actionName || ""}`);
}

function isSheriff(view) {
  return /sheriff/i.test(String(view?.role || "")) && view?.phase?.phase === "Day";
}

function phaseLines(view) {
  const phase = view?.phase?.name || "";
  return (view?.messages || []).filter((m) => m && m.senderId !== "server" && (!m.phase || !phase || m.phase === phase));
}

function living(view, id) {
  const p = view?.players?.[id];
  return !!p && !p.left && !view?.dead?.[id] && id !== view?.selfId;
}

function mentions(view, text, id) {
  const raw = String(text || "").toLowerCase();
  const tokens = [id, view?.players?.[id]?.name].filter((t) => t && String(t).length >= 2).map((t) => String(t).toLowerCase());
  return tokens.some((t) => new RegExp(`(^|[^a-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`).test(raw));
}

function claimedRole(view, id) {
  return view?.claims?.[id]?.kind !== "retract" ? view?.claims?.[id]?.role || null : null;
}

/** A Cop claimer's public guilty on a living player who did not claim a power role. */
export function copGuiltyTarget(view) {
  for (const m of phaseLines(view).slice().reverse()) {
    if (claimedRole(view, m.senderId) !== "Cop" && !/\bcop\b/i.test(String(m.content || ""))) continue;
    if (!copGuiltyResult(String(m.content || ""))) continue;
    for (const id of Object.keys(view?.players || {})) {
      if (id === m.senderId || !living(view, id) || !mentions(view, m.content, id)) continue;
      if (POWER_ROLES.has(claimedRole(view, id))) continue;
      return id;
    }
  }
  return null;
}

/** Best target: the Cop's guilty (the FJ test), else the strongest Mafia read on the BeliefBoard, else a suspect. */
export function sheriffShotTarget(view) {
  // Evidence first: a proven liar, a Journalist-exposed fake Cop, a claimer two players call a liar.
  const ids = Object.keys(view?.players || {}).filter((id) => living(view, id));
  const read = sheriffReadTarget(view, ids);
  if (read) return { target: read.target, why: `read: ${read.why}` };
  // Then test a Cop claimer's guilty (unless the target claims a power role).
  const guilty = copGuiltyTarget(view);
  if (guilty) return { target: guilty, why: "cop guilty" };
  const reads = Object.entries(view?.beliefs?.entries || {})
    .filter(([id, b]) => living(view, id) && beliefAlign(b?.role) === "Mafia" && !POWER_ROLES.has(claimedRole(view, id)))
    .sort((a, b) => (b[1].probability || 0) - (a[1].probability || 0));
  if (reads.length) return { target: reads[0][0], why: "belief board" };
  const suspect = [...memoryOf(view).suspects].find((id) => living(view, id) && !POWER_ROLES.has(claimedRole(view, id)));
  return suspect ? { target: suspect, why: "suspect" } : { target: null, why: "no read or claim" };
}

/** Fraction of the current day used, or null when the timer is unreadable. */
export function dayFraction(view, { now } = {}) {
  const clock = Number(now ?? view?.clock);
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (!Number.isFinite(clock) || !tm) return null;
  if (tm.length && tm.start) return Math.max(0, Math.min(1, (clock - tm.start) / tm.length));
  const start = Number(view?.phaseStartedAt);
  const elapsed = Number.isFinite(start) ? clock - start : null;
  if (tm.length && elapsed != null) return Math.max(0, Math.min(1, elapsed / tm.length));
  // A countdown "time" value: remaining ms. elapsed / (elapsed + remaining).
  if (tm.first != null && tm.last != null && tm.last < tm.first && elapsed != null && elapsed + tm.last > 0) {
    return Math.max(0, Math.min(1, elapsed / (elapsed + tm.last)));
  }
  return null;
}

/** Late in the day with no read: whoever the village is voting most, else the first living non-claimer. */
export function sheriffLateTarget(view) {
  // Any positive public read beats the biggest wagon (a mafia bloc can build the biggest wagon).
  const reads = townReads(view).score;
  const best = Object.entries(reads).filter(([id, s]) => s > 0 && living(view, id) && !POWER_ROLES.has(claimedRole(view, id))).sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const counts = {};
  for (const m of Object.values(view?.meetings || {})) {
    if (isGunMeeting(m) || !m?.voting) continue;
    for (const [voter, t] of Object.entries(m.votes || {})) {
      if (voter === view?.selfId) continue;
      for (const id of Array.isArray(t) ? t : [t]) if (living(view, id) && !POWER_ROLES.has(claimedRole(view, id))) counts[id] = (counts[id] || 0) + 1;
    }
  }
  const voted = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (voted) return voted;
  return Object.keys(view?.players || {}).find((id) => living(view, id) && !POWER_ROLES.has(claimedRole(view, id))) || null;
}

/**
 * Late in the day: any readable signal counts. Game GAME05: the day timer was unreadable and the
 * day ended before the old 6-minute fallback, so the Sheriff never shot.
 */
export function isLate(view, now) {
  const f = dayFraction(view, { now });
  if (f != null && f >= SHERIFF_RULES.lateFraction) return true;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (tm?.first != null && tm?.last != null && tm.last < tm.first && tm.last <= SHERIFF_RULES.lateRemainingMs) return true;
  // The server opens Vote Kick only when everyone else has voted: the day is about to end.
  if (kickSeen(view, false)) return true;
  // More than half the living village has voted: the lynch is coming.
  const vil = Object.values(view?.meetings || {}).find((m) => m?.voting && m.name === "Village");
  if (vil) {
    const alive = Object.keys(view?.players || {}).filter((id) => view.players[id] && !view.players[id].left && !view?.dead?.[id]).length;
    const voted = Object.entries(vil.votes || {}).filter(([, t]) => t != null && !(Array.isArray(t) && !t.length)).length;
    if (alive > 0 && voted / alive > SHERIFF_RULES.lateVoteShare) return true;
  }
  if (f != null) return false; // a readable day timer decides; elapsed time is only the fallback
  const start = Number(view?.phaseStartedAt);
  const clock = Number(now ?? view?.clock);
  return Number.isFinite(start) && Number.isFinite(clock) && clock - start >= SHERIFF_RULES.lateElapsedMs;
}

const GUILTY_RE = /\b(guilty|mafia|scum|mafioso|janitor|lawyer|red)\b/i;
const SHERIFF_CLAIM_RE = /\b(?:i'?m|i am|im)\s+(?:the\s+|a\s+|real\s+)*sheriff\b/i;

/** Someone who called this Sheriff guilty or counterclaimed Sheriff: shoot them, no timing gate. */
export function sheriffThreat(view) {
  if (!/sheriff/i.test(String(view?.role || ""))) return null;
  for (const m of phaseLines(view).slice().reverse()) {
    const from = m.senderId;
    if (!from || from === view.selfId || !living(view, from)) continue;
    const text = String(m.content || "");
    if (SHERIFF_CLAIM_RE.test(text) || claimedRole(view, from) === "Sheriff") return { target: from, why: "counterclaimed Sheriff" };
    // L4 (10/18): an accusation of the Sheriff is not a reason to shoot (he shot an unclaimed accuser for
    // "you are mafia" without asking). Accusers go through the reads and the claim-ask like anyone else.
    // A Cop result on him ("X is guilty, i checked him") is a false claim he can prove: still shot.
    const copResult = claimedRole(view, from) === "Cop" || /\b(?:checked|investigated|my check|results?|i'?m (?:the )?cop|im (?:the )?cop)\b/i.test(text);
    if (copResult && mentions(view, text, view.selfId) && /\b(guilty|red)\b/i.test(text) && !/\b(not|isn'?t|no)\s+(guilty|red)\b/i.test(text)) return { target: from, why: "fake Cop guilty on the Sheriff" };
  }
  return null;
}

/** "vinman" (default): always shoot on Day 1. "evidence": on Day 1 only on a strong read (sheriffEvidenceTarget). */
export const SHERIFF_RULE_NAMES = Object.freeze(["vinman", "evidence"]);
export const sheriffRuleOf = (view) => (view?.config?.sheriffRule === "evidence" ? "evidence" : "vinman");

/**
 * The evidence rule's Day 1 shot: a strong public read (townReads, the Sheriff's shoot threshold), a Cop
 * claimer's guilty, or the less credible of two living claimers of a unique role. null = hold the gun.
 */
export function sheriffEvidenceTarget(view) {
  const ids = Object.keys(view?.players || {}).filter((id) => living(view, id));
  const read = sheriffReadTarget(view, ids);
  if (read) return { target: read.target, why: `strong read: ${read.why}` };
  const guilty = copGuiltyTarget(view);
  if (guilty) return { target: guilty, why: "cop guilty" };
  const reads = townReads(view);
  // One of two living claimers of a unique role is lying: shoot the unverified one (the higher read if neither is).
  for (const [role, claimers] of Object.entries(reads.contested || {})) {
    if (new RegExp(`^${role}$`, "i").test(String(view?.role || ""))) continue; // my own role: sheriffThreat
    const rivals = claimers.filter((id) => living(view, id) && !reads.verified.includes(id))
      .sort((a, b) => (reads.score[b] || 0) - (reads.score[a] || 0) || (a < b ? -1 : 1));
    if (rivals.length) return { target: rivals[0], why: `counterclaim on ${role}` };
  }
  return null;
}

const isDay1 = (view) => /^day 1$/i.test(String(view?.phase?.name || "").trim());

/**
 * Village vote leader: the one player with strictly the most votes (2+). Votes on dead players (the server's
 * stale votes, Meeting.generateTargets) and "no one" don't count. Vinman: the Sheriff never shoots the player
 * the village is already lynching; the lynch handles them.
 */
export function villageLeader(view) {
  const vil = Object.values(view?.meetings || {}).find((m) => m?.voting && m.name === "Village");
  if (!vil) return null;
  const counts = {};
  for (const t of Object.values(vil.votes || {})) {
    for (const id of Array.isArray(t) ? t : [t]) if (id && id !== NO_ONE && view?.players?.[id] && !view.dead?.[id]) counts[id] = (counts[id] || 0) + 1;
  }
  const [top, next] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top && top[1] >= 2 && (!next || top[1] > next[1]) ? top[0] : null;
}

/** A living player the server revealed as town (the Sheriff after his shot, a revealed Cop...). */
const revealedTown = (view, id) => /^(Villager|Cop|Journalist|Sheriff|Doctor)$/.test(splitAppearance(view?.reveals?.[id] || "").role || "") && !(view?.teammates?.[id]);

/** This player's own public claim before (or without) an ask: { role, kind, at, phase } or null. */
function standingClaim(view, id) {
  for (const m of view?.messages || []) {
    if (m?.senderId !== id || m.public === false || !claimedRoleIn(m.content, claimOpts(view))) continue;
    const r = parseClaimReply(m.content, claimOpts(view));
    if (r?.role) return { ...r, at: Number(m.t), phase: m.phase || "" };
  }
  const c = view?.claims?.[id];
  if (c?.role && c.kind !== "retract") {
    const r = parseClaimReply(`im ${String(c.role).toLowerCase()}`);
    if (r) return { ...r, at: NaN, phase: "" };
  }
  return null;
}

/**
 * Where a candidate stands under the ask rule:
 *   unasked        no claim yet, not asked: ask first
 *   pending-reply  asked, no answer yet, still inside the reply window
 *   pending-cc     answered a power role, no counterclaim yet, still inside the counterclaim window
 *   protected      a power role nobody counterclaimed (in time): don't shoot, pick someone else
 *   contested      a power role with a counterclaim (or a dead player flipped it, or strong public evidence)
 *   open           no answer in time, a refusal, or a non-power claim: shootable
 */
export function shotStatus(view, id, { now, asks = sheriffAsks(view, view?.selfId), reads = null } = {}) {
  const clock = Number(now ?? view?.clock);
  const ask = asks.find((a) => a.target === id);
  const claim = ask?.reply || standingClaim(view, id);
  if (claim?.kind === "power") {
    const counter = ask?.counter || roleCounterclaimed(view, id, claim.role, { sheriffId: view?.selfId });
    if (counter) return { status: "contested", role: claim.role, counter: counter.by, how: counter.kind };
    // Vinman: only a counterclaim breaks a power claim. One exception is hard proof the claim is false: a Cop
    // claimer whose guilty flipped town (a Loyal Lawyer can't frame town).
    const why = (reads || townReads(view)).reasons[id] || [];
    if (why.some((w) => /their guilty flipped town$/.test(w))) return { status: "contested", role: claim.role, counter: null, how: "guilty flipped town" };
    const today = !claim.phase || claim.phase === view?.phase?.name;
    const since = Number.isFinite(claim.at) ? claim.at : ask?.at;
    if (today && Number.isFinite(clock) && Number.isFinite(since) && clock - since < SHERIFF_ASK.ccMs) return { status: "pending-cc", role: claim.role, until: since + SHERIFF_ASK.ccMs };
    return { status: "protected", role: claim.role };
  }
  if (claim?.role === "Villager") {
    const hold = villagerHold(view, id, claim, ask, clock);
    if (hold) return { status: "pending-vt", role: "Villager", until: hold.until, lines: hold.lines };
    return { status: "open", role: "Villager", why: "claimed Villager (held for more claims and reads)", vt: true };
  }
  if (claim) return { status: "open", role: claim.role, why: claim.kind === "refuse" ? "refused to claim" : `claimed ${claim.role}` };
  if (!ask) return { status: "unasked" };
  const replyMs = askReplyWindowMs(view);
  if (Number.isFinite(clock) && Number.isFinite(ask.at) && clock - ask.at < replyMs) return { status: "pending-reply", until: ask.at + replyMs, askedAt: ask.at };
  return { status: "open", role: null, why: "no claim when asked" };
}

/**
 * Night 5: the hold on a Villager answer, or null once it is over: { until, lines }. It is over after
 * vtHoldMaxMs, or after vtHoldMinMs once vtHoldLines lines from other players (not the Sheriff, not the
 * claimer) came after the answer. An answer from an earlier day, or with no time, is not held.
 */
function villagerHold(view, id, claim, ask, clock) {
  const since = Number.isFinite(claim?.at) ? claim.at : NaN;
  const today = !claim?.phase || claim.phase === view?.phase?.name;
  if (!today || !Number.isFinite(since) || !Number.isFinite(clock)) return null;
  const elapsed = clock - since;
  if (elapsed >= SHERIFF_ASK.vtHoldMaxMs) return null;
  const lines = phaseLines(view).filter((m) => m.senderId !== view?.selfId && m.senderId !== id && Number(m.t) > since && Number(m.t) <= clock).length;
  if (elapsed >= SHERIFF_ASK.vtHoldMinMs && lines >= SHERIFF_ASK.vtHoldLines) return null;
  return { until: since + SHERIFF_ASK.vtHoldMaxMs, lines };
}

/** Ranked shot candidates: evidence first, then (with `all`) every other living player. */
export function shotCandidates(view, { all = false } = {}) {
  const out = [];
  const framed = lynchPairFramed(view);
  const push = (id, why) => { if (id && living(view, id) && !revealedTown(view, id) && !framed.has(id) && !out.some((c) => c.target === id)) out.push({ target: id, why }); };
  const ids = Object.keys(view?.players || {}).filter((id) => living(view, id));
  const read = sheriffReadTarget(view, ids);
  if (read) push(read.target, `read: ${read.why}`);
  // Two living claimers of one unique role: one is lying. Test the less credible claim before any guilty
  // that a contested Cop claimer handed out.
  const tr = townReads(view);
  const contestedIds = new Set();
  for (const [role, claimers] of Object.entries(tr.contested || {})) {
    if (new RegExp(`^${role}$`, "i").test(String(view?.role || ""))) continue;
    claimers.filter((id) => living(view, id) && !tr.verified?.includes(id)).forEach((id) => contestedIds.add(id));
    claimers.filter((id) => living(view, id) && !tr.verified?.includes(id))
      .sort((a, b) => (tr.score[b] || 0) - (tr.score[a] || 0) || (a < b ? -1 : 1)).forEach((id) => push(id, `contested ${role} claim`));
  }
  const guilty = copGuiltyTarget(view);
  const from = guilty && phaseLines(view).find((m) => mentions(view, m.content, guilty) && /\b(guilty|mafia|scum)\b/i.test(String(m.content || "")))?.senderId;
  if (!(from && contestedIds.has(from))) push(guilty, "cop guilty");
  Object.entries(view?.beliefs?.entries || {})
    .filter(([id, b]) => living(view, id) && beliefAlign(b?.role) === "Mafia")
    .sort((a, b) => (b[1].probability || 0) - (a[1].probability || 0)).forEach(([id]) => push(id, "belief board"));
  for (const id of memoryOf(view).suspects || []) push(id, "suspect");
  if (!all) return out;
  const reads = townReads(view).score;
  Object.entries(reads).filter(([id, s]) => s > 0 && living(view, id)).sort((a, b) => b[1] - a[1]).forEach(([id]) => push(id, "best public read"));
  const counts = {};
  for (const m of Object.values(view?.meetings || {})) {
    if (isGunMeeting(m) || !m?.voting) continue;
    for (const [voter, t] of Object.entries(m.votes || {})) {
      if (voter === view?.selfId) continue;
      for (const id of Array.isArray(t) ? t : [t]) if (living(view, id)) counts[id] = (counts[id] || 0) + 1;
    }
  }
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([id]) => push(id, "votes on them"));
  ids.sort((a, b) => (reads[b] || 0) - (reads[a] || 0) || (a < b ? -1 : 1)).forEach((id) => push(id, "first non-claimer"));
  return out;
}

/**
 * A contested claim (shotStatus "contested"): a dead player's flip or hard proof shoots the claimer; two living
 * claimers go through pairDecide. { target, why } | { wait, why } | { skip, why }.
 */
function contestedDecide(view, id, st, { now, late = false, reads = townReads(view) } = {}) {
  const other = st?.counter;
  const leader = villageLeader(view);
  if (!other || st.how === "flip" || st.how === "sheriff" || !living(view, other) || revealedTown(view, other)) {
    return id === leader ? { skip: true, why: "leads the vote" } : { target: id, why: st?.how || "contested" };
  }
  return pairDecide(view, id, other, { now, late, role: st.role, reads });
}

// ---- Sheriff target selection (Vinman 10/20, 12:29pm) ----
// "sheriff should not be just targeting 1 person and shooting them without considering anyone else. If there are
// multiple cop claims, sheriff should shoot in them." Mafia's early Cop claims are fine; the Sheriff answers them.
export const SHERIFF_TARGET = Object.freeze({
  clearMargin: 1, // the asked Villager claimer is shot only when he leads every other candidate by this much
  accuserPts: 0.5, // per distinct player calling them sus / voting them in chat (the free-chat read)
  accuserCap: 3,
  quietPts: 0.5, // said nothing today while the table talked (quietLines lines from others)
  quietLines: 8,
  beliefPts: 1, // a Mafia read on this seat's BeliefBoard
  suspectPts: 0.5, // in this seat's suspects
  copLatePts: 1, // per place later in the Cop claim order (the later claimer answers a claim already out)
  copGuiltyOnTownPts: 3, // their guilty names a confirmed or likely townie (revealed town, verified, a sole power claim, me)
  copFramedRivalPts: 2, // their guilty named a rival who then claimed Cop (a real Cop answers a fake guilty on him)
  // Two claimers of one unique role (Cop pair, Journalist pair...): pairDecide. 10/20 2:02pm: fewer real Cops/Journalists shot.
  pairMargin: 2, // evidence gap that decides a pair on its own
  pairSettleMs: 15_000, // a weak pair waits this long after the later claim for reads, reports and votes (not late)
  guiltyOnDeadTownPts: 4, // a guilty on a player the mafia killed at night (town): impossible for a real Cop
  innoOnDeadTownPts: -1.5, // an inno on a night-killed townie: consistent with the deaths
  answeredAskPts: -1, // the claim was the answer to my claim request
  unpromptedCounterPts: 1, // claimed the role unprompted, after the rival had already claimed it
  rivalLiarPts: -1.5, // Cop pair: a "liar" call from the rival claimer is not evidence (each Cop claimer calls the other a liar)
  volunteeredFirstPts: 0.5, // Journalist pair, nobody asked: volunteered the claim first and was countered (selfplay: 35/35 fake)
  guiltyOpenPts: 0.5, // Cop pair: opened with a guilty while the rival reported an inno
});

const SUS_RE = /\b(sus|suspicious|suspect|sussy|scum|scummy|mafia|mafiaish|vote|voting|lynch|hang)\b/i;
const NOT_SUS_RE = /\b(not|isn'?t|no|never)\s+(sus|suspicious|scum|scummy|mafia|voting|vote)\b/i;

function hashOrder(view, id) {
  let h = 2166136261;
  for (const c of `${view?.config?.seed ?? ""}|${view?.gameId ?? ""}|${view?.selfId}|${view?.phase?.name}|${id}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * The Sheriff's suspicion of every living player: the town reads (claims, counterclaims, liar calls, Journalist
 * reports, vote history), plus today's free-chat suspicion (distinct players calling them sus or voting them),
 * going quiet while the table talks, and this seat's own belief board / suspects. { score, why }.
 */
export function sheriffSuspicion(view, { reads = townReads(view) } = {}) {
  const T = SHERIFF_TARGET;
  const score = {}, why = {};
  const add = (id, pts, w) => { if (!pts) return; score[id] = (score[id] || 0) + pts; (why[id] ||= []).push(`${pts > 0 ? "+" : ""}${pts} ${w}`); };
  const ids = Object.keys(view?.players || {}).filter((id) => living(view, id));
  for (const id of ids) { score[id] = reads.score[id] || 0; if (reads.reasons[id]?.length) why[id] = [...reads.reasons[id]]; }
  const lines = phaseLines(view).filter((m) => m.public !== false);
  const accusers = {};
  for (const m of lines) {
    const text = String(m.content || "");
    if (!m.senderId || m.senderId === view?.selfId || !SUS_RE.test(text) || NOT_SUS_RE.test(text)) continue;
    for (const id of ids) if (id !== m.senderId && mentions(view, text, id)) (accusers[id] ||= new Set()).add(m.senderId);
  }
  for (const [id, set] of Object.entries(accusers)) add(id, T.accuserPts * Math.min(T.accuserCap, set.size), `called sus / voted in chat by ${set.size}`);
  for (const id of ids) {
    const spoke = lines.some((m) => m.senderId === id);
    const others = lines.filter((m) => m.senderId !== id && m.senderId !== view?.selfId).length;
    if (!spoke && others >= T.quietLines) add(id, T.quietPts, "quiet today");
  }
  for (const [id, b] of Object.entries(view?.beliefs?.entries || {})) if (ids.includes(id) && beliefAlign(b?.role) === "Mafia") add(id, T.beliefPts, "belief board: Mafia");
  for (const id of memoryOf(view).suspects || []) if (ids.includes(id)) add(id, T.suspectPts, "suspect");
  for (const id of Object.keys(score)) score[id] = Math.round(score[id] * 100) / 100;
  return { score, why };
}

/** Living Cop claimers, in claim order: [{ id, at }] (at = the time of their first Cop claim, NaN when unknown). */
function copClaimers(view, reads) {
  const out = [];
  for (const m of view?.messages || []) {
    if (!m?.senderId || m.senderId === "server" || m.public === false || m.senderId === view?.selfId) continue;
    if (out.some((c) => c.id === m.senderId) || !living(view, m.senderId)) continue;
    if (reads.record.claims[m.senderId] !== "Cop" || claimedRoleIn(m.content, claimOpts(view)) !== "cop") continue;
    out.push({ id: m.senderId, at: Number(m.t) });
  }
  for (const id of Object.keys(reads.record.claims)) if (reads.record.claims[id] === "Cop" && living(view, id) && !out.some((c) => c.id === id)) out.push({ id, at: NaN });
  return out;
}

/**
 * Two living Cop claimers and the village vote is on one of them (the pair goes to the lynch): that claimer's
 * guilty targets are not evidence for the gun (if the vote is right he is the fake, and the fake's guilty names a
 * townie). Selfplay 10/20: shooting them was 0 for 19. Set of player ids.
 */
export function lynchPairFramed(view, reads = townReads(view)) {
  const cops = copClaimers(view, reads);
  if (cops.length !== 2) return new Set();
  const leader = villageLeader(view);
  const on = cops.find((c) => c.id === leader);
  if (!on) return new Set();
  return new Set(reads.record.guilty.filter((g) => g.by === on.id && !g.relay && !cops.some((c) => c.id === g.target)).map((g) => g.target));
}

/** Their guilty named another Cop claimer who only claimed after it (the usual fake-Cop opener: the real Cop answers). */
function framedRival(view, c, cops) {
  for (const m of view?.messages || []) {
    if (m?.senderId !== c.id || m.public === false || !copGuiltyResult(String(m.content || ""))) continue;
    const t = Number(m.t);
    if (cops.some((d) => d.id !== c.id && mentions(view, m.content, d.id) && Number.isFinite(d.at) && Number.isFinite(t) && d.at > t)) return true;
  }
  return false;
}

/** Their guilty names a confirmed or likely townie: revealed town, a verified claimer, a sole power-role claim, or me. */
function guiltyOnTown(view, id, reads) {
  return reads.record.guilty.some((g) => {
    if (g.by !== id || g.relay) return false;
    const t = g.target;
    if (t === view?.selfId || revealedTown(view, t) || reads.verified.includes(t)) return true;
    const role = reads.record.claims[t];
    if (!POWER_ROLES.has(role || "")) return (reads.score[t] || 0) <= TOWN_READS.credible;
    return Object.entries(reads.record.claims).filter(([x, r]) => r === role && living(view, x) && x !== t).length === 0;
  });
}

/** First public claim time of `role` (lowercase claim word, e.g. "cop") by `id`, NaN when unknown. */
function claimTime(view, id, role) {
  const m = (view?.messages || []).find((x) => x?.senderId === id && x.public !== false && claimedRoleIn(x.content, claimOpts(view)) === role);
  return m ? Number(m.t) : NaN;
}

/** A dead player who was town by the record: revealed Village, or no role shown (cleaned: killed by the mafia). */
function deadTown(view, id) {
  if (!view?.players?.[id] || living(view, id) || id === view?.selfId) return false;
  const rev = view?.reveals?.[id];
  if (!rev) return !!view?.dead?.[id];
  return /^(Villager|Cop|Journalist|Sheriff|Doctor)$/.test(splitAppearance(rev).role || "");
}

/**
 * How much the record says this claimer of `role` is the fake one (higher = more likely fake), against `rival`.
 * Town reads, minus the rival's own "liar" call; a guilty on a night-killed townie, on a likely townie, or on the
 * rival before he claimed; an inno on a night-killed townie (consistent); answering my claim request vs claiming
 * unprompted after the rival.
 */
export function claimEvidence(view, id, rival, { role, reads = townReads(view), asks = sheriffAsks(view, view?.selfId) } = {}) {
  const T = SHERIFF_TARGET;
  const word = String(role || reads.record.claims[id] || "").toLowerCase();
  let e = reads.score[id] || 0;
  const why = [];
  const add = (pts, w) => { e += pts; why.push(`${pts > 0 ? "+" : ""}${pts} ${w}`); };
  const cop = word === "cop";
  // Cop pair only: both Cop claimers call each other liars. In a Journalist pair the counter usually comes from the
  // real one (selfplay 10/20: 66 of 96 liar calls), so it stays evidence there.
  if (cop && rival && reads.record.liar.some((l) => l.by === rival && l.target === id)) add(T.rivalLiarPts, "liar call from the rival claimer discounted");
  if (cop) {
    const mine = reads.record.guilty.filter((g) => g.by === id && !g.relay);
    if (mine.some((g) => deadTown(view, g.target))) add(T.guiltyOnDeadTownPts, "guilty on a night-killed townie");
    if (guiltyOnTown(view, id, reads)) add(T.copGuiltyOnTownPts, "guilty on a likely townie");
    if (reads.record.inno.some((g) => g.by === id && deadTown(view, g.target))) add(T.innoOnDeadTownPts, "inno on a night-killed townie (consistent)");
    if (rival) {
      const tr = claimTime(view, rival, word);
      if (mine.some((g) => g.target === rival) && Number.isFinite(tr)) {
        const gm = (view?.messages || []).find((m) => m?.senderId === id && copGuiltyResult(String(m.content || "")) && mentions(view, m.content, rival));
        if (gm && Number(gm.t) < tr) add(T.copFramedRivalPts, "called the rival guilty before he claimed");
      }
      const rivalGuilty = reads.record.guilty.some((g) => g.by === rival && !g.relay);
      if (mine.length && !rivalGuilty && reads.record.inno.some((g) => g.by === rival)) add(T.guiltyOpenPts, "opened with a guilty, the rival with an inno");
    }
  }
  const answeredBy = (x) => asks.some((a) => a.target === x && a.reply && String(a.reply.role || "").toLowerCase() === word);
  const answered = answeredBy(id);
  const mineAt = claimTime(view, id, word), theirs = rival ? claimTime(view, rival, word) : NaN;
  const after = Number.isFinite(mineAt) && Number.isFinite(theirs) && mineAt > theirs;
  if (answered) add(T.answeredAskPts, "answered my claim request");
  else if (rival && after && (cop || answeredBy(rival))) add(T.unpromptedCounterPts, "claimed unprompted after the rival");
  // Journalist pair, nobody asked: the claim volunteered first is the one the other answered.
  if (!cop && rival && !answered && !answeredBy(rival) && Number.isFinite(mineAt) && Number.isFinite(theirs) && mineAt < theirs) add(T.volunteeredFirstPts, "volunteered the claim first, then countered");
  return { e: Math.round(e * 100) / 100, why };
}

/**
 * Two living claimers of one unique role, one of them lying. Returns { target, why } to shoot, { wait, why }
 * (a weak case, too fresh: reads, reports and votes first), or { skip, why } (leave the pair to the lynch).
 *   - a revealed/verified claimer is never shot (the other one is);
 *   - a clear evidence gap (pairMargin) shoots the weaker claim, unless he leads the vote (the lynch takes him);
 *   - a weak case waits pairSettleMs after the later claim (not late); then, if the village vote is on one of
 *     them, the pair goes to the lynch (a coin flip would kill the real one half the time); with no vote on
 *     either he keeps waiting, and only at the deadline shoots the weaker claim (ties by seed).
 */
export function pairDecide(view, a, b, { now, late = false, role, reads = townReads(view) } = {}) {
  const leader = villageLeader(view);
  const name = (id) => view.players?.[id]?.name || id;
  if (!b || !living(view, b) || revealedTown(view, b)) return a === leader ? { skip: true, why: `${name(a)} leads the vote` } : { target: a, why: "rival claim gone" };
  const word = String(role || reads.record.claims[a] || "").toLowerCase();
  const va = reads.verified.includes(a), vb = reads.verified.includes(b);
  if (va !== vb) {
    const t = va ? b : a;
    return t === leader ? { skip: true, why: `${name(t)} claims against a verified ${word} and leads the vote` } : { target: t, why: `claims ${word} against a verified ${word}` };
  }
  const asks = sheriffAsks(view, view?.selfId);
  const ea = claimEvidence(view, a, b, { role: word, reads, asks }), eb = claimEvidence(view, b, a, { role: word, reads, asks });
  const [hi, lo, ehi, elo] = ea.e > eb.e || (ea.e === eb.e && hashOrder(view, a) <= hashOrder(view, b)) ? [a, b, ea, eb] : [b, a, eb, ea];
  const tag = `${word} pair ${name(hi)} ${ehi.e} vs ${name(lo)} ${elo.e}`;
  if (ehi.e - elo.e >= SHERIFF_TARGET.pairMargin) {
    if (hi === leader) return { skip: true, why: `${tag}: the weaker claim leads the vote, the lynch takes him` };
    return { target: hi, why: `${tag}: ${ehi.why.join("; ") || "reads"}` };
  }
  const clock = Number(now ?? view?.clock);
  const latest = Math.max(claimTime(view, a, word), claimTime(view, b, word));
  if (!late && Number.isFinite(clock) && Number.isFinite(latest) && clock - latest < SHERIFF_TARGET.pairSettleMs) return { wait: true, why: `${tag}: weak, waiting for reads and votes` };
  if (a === leader || b === leader) return { skip: true, why: `${tag}: weak, the village vote is on ${name(leader)}: the lynch tests the pair` };
  // Still weak and the village has not picked: keep waiting until it does, or until the deadline.
  if (!late) return { wait: true, why: `${tag}: weak, waiting for the village vote` };
  return { target: hi, why: `${tag}: weak at the deadline, the weaker claim` };
}

/**
 * Two or more living Cop claimers: at most one is the Cop, so the Sheriff shoots one of them. This overrides
 * the other targeting (only a Sheriff counterclaim or a fake guilty on him comes first, sheriffThreat).
 * Weakest claim first: the town reads, later in the claim order, a guilty on a likely townie; ties by seed.
 * A revealed-town (or verified) Cop claimer is never shot. With two claimers, when the weaker one leads the
 * village vote, the lynch takes him and the gun is not spent on the other (null: the usual targeting).
 * Like the old contested-claim shot, it fires as soon as the second claim is out. { target, why } or null.
 */
export function multiCopTarget(view, { now, late = false, reads = townReads(view) } = {}) {
  const cops = copClaimers(view, reads);
  if (cops.length < 2) return null;
  const pool = cops.filter((c) => !revealedTown(view, c.id) && !reads.verified.includes(c.id));
  if (!pool.length) return null;
  if (cops.length === 2) {
    const d = pairDecide(view, cops[0].id, cops[1].id, { now, late, role: "Cop", reads });
    if (d.target) return { target: d.target, why: `2 Cop claims: ${d.why}` };
    if (d.wait) return { target: null, wait: true, why: `2 Cop claims: ${d.why}` };
    return null; // skip: the lynch tests the pair; the usual targeting goes on (never at a Cop claimer)
  }
  const ev = (c) => claimEvidence(view, c.id, null, { role: "Cop", reads }).e;
  const weak = (c) => ev(c) + SHERIFF_TARGET.copLatePts * cops.indexOf(c) + (framedRival(view, c, cops) ? SHERIFF_TARGET.copFramedRivalPts : 0);
  const ranked = pool.slice().sort((a, b) => weak(b) - weak(a) || hashOrder(view, a.id) - hashOrder(view, b.id));
  const leader = villageLeader(view);
  let pick = ranked[0];
  if (pick.id === leader) {
    if (cops.length < 3) return null;
    pick = ranked.find((c) => c.id !== leader);
    if (!pick) return null;
  }
  const g = guiltyOnTown(view, pick.id, reads) ? ", guilty on a likely townie" : "";
  return { target: pick.id, why: `${cops.length} Cop claims: shooting the weaker (claim #${cops.indexOf(pick) + 1}${g})` };
}

/**
 * After the hold on a Villager answer: re-evaluate every living, non-cleared player before shooting the asked
 * one. He is shot only when he is still clearly the most suspicious (clearMargin over everyone else);
 * otherwise the Sheriff moves on: a stronger case (refused, no answer, a contested claim) is shot, a
 * comparable unasked player is asked, and once nobody is left to ask the most suspicious open player is
 * shot (ties by seed, not by who was asked first). Never a sole uncontested power claim (protected), the
 * vote leader, or a revealed/verified townie.
 */
export function sheriffReconsider(view, askedId, { now, asks = sheriffAsks(view, view?.selfId), reads = townReads(view) } = {}) {
  const sus = sheriffSuspicion(view, { reads }).score;
  const leader = villageLeader(view);
  const name = (id) => view.players?.[id]?.name || id;
  const pool = [];
  const framed = lynchPairFramed(view, reads);
  for (const id of Object.keys(view?.players || {})) {
    if (!living(view, id) || id === leader || revealedTown(view, id) || reads.verified.includes(id) || framed.has(id)) continue;
    const st = shotStatus(view, id, { now, asks, reads });
    if (st.status === "protected" || st.status === "pending-cc") continue;
    pool.push({ id, st, s: sus[id] || 0 });
  }
  pool.sort((a, b) => b.s - a.s || hashOrder(view, a.id) - hashOrder(view, b.id));
  const me = pool.find((c) => c.id === askedId);
  const others = pool.filter((c) => c.id !== askedId);
  if (!me) return { ok: false, reason: `${name(askedId)} is no longer a target` };
  const fmt = (c) => `${name(c.id)} ${c.s}`;
  if (!others.length || me.s >= others[0].s + SHERIFF_TARGET.clearMargin) return { ok: true, target: askedId, why: `still clearly the most suspicious (${fmt(me)} vs ${others[0] ? fmt(others[0]) : "nobody"})` };
  // Everyone comparable to (or above) him is considered, most suspicious first.
  for (const c of others.filter((x) => x.s > me.s - SHERIFF_TARGET.clearMargin)) {
    const st = c.st;
    if (st.status === "contested") {
      const d = contestedDecide(view, c.id, st, { now, reads });
      if (d.target) return { ok: true, target: d.target, why: `re-ranked: ${fmt(c)}; ${st.role} claim contested (${d.why})` };
      if (d.wait) return { ok: false, reason: `waiting on the ${st.role} claims (${d.why})` };
      continue; // the lynch tests that pair
    }
    if (st.status === "open" && !st.vt) return { ok: true, target: c.id, why: `re-ranked: ${fmt(c)}; ${st.why}` };
    if (st.status === "open") continue; // another Villager claim, held and done
    // A fresh answer (or an ask still out) holds the shot only when that player reads worse than the asked one.
    if (st.status === "pending-vt" || st.status === "pending-reply") {
      if (c.s > me.s || st.status === "pending-reply") return { ok: false, reason: `waiting on ${name(c.id)} (${st.status}; re-ranking before shooting ${name(askedId)})` };
      continue;
    }
    if (st.status === "unasked" && asks.length < SHERIFF_ASK.maxAsks) return { ok: false, reason: `re-ranked: asking ${name(c.id)} (${c.s}) before shooting ${name(askedId)} (${me.s})`, ask: { target: c.id, line: askLineFor(view, c.id) } };
  }
  // Nobody left to ask: the most suspicious open player (the asked one only if he is on top, ties by seed).
  const top = pool.find((c) => c.st.status === "open" || c.st.status === "unasked");
  return top ? { ok: true, target: top.id, why: `re-ranked, nobody left to ask: most suspicious ${fmt(top)}` } : { ok: true, target: askedId, why: `asked; ${me.st.why}` };
}

/** The Sheriff's last call: too little day left to ask and wait for a reply (SHERIFF_RULES.lastCall*). */
export function lastCall(view, now) {
  const f = dayFraction(view, { now });
  if (f != null && f >= SHERIFF_RULES.lastCallFraction) return true;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (tm?.first != null && tm?.last != null && tm.last < tm.first && tm.last <= SHERIFF_RULES.lastCallRemainingMs) return true;
  if (kickSeen(view, true)) return true;
  if (f != null) return false;
  const start = Number(view?.phaseStartedAt), clock = Number(now ?? view?.clock);
  return Number.isFinite(start) && Number.isFinite(clock) && clock - start >= SHERIFF_RULES.lateElapsedMs + 60_000;
}

/**
 * A Vote Kick the Sheriff's timing reacts to. Default: any open Vote Kick meeting (plus the seat's own kick warning
 * where `warning`). config.voteKickGuard "on" (Night 5 solo flags, off by default): only a kick aimed at this seat
 * counts, i.e. its own youAreBeingVoteKicked warning or a Vote Kick it may not vote in (the server's kick targets).
 */
export function kickAimedAtMe(view) {
  if (view?.voteKickWarning) return true;
  return Object.values(view?.meetings || {}).some((m) => /vote\s*kick/i.test(String(m?.name || "")) && m.canVote === false);
}
function kickSeen(view, warning) {
  if (view?.config?.voteKickGuard === "on") return kickAimedAtMe(view);
  if (warning && view?.voteKickWarning) return true;
  return Object.values(view?.meetings || {}).some((m) => /vote\s*kick/i.test(String(m?.name || "")));
}

/** Sheriff's shot deadline: timer-based lateness (and the Vote Kick); the vote share alone does not end the asks. */
export function shotDeadline(view, now) {
  const f = dayFraction(view, { now });
  if (f != null && f >= SHERIFF_RULES.lateFraction) return true;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (tm?.first != null && tm?.last != null && tm.last < tm.first && tm.last <= SHERIFF_RULES.lateRemainingMs) return true;
  if (kickSeen(view, false)) return true;
  if (f != null) return false;
  // No readable timer: the Sheriff's own Village vote holds the day open on Day 1, so the vote share can't
  // close it; outside Day 1 (or with his vote in) the vote share still counts.
  // With no timer (GAME05) the day length is unknown: after the discussion window a mostly-voted village still
  // means late, so the asks can't outlive a short day.
  if (!sheriffVoteHeld(view)) return isLate(view, now);
  const start = Number(view?.phaseStartedAt);
  const clock = Number(now ?? view?.clock);
  const elapsed = Number.isFinite(start) && Number.isFinite(clock) ? clock - start : null;
  if (elapsed != null && elapsed >= SHERIFF_RULES.lateElapsedMs) return true;
  return elapsed != null && elapsed >= SHERIFF_RULES.minElapsedMs && isLate(view, now);
}

function sheriffVoteHeld(view) {
  const vil = Object.values(view?.meetings || {}).find((m) => m?.voting && m.name === "Village");
  const mine = vil?.votes?.[view?.selfId];
  return isDay1(view) && sheriffRuleOf(view) === "vinman" && (mine == null || (Array.isArray(mine) && !mine.length));
}

/**
 * Walk the candidates under the ask rule. Returns { ok:true, target, why } to shoot, { ok:false, ask:{target,line} }
 * to ask, or { ok:false, reason } to wait. late: no more asking or waiting; shoot the best uncontested non-PR.
 */
function askWalk(view, cands, { now, late }) {
  const asks = sheriffAsks(view, view?.selfId);
  const reads = townReads(view);
  const leader = villageLeader(view);
  const pending = [], unasked = [];
  const final = late && lastCall(view, now);
  // Night 5: a Villager answer inside its hold. Late, it is shootable like any open target; earlier, the walk
  // only moves on to a stronger case (a contested power claim, a refusal or no answer), never a new ask.
  let holding = null;
  const holdWait = () => ({ ok: false, reason: `waiting on ${view.players?.[holding.target]?.name || holding.target} (pending-vt: more claims and reads first)` });
  for (const c of cands) {
    if (c.target === leader) continue;
    const st = shotStatus(view, c.target, { now, asks, reads });
    if (st.status === "protected") continue;
    if (st.status === "pending-vt") {
      if (late) return { ok: true, target: c.target, why: `${c.why}; claimed Villager, no time left to hold` };
      holding ||= c;
      continue;
    }
    if (st.status === "contested") {
      const d = contestedDecide(view, c.target, st, { now, late, reads });
      if (d.target) return { ok: true, target: d.target, why: `${c.why}; ${st.role} claim contested (${d.why})` };
      if (d.wait) return { ok: false, reason: `waiting on the ${st.role} claims (${d.why})` };
      continue; // skip: the lynch tests the pair
    }
    if (holding && st.status === "open" && st.vt) continue;
    if (holding && st.status !== "open") return holdWait();
    if (st.status === "open") return { ok: true, target: c.target, why: `${c.why}; ${st.why}` };
    // L4 (10/18): every shot target is asked to claim first, late in the day too. Only the last call (no
    // time left for a reply) shoots an unasked target; a spent ask budget falls back to the asked ones.
    if (st.status === "unasked") {
      if (final) { unasked.push(c); continue; }
      if (asks.length >= SHERIFF_ASK.maxAsks) { unasked.push(c); continue; }
      return { ok: false, reason: `asking ${view.players?.[c.target]?.name || c.target} to claim`, ask: { target: c.target, line: askLineFor(view, c.target) } };
    }
    // pending-reply / pending-cc: wait for this one, unless the day is running out (late: a short reply window).
    const askedAt = Number.isFinite(st.askedAt) ? st.askedAt : Number.isFinite(st.until) ? st.until - SHERIFF_ASK.replyMs : NaN;
    const replyWait = st.status === "pending-reply" && !final && Number.isFinite(askedAt) && Number(now ?? view?.clock) - askedAt < SHERIFF_ASK.lateReplyMs;
    if (!late || replyWait) return { ok: false, reason: `waiting on ${view.players?.[c.target]?.name || c.target} (${st.status})` };
    // Late, asked and no answer in the late window: shoot this one rather than ask someone new.
    if (st.status === "pending-reply") return { ok: true, target: c.target, why: `${c.why}; no answer before the deadline` };
    pending.push({ ...c, st });
  }
  // Late with only pending candidates: an unanswered ask is not a claim, so it can be shot; a fresh
  // power claim still waiting on a counterclaim is not.
  const noReply = pending.find((c) => c.st.status === "pending-reply");
  if (noReply) return { ok: true, target: noReply.target, why: `${noReply.why}; no answer before the deadline` };
  if (final && unasked.length) return { ok: true, target: unasked[0].target, why: `${unasked[0].why}; last call, no time to ask` };
  if (holding) return holdWait();
  return { ok: false, reason: "no shootable target (every candidate claimed a power role or leads the vote)" };
}

/** The deadline version of sheriffReconsider: no asks, no waits; the most suspicious shootable player, or null. */
function lateReconsider(view, { now } = {}) {
  const reads = townReads(view);
  const sus = sheriffSuspicion(view, { reads }).score;
  const leader = villageLeader(view);
  const asks = sheriffAsks(view, view?.selfId);
  const pool = [];
  const framed = lynchPairFramed(view, reads);
  for (const id of Object.keys(view?.players || {})) {
    if (!living(view, id) || id === leader || revealedTown(view, id) || reads.verified.includes(id) || framed.has(id)) continue;
    const st = shotStatus(view, id, { now, asks, reads });
    if (st.status === "protected" || st.status === "pending-cc") continue;
    pool.push({ id, st, s: sus[id] || 0 });
  }
  pool.sort((a, b) => b.s - a.s || hashOrder(view, a.id) - hashOrder(view, b.id));
  for (const c of pool) {
    if (c.st.status !== "contested") return { ok: true, target: c.id, why: `most suspicious of everyone (${view.players?.[c.id]?.name || c.id} ${c.s}), no time to ask` };
    const d = contestedDecide(view, c.id, c.st, { now, late: true, reads });
    if (d.target) return { ok: true, target: d.target, why: `most suspicious ${c.s}; ${c.st.role} claim contested (${d.why})` };
  }
  return null;
}

/** Whether this Sheriff may shoot now, and at whom (or whom to ask first: result.ask). */
export function sheriffShotReady(view, { now } = {}) {
  const leader = villageLeader(view);
  const threat = sheriffThreat(view);
  if (threat && threat.target !== leader) return { ok: true, target: threat.target, why: threat.why };
  const lines = phaseLines(view);
  const day1 = isDay1(view);
  const evidence = sheriffRuleOf(view) === "evidence";
  const clock = now ?? view?.clock;
  const deadline = shotDeadline(view, clock);
  // Vinman: the Sheriff ALWAYS shoots on Day 1. At the deadline every other gate gives way: shoot the best
  // uncontested non-PR candidate now, so the day can't end with the gun unfired.
  if (day1 && !evidence && deadline) {
    const cops = multiCopTarget(view, { now: clock, late: true });
    if (cops?.target) return { ok: true, target: cops.target, why: `day 1 always shoots: late; ${cops.why}` };
    // A Villager answer is not shot at the deadline just because he was asked first: the most suspicious
    // shootable player is, with no time left to ask.
    const vt = sheriffAsks(view, view?.selfId).find((a) => a.reply?.role === "Villager" && living(view, a.target) && a.target !== leader && !revealedTown(view, a.target));
    if (vt) {
      const re = lateReconsider(view, { now: clock });
      if (re) return { ...re, why: `day 1 always shoots: late; ${re.why}` };
    }
    const pick = askWalk(view, shotCandidates(view, { all: true }), { now: clock, late: true });
    if (pick.ok) return { ...pick, why: `day 1 always shoots: late; ${pick.why}` };
    return pick;
  }
  const said = (list) => list.some((m) => m.senderId === view?.selfId && /sheriff/i.test(String(m.content || "")));
  // The evidence rule can carry the gun past Day 1: a claim made on an earlier day still counts as outed.
  const outed = said(lines) || (evidence && !day1 && said(view?.messages || []));
  if (!outed) return { ok: false, reason: "sheriff has not outed" };
  // Vinman 10/20: two or more Cop claimers alive, he shoots one of them (overrides the other targeting).
  const cops = multiCopTarget(view, { now: clock, late: deadline });
  if (cops?.target) return { ok: true, target: cops.target, why: cops.why };
  if (cops?.wait) return { ok: false, reason: `waiting on the Cop claims (${cops.why})` };
  const others = lines.filter((m) => m.senderId !== view?.selfId).length;
  const start = Number(view?.phaseStartedAt);
  const elapsed = clock != null && Number.isFinite(start) ? Number(clock) - start : null;
  // A gun held past Day 1 must fire before the lynch closes the day: once the village starts voting, no more waiting.
  const voting = Object.values(view?.meetings || {}).some((m) => m?.name === "Village" && Object.keys(m.votes || {}).length > 0);
  const heldReady = evidence && !day1 && voting;
  // L5 (10/18): the ask goes out early, a beat after his claim, on his top eligible read. It used to wait
  // for a read candidate or 45% of the day (askFraction); live Day 1 closed at ~75s and he shot unasked
  // at the last call. The discussion gate below now holds only the shot, not the ask.
  const claimAt = Math.max(...lines.filter((m) => m.senderId === view?.selfId && /sheriff/i.test(String(m.content || ""))).map((m) => Number(m.t)).filter(Number.isFinite), -Infinity);
  const sinceClaim = lines.filter((m) => m.senderId !== view?.selfId && Number(m.t) > claimAt).length;
  // One beat ask only: chaining asks before the discussion gate spent the ask budget on noise reads and outed
  // power roles early (-7 points of village wins in the L5 eval).
  // It fires once the village starts voting (live, the day can close soon after all votes are in): an
  // unconditional beat ask cost ~10 points of village wins in selfplay (no-lynch D1 up, PRs outed early).
  const beat = day1 && !evidence && voting && sheriffAsks(view, view?.selfId).length === 0 && (sinceClaim >= SHERIFF_ASK.askAfterLines || (Number.isFinite(claimAt) && clock != null && Number(clock) - claimAt >= SHERIFF_ASK.askAfterClaimMs) || !Number.isFinite(claimAt));
  // L6 (10/18): an ask is a commitment. Once the asked seat answers with a non-power claim (or refuses, or
  // stays silent past replyMs, 15s) he shoots it now: live, he asked at ~90s and never fired.
  if (day1 && !evidence) {
    for (const a of sheriffAsks(view, view?.selfId)) {
      if (a.target === leader || !living(view, a.target) || revealedTown(view, a.target)) continue;
      const st = shotStatus(view, a.target, { now: clock });
      // Night 5: after the hold on a Villager answer, re-rank the evidence (reads, contested claims, a Cop guilty,
      // suspects) and decide: the same target, a stronger case, or an ask on a new evidence read. Filler
      // candidates are never asked here; with no evidence the asked Villager claimer takes the shot.
      if (st.status === "open" && st.vt) {
        const pick = askWalk(view, shotCandidates(view), { now: clock, late: false });
        // A stronger evidence case on someone else is shot or asked; the asked Villager claimer himself is only
        // shot when he is still clearly the most suspicious of everyone (sheriffReconsider, Vinman 10/20).
        // A contested claim whose rival leads the vote is left to the lynch (shooting the other claimer kills the
        // real one whenever the leader is the liar).
        if (pick.ok && pick.target !== a.target) return { ...pick, why: `asked, held after a Villager answer; ${pick.why}` };
        if (pick.ask || /^waiting/.test(String(pick.reason || ""))) return pick;
        const re = sheriffReconsider(view, a.target, { now: clock });
        if (re.ok) return { ...re, why: `asked, held after a Villager answer; ${re.why}` };
        if (re.ask || /^waiting/.test(String(re.reason || ""))) return re;
        continue;
      }
      if (st.status === "open") return { ok: true, target: a.target, why: `asked; ${st.why}` };
      if (st.status === "contested") {
        const d = contestedDecide(view, a.target, st, { now: clock });
        if (d.target) return { ok: true, target: d.target, why: `asked; ${st.role} claim contested (${d.why})` };
        if (d.wait) return { ok: false, reason: `waiting on the ${st.role} claims (${d.why})` };
      }
    }
  }
  if (!heldReady && others < SHERIFF_RULES.minOtherMessages && !(elapsed != null && elapsed >= SHERIFF_RULES.minElapsedMs)) {
    if (beat) {
      const early = askWalk(view, shotCandidates(view, { all: true }), { now: clock, late: false });
      if (early.ask) return early;
    }
    return { ok: false, reason: `discussion first (${others}/${SHERIFF_RULES.minOtherMessages} lines)` };
  }
  if (day1 && evidence) {
    const strong = sheriffEvidenceTarget(view);
    if (!strong) return { ok: false, reason: "evidence rule: no strong read on day 1, holding" };
    return askWalk(view, [{ target: strong.target, why: strong.why }], { now: clock, late: false });
  }
  const primary = shotCandidates(view);
  // Vinman Day 1 with no read yet: start asking down the full list once enough of the day has gone.
  const frac = dayFraction(view, { now: clock });
  const askAll = day1 && !evidence && (frac == null ? elapsed != null && elapsed >= SHERIFF_RULES.minElapsedMs : frac >= SHERIFF_ASK.askFraction);
  const walked = primary.length ? askWalk(view, primary, { now: clock, late: heldReady }) : null;
  if (walked && (walked.ok || walked.ask || /^waiting/.test(walked.reason))) return walked;
  if (askAll) return askWalk(view, shotCandidates(view, { all: true }), { now: clock, late: false });
  // The beat ask only asks: with no read, the shot itself still waits for reads or askFraction (an
  // early unread shot cost ~10 points of village wins in the L5 eval).
  if (beat) {
    const early = askWalk(view, shotCandidates(view, { all: true }), { now: clock, late: false });
    if (early.ask) return early;
  }
  // Evidence rule, a gun held past Day 1: shoot after discussion at the best read (top read, wagon, first non-claimer).
  if (evidence && !day1) {
    const held = askWalk(view, shotCandidates(view, { all: true }), { now: clock, late: heldReady });
    if (held.ok || held.ask) return held.ok ? { ...held, why: `held gun, best read after day 1; ${held.why}` } : held;
  }
  return walked || { ok: false, reason: "no read or claim" };
}

/** The ask line this Sheriff should say now ({ target, line }), or null. */
export function sheriffAskLine(view, { now } = {}) {
  if (!isSheriff(view) || !sheriffGunOwed(view, { any: true })) return null;
  const r = sheriffShotReady(view, { now });
  return r.ask || null;
}

/**
 * validateAction hook: a gun vote at a player is legal only when the Sheriff rule says ready, and never at the
 * village's vote leader, a revealed townie, or a player whose power-role claim stands uncounterclaimed (or is
 * still inside its ask/counterclaim window).
 */
export function sheriffShotCheck(view, action) {
  const m = view?.meetings?.[action?.data?.meetingId];
  if (action?.event !== "vote" || !isGunMeeting(m) || !isSheriff(view)) return { ok: true };
  const sel = action.data.selection;
  if (sel === NO_ONE) return { ok: false, reason: "sheriff does not skip the shot on day 1" };
  const ready = sheriffShotReady(view);
  if (!ready.ok) return { ok: false, reason: `sheriff shot too early: ${ready.reason}` };
  if (sel === ready.target) return { ok: true };
  if (sel === villageLeader(view)) return { ok: false, reason: "sheriff never shoots the village vote leader" };
  if (revealedTown(view, sel)) return { ok: false, reason: "sheriff never shoots a revealed townie" };
  if (sheriffThreat(view)?.target === sel) return { ok: true };
  const st = shotStatus(view, sel);
  if (st.status === "open" || st.status === "contested") return { ok: true };
  if (shotDeadline(view, view?.clock) && (st.status === "unasked" || st.status === "pending-reply" || st.status === "pending-vt")) return { ok: true };
  return { ok: false, reason: `sheriff shot: ${view.players?.[sel]?.name || sel} is ${st.status}${st.role ? ` (${st.role})` : ""}` };
}

/** The gun is loaded and in my hands (its meeting is open and I have not fired). */
function gunOpen(view) {
  const gun = Object.values(view?.meetings || {}).find((m) => isGunMeeting(m) && m.voting && m.amMember !== false && m.canVote !== false && !m.used);
  const mine = gun?.votes?.[view.selfId];
  return !!gun && view.gunFired !== view.stateId && (mine == null || (Array.isArray(mine) && !mine.length));
}

/**
 * Vinman, Day 1: the gun is still loaded and a shot is still possible. { any: true }: any day, any rule
 * (for the ask line). At the deadline with nothing shootable (everyone left claimed a power role or leads the
 * vote) the gun is not owed, so the Sheriff's Village vote is released and he is never vegged.
 */
export function sheriffGunOwed(view, { any = false } = {}) {
  if (!isSheriff(view) || !gunOpen(view)) return false;
  if (any) return true;
  if (!isDay1(view) || sheriffRuleOf(view) !== "vinman") return false;
  // L4: late asks still owe the shot (asking, or waiting on the late reply window): keep the vote held.
  if (shotDeadline(view, view?.clock)) { const r = sheriffShotReady(view); return r.ok || !!r.ask || /^waiting/.test(String(r.reason || "")); }
  return true;
}

/**
 * Drop early gun votes; once ready, aim the gun at the rule's target. Vinman, Day 1: the Sheriff's own
 * Village vote waits for the shot, so the village can't close the day (all votes in) before the gun fires.
 */
export function applySheriffRule(view, actions, { now } = {}) {
  if (!isSheriff(view)) return actions;
  const owed = sheriffGunOwed(view);
  const out = [];
  for (const a of actions || []) {
    const m = view?.meetings?.[a?.data?.meetingId];
    if (owed && a?.event === "vote" && m?.name === "Village") continue;
    if (a?.event !== "vote" || !isGunMeeting(m)) { out.push(a); continue; }
    const ready = sheriffShotReady(view, { now });
    if (!ready.ok) continue;
    const legal = (m.targets || []).includes(ready.target);
    out.push(legal ? { ...a, data: { ...a.data, selection: ready.target } } : a);
  }
  // decide() returns one vote per call, so the gun can starve behind the Village vote. Add it here.
  const gun = Object.values(view?.meetings || {}).find((m) => isGunMeeting(m) && m.voting && m.canVote !== false && m.amMember !== false && !m.used);
  const mine = gun?.votes?.[view.selfId];
  if (gun && view.gunFired !== view.stateId && (mine == null || (Array.isArray(mine) && !mine.length)) && !out.some((a) => a?.data?.meetingId === gun.id)) {
    const ready = sheriffShotReady(view, { now });
    if (ready.ok && (gun.targets || []).includes(ready.target)) out.push({ event: "vote", data: { meetingId: gun.id, selection: ready.target } });
  }
  return out;
}

const GUN_LINE = /^(?::gun:\s*)?(.+?) pulls a gun and shoots (?:at )?.+!*$/i;
/** This seat is the Sheriff and the gun has already been fired (gun line, or the shot meeting is used). */
export function sheriffGunSpent(view) {
  if (!/sheriff/i.test(String(view?.role || ""))) return false;
  if (view?.gunFired) return true;
  const me = String(view?.players?.[view.selfId]?.name || "").trim().toLowerCase();
  const shot = me && (view?.messages || []).some((m) => {
    if (m?.senderId && m.senderId !== "server") return false;
    const hit = GUN_LINE.exec(String(m?.content || "").trim());
    return hit && hit[1].trim().toLowerCase() === me;
  });
  if (shot) return true;
  return Object.values(view?.meetings || {}).some((m) => m?.used && /gun|shoot/i.test(`${m?.name || ""} ${m?.actionName || ""}`));
}

/** "X claim or im shooting" / "claim before i shoot" once the gun is empty. */
export const SPENT_GUN_THREAT = /\bclaim\b(?:\s+\w+){0,6}\s+or\s+i(?:'?m|m)?\s*shoot|\bclaim\s+before\s+i\s+shoot|\bor\s+i(?:'?m|m)?\s*shoot(?:ing)?\b|\bi(?:'?m|m)\s+shooting\b/i;

// The whole threat clause, its addressee and the rest of "shooting" included. The detector above only
// matches the start: replacing just that left "ok sheriff here, player05 ing" (L8 replay, 10/18).
const THREAT_CLAUSE = /\bclaim\b(?:\s+\w+){0,6}?\s+or\s+i(?:'?m|m)?\s*shoot(?:ing)?\b|\bclaim\s+before\s+i\s+shoot\b|\bor\s+i(?:'?m|m)?\s*shoot(?:ing)?\b|\bi(?:'?m|m)\s+shooting\b/gi;
const escName = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drop a spent-gun threat. A line that was only the threat becomes "guns spent". */
export function repairSpentGunThreat(view, text) {
  const raw = String(text ?? "");
  if (!sheriffGunSpent(view) || !SPENT_GUN_THREAT.test(raw)) return raw;
  const names = Object.keys(view?.players || {}).flatMap((id) => [id, view.players[id]?.name]).filter(Boolean).map(escName);
  // Only an addressee goes: "player05 claim ..." or a line-opening "ash, claim ...", not "my read is player05, claim".
  const who = names.length ? new RegExp(`(?:(?:^|[\\s,.!?])(?:${names.join("|")})\\s+|^\\s*(?:${names.join("|")})[,:]\\s*)$`, "i") : null;
  let out = raw.replace(THREAT_CLAUSE, (hit, at) => {
    // "player05 claim or im shooting": the name in front of the threat goes with it.
    const head = raw.slice(0, at);
    const m = who && who.exec(head);
    return m ? `\u0000${m[0].length}\u0000` : " ";
  });
  out = out.replace(/([^\u0000]*?)\u0000(\d+)\u0000/g, (all, pre, n) => `${pre.slice(0, Math.max(0, pre.length - Number(n)))} `);
  out = out.replace(/\s+([,.!?])/g, "$1").replace(/\s+/g, " ").replace(/^[\s,.!?:;-]+|[\s,:;-]+$/g, "").trim();
  return out.split(/\s+/).filter(Boolean).length >= 3 && !SPENT_GUN_THREAT.test(out) ? out : "guns spent";
}
