// Deterministic baseline seat. No model calls.
// Uses rules decide, validateAction, this seat's Frontier Justice card, and a few heuristics.
// Public lines go through the Phase B scheduler. Faction chat does not.
import { beliefAlign } from "./beliefs.js";
import { decide } from "./decide.js";
import { allies } from "./faction.js";
import { validateAction } from "./legal.js";
import { memoryOf } from "./notes.js";
import { nightAbilityMeetings } from "./nightAct.js";
import { isAlive, splitAppearance } from "./reducer.js";
import { roleCard } from "./roleGuide.js";
import { decideSpeech, isPublicSpeak, publicMessages, publicSpeechMeeting, speechCap } from "./scheduler.js";
import { createSeededRng } from "./selector.js";
import { agreedPlan, formatPlanSpeech, parsePlanLine, scumFaction } from "./scumPlan.js";
import { NO_ONE } from "./types.js";
import { noLynchLoses, townSeat } from "./lynchMath.js";

const KILL_PRIORITY = ["Cop", "Sheriff", "Journalist"];
const POWER_CLAIM = new Set(["Cop", "Sheriff", "Journalist", "Doctor"]);

function escapeReg(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameOf(view, id) {
  if (id === NO_ONE) return "No one";
  return view.players?.[id]?.name || id;
}

function knownRole(view, id) {
  const revealed = splitAppearance(view.reveals?.[id]).role;
  if (revealed) return revealed;
  const claim = view.claims?.[id];
  if (claim?.role && claim.kind !== "retract" && claim.kind !== "soft") return claim.role;
  return null;
}

function mentions(text, player) {
  const token = player?.name || player?.id;
  if (!token) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeReg(token)}([^A-Za-z0-9_]|$)`, "i").test(String(text || ""));
}

function chatBoard(view) {
  const suspected = new Set();
  let sheriffTarget = null;
  for (const message of publicMessages(view)) {
    if (!message || message.senderId === view.selfId || message.senderId === "server") continue;
    const text = String(message.content || "");
    if (/\b(mafia|guilty|scum|sided with the mafia)\b/i.test(text)) {
      for (const player of Object.values(view.players || {})) {
        if (!player || player.id === message.senderId) continue;
        if (mentions(text, player)) suspected.add(player.id);
      }
    }
    if (sheriffTarget || !/\bshooting\b/i.test(text)) continue;
    const speakerIsSheriff = knownRole(view, message.senderId) === "Sheriff" || /\bsheriff\b/i.test(text);
    if (!speakerIsSheriff) continue;
    for (const player of Object.values(view.players || {})) {
      if (!player || player.id === message.senderId || player.id === view.selfId) continue;
      if (mentions(text, player)) sheriffTarget = player.id;
    }
  }
  return { suspected, sheriffTarget };
}

function suspicionScore(view, id, board) {
  const memory = memoryOf(view);
  let score = 0;
  if (memory.suspects.has(id)) score += 4;
  if (memory.cleared.has(id)) score -= 6;
  if (board.suspected.has(id)) score += 5;
  if (board.sheriffTarget === id) score += 4;
  const belief = view.beliefs?.entries?.[id];
  if (belief) {
    const align = beliefAlign(belief.role);
    const probability = Number(belief.probability);
    const mag = Number.isFinite(probability) ? probability : 0.5;
    if (align === "Mafia" || align === "Cult") score += 2 + mag * 3;
    if (align === "Village") score -= 2 + mag * 2;
  }
  return score;
}

function ranked(view, ids, rng, board) {
  return ids
    .map((id) => ({ id, score: suspicionScore(view, id, board), tie: rng() }))
    .sort((a, b) => b.score - a.score || a.tie - b.tie || (a.id < b.id ? -1 : 1));
}

function livingPool(view, targets) {
  const friends = allies(view);
  return (targets || []).filter((id) => id !== view.selfId && id !== NO_ONE && isAlive(view, id) && !friends.has(id));
}

function mostSuspected(view, targets, rng, board) {
  const ordered = ranked(view, livingPool(view, targets), rng, board);
  if (!ordered.length || ordered[0].score <= 0) return null;
  return ordered[0].id;
}

function uncheckedTarget(view, targets, rng, board) {
  const memory = memoryOf(view);
  const pool = livingPool(view, targets);
  const fresh = pool.filter((id) => !memory.checks[id] && !memory.cleared.has(id) && !view.reveals?.[id]);
  const ordered = ranked(view, fresh.length ? fresh : pool, rng, board);
  return ordered[0]?.id || null;
}

function priorityTarget(view, targets) {
  const friends = allies(view);
  for (const role of KILL_PRIORITY) {
    const hit = (targets || []).find((id) => id !== view.selfId && id !== NO_ONE && isAlive(view, id) && !friends.has(id) && knownRole(view, id) === role);
    if (hit) return hit;
  }
  return null;
}

function findMeeting(view, re) {
  return Object.values(view.meetings || {}).find((meeting) => meeting?.amMember && meeting.voting && meeting.canVote && re.test(meeting.name || "")) || null;
}

function sheriffDead(view) {
  return Object.entries(view.reveals || {}).some(([id, appearance]) => splitAppearance(appearance).role === "Sheriff" && view.dead?.[id]);
}

function claimedPower(view, id) {
  return POWER_CLAIM.has(knownRole(view, id));
}

function alreadySaid(view, content) {
  return (view.messages || []).some((message) => message?.senderId === view.selfId && message.content === content);
}

function templateLine(view, actions) {
  const card = roleCard(view.role);
  const role = card?.role || view.role;
  const gun = actions.find((action) => action.event === "vote" && /shoot|gun/i.test(view.meetings?.[action.data.meetingId]?.name || ""));
  if (role === "Sheriff" && gun?.data.selection && gun.data.selection !== NO_ONE) {
    return `I'm Sheriff. Shooting ${nameOf(view, gun.data.selection)}.`;
  }
  const checks = Object.entries(view.notes?.checks || {});
  if (checks.length && (role === "Cop" || role === "Journalist")) {
    const [id, info] = checks[checks.length - 1];
    const side = /mafia|cult/i.test(String(info.result || info.detail || "")) ? "Mafia" : "Village";
    return `I'm ${role}. ${nameOf(view, id)} is sided with the ${side}.`;
  }
  const vote = actions.find((action) => action.event === "vote" && view.meetings?.[action.data.meetingId]?.name === "Village");
  if (!vote || vote.data.selection === NO_ONE) return "No lynch.";
  return `Voting ${nameOf(view, vote.data.selection)}.`;
}

