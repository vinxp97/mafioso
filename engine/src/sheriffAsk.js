// Vinman (2026-10-18): the Sheriff asks his intended target for a claim before he shoots. A power-role
// answer waits for a counterclaim; an uncounterclaimed power role is not shot (pick someone else). No answer,
// a refusal or a non-power answer lets the shot go ahead. Pure: reads one seat's view.
//   ask        a public line from the Sheriff (this seat, or the living Sheriff claimer / revealed Sheriff) naming
//              one living player and asking for a role ("ash claim?", "ash whats your role").
//   reply      that player's first public line after the ask: parseClaimReply -> power | plain | refuse | null.
//   counter    another living player claims the same role, or a dead player already flipped it.
import { claimedRoleIn } from "./chatStyle.js";
import { splitAppearance } from "./reducer.js";

export const SHERIFF_ASK = Object.freeze({
  replyMs: 15_000, // how long the Sheriff waits for an answer (L6 10/18: 30s -> 15s, then he shoots)
  askAfterClaimMs: 8_000, // L5: the first ask goes out this long after his claim (or after askAfterLines other lines)
  askAfterLines: 2,
  lateReplyMs: 10_000, // late in the day (L4): the shortest wait after an ask before shooting
  ccMs: 40_000, // after a power-role answer, how long he waits for a counterclaim
  askFraction: 0.45, // with no read, the Sheriff asks once this much of the day has gone (or the discussion gate passed)
  maxAsks: 3, // asks per day
});

/** Power roles a claim protects from the shot (Vinman: Cop/Journalist/Sheriff/Doctor etc.). */
export const ASK_POWER = Object.freeze(new Set(["Cop", "Journalist", "Sheriff", "Doctor", "Detective", "Medic", "Tracker", "Watcher", "Vigilante", "Deputy"]));
const ROLE_OF = { cop: "Cop", journalist: "Journalist", journo: "Journalist", sheriff: "Sheriff", doctor: "Doctor", doc: "Doctor", medic: "Doctor",
  villager: "Villager", vanilla: "Villager", vt: "Villager", "v/t": "Villager", town: "Villager", townie: "Villager", blue: "Villager", "plain town": "Villager", "vanilla town": "Villager",
  mafioso: "Mafioso", lawyer: "Lawyer", janitor: "Janitor", godfather: "Godfather" };

