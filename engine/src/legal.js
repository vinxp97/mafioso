import { sheriffShotCheck } from "./sheriffGate.js";
import { isPublicSpeechMeeting } from "./scheduler.js";
import { selfAlive } from "./reducer.js";
import { MAX_SPEECH } from "./types.js";
import { PUBLIC_MAX, earlyClaimBlock } from "./chatStyle.js";
import { agreedPlan } from "./scumPlan.js";

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
  // PLAN syntax, prompt text and raw ids never go to a public chat.
  if (action.event === "speak" && view.meetings?.[action.data?.meetingId] && isPublicSpeechMeeting(view.meetings[action.data.meetingId])) {
    const leak = publicLeak(view, action.data?.content);
    if (leak) return no(`public leak: ${leak}`);
    if (String(action.data?.content || "").length > PUBLIC_MAX) return no("too long for chat");
    const claim = earlyClaimBlock(view, action.data?.content, { planSpeaker: agreedPlan(view)?.speakerId === view.selfId, planRole: agreedPlan(view)?.claimRole });
    if (claim) return no(claim);
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

const LEAK_RE = /\bPLAN\b|\b(kill|lynch|condemn|claim|lawyer|speaker)=|\bsystem\b|\bprompt\b/i;
/** Reason a public line must not go out, or null. */
export function publicLeak(view, content) {
  const text = String(content || "");
  const m = text.match(LEAK_RE);
  if (m) return `contains "${m[0]}"`;
  for (const id of Object.keys(view?.players || {})) {
    if (id.length >= 4 && text.includes(id)) return "contains a player id";
  }
  return null;
}
