// Public chat must read like a person: player ids become display names, unknown ids are dropped.
import { NO_ONE } from "./types.js";

function escapeReg(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every id this seat knows about: players, meeting targets and members. */
function knownIds(view) {
  const ids = new Set(Object.keys(view?.players || {}));
  for (const m of Object.values(view?.meetings || {})) {
    for (const t of Array.isArray(m?.targets) ? m.targets : []) if (typeof t === "string" && t !== NO_ONE) ids.add(t);
    for (const mem of Array.isArray(m?.members) ? m.members : Object.values(m?.members || {})) if (mem?.id) ids.add(mem.id);
  }
  return ids;
}

/**
 * Replace each known player id in text with that player's name. Ids with no known name are removed,
 * along with the comma or "and" left dangling. Ids shorter than 2 chars are ignored.
 */
export function humanizePlayerIds(view, text) {
  let out = String(text ?? "");
  const ids = [...knownIds(view)].filter((id) => id.length >= 2).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const name = view?.players?.[id]?.name;
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeReg(id)}(?=$|[^A-Za-z0-9_-])`, "g");
    out = out.replace(re, (_m, pre) => `${pre}${name && name !== id ? name : "\u0000"}`);
  }
  // Ids we never saw but that look like Ultimafia ids (8-12 chars, letters+digits, mixed case) also go.
  out = out.replace(/(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,12})(?=$|[^A-Za-z0-9_-])/g, (m, pre, tok) =>
    /[0-9]/.test(tok) && /[a-z]/.test(tok) && /[A-Z]/.test(tok) ? `${pre}\u0000` : m);
  if (out.includes("\u0000")) {
    out = out
      .replace(/\u0000(\s*(,|and)\s*\u0000)+/g, "\u0000")
      .replace(/\s*,?\s*\band\s+\u0000/g, "")
      .replace(/\u0000\s+and\b\s*/g, "")
      .replace(/(,\s*)?\u0000(\s*,)?/g, (_m, a, b) => (a && b ? ", " : ""))
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,:;])\s*([.!?]|$)/g, "$2")
      .trim();
  }
  return out;
}

/**
 * Vinman 10/18: a player's FULL name in an outgoing line takes that player's exact username capitalization,
 * as tab-complete would ("vinman" -> "Vinman"). Whole words only, case-insensitive, living and dead players;
 * partial names and nicknames stay as written.
 */
// A name that is also an everyday word ("Me", "No") is left alone: "why me" must not become "why Me".
const COMMON_WORDS = new Set("i me my a an the is it its no not so ok yes you he she we us him her his they them all any one and or but if to of in on at by be do go up out who why how what when lol idk".split(" "));
export function exactNames(view, text) {
  let out = String(text ?? "");
  const names = [...new Set(Object.values(view?.players || {}).map((p) => String(p?.name || "")).filter((n) => n.length >= 2 && !COMMON_WORDS.has(n.toLowerCase())))]
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeReg(name)}(?![A-Za-z0-9_])`, "gi");
    out = out.replace(re, name);
  }
  return out;
}

/** Same action with its content humanized; non-speak actions pass through. */
export function humanizeSpeak(view, action) {
  if (action?.event !== "speak" || typeof action.data?.content !== "string") return action;
  return { ...action, data: { ...action.data, content: exactNames(view, humanizePlayerIds(view, action.data.content)) } };
}

/** The last step before a line goes out: exactNames on speak content. */
export function finalSpeak(view, action) {
  if (action?.event !== "speak" || typeof action.data?.content !== "string") return action;
  const content = exactNames(view, action.data.content);
  return content === action.data.content ? action : { ...action, data: { ...action.data, content } };
}
