// Per-event diff of two builds of one replay fixture (the committed one vs a rebuild). Events are compared as a
// multiset with the build counters (t, seq, message ids and times) dropped, so a frame that only moved shows up
// under "moved" and one that exists on one side only under "only old" / "only new". Grouped by the phase the
// event sits in, its type, and (for chat) the sender and the first words.
//   node scripts/fixture-diff.mjs <old.jsonl> <new.jsonl> [--md]
import fs from "node:fs";

const [oldFile, newFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const md = process.argv.includes("--md");
if (!oldFile || !newFile) { console.error("usage: fixture-diff.mjs <old.jsonl> <new.jsonl> [--md]"); process.exit(2); }

export function load(file) {
  const out = []; const phase = {};
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    const e = JSON.parse(line);
    if (e.event === "state") phase[e.accountId] = e.data.name;
    out.push({ e, phase: phase[e.accountId] || "-" });
  }
  return out;
}
const key = ({ e }) => {
  const { t, seq, ...rest } = e;
  if (rest.data && typeof rest.data === "object" && !Array.isArray(rest.data)) { const { id, time, ...d } = rest.data; rest.data = d; }
  return JSON.stringify(rest);
};
const label = ({ e, phase }) => {
  const d = e.data;
  if (e.event === "message") return `${phase} | message from ${d.senderId} | ${String(d.content).slice(0, 60)}`;
  if (e.event === "vote") return `${phase} | vote ${d.voterId}->${d.target} (${d.meetingId})`;
  if (e.event === "obituaries") return `${phase} | obituaries ${(d.obituaries || []).map((o) => `${o.id} ${o.snippets.join("/")}`).join(", ")}`;
  return `${phase} | ${e.event}${d === undefined ? "" : ` ${JSON.stringify(d).slice(0, 50)}`}`;
};

const a = load(oldFile); const b = load(newFile);
const count = (xs) => xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) || []), x]), new Map());
const ca = count(a); const cb = count(b);
const only = (x, y) => [...x].flatMap(([k, v]) => v.slice(0, Math.max(0, v.length - (y.get(k)?.length || 0))));
const group = (xs) => xs.reduce((m, x) => m.set(label(x), (m.get(label(x)) || 0) + 1), new Map());
// Order: the position of each shared event's first copy, old vs new (a moved frame keeps its key).
const firstAt = (xs) => { const m = new Map(); xs.forEach((x, i) => { if (!m.has(key(x))) m.set(key(x), i); }); return m; };
const fa = firstAt(a); const fb = firstAt(b);
const shared = [...fa.keys()].filter((k) => fb.has(k));
const rank = (m) => new Map(shared.slice().sort((x, y) => m.get(x) - m.get(y)).map((k, i) => [k, i]));
const ra = rank(fa); const rb = rank(fb);
const moved = shared.filter((k) => ra.get(k) !== rb.get(k));

// Two kinds of difference: a payload that exists on one side only (content: new text, a new frame), and a payload
// both sides have but delivered to a different set of seats (delivery: e.g. a seat that died earlier gets less).
const payload = (x) => { const k = JSON.parse(key(x)); delete k.accountId; return JSON.stringify(k); };
const pa = new Set(a.map(payload)); const pb = new Set(b.map(payload));
const oldOnly = only(ca, cb); const newOnly = only(cb, ca);
const content = (xs, other) => group(xs.filter((x) => !other.has(payload(x))));
const delivery = (xs, other) => xs.filter((x) => other.has(payload(x))).reduce((m, x) => { const k = `${x.phase} | ${x.e.event} to ${x.e.accountId}`; return m.set(k, (m.get(k) || 0) + 1); }, new Map());
const rows = [["content, old only", content(oldOnly, pb)], ["content, new only", content(newOnly, pa)], ["delivery, old only", delivery(oldOnly, pb)], ["delivery, new only", delivery(newOnly, pa)]];
const head = `${oldFile.split("/").pop()}: ${a.length} events old, ${b.length} new; ${moved.length} of ${shared.length} distinct shared events change order`;
if (md) {
  console.log(`**${head}**\n`);
  console.log("| kind | phase / event | n |\n|---|---|---|");
  for (const [side, g] of rows) for (const [k, n] of g) console.log(`| ${side} | ${k.replace(/\|/g, "·")} | ${n} |`);
} else {
  console.log(head);
  for (const [side, g] of rows) for (const [k, n] of g) console.log(`${side.padEnd(19)} ${String(n).padStart(4)}  ${k}`);
}
