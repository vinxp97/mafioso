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

/** Faction chat: where PLAN lines go. Never a public meeting. */
function factionMeeting(view, faction) {
  const name = FACTION_MEETINGS[faction] || faction;
  return Object.values(view.meetings || {}).find((m) => m?.amMember && m.name === name && (m.factionRole == null || m.factionRole === "chat")) || null;
}

/** Faction kill vote: the split "Mafia Kill" meeting, or a combined "Mafia" meeting that votes. */
export function factionKillMeeting(view, faction = scumFaction(view)) {
  if (!faction) return null;
  const ms = Object.values(view.meetings || {}).filter((m) => m?.amMember);
  return ms.find((m) => m.factionRole === "kill" && m.faction === faction)
    || ms.find((m) => m.name === (FACTION_MEETINGS[faction] || faction) && m.factionRole !== "action" && m.voting) || null;
}

function factionActionMeeting(view, faction) {
  return Object.values(view.meetings || {}).find((m) => m?.amMember && m.factionRole === "action" && m.faction === faction) || null;
}

export function isVoteKick(meeting) {
  if (!meeting) return false;
  const t = meeting.targets || [];
  return /vote\s*kick/i.test(String(meeting.name || "")) || (t.length === 1 && /^kick$/i.test(String(t[0])));
}

/** Seats that lead the faction's night: lowest player id among living faction members. */
export function factionLeader(view) {
  const ids = [view.selfId, ...allies(view)].filter((id) => id && alive(view, id)).sort();
  return ids[0] || null;
}

/** A living teammate's vote already in the kill meeting: copy it. */
export function teammateKillVote(view) {
  const kill = factionKillMeeting(view);
  if (!kill) return null;
  const mates = allies(view);
  for (const [voter, t] of Object.entries(kill.votes || {})) {
    const sel = Array.isArray(t) ? t[0] : t;
    if (voter !== view.selfId && mates.has(voter) && sel && sel !== NO_ONE && (kill.targets || []).includes(sel) && !mates.has(sel)) return sel;
  }
  return null;
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
    lawyerTarget: blank(match[4]),
    speakerId: blank(match[5]),
  };
}

