// Frontier Justice Sheriff: out on Day 1, then shoot after discussion, at the best read.
// Hard rule: no shot before the Sheriff has outed, others have talked (or the day is well along),
// and there is a read or claim to act on.
import { NO_ONE } from "./types.js";
import { memoryOf } from "./notes.js";
import { beliefAlign } from "./beliefs.js";

export const SHERIFF_RULES = Object.freeze({ minOtherMessages: 6, minElapsedMs: 120_000 });
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

/** Whether this Sheriff may shoot now, and at whom. */
export function sheriffShotReady(view, { now } = {}) {
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
  if (!pick.target) return { ok: false, reason: pick.why };
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
  return out;
}
