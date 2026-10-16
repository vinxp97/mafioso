// Faction plan read from THIS bot's copy of the faction meeting.
// Another seat learns the plan only when the game delivers that chat to them.
import { allies, FACTION_MEETINGS, myFaction } from "./faction.js";
import { memoryOf } from "./notes.js";
import { MAX_SPEECH, NO_ONE } from "./types.js";

const PLAN_RE = /\bPLAN\s+kill=(\S+)\s+lynch=(\S+)\s+claim=(\S+)\s+lawyer=(\S+)\s+speaker=(\S+)/i;

export function scumFaction(view) {
  const faction = myFaction(view);
  if (faction !== "Mafia" && faction !== "Cult") return null;
  return faction;
}

export function isLawyerRole(role) {
  return /lawyer/i.test(String(role || ""));
}

function alive(view, id) {
  const player = view.players?.[id];
  return !!player && !player.left && !view.dead?.[id];
}

function factionMeeting(view, faction) {
  const name = FACTION_MEETINGS[faction] || faction;
  return Object.values(view.meetings || {}).find((m) => m?.amMember && m.name === name) || null;
}

function blank(token) {
  return token == null || token === "-" || token === "none" ? null : String(token);
}

export function parsePlanLine(text) {
  const match = String(text || "").match(PLAN_RE);
  if (!match) return null;
  const killTarget = blank(match[1]);
  if (!killTarget || killTarget === NO_ONE) return null;
  return {
    killTarget,
    lynchTarget: blank(match[2]),
    claimRole: blank(match[3]) || "Cop",
    lawyerTarget: blank(match[4]) || killTarget,
    speakerId: blank(match[5]),
  };
}

export function formatPlanSpeech(plan) {
  const line = `PLAN kill=${plan.killTarget} lynch=${plan.lynchTarget || "-"} claim=${plan.claimRole || "Cop"} lawyer=${plan.lawyerTarget || plan.killTarget} speaker=${plan.speakerId || "-"}`;
  return line.slice(0, MAX_SPEECH);
}

export function claimLine(plan) {
  return `I'm ${plan.claimRole || "Cop"}. Vote ${plan.lynchTarget}.`;
}

/** Record the first PLAN line this bot sees in its own faction meeting. */
export function noteFactionPlan(view, message) {
  if (!view?.notes || view.notes.plan || !message?.meetingId) return;
  const parsed = parsePlanLine(message.content);
  if (!parsed) return;
  const faction = scumFaction(view);
  if (!faction) return;
  const meeting = view.meetings?.[message.meetingId];
  const name = FACTION_MEETINGS[faction] || faction;
  if (!meeting?.amMember || meeting.name !== name) return;
  view.notes.plan = {
    killTarget: parsed.killTarget,
    lynchTarget: parsed.lynchTarget,
    claimRole: parsed.claimRole,
    lawyerTarget: parsed.lawyerTarget || parsed.killTarget,
    janitorTarget: parsed.killTarget,
    speakerId: parsed.speakerId || message.senderId || null,
    source: "chat",
  };
}

/** Plan already visible to this bot. Drafts are not stored here. */
export function agreedPlan(view) {
  const faction = scumFaction(view);
  if (!faction) return null;
  if (view.notes?.plan?.source === "chat" && view.notes.plan.killTarget) return view.notes.plan;
  const name = FACTION_MEETINGS[faction] || faction;
  for (const message of view.messages || []) {
    const meeting = message?.meetingId ? view.meetings?.[message.meetingId] : null;
    if (!meeting?.amMember || meeting.name !== name) continue;
    const parsed = parsePlanLine(message.content);
    if (!parsed) continue;
    return {
      ...parsed,
      lawyerTarget: parsed.lawyerTarget || parsed.killTarget,
      janitorTarget: parsed.killTarget,
      speakerId: parsed.speakerId || message.senderId || null,
      source: "chat",
    };
  }
  return null;
}