const ASK_RE = /\b(claim|claiming|role|what are you|wha?t r u|whats ur role|what'?s your role|u claim)\b/i;
const NOT_ASK_RE = /\b(i'?m|im|i am)\s+(?:the\s+|a\s+|real\s+)*sheriff\b/i;
const REFUSE_RE = /\b(not claiming|no claim|won'?t claim|wont claim|not telling|not gonna claim|rather not|pass)\b/i;
const NEG_RE = /\b(not|never|isn'?t|aint|ain'?t)\s+(?:a\s+|the\s+)?(cop|journalist|journo|sheriff|doctor|doc)\b/i;
const BARE_RE = /^\s*(?:i'?m\s+|im\s+|i am\s+)?(?:just\s+|a\s+|the\s+|only\s+|plain\s+)*(vanilla town|plain town|cop|journalist|journo|sheriff|doctor|doc|medic|villager|vanilla|v\/t|vt|townie|town|blue)\b/i;
const DOC_RE = /\b(?:i'?m|im|i am)\s+(?:the\s+|a\s+|just\s+)*(doc|journo)\b/i;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const nameOf = (view, id) => String(view?.players?.[id]?.name || "").toLowerCase();
const named = (view, text, id) => { const n = nameOf(view, id); return n.length >= 2 && new RegExp(`(^|[^a-z0-9_])${esc(n)}([^a-z0-9_]|$)`, "i").test(String(text || "")); };
const lines = (view) => (view?.messages || []).filter((m) => m && m.senderId && m.senderId !== "server" && m.public !== false);
const today = (view) => lines(view).filter((m) => !m.phase || !view?.phase?.name || m.phase === view.phase.name);

/**
 * A reply to "claim?": { role, kind } where kind is "power" (a power role), "plain" (Villager or a non-power
 * role), "refuse" (won't claim), or null (not an answer). Live-path parser: casual chat, any case.
 */
export function parseClaimReply(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (NEG_RE.test(t) && !claimedRoleIn(t.replace(NEG_RE, " "))) {
    // "not cop, vt": the negated role is not a claim; read what is left.
    const rest = t.replace(NEG_RE, " ").replace(/^[\s,.;:!-]+/, "");
    const r = parseClaimReply(rest);
    return r || { role: null, kind: "refuse" };
  }
  const word = claimedRoleIn(t) || (t.match(DOC_RE) || [])[1] || (t.match(BARE_RE) || [])[1];
  const role = word ? ROLE_OF[String(word).toLowerCase()] || null : null;
  if (role) return { role, kind: ASK_POWER.has(role) ? "power" : "plain" };
  if (REFUSE_RE.test(t)) return { role: null, kind: "refuse" };
  return null;
}

/** The Sheriff this seat can see: itself, the revealed living Sheriff, else the living Sheriff claimer. */
export function sheriffSeat(view) {
  if (/^sheriff$/i.test(String(view?.role || "")) && alive(view, view.selfId)) return view.selfId;
  const rev = Object.entries(view?.reveals || {}).find(([id, a]) => splitAppearance(a).role === "Sheriff" && alive(view, id));
  if (rev) return rev[0];
  for (const m of lines(view)) if (alive(view, m.senderId) && claimedRoleIn(m.content) === "sheriff") return m.senderId;
  const c = Object.entries(view?.claims || {}).find(([id, x]) => x?.kind !== "retract" && /^sheriff$/i.test(String(x?.role || "")) && alive(view, id));
  return c ? c[0] : null;
}

/** The living player a Sheriff line asks for a claim, or null. */
export function askTargetIn(view, text, sheriffId) {
  const t = String(text || "");
  if (!ASK_RE.test(t) || NOT_ASK_RE.test(t) || /\b(i claim|i'?m claiming)\b/i.test(t)) return null;
  const ids = Object.keys(view?.players || {}).filter((id) => id !== sheriffId && alive(view, id) && named(view, t, id));
  return ids.length === 1 ? ids[0] : null;
}

/** First answer from `target` after time t (or after line index i): { role, kind, at } or null. */
function replyAfter(view, target, ask) {
  const all = today(view);
  const from = all.indexOf(ask);
  for (const m of all.slice(from + 1)) {
    if (m.senderId !== target) continue;
    const r = parseClaimReply(m.content);
    if (r) return { ...r, at: Number(m.t), text: String(m.content || "") };
  }
  return null;
}

/** A role's claim made by someone other than `id`, or that role already flipped by a dead player. */
export function roleCounterclaimed(view, id, role, { sheriffId = null } = {}) {
  if (!role) return null;
  for (const m of lines(view)) {
    if (m.senderId === id || !alive(view, m.senderId)) continue;
    const r = parseClaimReply(m.content);
    if (claimedRoleIn(m.content) && r?.role === role) return { by: m.senderId, kind: "claim" };
  }
  for (const [pid, c] of Object.entries(view?.claims || {})) if (pid !== id && c?.kind !== "retract" && String(c?.role || "") === role && alive(view, pid)) return { by: pid, kind: "claim" };
  const flip = Object.entries(view?.reveals || {}).find(([pid, a]) => pid !== id && !alive(view, pid) && splitAppearance(a).role === role);
  if (flip) return { by: flip[0], kind: "flip" };
  // The Sheriff himself holds the Sheriff role: a Sheriff answer is a counterclaim.
  if (role === "Sheriff" && sheriffId && sheriffId !== id) return { by: sheriffId, kind: "sheriff" };
  return null;
}

/**
 * Today's asks by the Sheriff: [{ target, at, reply, counter, line }] in order. reply null = no answer yet.
 * counter: a counterclaim on the reply's power role.
 */
export function sheriffAsks(view, sheriffId = sheriffSeat(view)) {
  if (!sheriffId) return [];
  const out = [];
  for (const m of today(view)) {
    if (m.senderId !== sheriffId) continue;
    const target = askTargetIn(view, m.content, sheriffId);
    if (!target || out.some((a) => a.target === target)) continue;
    const reply = replyAfter(view, target, m);
    const counter = reply?.kind === "power" ? roleCounterclaimed(view, target, reply.role, { sheriffId }) : null;
    out.push({ target, at: Number(m.t), reply, counter, line: String(m.content || "") });
  }
  return out;
}

/** The ask aimed at this seat that it has not answered yet (a living Sheriff asked me today), or null. */
export function sheriffAskedMe(view) {
  if (view?.phase?.phase !== "Day") return null;
  const sheriffId = sheriffSeat(view);
  if (!sheriffId || sheriffId === view.selfId) return null;
  const ask = sheriffAsks(view, sheriffId).find((a) => a.target === view.selfId);
  return ask && !ask.reply ? { ...ask, sheriffId } : null;
}

const ASK_LINES = ["{n} claim?", "{n} whats your role", "{n} claim before i shoot", "{n} what are you"];
/** The Sheriff's short, human ask line for a target (varied by target and day, deterministic). */
export function askLineFor(view, target) {
  const n = nameOf(view, target);
  let h = 2166136261;
  for (const c of `${view?.selfId}|${target}|${view?.phase?.name}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ASK_LINES[(h >>> 0) % ASK_LINES.length].replace("{n}", n);
}
