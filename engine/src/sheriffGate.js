// Frontier Justice Sheriff: out on Day 1, then shoot after discussion, at the best read.
// Hard rule: no shot before the Sheriff has outed, others have talked (or the day is well along),
// and there is a read or claim to act on.
import { NO_ONE } from "./types.js";
import { memoryOf } from "./notes.js";
import { beliefAlign } from "./beliefs.js";
import { TOWN_READS, sheriffReadTarget, townReads } from "./townReads.js";
import { copGuiltyResult } from "./townReads.js";
import { SHERIFF_ASK, askLineFor, parseClaimReply, roleCounterclaimed, sheriffAsks } from "./sheriffAsk.js";
import { claimedRoleIn } from "./chatStyle.js";
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
  if (Object.values(view?.meetings || {}).some((m) => /vote\s*kick/i.test(String(m?.name || "")))) return true;
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
    if (m?.senderId !== id || m.public === false || !claimedRoleIn(m.content)) continue;
    const r = parseClaimReply(m.content);
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
  if (claim) return { status: "open", role: claim.role, why: claim.kind === "refuse" ? "refused to claim" : `claimed ${claim.role}` };
  if (!ask) return { status: "unasked" };
  if (Number.isFinite(clock) && Number.isFinite(ask.at) && clock - ask.at < SHERIFF_ASK.replyMs) return { status: "pending-reply", until: ask.at + SHERIFF_ASK.replyMs };
  return { status: "open", role: null, why: "no claim when asked" };
}

/** Ranked shot candidates: evidence first, then (with `all`) every other living player. */
export function shotCandidates(view, { all = false } = {}) {
  const out = [];
  const push = (id, why) => { if (id && living(view, id) && !revealedTown(view, id) && !out.some((c) => c.target === id)) out.push({ target: id, why }); };
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

/** The less credible of a contested claimer and the counterclaimer (my target on a tie). */
function contestedPick(view, id, other, reads) {
  if (!other || !living(view, other) || revealedTown(view, other) || other === villageLeader(view)) return id;
  return (reads.score[other] || 0) > (reads.score[id] || 0) + TOWN_READS.shootMargin ? other : id;
}

/** The Sheriff's last call: too little day left to ask and wait for a reply (SHERIFF_RULES.lastCall*). */
export function lastCall(view, now) {
  const f = dayFraction(view, { now });
  if (f != null && f >= SHERIFF_RULES.lastCallFraction) return true;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (tm?.first != null && tm?.last != null && tm.last < tm.first && tm.last <= SHERIFF_RULES.lastCallRemainingMs) return true;
  if (view?.voteKickWarning || Object.values(view?.meetings || {}).some((m) => /vote\s*kick/i.test(String(m?.name || "")))) return true;
  if (f != null) return false;
  const start = Number(view?.phaseStartedAt), clock = Number(now ?? view?.clock);
  return Number.isFinite(start) && Number.isFinite(clock) && clock - start >= SHERIFF_RULES.lateElapsedMs + 60_000;
}

/** Sheriff's shot deadline: timer-based lateness (and the Vote Kick); the vote share alone does not end the asks. */
export function shotDeadline(view, now) {
  const f = dayFraction(view, { now });
  if (f != null && f >= SHERIFF_RULES.lateFraction) return true;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (tm?.first != null && tm?.last != null && tm.last < tm.first && tm.last <= SHERIFF_RULES.lateRemainingMs) return true;
  if (Object.values(view?.meetings || {}).some((m) => /vote\s*kick/i.test(String(m?.name || "")))) return true;
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
  for (const c of cands) {
    if (c.target === leader) continue;
    const st = shotStatus(view, c.target, { now, asks, reads });
    if (st.status === "protected") continue;
    if (st.status === "contested") return { ok: true, target: contestedPick(view, c.target, st.counter, reads), why: `${c.why}; ${st.role} claim contested (${st.how})` };
    if (st.status === "open") return { ok: true, target: c.target, why: `${c.why}; ${st.why}` };
    // L4 (10/18): every shot target is asked to claim first, late in the day too. Only the last call (no
    // time left for a reply) shoots an unasked target; a spent ask budget falls back to the asked ones.
    if (st.status === "unasked") {
      if (final) { unasked.push(c); continue; }
      if (asks.length >= SHERIFF_ASK.maxAsks) { unasked.push(c); continue; }
      return { ok: false, reason: `asking ${view.players?.[c.target]?.name || c.target} to claim`, ask: { target: c.target, line: askLineFor(view, c.target) } };
    }
    // pending-reply / pending-cc: wait for this one, unless the day is running out (late: a short reply window).
    const askedAt = Number.isFinite(st.until) ? st.until - SHERIFF_ASK.replyMs : NaN;
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
  return { ok: false, reason: "no shootable target (every candidate claimed a power role or leads the vote)" };
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
    const pick = askWalk(view, shotCandidates(view, { all: true }), { now: clock, late: true });
    if (pick.ok) return { ...pick, why: `day 1 always shoots: late; ${pick.why}` };
    return pick;
  }
  const said = (list) => list.some((m) => m.senderId === view?.selfId && /sheriff/i.test(String(m.content || "")));
  // The evidence rule can carry the gun past Day 1: a claim made on an earlier day still counts as outed.
  const outed = said(lines) || (evidence && !day1 && said(view?.messages || []));
  if (!outed) return { ok: false, reason: "sheriff has not outed" };
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
      if (st.status === "open") return { ok: true, target: a.target, why: `asked; ${st.why}` };
      if (st.status === "contested") return { ok: true, target: contestedPick(view, a.target, st.counter, townReads(view)), why: `asked; ${st.role} claim contested (${st.how})` };
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
  if (shotDeadline(view, view?.clock) && (st.status === "unasked" || st.status === "pending-reply")) return { ok: true };
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
