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

/** Same action with its content humanized; non-speak actions pass through. */
export function humanizeSpeak(view, action) {
  if (action?.event !== "speak" || typeof action.data?.content !== "string") return action;
  return { ...action, data: { ...action.data, content: humanizePlayerIds(view, action.data.content) } };
}
