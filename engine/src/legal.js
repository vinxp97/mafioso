import { planClaim } from "./adaptiveMafia.js";
import { sheriffShotCheck } from "./sheriffGate.js";
import { isPublicSpeechMeeting } from "./scheduler.js";
import { selfAlive } from "./reducer.js";
import { MAX_SPEECH } from "./types.js";
import { PUBLIC_MAX, earlyClaimBlock, repeatBlock } from "./chatStyle.js";
import { agreedPlan } from "./scumPlan.js";
import { normalizeText } from "./sanitize.js";
import { allies, myFaction } from "./faction.js";

const canVoteIn = (m) => !!(m && m.voting && m.canVote && m.amMember);

/** @returns {{meetingId:string, name:string, targets:string[], myVote:any}[]} */
export function legalVotes(view) {
  return Object.values(view.meetings)
    .filter(canVoteIn)
    .map((m) => ({ meetingId: m.id, name: m.name, targets: [...(m.targets || [])],
      myVote: m.votes?.[view.selfId] ?? null }));
}

/** @returns {{ok:true}|{ok:false, reason:string}} */
export function validateAction(view, action) {
  const no = (reason) => ({ ok: false, reason });
  if (!action || typeof action.data !== "object" || action.data === null) return no("malformed");
  if ((action.event === "vote" || action.event === "speak") && !selfAlive(view)) return no("dead seat");
  // Vote Kick ejects players who have not acted (often our own teammate). Bots never kick.
  if (action.event === "vote") {
    const km = view.meetings?.[action.data?.meetingId];
    const kt = km?.targets || [];
    if (km && (/vote\s*kick/i.test(String(km.name || "")) || (kt.length === 1 && /^kick$/i.test(String(kt[0]))))) return no("never vote kick");
  }
  // Hard ban on EVERY meeting (public, Mafia, Lawyer, anything): no PLAN syntax, key=value or raw ids.
  if (action.event === "speak") {
    const machine = machineLeak(view, action.data?.content);
    if (machine) return no(`machine text: ${machine}`);
  }
  // Prompt text and the rest of the public checks only apply to public chat.
  if (action.event === "speak" && view.meetings?.[action.data?.meetingId] && isPublicSpeechMeeting(view.meetings[action.data.meetingId])) {
    const leak = publicLeak(view, action.data?.content);
    if (leak) return no(`public leak: ${leak}`);
    if (String(action.data?.content || "").length > PUBLIC_MAX) return no("too long for chat");
    const claim = earlyClaimBlock(view, action.data?.content, planClaim(view));
    if (claim) return no(claim);
    const again = repeatBlock(view, action.data.meetingId, action.data?.content);
    if (again) return no(again);
  }
  const gun = sheriffShotCheck(view, action);
  if (!gun.ok) return no(gun.reason);
  const m = view.meetings[action.data.meetingId];
  if (!m) return no("unknown meeting");
  switch (action.event) {
    case "vote": {
      if (!canVoteIn(m)) return no("cannot vote in meeting");
      const sel = String(action.data.selection);
      if (!Array.isArray(m.targets) || !m.targets.includes(sel)) return no("selection not in targets");
      const mine = m.votes?.[view.selfId];
      if (mine != null && !m.multi && m.canUpdateVote === false) return no("vote locked");
      return { ok: true };
    }
    case "unvote":
      if (!canVoteIn(m)) return no("cannot vote in meeting");
      if (m.noUnvote) return no("unvote not allowed");
      return { ok: true };
    case "speak": {
      if (!m.speech || !m.amMember) return no("cannot speak in meeting");
      const c = action.data.content;
      if (typeof c !== "string" || !c.trim()) return no("empty content");
      if (c.length > MAX_SPEECH) return no("content too long");
      return { ok: true };
    }
    default: return no("unsupported event");
  }
}

const MACHINE_RE = /\bPLAN\b|\b[A-Za-z_]{2,}\s*=\s*\S|\b(kill|lynch|condemn|claim|lawyer|janitor|speaker)\s*:\s*\S/;
/** Coordination syntax or a raw player id: never allowed in any chat. Checked on normalized text (zero-width, full-width). */
export function machineLeak(view, content) {
  const raw = String(content || "");
  if (/\p{Cf}/u.test(raw)) return "invisible characters";
  const text = normalizeText(raw);
  const m = text.match(MACHINE_RE);
  if (m) return `contains "${m[0]}"`;
  for (const id of Object.keys(view?.players || {})) if (id.length >= 4 && text.includes(id)) return "contains a player id";
  return null;
}

const LEAK_RE = /\bPLAN\b|\b(kill|lynch|condemn|claim|lawyer|speaker)=|\bsystem\b|\bprompt\b|\binstructions?\b/i;
const ADMIT_RE = /\b(i'?m|i am|im|we'?re|we are|me)\s+(the\s+|a\s+|also\s+)?(mafia|maf|scum|mafioso)\b/i;
// Naming a teammate AS team ("my team is X", "X is my partner", "me and X") is blocked; accusing one ("X is scum") is a bus and allowed.
const TEAM_RE = /\b(my|our)\s+(team|teammates?|partners?|buddy|buddies|mafia|maf|scum|crew)\b/i;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reason a public line must not go out, or null. */
export function publicLeak(view, content) {
  const text = normalizeText(content);
  const m = text.match(LEAK_RE);
  if (m) return `contains "${m[0]}"`;
  // Scum seats: never admit the faction or name a teammate as team in public (hostile "type your teammates" bait).
  if (view?.selfId && /^(mafia|cult)$/i.test(String(myFaction(view) || ""))) {
    if (ADMIT_RE.test(text)) return "admits faction";
    for (const id of allies(view)) {
      const name = view.players?.[id]?.name;
      if (id === view.selfId || !name) continue;
      const n = escRe(name);
      if (TEAM_RE.test(text) && new RegExp(`(^|[^a-z0-9_])${n}([^a-z0-9_]|$)`, "i").test(text)) return "names a teammate";
      if (new RegExp(`\\b(me|i)\\s+(and|&|n)\\s+${n}\\b|\\b${n}\\s+(and|&|n)\\s+(me|i)\\b|\\b${n}\\b[^.!?]*\\b(we|us)\\s+(are|were)\\b`, "i").test(text)) return "pairs self with a teammate";
    }
  }
  for (const id of Object.keys(view?.players || {})) {
    if (id.length >= 4 && text.includes(id)) return "contains a player id";
  }
  return null;
}