function lawyerAsk(view, teammates) {
  for (let i = (view.messages || []).length - 1; i >= 0; i--) {
    const message = view.messages[i];
    if (!message || !teammates.has(message.senderId)) continue;
    const text = String(message.content || "");
    if (/\blawyer\s+me\b/i.test(text) && alive(view, message.senderId)) return message.senderId;
    const named = text.match(/\blawyer\s+(?!me\b)([A-Za-z0-9_-]+)\b/i);
    if (!named) continue;
    const id = Object.values(view.players || {}).find((p) => p && (p.id === named[1] || String(p.name || "").toLowerCase() === named[1].toLowerCase()))?.id;
    if (id && teammates.has(id) && alive(view, id)) return id;
  }
  return null;
}

function pickFrom(view, ids) {
  const memory = memoryOf(view);
  const fresh = ids.filter((id) => !memory.cleared.has(id));
  const pool = fresh.length ? fresh : ids;
  return pool.find((id) => memory.suspects.has(id)) || pool[0] || null;
}

/** This seat's own proposal. Not written onto the view and not visible to other seats. */
export function draftPlan(view) {
  const faction = scumFaction(view);
  if (!faction || view.phase?.phase !== "Night") return null;
  const meeting = factionMeeting(view, faction);
  if (!meeting) return null;
  const teammates = allies(view);
  const killPool = (meeting.targets || []).filter((id) => id !== view.selfId && id !== NO_ONE && alive(view, id) && !teammates.has(id));
  const killTarget = pickFrom(view, killPool);
  if (!killTarget) return null;
  const lynchPool = Object.keys(view.players || {}).filter((id) => id !== view.selfId && id !== killTarget && alive(view, id) && !teammates.has(id));
  const asked = lawyerAsk(view, teammates);
  return {
    killTarget,
    lynchTarget: pickFrom(view, lynchPool) || killTarget,
    claimRole: "Cop",
    lawyerTarget: asked || killTarget,
    janitorTarget: killTarget,
    speakerId: view.selfId,
    source: "draft",
  };
}

function unvoted(meeting, selfId) {
  const mine = meeting?.votes?.[selfId];
  return mine == null || (Array.isArray(mine) && mine.length === 0);
}

function needsTarget(meeting, selfId, target) {
  const mine = meeting?.votes?.[selfId];
  if (mine == null || (Array.isArray(mine) && mine.length === 0)) return true;
  if (mine === target) return false;
  return meeting.canUpdateVote !== false;
}

function said(view, content) {
  return (view.messages || []).some((message) => message?.senderId === view.selfId && message.content === content);
}

export function lawyerSelection(meeting, plan) {
  const targets = meeting?.targets || [];
  if (plan.lawyerTarget && targets.includes(plan.lawyerTarget)) return plan.lawyerTarget;
  if (targets.includes(plan.killTarget)) return plan.killTarget;
  return null;
}

export function janitorSelection(meeting, plan) {
  const targets = meeting?.targets || [];
  const kill = plan.janitorTarget || plan.killTarget;
  if (kill && targets.includes(kill)) return kill;
  const yes = targets.find((target) => /^yes$/i.test(String(target)));
  return yes || null;
}

function roleMeetings(view, chat) {
  return Object.values(view.meetings || {}).filter((meeting) => meeting?.amMember && meeting.voting && meeting.canVote && meeting.id !== chat?.id);
}

function nightScum(view, faction) {
  const agreed = agreedPlan(view);
  const plan = agreed || draftPlan(view);
  if (!plan) return null;
  const chat = factionMeeting(view, faction);
  const out = [];
  if (!agreed && chat?.speech) {
    const content = formatPlanSpeech(plan);
    if (!said(view, content)) out.push({ event: "speak", data: { meetingId: chat.id, content } });
  }
  if (chat?.voting && chat.canVote && (chat.targets || []).includes(plan.killTarget) && needsTarget(chat, view.selfId, plan.killTarget)) {
    out.push({ event: "vote", data: { meetingId: chat.id, selection: plan.killTarget } });
  }
  for (const meeting of roleMeetings(view, chat)) {
    if (isLawyerRole(view.role)) {
      const selection = lawyerSelection(meeting, plan);
      if (selection && needsTarget(meeting, view.selfId, selection)) out.push({ event: "vote", data: { meetingId: meeting.id, selection } });
    }
    if (view.role === "Janitor") {
      const selection = janitorSelection(meeting, plan);
      if (selection && needsTarget(meeting, view.selfId, selection)) out.push({ event: "vote", data: { meetingId: meeting.id, selection } });
    }
  }
  return out;
}

