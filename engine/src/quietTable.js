// Quiet-table variants (10/19 overnight, Nightshift). Every flag is OFF by default: with no
// view.config.quietTable / table.config.quietTable the harness keeps the d8cbfa1 behaviour.
//   filler: "facts"   the day opener and the silence filler only restate public facts (vote counts,
//                     living claims, flips), never this seat's reads, watch targets or its own role.
//   repair: "intent"  a held line is re-sent only when it keeps its intent: a stale reply is dropped
//                     (as on a0e6d88) unless it carries a claim, result or counterclaim; an invalid line
//                     is replaced only by a repair that names the same players. No generic fallback.
//   keyFirst: true    claims, Cop/Journalist results and counterclaims go out on the 1s claim gap from
//                     the last real send. They neither wait behind queued table lines nor the 2.5s gap
//                     after a normal line, and quiet-table lines hold while one is pending.
import { chatAudit } from "./chatAudit.js";
import { claimedRoleIn, earlyClaimBlock } from "./chatStyle.js";
import { machineLeak, publicLeak } from "./legal.js";
import { repairSpentGunThreat } from "./sheriffGate.js";
import { publicRecord } from "./townReads.js";

export const QUIET_TABLE_DEFAULTS = Object.freeze({ filler: "default", repair: "default", keyFirst: false });

/** The quiet-table flags in force for a view or table config (unknown values fall back to the defaults). */
export function quietTableOpts(config) {
  const q = config?.quietTable || {};
  return {
    filler: q.filler === "facts" ? "facts" : "default",
    repair: q.repair === "intent" ? "intent" : "default",
    keyFirst: q.keyFirst === true || q.keyFirst === "on",
  };
}

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const nm = (view, id) => String(view?.players?.[id]?.name || id).toLowerCase();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lineOk(view, content) {
  return !!content && !publicLeak(view, content) && !machineLeak(view, content) && !earlyClaimBlock(view, content) && !chatAudit(view, content).length;
}

/** Ids named in a line, in order of appearance (full names, case-insensitive). */
export function namedIn(view, text) {
  const t = String(text || "").toLowerCase();
  const out = [];
  for (const [id, p] of Object.entries(view?.players || {})) {
    const n = String(p?.name || "").toLowerCase();
    if (n.length < 2) continue;
    const m = t.match(new RegExp(`(^|[^a-z0-9_])${esc(n)}([^a-z0-9_]|$)`));
    if (m) out.push({ id, at: m.index });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.id);
}

const RESULT = /\b(guilty|innocent|inno|no reports?|got a (?:cop )?report|real cop|fake cop|fake journalist|is (?:the )?janitor|report said|it said)\b/i;
const COUNTER = /\b(lying|liar|fake|counter ?claim|im the real|i'?m the real)\b/i;
const KEY_SOURCES = /^(claim-rule|counter-rule|ask-rule)/;

/** A claim, a Cop/Journalist result, a counterclaim, or a Sheriff ask/answer line. */
export function isKeyLine(content, source = "") {
  const t = String(content || "");
  return !!claimedRoleIn(t) || RESULT.test(t) || COUNTER.test(t) || KEY_SOURCES.test(String(source || ""));
}

function villageVoting(view) {
  return Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.voting) || null;
}

/** Public-fact lines for a quiet table, best first. None states this seat's own read or role. */
export function publicFactLines(view) {
  const out = [];
  const m = villageVoting(view);
  if (m) {
    const counts = {};
    for (const t of Object.values(m.votes || {})) {
      const sel = Array.isArray(t) ? t[0] : t;
      if (!sel) continue;
      counts[sel] = (counts[sel] || 0) + 1;
    }
    const tally = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id, n]) => `${id === "*" || id === "No" ? "no lynch" : nm(view, id)} ${n}`);
    out.push(tally.length ? `votes so far: ${tally.join(", ")}` : "no votes yet");
  }
  const rec = publicRecord(view);
  const claims = Object.entries(rec.claims || {}).filter(([id]) => alive(view, id)).map(([id, role]) => `${nm(view, id)} ${String(role).toLowerCase()}`);
  if (claims.length) out.push(`claims so far: ${claims.join(", ")}`);
  const flips = Object.entries(view?.reveals || {}).filter(([id]) => view?.players?.[id] && !alive(view, id))
    .map(([id, role]) => `${nm(view, id)} flipped ${String(role).split(/:| \(/)[0].toLowerCase()}`);
  if (flips.length) out.push(flips.slice(-3).join(", "));
  return out.filter((line) => lineOk(view, line));
}

/**
 * The intent-keeping repair of a held line, or null (drop it). stale: the line was dropped as a stale reply.
 * Returns a speak action in the Village meeting.
 */
export function reviveKeepingIntent(view, content, { stale = false, source = "" } = {}) {
  const meeting = Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.speech);
  if (!meeting || !content) return null;
  const speak = (line) => ({ event: "speak", data: { meetingId: meeting.id, content: line } });
  if (stale) return isKeyLine(content, source) && lineOk(view, content) ? speak(content) : null;
  if (lineOk(view, content)) return speak(content);
  const repaired = repairSpentGunThreat(view, content);
  if (!repaired || repaired === content || !lineOk(view, repaired)) return null;
  const before = namedIn(view, content).filter((id) => alive(view, id)).sort().join(",");
  const after = namedIn(view, repaired).filter((id) => alive(view, id)).sort().join(",");
  return before === after ? speak(repaired) : null;
}
