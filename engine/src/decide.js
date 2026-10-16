// Pure; always emits legal actions.
// Kill/lynch picks never hit a known ally while a non-ally living target exists.
import { legalVotes, validateAction } from "./legal.js";
import { isAlive } from "./reducer.js";
import { proposeNightAction } from "./nightAct.js";
import { allies, enemies } from "./faction.js";
import { memoryOf } from "./notes.js";
import { isLawyerRole, parsePlanLine, scumDecisions } from "./scumPlan.js";
import { NO_ONE } from "./types.js";

/** Enemies and suspects, then other non-allies, skipping cleared players while another target exists. */
export function pickHostileTarget(view, targets, al = allies(view), en = enemies(view)) {
  const memory = memoryOf(view);
  const living = targets.filter((t) => t !== view.selfId && t !== NO_ONE && isAlive(view, t));
  const nonAllies = living.filter((t) => !al.has(t));
  const fresh = nonAllies.filter((t) => !memory.cleared.has(t));
  const pool = fresh.length ? fresh : nonAllies;
  return pool.find((t) => memory.suspects.has(t)) ?? pool.find((t) => en.has(t)) ?? pool[0]
    ?? (targets.includes(NO_ONE) ? NO_ONE : null);
}

/** Keep a model action, then add rules actions for meetings it did not cover. */
export function supplementActions(chosen, rules, view) {
  const out = [];
  const seen = new Set();
  const add = (action) => {
    if (!action?.data?.meetingId) return;
    const key = `${action.event}|${action.data.meetingId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(action);
  };
  for (const action of chosen || []) add(action);
  for (const action of rules || []) {
    if (action.event === "speak" && String(action.data?.content || "").startsWith("PLAN ")) {
      const plan = parsePlanLine(action.data.content);
      const clash = out.some((vote) => {
        if (vote.event !== "vote" || !plan) return false;
        const meeting = view?.meetings?.[vote.data.meetingId];
        return meeting && (meeting.name === "Mafia" || meeting.name === "Cult") && vote.data.selection !== plan.killTarget;
      });
      if (clash) continue;
    }
    add(action);
  }
  return out;
}

/** @returns {import('./types.js').ProposedAction[]} */
export function decide(view, opts = {}) {
  if (!view.selfId || view.finished || view.leftGame) return [];
  const scum = scumDecisions(view);
  if (scum) {
    const out = scum.filter((action) => validateAction(view, action).ok);
    if (view.phase?.phase === "Night" && view.role !== "Janitor" && !isLawyerRole(view.role)) {
      const night = proposeNightAction(view, { ...opts, rng: opts.rng ?? (() => 0) });
      const covered = night && out.some((action) => action.data.meetingId === night.data.meetingId);
      if (night && !covered && !allies(view).has(night.data.selection)) out.push({ event: night.event, data: night.data });
    }
    return out;
  }
  if (view.phase?.phase === "Night") {
    const n = proposeNightAction(view, { ...opts, rng: opts.rng ?? (() => 0) });
    if (n && !allies(view).has(n.data.selection)) return [{ event: n.event, data: n.data }];
  }
  const al = allies(view), en = enemies(view);
  for (const lv of legalVotes(view)) {
    if (lv.myVote != null && !(Array.isArray(lv.myVote) && !lv.myVote.length)) continue;
    const pick = pickHostileTarget(view, lv.targets, al, en);
    if (pick == null) continue;
    const a = { event: "vote", data: { meetingId: lv.meetingId, selection: pick } };
    if (validateAction(view, a).ok) return [a];
  }
  return [];
}
