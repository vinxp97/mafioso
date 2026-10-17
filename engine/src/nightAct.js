// Night-ability policy. Adapted from UM-Autobot-Player/src/night-act.js:
// same spec/mustAct/meeting filters and pick modes, but pure (map + rng injected,
// no fs/LLM), and every output passes validateAction.
import { createRequire } from "node:module";
import { validateAction } from "./legal.js";
import { isAlive } from "./reducer.js";
import { memoryOf } from "./notes.js";
import { ALIGNMENT } from "./faction.js";
import { townReads } from "./townReads.js";

const DEFAULT_MAP = createRequire(import.meta.url)("../data/night-actions.json");
const KILL_MEETING = /^(mafia|cult)$/i;
const KILL_NAME = /\b(kill|shoot|gun|execute|condemn)\b/i;
const BOOLEAN_TARGET = /^(yes|no)$/i;

export const isKillMeeting = (m) => KILL_MEETING.test(m?.name || "") || KILL_NAME.test(m?.name || "");

/** @returns {import('./types.js').NightSpec} */
export function specForRole(roleName, map = DEFAULT_MAP) {
  const bare = String(roleName || "").split(":")[0];
  const l = map[bare] || {};
  const alwaysAct = String(l.alwaysAct ?? "no").toLowerCase() === "yes" ? "yes" : "no";
  const nights = l.nights || (alwaysAct === "yes" ? "n1" : "none");
  return { role: bare, alwaysAct, nights, n1Pick: l.n1Pick || "random",
    laterPick: l.laterPick || "random", neverNoOne: Boolean(l.neverNoOne) || nights === "all" };
}

export function mustActTonight(spec, night) {
  if (!spec || spec.alwaysAct !== "yes" || !night) return false;
  if (spec.nights === "all" || spec.neverNoOne) return true;
  return night === 1;
}

/** Non-kill meetings the bot can vote in that target players. */
export function nightAbilityMeetings(view) {
  return Object.values(view.meetings).filter((m) => m?.amMember && m.voting && m.canVote
    && !isKillMeeting(m)
    && (m.targets || []).some((t) => t !== "*" && !BOOLEAN_TARGET.test(String(t))));
}

function rankNightTargets(ids, memory) {
  const unseen = ids.filter((id) => !memory.cleared.has(id) && !memory.checks[id]);
  const pool = unseen.length ? unseen : ids.filter((id) => !memory.cleared.has(id));
  const use = pool.length ? pool : ids;
  const suspects = use.filter((id) => memory.suspects.has(id));
  return suspects.length ? suspects : use;
}

/** True when this role's policy says to act and a non-faction meeting still has a living target. */
export function mustActMeeting(view) {
  if (view.phase?.phase !== "Night" || !view.selfId) return false;
  const spec = specForRole(view.role);
  if (!mustActTonight(spec, view.phase.day)) return false;
  return Object.values(view.meetings || {}).some((meeting) => {
    if (!meeting?.amMember || !meeting.voting || !meeting.canVote) return false;
    if (/^(mafia|cult)$/i.test(meeting.name || "")) return false;
    const mine = meeting.votes?.[view.selfId];
    const open = mine == null || (Array.isArray(mine) && !mine.length);
    return open && livingTargets(view, meeting).length > 0;
  });
}

export const livingTargets = (view, m) => (m?.targets || []).filter((t) =>
  t !== "*" && t !== view.selfId && !BOOLEAN_TARGET.test(String(t)) && isAlive(view, t));

const SCUM = /\b(fos|scum|scummy|mafia|maf|wolfy|wolf)\b/i;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "read": last player named alongside a scum word in chat. */
export function pickByRead(view, ids) {
  let hit = null;
  for (const msg of view.messages) {
    if (!msg || msg.senderId === "server" || !SCUM.test(String(msg.content || ""))) continue;
    for (const id of ids) {
      const name = view.players[id]?.name;
      if (name && id !== msg.senderId && new RegExp(`\\b${esc(name)}\\b`, "i").test(msg.content)) hit = id;
    }
  }
  return hit;
}

/** "asked": most recent "carol me" sender among ids. */
export function pickAsked(view, ids) {
  for (const msg of [...view.messages].reverse())
    if (ids.includes(msg?.senderId) && /\bcarol(?:ed|ing)?\s+me\b/i.test(String(msg.content || ""))) return msg.senderId;
  return null;
}

/**
 * Town investigators follow the public reads (townReads): the Journalist visits an unvisited Cop claimer
 * from Night 2 (a fake Cop gets no report), the Cop checks the most suspicious unchecked player.
 */
function readPick(view, spec, night, ids, memory) {
  const role = String(view.role || "");
  if (!/^(cop|journalist)$/i.test(role) || ALIGNMENT[role] !== "Village") return null;
  const reads = townReads(view);
  const fresh = ids.filter((id) => !memory.checks[id] && !memory.cleared.has(id));
  const best = (list) => list.map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  if (/journalist/i.test(role) && night > 1) {
    const cops = fresh.filter((id) => reads.record.claims[id] === "Cop");
    if (cops.length) return best(cops)[0];
  }
  if (/^cop$/i.test(role)) {
    const top = best(fresh);
    if (top && top[1] > 0) return top[0];
  }
  return null;
}

/**
 * Propose a night vote for the bot's role. Returns a validated ProposedAction or null.
 * opts: {role?, meetingName?, map?, rng?, lastTargetId?}
 */
export function proposeNightAction(view, opts = {}) {
  if (view.phase?.phase !== "Night") return null;
  const night = view.phase.day;
  const spec = specForRole(opts.role ?? view.role, opts.map);
  let meetings = nightAbilityMeetings(view).filter((m) => m.votes?.[view.selfId] == null);
  if (opts.meetingName) meetings = meetings.filter((m) => m.name.toLowerCase() === opts.meetingName.toLowerCase());
  const m = meetings[0];
  if (!m) return null;
  const forced = mustActTonight(spec, night);
  let ids = livingTargets(view, m);
  if (opts.lastTargetId && ids.length > 1) ids = ids.filter((i) => i !== opts.lastTargetId);
  let pick = null;
  if (ids.length) {
    const mode = night > 1 ? spec.laterPick : spec.n1Pick;
    if (mode === "asked") pick = pickAsked(view, ids);
    if (mode === "read") pick = pickByRead(view, ids);
    const memory = memoryOf(view);
    const ranked = rankNightTargets(ids, memory);
    if (pick && ranked.length && !ranked.includes(pick) && (memory.cleared.has(pick) || memory.checks[pick])) pick = null;
    if (!pick) pick = readPick(view, spec, night, ids, memory);
    if (!pick) {
      const bag = ranked.length ? ranked : ids;
      pick = bag[Math.floor((opts.rng ?? Math.random)() * bag.length) % bag.length];
    }
  } else if (!forced && m.targets?.includes("*")) pick = "*";
  if (!pick) return null;
  const action = { event: "vote", data: { meetingId: m.id, selection: pick } };
  return validateAction(view, action).ok ? { ...action, forced, mode: forced ? "policy" : "optional" } : null;
}