function dayScum(view) {
  const plan = agreedPlan(view);
  if (!plan) return null;
  const village = Object.values(view.meetings || {}).find((meeting) => meeting?.name === "Village" && meeting.amMember);
  if (!village) return null;
  const out = [];
  if (plan.speakerId === view.selfId && village.speech && plan.lynchTarget) {
    const content = claimLine(plan);
    if (content.length <= MAX_SPEECH && !said(view, content)) out.push({ event: "speak", data: { meetingId: village.id, content } });
  }
  const teammates = allies(view);
  const lynchOk = plan.lynchTarget && plan.lynchTarget !== view.selfId && !teammates.has(plan.lynchTarget) && (village.targets || []).includes(plan.lynchTarget);
  if (village.voting && village.canVote && lynchOk && needsTarget(village, view.selfId, plan.lynchTarget)) {
    out.push({ event: "vote", data: { meetingId: village.id, selection: plan.lynchTarget } });
  }
  if (!out.length && !unvoted(village, view.selfId)) return [];
  if (!out.length) return null;
  return out;
}

/** Null when this seat is not scum. Empty when the scum actions for this phase are done. */
export function scumDecisions(view) {
  const faction = scumFaction(view);
  if (!faction) return null;
  if (view.phase?.phase === "Night") return nightScum(view, faction);
  if (view.phase?.phase === "Day") return dayScum(view);
  return null;
}

export function scumOwesNightVote(view) {
  if (view.phase?.phase !== "Night") return false;
  const faction = scumFaction(view);
  if (!faction) return false;
  const chat = factionMeeting(view, faction);
  if (chat?.voting && chat.canVote && unvoted(chat, view.selfId) && (chat.targets || []).some((id) => id !== NO_ONE && id !== view.selfId)) return true;
  if (view.role !== "Janitor" && !isLawyerRole(view.role)) return false;
  return roleMeetings(view, chat).some((meeting) => unvoted(meeting, view.selfId));
}

export function planViolation(view, action) {
  if (!action || action.event !== "vote") return null;
  const plan = agreedPlan(view);
  if (!plan) return null;
  const meeting = view.meetings?.[action.data?.meetingId];
  if (!meeting) return null;
  const faction = scumFaction(view);
  const factionName = faction ? (FACTION_MEETINGS[faction] || faction) : null;
  if (factionName && meeting.name === factionName && (meeting.targets || []).includes(plan.killTarget) && action.data.selection !== plan.killTarget) {
    return "kill vote must match the faction plan";
  }
  if (meeting.name === "Village" && plan.lynchTarget && (meeting.targets || []).includes(plan.lynchTarget) && !allies(view).has(plan.lynchTarget) && action.data.selection !== plan.lynchTarget) {
    return "day vote must match the faction plan";
  }
  if (factionName && meeting.name !== factionName && isLawyerRole(view.role)) {
    const selection = lawyerSelection(meeting, plan);
    if (selection && action.data.selection !== selection) return "lawyer target must match the faction plan";
  }
  if (factionName && meeting.name !== factionName && view.role === "Janitor") {
    if (/^(no|skip|none|\*)$/i.test(String(action.data.selection))) return "janitor must not skip the clean";
    const selection = janitorSelection(meeting, plan);
    if (selection && action.data.selection !== selection) return "janitor must clean the kill";
  }
  return null;
}
