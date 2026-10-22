// Re-scrub of sanitized live logs (Night 6). The handle list is read at run time from a box-only raw log
// directory (seatmap / accounts lines); nothing here, in the tests or in the docs names a real handle.
// Full handles become SeatN, ids userN, accounts acctN, and every 3+ letter fragment of a handle NickN.
import fs from "node:fs";
import path from "node:path";

export const RAW_DIR_DEFAULT = "/workspace/live-night5-raw";
const RESERVED = new Set(["seat", "nick", "user", "acct"]);

/** Seat handles, ids and account names from the seatmap / accounts lines of every *.log.err in rawDir. */
export function loadHandles(rawDir = RAW_DIR_DEFAULT) {
  if (!fs.existsSync(rawDir)) return null;
  const out = [];
  for (const f of fs.readdirSync(rawDir).filter((x) => x.endsWith(".log.err")).sort()) {
    const t = fs.readFileSync(path.join(rawDir, f), "utf8");
    const game = gameOf(f);
    const m = /^seatmap (.*)$/m.exec(t);
    if (m) for (const [, seat, uid, name] of m[1].matchAll(/s(\d+)=([^:\s]+):"([^"]+)"/g)) out.push({ game, seat: Number(seat), name, uid });
    const a = /accounts=([^\s]+)/.exec(t);
    if (a) a[1].split(",").forEach((acct, i) => out.push({ game, acct, n: i + 1 }));
  }
  return out;
}

/** g1 / g01 / g1-xyz -> 1; null when the name carries no game number. */
export function gameOf(file) {
  const m = /(?:^|[/_-])g0?(\d+)(?=[-._])/.exec(`/${path.basename(String(file))}`);
  return m ? Number(m[1]) : null;
}

/** Lowercase 3+ letter pieces of a handle: split on non-letters and camelCase. */
export function fragmentsOf(name) {
  const parts = String(name).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z]+/);
  return [...new Set(parts.map((p) => p.toLowerCase()).filter((p) => p.length >= 3 && !RESERVED.has(p)))];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replacement rules for one file (game-specific seat numbers when the file names its game). */
export function rulesFor(handles, game = null) {
  const seats = handles.filter((h) => h.name);
  const pick = (list) => list.find((h) => h.game === game) || list[0];
  const rules = [];
  const byName = new Map(); const byFrag = new Map();
  for (const h of seats) { (byName.get(h.name.toLowerCase()) || byName.set(h.name.toLowerCase(), []).get(h.name.toLowerCase())).push(h); for (const f of fragmentsOf(h.name)) (byFrag.get(f) || byFrag.set(f, []).get(f)).push(h); }
  for (const [n, list] of byName) {
    rules.push({ kind: "handle", token: n, to: `Seat${pick(list).seat}` });
    // The same handle without digits or separators ("Ab-CdEf12" -> "abcdef"), as a model may write it.
    const letters = n.replace(/[^a-z]/g, "");
    if (letters.length >= 3 && letters !== n) rules.push({ kind: "handle", token: letters, to: `Seat${pick(list).seat}` });
  }
  for (const h of seats) if (h.uid && h.uid.length >= 4) rules.push({ kind: "id", token: h.uid.toLowerCase(), to: `user${h.seat}` });
  for (const h of handles.filter((x) => x.acct && x.acct.length >= 3)) rules.push({ kind: "account", token: h.acct.toLowerCase(), to: `acct${h.n}` });
  for (const [f, list] of byFrag) rules.push({ kind: "fragment", token: f, to: `Nick${pick(list).seat}` });
  // Longest first, so a full handle goes before its own pieces.
  rules.sort((a, b) => b.token.length - a.token.length);
  return rules.map((r) => ({ ...r, re: new RegExp(`(?<![A-Za-z])${esc(r.token)}(?=s?(?![A-Za-z]))`, "gi") }));
}

/** Scrub one string; counts[kind] += hits. */
export function scrubText(text, rules, counts = {}) {
  let t = String(text);
  for (const r of rules) t = t.replace(r.re, () => { counts[r.kind] = (counts[r.kind] || 0) + 1; return r.to; });
  return t;
}

function walk(v, f) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), walk(x, f)]));
  return v;
}

/** Scrub a file's content; JSON and JSONL stay valid (keys and string values are scrubbed). */
export function scrubContent(content, file, rules, counts = {}) {
  const f = (s) => scrubText(s, rules, counts);
  if (file.endsWith(".jsonl")) return content.split("\n").map((l) => { if (!l.trim()) return l; try { return JSON.stringify(walk(JSON.parse(l), f)); } catch { return f(l); } }).join("\n");
  if (file.endsWith(".json")) { try { const j = JSON.parse(content); return JSON.stringify(walk(j, f), null, /\n {2}"/.test(content) ? 2 : /\n "/.test(content) ? 1 : 0) + (content.endsWith("\n") ? "\n" : ""); } catch { return f(content); } }
  return f(content);
}

/** Hits of any handle, id, account or fragment: [{ line, kind }] (never the token itself). */
export function scan(content, rules) {
  const hits = [];
  content.split("\n").forEach((l, i) => { for (const r of rules) { r.re.lastIndex = 0; if (r.re.test(l)) hits.push({ line: i + 1, kind: r.kind }); } });
  return hits;
}

const TEXT = /\.(log|err|txt|md|json|jsonl|mjs|js|csv)$/;
/** Copy srcDir to dstDir, scrubbing every text file. Originals are only read. Returns per-file counts. */
export function rescrubDir(srcDir, dstDir, handles) {
  if (path.resolve(srcDir) === path.resolve(dstDir)) throw new Error("rescrub: destination must differ from the source");
  const report = [];
  const visit = (rel) => {
    const src = path.join(srcDir, rel); const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) { const real = fs.realpathSync(src); if (fs.statSync(real).isDirectory()) return; return copyFile(real, rel); }
    if (st.isDirectory()) { for (const x of fs.readdirSync(src).sort()) visit(path.join(rel, x)); return; }
    copyFile(src, rel);
  };
  const copyFile = (src, rel) => {
    const dst = path.join(dstDir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!TEXT.test(src)) { fs.copyFileSync(src, dst); report.push({ file: rel, binary: true }); return; }
    const counts = {}; const rules = rulesFor(handles, gameOf(rel));
    const out = scrubContent(fs.readFileSync(src, "utf8"), rel, rules, counts);
    // Untouched files are copied byte for byte (no JSON re-formatting).
    if (Object.keys(counts).length) fs.writeFileSync(dst, out); else fs.copyFileSync(src, dst);
    report.push({ file: rel, counts });
  };
  visit("");
  return report;
}
