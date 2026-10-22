// ActionSelector for one seat. Hard rules drop options, then a scorer ranks the rest.
// `score` is the learned-policy seam: replace ruleScore later. Nothing here trains.
import { adaptiveVote, mafiaModeOf } from "./adaptiveMafia.js";
import { beliefAlign } from "./beliefs.js";
import { allies, FACTION_MEETINGS } from "./faction.js";
import { busCheck, busPick } from "./bus.js";
import { meetingActions, validateAction } from "./legal.js";
import { isKillMeeting, mustActMeeting } from "./nightAct.js";
import {
  agreedPlan, factionKillMeeting, isLawyerRole, janitorSelection, lawyerSelection, scumFaction, scumOwesNightVote,
} from "./scumPlan.js";
import { NO_ONE } from "./types.js";
import { killOptional } from "./lynchMath.js";

export const SELECTOR_TEMPERATURE = 1;

/** Mulberry32. One generator per selectAction call, so seats do not share a stream. */
export function createSeededRng(seed) {
  let state = (typeof seed === "number" && Number.isFinite(seed) ? seed : 1) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function rng() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(view) {
  const text = `${view?.selfId || ""}:${view?.stateId || ""}:${view?.messages?.length || 0}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function personalMeeting(meeting) {
  return !!meeting && meeting.name !== "Village" && meeting.name !== "Mafia" && meeting.name !== "Cult";
}

function nightMust(view) {
  return view?.phase?.phase === "Night" && (mustActMeeting(view) || scumOwesNightVote(view));
}

/** Town belief in [0, 1], or null when this seat has no town read. */
export function townBelief(view, playerId) {
  const belief = view?.beliefs?.entries?.[playerId];
  if (!belief) return null;
  const town = beliefAlign(belief.role) === "Village" || /^(town|villager|village)$/i.test(String(belief.role || ""));
  if (!town) return null;
  if (belief.probability != null && belief.probability !== "" && Number.isFinite(Number(belief.probability))) {
    return Number(belief.probability);
  }
  if (belief.label === "confirmed") return 0.95;
  if (belief.label === "likely") return 0.7;
  return 0.4;
}

/** True when this seat's vote would put `target` strictly ahead of a lynch they are already tied or leading. */
export function tipsLynch(view, meeting, target) {
  if (!meeting || target == null || target === NO_ONE) return false;
  const counts = new Map();
  for (const [voter, raw] of Object.entries(meeting.votes || {})) {
    if (voter === view?.selfId) continue;
    const picks = Array.isArray(raw) ? raw : [raw];
    for (const pick of picks) {
      if (pick == null || pick === "") continue;
      const id = String(pick);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const mine = counts.get(String(target)) || 0;
  if (mine < 1) return false;
  let otherMax = 0;
  for (const [id, count] of counts) if (id !== String(target)) otherMax = Math.max(otherMax, count);
  return mine >= otherMax && mine + 1 > otherMax;
}

function wantedTarget(view, meeting, plan) {
  if (!meeting || !plan) return null;
  const faction = scumFaction(view);
  const factionName = faction ? (FACTION_MEETINGS[faction] || faction) : null;
  // The faction kill vote: a combined "Mafia" meeting or the live split "Mafia Kill" meeting.
  if ((factionName && meeting.name === factionName) || factionKillMeeting(view)?.id === meeting.id) return plan.killTarget;
  if (meeting.name === "Village" && view.phase?.phase !== "Night") return mafiaModeOf(view) === "adaptive" ? adaptiveVote(view, meeting, plan) : plan.lynchTarget;
  if (isLawyerRole(view.role) && personalMeeting(meeting)) {
    const selection = lawyerSelection(meeting, plan);
    return selection && allies(view).has(selection) ? selection : null;
  }
  if (view.role === "Janitor" && personalMeeting(meeting)) return janitorSelection(meeting, plan);
  return null;
}

/**
 * Why a vote candidate cannot be sent. Empty string means it survived the hard rules.
 * Scoring never sees a candidate rejected here.
 */
export function rejectCandidate(view, candidate) {
  if (!candidate || candidate.kind === "claim" || candidate.kind === "speech-goal") return "not a vote";
  if (candidate.action === "wait" || candidate.target == null || candidate.target === "") {
    return nightMust(view) ? "night action is open" : "wait";
  }
  const meeting = view.meetings?.[candidate.meetingId];
  const target = String(candidate.target);
  const action = { event: "vote", data: { meetingId: candidate.meetingId, selection: target } };
  const valid = validateAction(view, action);
  if (!valid.ok) return valid.reason;
  const lawyerRoom = isLawyerRole(view.role) && personalMeeting(meeting);
  if (allies(view).has(target) && !lawyerRoom) {
    // A bus (voting a teammate) only passes when town is already on them, or as a model-chosen town-read play.
    const bus = busCheck(view, candidate.meetingId, target, { deliberate: candidate.kind === "day-vote" });
    if (!bus.ok) return `known teammate (${bus.reason})`;
  }
  // legalActions' advice on Litigate: a Loyal Lawyer's vote on a non-teammate is server-legal but has no effect,
  // and the Lawyer never skips. Only Litigate: the Lawyer votes the Mafia Kill like any teammate.
  const advice = lawyerRoom && meeting ? meetingActions(view, meeting) : null;
  if (advice?.kind === "litigate" && advice.notes[target]?.tier === "advice") return "lawyer only litigates teammates";
  if (view.role === "Janitor" && personalMeeting(meeting)) {
    const plan = agreedPlan(view);
    const saving = mafiaModeOf(view) === "adaptive" && plan && plan.janitorTarget === null;
    if (!saving && /^(no|skip|none|\*)$/i.test(target)) return "janitor must not skip the clean";
    const wanted = plan ? janitorSelection(meeting, plan) : null;
    if (wanted && target !== wanted) return "janitor must clean the plan";
  }
  const skip = target === NO_ONE || /^(no|skip|none)$/i.test(target);
  // Mafia need not kill when the meteor is not on them; they still kill a living town power-role claimer.
  const optionalKill = skip && meeting === factionKillMeeting(view) && killOptional(view);
  if (nightMust(view) && skip && !optionalKill) return "night action is open";
  const dayVote = candidate.kind === "day-vote" || (view.phase?.phase === "Day" && meeting?.name === "Village");
  if (!scumFaction(view) && dayVote && candidate.kind !== "night-target") {
    const town = townBelief(view, target);
    if (town != null && town >= 0.8 && !tipsLynch(view, meeting, target)) return "believed town";
  }
  return "";
}

function alignmentScore(belief) {
  if (!belief) return { town: null, scum: null };
  const align = beliefAlign(belief.role);
  const probability = belief.probability == null || belief.probability === "" ? null : Number(belief.probability);
  const value = Number.isFinite(probability) ? probability : null;
  if (align === "Village") return { town: value, scum: value == null ? null : 1 - value };
  if (align === "Mafia" || align === "Cult") return { scum: value, town: value == null ? null : 1 - value };
  return { town: null, scum: null };
}

/**
 * Default scorer. Unknown and equal beliefs tie, so the softmax can change targets.
 * A learned selector replaces this function; it should not reimplement the hard rules.
 */
export function ruleScore(view, candidate) {
  if (!candidate || candidate.kind === "speech-goal" || candidate.kind === "claim") {
    const plan = agreedPlan(view);
    const text = `${candidate?.goal || ""} ${candidate?.role || ""}`.toLowerCase();
    let score = 0;
    if (plan?.speakerId === view.selfId && candidate?.claim === true && plan.claimRole
      && String(candidate.role || "").toLowerCase() === String(plan.claimRole).toLowerCase()) score += 3;
    if (plan?.lynchTarget && text.includes(String(plan.lynchTarget).toLowerCase())) score += 1;
    return score;
  }
  if (candidate.target != null && allies(view).has(String(candidate.target))) {
    const bus = busCheck(view, candidate.meetingId, candidate.target, { deliberate: true });
    if (bus.ok) return bus.sure ? 0.95 : bus.mode === "wagon" ? 0.6 : 0.35;
  }
  const belief = view?.beliefs?.entries?.[candidate.target];
  const { town, scum } = alignmentScore(belief);
  const meeting = view.meetings?.[candidate.meetingId];
  const kill = isKillMeeting(meeting);
  if (kill) return (town ?? 0.5) - (scum ?? 0.5);
  if (scum != null) return scum;
  if (town != null) return 1 - town;
  return 0.5;
}

function sortKey(candidate) {
  return [candidate.meetingId, candidate.target, candidate.kind, candidate.claim, candidate.role, candidate.goal].join("|");
}

function distinct(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = candidate.kind === "claim"
      ? `claim:${candidate.claim}:${candidate.role}`
      : candidate.kind === "speech-goal"
        ? `goal:${candidate.goal}`
        : `${candidate.meetingId}:${candidate.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

function sampleByScore(items, scoreOf, rng, temperature) {
  if (items.length === 1) return items[0];
  const temp = Number.isFinite(temperature) && temperature > 0 ? temperature : 1e-6;
  const scores = items.map((item) => {
    const value = Number(scoreOf(item));
    return Number.isFinite(value) ? value : 0;
  });
  const max = Math.max(...scores);
  const weights = scores.map((score) => Math.exp((score - max) / temp));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function matches(candidate, decision) {
  if (decision.kind === "claim") return candidate.kind === "claim";
  if (decision.kind === "speech-goal") return candidate.kind === "speech-goal";
  if (candidate.kind === "claim" || candidate.kind === "speech-goal") return false;
  if (candidate.decisionId && candidate.decisionId === decision.id) return true;
  return !!candidate.meetingId && candidate.meetingId === decision.meetingId;
}

function voteCandidate(decision, target, reason) {
  return {
    kind: decision.kind,
    decisionId: decision.id,
    meetingId: decision.meetingId,
    target: String(target),
    reason,
  };
}

function anchorsFor(view, decision) {
  if (decision.kind !== "day-vote" && decision.kind !== "night-target") return [];
  const meeting = view.meetings?.[decision.meetingId];
  const plan = agreedPlan(view);
  const target = wantedTarget(view, meeting, plan);
  const out = target ? [voteCandidate(decision, target, "seen plan")] : [];
  // Rules bus option: a teammate town is already voting (offered, not forced; the scorer weighs it).
  if (decision.kind === "day-vote") for (const id of allies(view)) {
    const bus = busCheck(view, decision.meetingId, id);
    if (bus.ok && bus.mode === "wagon") out.push(voteCandidate(decision, id, `bus: ${bus.reason}`));
  }
  return out;
}

function inferDecisions(view, candidates) {
  const map = new Map();
  for (const candidate of candidates || []) {
    if (candidate.kind === "claim") {
      map.set("claim", { id: "claim", kind: "claim", meetingId: candidate.meetingId || "", targets: [] });
    } else if (candidate.kind === "speech-goal") {
      map.set("speech", { id: "speech", kind: "speech-goal", meetingId: candidate.meetingId || "", targets: [] });
    } else if (candidate.meetingId) {
      const kind = candidate.kind === "night-target" || candidate.kind === "day-vote"
        ? candidate.kind
        : (view?.phase?.phase === "Night" ? "night-target" : "day-vote");
      const id = candidate.decisionId || `${kind === "night-target" ? "night" : "day"}:${candidate.meetingId}`;
      if (!map.has(id)) map.set(id, { id, kind, meetingId: candidate.meetingId, targets: [] });
    }
  }
  return [...map.values()];
}

/**
 * Pick one option per decision for this seat only.
 * Hard rules run before `score`. Pass `score` to replace the rule scorer.
 * @returns {{ok:boolean, actions:object[], speechGoal:string|null, claim:object|null, dropped:object[], reason:string}}
 */
export function selectAction(view, candidates, opts = {}) {
  const score = opts.score || ruleScore;
  const temperature = opts.temperature ?? SELECTOR_TEMPERATURE;
  const rng = Number.isFinite(opts.seed)
    ? createSeededRng(opts.seed)
    : (typeof opts.rng === "function" ? opts.rng : createSeededRng(opts.seed ?? seedFor(view)));
  const decisions = opts.decisions?.length ? opts.decisions : inferDecisions(view, candidates);
  const dropped = [];
  const actions = [];
  let speechGoal = null;
  let claim = null;
  let actionSlots = 0;
  let actionPicks = 0;
  const pool = Array.isArray(candidates) ? candidates : [];

  for (const decision of decisions) {
    const mine = pool.filter((candidate) => matches(candidate, decision));
    if (decision.kind === "speech-goal") {
      const goals = distinct(mine.filter((candidate) => candidate.goal));
      if (!goals.length) continue;
      speechGoal = sampleByScore(goals, (candidate) => score(view, candidate), rng, temperature).goal;
      continue;
    }
    if (decision.kind === "claim") {
      const claims = distinct(mine.filter((candidate) => typeof candidate.claim === "boolean"));
      if (!claims.length) continue;
      claim = sampleByScore(claims, (candidate) => score(view, candidate), rng, temperature);
      continue;
    }
    actionSlots += 1;
    const surviving = [];
    for (const candidate of mine) {
      const why = rejectCandidate(view, candidate);
      if (why) dropped.push({ target: candidate.target, kind: candidate.kind, reason: why });
      else surviving.push(candidate);
    }
    for (const anchor of anchorsFor(view, decision)) {
      const why = rejectCandidate(view, anchor);
      if (why) dropped.push({ target: anchor.target, kind: anchor.kind, reason: why });
      else if (!surviving.some((candidate) => candidate.meetingId === anchor.meetingId && candidate.target === anchor.target)) {
        surviving.push(anchor);
      }
    }
    const unique = distinct(surviving);
    if (!unique.length) continue;
    const meeting = view.meetings?.[decision.meetingId];
    const planTarget = wantedTarget(view, meeting, agreedPlan(view));
    const planHit = planTarget == null ? null : unique.find((candidate) => String(candidate.target) === String(planTarget));
    const picked = planHit || sampleByScore(unique, (candidate) => score(view, candidate), rng, temperature);
    actions.push({ event: "vote", data: { meetingId: decision.meetingId, selection: String(picked.target) } });
    actionPicks += 1;
  }

  if ((actionSlots > 0 && actionPicks === 0) || (actionSlots === 0 && !speechGoal && !claim)) {
    return { ok: false, actions: [], speechGoal: null, claim: null, dropped, reason: "no legal candidate" };
  }
  return { ok: true, actions, speechGoal, claim, dropped, reason: "" };
}