function preferredVotes(view, rng, board) {
  const picks = new Map();
  const card = roleCard(view.role);
  if (card?.role === "Cop" && view.phase?.phase === "Night") {
    const meeting = findMeeting(view, /investigate|cop|check/i) || nightAbilityMeetings(view)[0];
    const pick = meeting && uncheckedTarget(view, meeting.targets, rng, board);
    if (pick) picks.set(meeting.id, pick);
  }
  if (card?.role === "Journalist" && view.phase?.phase === "Night") {
    const meeting = findMeeting(view, /report|journalist|learn/i) || nightAbilityMeetings(view)[0];
    if (meeting) {
      const cop = (meeting.targets || []).find((id) => knownRole(view, id) === "Cop" && isAlive(view, id));
      const pick = cop || uncheckedTarget(view, meeting.targets, rng, board);
      if (pick) picks.set(meeting.id, pick);
    }
  }
  if (card?.role === "Sheriff" && view.phase?.phase === "Day" && Number(view.phase.day) === 1) {
    const gun = findMeeting(view, /shoot|gun/i);
    if (gun) {
      const guilty = [...board.suspected].find((id) => (gun.targets || []).includes(id) && isAlive(view, id) && !claimedPower(view, id));
      const loud = livingPool(view, gun.targets).filter((id) => !claimedPower(view, id));
      const pick = guilty || mostSuspected(view, loud, rng, board) || mostSuspected(view, gun.targets, rng, board)
        || livingPool(view, gun.targets)[0];
      if (pick) picks.set(gun.id, pick);
    }
  }
  if (scumFaction(view) && view.phase?.phase === "Night" && !agreedPlan(view)) {
    const mafia = findMeeting(view, /^(mafia|cult)$/i);
    if (mafia) {
      const pick = priorityTarget(view, mafia.targets) || mostSuspected(view, mafia.targets, rng, board);
      if (pick) picks.set(mafia.id, pick);
    }
  }
  const village = findMeeting(view, /^village$/i);
  if (village && view.phase?.phase === "Day") {
    const plan = agreedPlan(view);
    if (plan?.lynchTarget && (village.targets || []).includes(plan.lynchTarget) && !allies(view).has(plan.lynchTarget)) {
      picks.set(village.id, plan.lynchTarget);
    } else {
      const suspect = mostSuspected(view, village.targets, rng, board);
      const hold = sheriffDead(view) && Number(view.phase.day) === 1 && (!suspect || suspicionScore(view, suspect, board) < 4);
      const noLynch = (village.targets || []).includes(NO_ONE) && !(townSeat(view) && noLynchLoses(view));
      const pick = hold || !suspect ? (noLynch ? NO_ONE : suspect) : suspect;
      if (pick) picks.set(village.id, pick);
    }
  }
  return picks;
}

