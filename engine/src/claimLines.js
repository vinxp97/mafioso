// Night 5 (Vinman 10/20): claim wording, enforced on the way out. Pure, no imports (chatStyle and
// speechNames both use it).
//   vt guard   A town claim says villager or blue, never vt / v/t (rewriteVt, vtLeft).
//   one line   A Cop claim and its report go out as ONE line: joined if the text has line breaks, fit
//              under the chat cap by dropping whole result items (never a name cut in half, never the
//              report dropped for the first sentence), and no second same-day Cop line (copSecondLine).

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VT_TOKEN = /(^|[^A-Za-z0-9_/])(v\/t|vt)(s?)(?![A-Za-z0-9_/])/gi;
const TOWNISH_CLAIM = /\b((?:i'?m|i am|im|i claim)\s+(?:(?:a|an|the|just|only|plain|real)\s+)*)(vanilla town|plain town|townie|town|vanilla)\b(?!\s*(?:read|reads|vote|votes|wagon|win|is|was|cop|journalist|sheriff|doctor))/i;

/** Player names in this view that would collide with a vt token (a user called "vt" or "Vt-Rex"). */
function maskNames(view, text) {
  // A name that is only the token ("vt") can't be told apart from the word: it is not masked.
  const names = Object.values(view?.players || {}).map((p) => String(p?.name || "")).filter((n) => n.length >= 2 && !/^v\/?t$/i.test(n) && /(^|[^a-z0-9_/])v\/?t([^a-z0-9_/]|$)/i.test(n))
    .sort((a, b) => b.length - a.length);
  const keep = [];
  let out = String(text ?? "");
  for (const n of names) out = out.replace(new RegExp(esc(n), "gi"), (m) => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; });
  return { out, unmask: (s) => s.replace(/\u0001(\d+)\u0001/g, (_m, i) => keep[Number(i)]) };
}

/**
 * Every vt / v/t / vts token becomes villager(s); a claim that only says town / townie / vanilla says
 * villager. Player names are never touched.
 */
export function rewriteVt(view, text) {
  const { out, unmask } = maskNames(view, text);
  let s = out.replace(VT_TOKEN, (_m, pre, _w, plural) => `${pre}villager${plural ? "s" : ""}`);
  if (!/\b(villager|blue)\b/i.test(s)) s = s.replace(TOWNISH_CLAIM, (_m, lead) => `${lead}villager`);
  return unmask(s);
}

/** A vt token still in the line (after masking player names), or null. */
export function vtLeft(view, text) {
  const { out } = maskNames(view, text);
  VT_TOKEN.lastIndex = 0;
  const m = VT_TOKEN.exec(out);
  VT_TOKEN.lastIndex = 0;
  return m ? m[2] : null;
}

const COP_CLAIM = /\b(?:i'?m|im|i am)\s+(?:the\s+)?(?:real\s+)?cop\b|^\s*cop\b(?:\s*(?:here|btw|[.,:!-]))/i;
const RESULTS_LEAD = /^\s*(?:my\s+)?(?:results?|checks?|report)\s*[:\-–]\s*/i;

/** A line that claims Cop ("im cop", "i'm the real cop", "cop here,"). */
export function isCopClaim(text) {
  return COP_CLAIM.test(String(text || ""));
}

/** A Cop result said on its own: "results: x guilty", "x inno", "checked x, village". */
export function isCopResultLine(text) {
  const t = String(text || "").trim();
  if (RESULTS_LEAD.test(t)) return true;
  return /^\s*(?:checked\s+)?[A-Za-z0-9_'.-]{2,}\s*(?:is\s+|=\s*|:\s*|,\s*)?(guilty|inno|innocent)\b/i.test(t);
}

/** "im cop\nx guilty" -> "im cop. x guilty": a Cop claim's lines become one line. */
export function joinCopLines(text) {
  const parts = String(text ?? "").split(/\r?\n+/).map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, "").replace(RESULTS_LEAD, "").trim()).filter(Boolean);
  if (parts.length <= 1) return (parts[0] || "").replace(/\s+/g, " ").trim();
  return parts.map((p, i) => (i < parts.length - 1 ? p.replace(/[.,;:\s]+$/, "") : p)).join(". ").replace(/\s+/g, " ").trim();
}

/**
 * A Cop claim line under `max` characters. Results are whole items ("name guilty"): inno items are
 * dropped from the end first, then guilty ones, never a name cut in half and never the claim alone
 * when one result fits.
 */
export function fitCopLine(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const m = s.match(/^(.*?\bcop\b[^.,]*?)([.,:;-]\s*)(.+)$/i);
  if (!m) { const cut = s.slice(0, max + 1); const sp = cut.lastIndexOf(" "); return (sp > 0 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[,;:\s-]+$/, ""); }
  const head = m[1].trim();
  const items = m[3].split(/\s*[,;]\s*|\.\s+/).map((x) => x.trim()).filter(Boolean);
  const guilty = items.filter((x) => /\bguilty|mafia|scum\b/i.test(x));
  const other = items.filter((x) => !guilty.includes(x));
  let keep = [...guilty, ...other];
  const line = (list) => (list.length ? `${head}. ${list.join(", ")}` : head);
  while (keep.length > 1 && line(keep).length > max) {
    // Drop the last inno first; once only guilties are left, the last guilty.
    const lastOther = keep.map((x, i) => [x, i]).filter(([x]) => !guilty.includes(x)).pop();
    keep.splice(lastOther ? lastOther[1] : keep.length - 1, 1);
  }
  const out = line(keep);
  return out.length <= max ? out : head.slice(0, max);
}

/** Lines this seat said in public in the current phase (view.messages plus any not echoed yet). */
function ownLinesToday(view, extra = []) {
  const phase = view?.phase?.name || "";
  const mine = (view?.messages || []).filter((m) => m?.senderId === view?.selfId && m.public !== false && (!m.phase || !phase || m.phase === phase)).map((m) => String(m.content || ""));
  return [...mine, ...extra.map(String)];
}

const guiltyNames = (text) => [...String(text || "").matchAll(/([A-Za-z0-9_'.-]{2,})\s+(?:is\s+)?(?:guilty|mafia|scum)\b/gi)].map((m) => m[1].toLowerCase());

/**
 * Reason to block a second same-day Cop line, or null. Once this seat said a Cop claim today, a later
 * line that claims Cop again or states Cop results is a split claim. One exception: a guilty the first
 * line did not carry (the report landed after the claim) still goes out, since town needs it.
 */
export function copSecondLine(view, text, { sent = [] } = {}) {
  const t = String(text || "");
  if (!isCopClaim(t) && !isCopResultLine(t)) return null;
  const before = ownLinesToday(view, sent);
  const first = before.find((l) => isCopClaim(l));
  if (!first) return null;
  const said = new Set(before.flatMap(guiltyNames));
  if (guiltyNames(t).some((n) => !said.has(n))) return null;
  return "cop claim is one line (already claimed cop today)";
}
