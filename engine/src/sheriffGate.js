// Frontier Justice Sheriff: out on Day 1, then shoot after discussion, at the best read.
// Hard rule: no shot before the Sheriff has outed, others have talked (or the day is well along),
// and there is a read or claim to act on.
import { NO_ONE } from "./types.js";
import { memoryOf } from "./notes.js";
import { beliefAlign } from "./beliefs.js";

export const SHERIFF_RULES = Object.freeze({ minOtherMessages: 6, minElapsedMs: 120_000, lateFraction: 0.85, lateElapsedMs: 180_000, lateRemainingMs: 60_000, lateVoteShare: 0.5 });
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
    if (!/\b(guilty|mafia|scum)\b/i.test(String(m.content || ""))) continue;
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
 * Late in the day: any readable signal counts. Game 1fo007iEq: the day timer was unreadable and the
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
    if (mentions(view, text, view.selfId) && GUILTY_RE.test(text) && !/\b(not|isn'?t|no)\s+(guilty|mafia|scum)\b/i.test(text)) return { target: from, why: "called the Sheriff guilty" };
  }
  return null;
}

/** Whether this Sheriff may shoot now, and at whom. */
export function sheriffShotReady(view, { now } = {}) {
  const threat = sheriffThreat(view);
  if (threat) return { ok: true, target: threat.target, why: threat.why };
  const lines = phaseLines(view);
  const outed = lines.some((m) => m.senderId === view?.selfId && /sheriff/i.test(String(m.content || "")));
  if (!outed) return { ok: false, reason: "sheriff has not outed" };
  const others = lines.filter((m) => m.senderId !== view?.selfId).length;
  const clock = now ?? view?.clock;
  const start = Number(view?.phaseStartedAt);
  const elapsed = clock != null && Number.isFinite(start) ? Number(clock) - start : null;
  if (others < SHERIFF_RULES.minOtherMessages && !(elapsed != null && elapsed >= SHERIFF_RULES.minElapsedMs)) {
    return { ok: false, reason: `discussion first (${others}/${SHERIFF_RULES.minOtherMessages} lines)` };
  }
  const pick = sheriffShotTarget(view);
  if (!pick.target) {
    // Always shoot on Day 1: late in the day with still no read, take the top suspect anyway.
    const day1 = /^day 1$/i.test(String(view?.phase?.name || "").trim());
    if (day1 && isLate(view, clock)) {
      const late = sheriffLateTarget(view);
      if (late) return { ok: true, target: late, why: "late day 1, no read" };
    }
    return { ok: false, reason: pick.why };
  }
  return { ok: true, target: pick.target, why: pick.why };
}

/** validateAction hook: a gun vote at a player is legal only when the Sheriff rule says ready. */
export function sheriffShotCheck(view, action) {
  const m = view?.meetings?.[action?.data?.meetingId];
  if (action?.event !== "vote" || !isGunMeeting(m) || !isSheriff(view)) return { ok: true };
  if (action.data.selection === NO_ONE) return { ok: false, reason: "sheriff does not skip the shot on day 1" };
  const ready = sheriffShotReady(view);
  return ready.ok ? { ok: true } : { ok: false, reason: `sheriff shot too early: ${ready.reason}` };
}

/** Drop early gun votes; once ready, aim the gun at the rule's target. */
export function applySheriffRule(view, actions, { now } = {}) {
  if (!isSheriff(view)) return actions;
  const out = [];
  for (const a of actions || []) {
    const m = view?.meetings?.[a?.data?.meetingId];
    if (a?.event !== "vote" || !isGunMeeting(m)) { out.push(a); continue; }
    const ready = sheriffShotReady(view, { now });
    if (!ready.ok) continue;
    const legal = (m.targets || []).includes(ready.target);
    out.push(legal ? { ...a, data: { ...a.data, selection: ready.target } } : a);
  }
  // decide() returns one vote per call, so the gun can starve behind the Village vote. Add it here.
  const gun = Object.values(view?.meetings || {}).find((m) => isGunMeeting(m) && m.voting && m.canVote !== false);
  const mine = gun?.votes?.[view.selfId];
  if (gun && (mine == null || (Array.isArray(mine) && !mine.length)) && !out.some((a) => a?.data?.meetingId === gun.id)) {
    const ready = sheriffShotReady(view, { now });
    if (ready.ok && (gun.targets || []).includes(ready.target)) out.push({ event: "vote", data: { meetingId: gun.id, selection: ready.target } });
  }
  return out;
}