/**
 * One seat, one seed. Every returned action passes validateAction.
 * @returns {{actions:object[], schedule:object, source:"rulebot", rejections:string[]}}
 */
export function ruleBotActions(view, { seed = 1, rng, now } = {}) {
  const random = typeof rng === "function" ? rng : createSeededRng(seed);
  const schedule = decideSpeech(view, { now });
  if (!view?.selfId || view.finished || view.leftGame) {
    return { actions: [], schedule, source: "rulebot", rejections: [] };
  }
  const board = chatBoard(view);
  const picks = preferredVotes(view, random, board);
  const base = decide(view, { rng: random });
  const actions = [];
  const seen = new Set();
  const put = (action) => {
    if (!action?.data?.meetingId || isPublicSpeak(view, action)) return;
    const key = `${action.event}|${action.data.meetingId}`;
    if (seen.has(key)) return;
    const next = { event: action.event, data: { ...action.data } };
    if (!validateAction(view, next).ok) return;
    seen.add(key);
    actions.push(next);
  };

  for (const action of base) if (action.event === "speak") put(action);

  const mafia = findMeeting(view, /^(mafia|cult)$/i);
  const kill = mafia && picks.get(mafia.id);
  for (const action of actions) {
    if (action.event !== "speak" || !kill || action.data.meetingId !== mafia.id) continue;
    const plan = parsePlanLine(action.data.content, view, view.selfId);
    if (!plan || plan.killTarget === kill) continue;
    const previous = action.data.content;
    action.data.content = formatPlanSpeech({ ...plan, killTarget: kill }, view) || previous;
    if (!validateAction(view, action).ok) action.data.content = previous;
  }

  for (const action of base) {
    if (action.event !== "vote") continue;
    const selection = picks.has(action.data.meetingId) ? picks.get(action.data.meetingId) : action.data.selection;
    put({ event: "vote", data: { meetingId: action.data.meetingId, selection } });
    picks.delete(action.data.meetingId);
  }
  for (const [meetingId, selection] of picks) put({ event: "vote", data: { meetingId, selection } });

  const cap = speechCap(view, { now });
  if (schedule.speak && !schedule.capped && cap.ok) {
    const meeting = publicSpeechMeeting(view);
    const fromRules = base.find((action) => isPublicSpeak(view, action));
    const content = fromRules?.data?.content || templateLine(view, actions);
    if (meeting && content && !alreadySaid(view, content)) {
      const speak = { event: "speak", data: { meetingId: meeting.id, content } };
      if (validateAction(view, speak).ok) actions.push(speak);
    }
  }

  return {
    actions: actions.filter((action) => validateAction(view, action).ok),
    schedule,
    source: "rulebot",
    rejections: [],
  };
}
