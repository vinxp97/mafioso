// Placeholder policy (LLM layer goes here later). Pure; always emits legal actions.
// Kill/lynch picks never hit a known ally while a non-ally living target exists.
import { legalVotes, validateAction } from "./legal.js";
import { isAlive } from "./reducer.js";
import { proposeNightAction } from "./nightAct.js";
import { allies, enemies } from "./faction.js";
import { NO_ONE } from "./types.js";

/** Pick a target from a meeting: enemies first, then non-allies, else "*", else null. */
export function pickHostileTarget(view, targets, al = allies(view), en = enemies(view)) {
  const living = targets.filter((t) => t !== view.selfId && t !== NO_ONE && isAlive(view, t));
  const nonAllies = living.filter((t) => !al.has(t));
  return nonAllies.find((t) => en.has(t)) ?? nonAllies[0]
    ?? (targets.includes(NO_ONE) ? NO_ONE : null);
}

/** @returns {import('./types.js').ProposedAction[]} */
export function decide(view, opts = {}) {
  if (!view.selfId || view.finished || view.leftGame) return [];
  if (view.phase?.phase === "Night") {
    const n = proposeNightAction(view, { rng: opts.rng ?? (() => 0), ...opts });
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