export function formatPlanSpeech(plan) {
  const line = `PLAN kill=${plan.killTarget} lynch=${plan.lynchTarget || "-"} claim=${plan.claimRole || "Cop"} lawyer=${plan.lawyerTarget || "-"} speaker=${plan.speakerId || "-"}`;
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
    lawyerTarget: parsed.lawyerTarget,
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
      lawyerTarget: parsed.lawyerTarget,
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

// Loyal Lawyer makes a teammate look innocent: prefer a living non-Lawyer teammate.
function lawyerTeammate(view, teammates) {
  const roleOf = (id) => (id === view.selfId ? view.role : view.teammates?.[id]?.role || view.reveals?.[id]);
  const pool = [view.selfId, ...teammates].filter((id) => id && alive(view, id) && !isLawyerRole(roleOf(id))).sort();
  return pool.find((id) => /mafioso/i.test(String(roleOf(id) || ""))) || pool[0] || null;
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
  const meeting = factionKillMeeting(view, faction);
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
    lawyerTarget: asked || lawyerTeammate(view, teammates),
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

export function lawyerSelection(meeting, plan, view = null) {
  const targets = meeting?.targets || [];
  const mates = view ? allies(view) : null;
  const ok = (id) => id && targets.includes(id) && (!mates || mates.has(id) || id === view?.selfId);
  if (ok(plan?.lawyerTarget)) return plan.lawyerTarget;
  if (view) { const t = lawyerTeammate(view, mates); if (ok(t)) return t; }
  return null;
}

/** The Mafia kill this seat can see: majority of the faction meeting's votes. */
export function factionKillVote(view) {
  const faction = scumFaction(view);
  const chat = faction ? factionKillMeeting(view, faction) : null;
  const counts = {};
  for (const t of Object.values(chat?.votes || {})) for (const id of Array.isArray(t) ? t : [t]) if (id && id !== NO_ONE) counts[id] = (counts[id] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

export function janitorSelection(meeting, plan) {
  const targets = meeting?.targets || [];
  const kill = plan?.janitorTarget || plan?.killTarget;
  if (kill && targets.includes(kill)) return kill;
  const yes = targets.find((target) => /^yes$/i.test(String(target)));
  return yes || null;
}

function roleMeetings(view) {
  return Object.values(view.meetings || {}).filter((meeting) => meeting?.amMember && meeting.voting && meeting.canVote
    && meeting.faction == null && meeting.name !== (FACTION_MEETINGS[scumFaction(view)] || "") && !isVoteKick(meeting));
}

function nightScum(view, faction) {
  const agreed = agreedPlan(view);
  const copied = teammateKillVote(view);
  const leader = factionLeader(view) === view.selfId;
  let plan = agreed || draftPlan(view);
  // Only the first voter decides: a teammate's kill vote wins over this seat's own draft.
  if (!agreed && copied) plan = { ...(plan || {}), killTarget: copied, janitorTarget: copied, source: "copy" };
  if (view.role === "Janitor" && !agreed && !copied) {
    const voted = factionKillVote(view);
    if (voted) plan = { ...(plan || {}), killTarget: voted, janitorTarget: voted, source: plan?.source || "vote" };
  }
  if (!plan) return null;
  const chat = factionMeeting(view, faction);
  const kill = factionKillMeeting(view, faction);
  const out = [];
  // One PLAN per faction, from the leader, in the faction chat only.
  if (!agreed && !copied && leader && chat?.speech && (chat.name === "Mafia" || chat.name === "Cult")) {
    const content = formatPlanSpeech(plan);
    if (!said(view, content)) out.push({ event: "speak", data: { meetingId: chat.id, content } });
  }
  const mayDecide = agreed || copied || leader;
  if (mayDecide && kill?.voting && kill.canVote !== false && (kill.targets || []).includes(plan.killTarget) && needsTarget(kill, view.selfId, plan.killTarget)) {
    out.push({ event: "vote", data: { meetingId: kill.id, selection: plan.killTarget } });
  }
  const action = factionActionMeeting(view, faction);
  const killDone = kill && !unvoted(kill, view.selfId);
  if (action?.voting && action.canVote !== false && killDone && unvoted(action, view.selfId)) {
    const yes = (action.targets || []).find((t) => /^yes$/i.test(String(t)));
    if (yes) out.push({ event: "vote", data: { meetingId: action.id, selection: yes } });
  }
  for (const meeting of roleMeetings(view)) {
    if (isLawyerRole(view.role)) {
      const selection = lawyerSelection(meeting, plan, view);
      if (selection && unvoted(meeting, view.selfId)) out.push({ event: "vote", data: { meetingId: meeting.id, selection } });
    }
    if (view.role === "Janitor") {
      const selection = janitorSelection(meeting, plan);
      if (selection && unvoted(meeting, view.selfId)) out.push({ event: "vote", data: { meetingId: meeting.id, selection } });
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
  const kill = factionKillMeeting(view, faction);
  if (kill?.voting && kill.canVote !== false && unvoted(kill, view.selfId) && (kill.targets || []).some((id) => id !== NO_ONE && id !== view.selfId)) return true;
  const action = factionActionMeeting(view, faction);
  if (action?.voting && action.canVote !== false && unvoted(action, view.selfId)) return true;
  if (view.role !== "Janitor" && !isLawyerRole(view.role)) return false;
  return roleMeetings(view).some((meeting) => unvoted(meeting, view.selfId));
}

export function planViolation(view, action) {
  if (!action || action.event !== "vote") return null;
  const plan = agreedPlan(view);
  if (!plan) return null;
  const meeting = view.meetings?.[action.data?.meetingId];
  if (!meeting) return null;
  const faction = scumFaction(view);
  const factionName = faction ? (FACTION_MEETINGS[faction] || faction) : null;
  const killM = factionKillMeeting(view, faction);
  if (killM && meeting.id === killM.id && (meeting.targets || []).includes(plan.killTarget) && action.data.selection !== plan.killTarget) {
    return "kill vote must match the faction plan";
  }
  if (meeting.name === "Village" && plan.lynchTarget && (meeting.targets || []).includes(plan.lynchTarget) && !allies(view).has(plan.lynchTarget) && action.data.selection !== plan.lynchTarget) {
    return "day vote must match the faction plan";
  }
  if (factionName && meeting.faction == null && meeting.name !== factionName && isLawyerRole(view.role)) {
    const selection = lawyerSelection(meeting, plan, view);
    if (selection && action.data.selection !== selection) return "lawyer target must match the faction plan";
  }
  if (factionName && meeting.faction == null && meeting.name !== factionName && !isVoteKick(meeting) && view.role === "Janitor") {
    if (/^(no|skip|none|\*)$/i.test(String(action.data.selection))) return "janitor must not skip the clean";
    const selection = janitorSelection(meeting, plan);
    if (selection && action.data.selection !== selection) return "janitor must clean the kill";
  }
  return null;
}
