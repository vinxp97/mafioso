// Offline audit of held/rejected live lines: replays each logged line through today's validators and chatAudit,
// in the speaking seat's view rebuilt from the fixture frames up to where the line was rejected. No model calls.
// Lines the log kept no text for are replayed from the reject detail where the rule's detail carries the words
// (misquote: `x never said "q"`, flip: `x role? x ...`); the rest are labelled from the rule and the rebuilt state.
// Usage: node scripts/audit-rejects.mjs <dir with gNN.jsonl + gNN.rejects.jsonl> [--json out.json] [--engine path]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const engineAt = process.argv.indexOf("--engine");
const E = await import(engineAt > 0 ? pathToFileURL(path.resolve(process.argv[engineAt + 1], "src/index.js")).href : "mafioso-engine");
const { emptyView, reduce, validateAction, chatAudit, earlyClaimBlock, publicLeak, machineLeak } = E;

/** Labels: true catch, false positive, stale (timing alone); `fp-flag` = false positive a flagged loosening clears. */
export const LABELS = ["true", "fp", "fp-flag", "stale", "other"];
/**
 * Evidence from the raw logs where the fixture state can't show it (votes land at the end of a phase there):
 * L8 (g07) D3, the Mafioso's pressure vt claim: 3 alive, one vote on him (L-1, hammer 2), per the log's
 * `send ... vote` lines. Blocked by the 2-vote claim rule; config.claimPressure "l1" allows it.
 */
const L8_D3_CLAIM = { label: "fp-flag", why: "3 alive, 1 vote on the seat (L-1); claimPressure l1" };
const EVIDENCE = { "g07|acc01|Day 3|early-claim": L8_D3_CLAIM, "l08|acc01|Day 3|early-claim": L8_D3_CLAIM };

function viewAt(frames, r) {
  let view = emptyView();
  for (const e of frames.slice(0, r.outIndex)) if (e.accountId === r.accountId) view = reduce(view, e);
  return view;
}

/** A line rebuilt from the reject detail, for rules whose detail quotes the words; else null. */
export function lineFromDetail(rule, reasons) {
  const d = (reasons || []).map(String).map((x) => /\((.*)\)\s*$/.exec(x)?.[1]).find(Boolean) || "";
  if (rule === "misquote") { const m = /^(\S+) never said "(.*)"$/.exec(d); return m ? `${m[1]} said ${m[2]}` : null; }
  if (rule === "flip") {
    const m = /^(\S+) (\S+)\? \1 (?:flipped|is alive|was cleaned)/.exec(d);
    if (!m) return null;
    return m[2] === "flip" ? `${m[1]}'s flip` : `${m[1]} flipped ${m[2]}`;
  }
  return null;
}

function replay(view, line) {
  const vil = Object.values(view.meetings || {}).find((m) => m?.name === "Village" && m.speech);
  if (!vil) return null;
  const v = validateAction(view, { event: "speak", data: { meetingId: vil.id, content: line } });
  return { ok: v.ok, reason: v.ok ? null : String(v.reason), audit: chatAudit(view, line).map((f) => `${f.kind} ${f.rule}`), earlyClaim: earlyClaimBlock(view, line) || null, leak: !!publicLeak(view, line) || !!machineLeak(view, line) };
}

/** Did `name` die in the same phase as this reject (the line was written before the death)? */
function diedThisPhase(frames, r, name) {
  const mine = frames.slice(0, r.outIndex).filter((e) => e.accountId === r.accountId);
  const view = viewAt(frames, r);
  const id = Object.keys(view.players || {}).find((k) => String(view.players[k]?.name).toLowerCase() === String(name).toLowerCase());
  let lastState = -1, death = -1;
  mine.forEach((e, i) => { if (e.event === "state") lastState = i; if (e.event === "death" && e.data === id) death = i; });
  return death > lastState;
}

export function labelOf(game, rec, frames) {
  const key = `${game}|${rec.accountId}|${rec.phase}|${rec.rule}`;
  if (EVIDENCE[key]) return EVIDENCE[key];
  const rule = rec.rule;
  if (rule === "stale reply" || rule === "model stale") return { label: "stale", why: "pacing: the reply came too late" };
  if (/\(held\)$/.test(rule)) return { label: "stale", why: "held line: the state changed before send" };
  if (/^model error/.test(rule)) return { label: "other", why: "model/server error, no line" };
  if (rule === "dead-sus" || rule === "vote-dead") {
    const name = /calls (\S+) sus|vote on (\S+),/.exec(rec.reasons.join(" "));
    const who = name?.[1] || name?.[2];
    return who && diedThisPhase(frames, rec, who) ? { label: "stale", why: "target died this phase, after the line was written" } : { label: "true", why: "target died in an earlier phase" };
  }
  const t = rec.today || rec.rebuilt;
  if (t && (rule === "misquote" || rule === "flip" || rule === "early-claim")) return t.ok && !t.audit.length ? { label: "fp", why: rec.today ? "passes today" : "rebuilt line passes" } : { label: "true", why: (t.audit[0] || t.reason || "").slice(0, 60) };
  return { label: "true", why: rec.line != null ? "still rejected" : "state-consistent (no text logged)" };
}

export function auditRejects(frames, rejects, game = "") {
  const out = [];
  for (const r of rejects) {
    const view = viewAt(frames, r);
    const rule = ruleOf(r.reasons);
    const rec = { ...r, rule, replayed: false };
    if (r.line != null) { const t = replay(view, r.line); if (t) { rec.replayed = true; rec.today = t; } }
    else { const l = lineFromDetail(rule, r.reasons); const t = l && replay(view, l); if (t) { rec.rebuiltLine = l; rec.rebuilt = t; } }
    rec.label = labelOf(game, rec, frames);
    out.push(rec);
  }
  return out;
}

/** The rule a reject was filed under: the chat-audit rule name, or the validator/pacing reason. */
export function ruleOf(reasons) {
  const all = (reasons || []).map(String);
  const audit = all.map((x) => /chat-audit: [A-Z_]+ ([a-z-]+)/.exec(x)?.[1]).find(Boolean);
  if (audit) return all.some((x) => /^held line invalid at send/.test(x)) ? `${audit} (held)` : audit;
  const r = all[0] || "?";
  if (/^model error: stale/.test(r)) return "model stale";
  if (/^model error/.test(r)) return "model error";
  if (/^stale reply/.test(r)) return "stale reply";
  if (/^early claim/.test(r)) return "early-claim";
  if (/^too similar/.test(r)) return "too-similar";
  if (/^public leak/.test(r)) return "public-leak";
  return r.replace(/\(.*$/, "").trim();
}

/** Per-rule counts: rejects, labels, and how many are still rejected when replayed (text or rebuilt line). */
export function tally(all) {
  const by = {};
  for (const x of all) {
    const b = (by[x.rule] ||= { n: 0, true: 0, fp: 0, "fp-flag": 0, stale: 0, other: 0, replayed: 0, still: 0 });
    b.n++; b[x.label.label]++;
    const t = x.today || x.rebuilt;
    if (t) { b.replayed++; if (!t.ok || t.audit.length) b.still++; }
  }
  return by;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2];
  const jsonAt = process.argv.indexOf("--json");
  const all = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.rejects\.jsonl$/.test(x)).sort()) {
    const id = f.replace(/\.rejects\.jsonl$/, "");
    const frames = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const text = fs.readFileSync(path.join(dir, f), "utf8").trim();
    const rejects = text ? text.split("\n").map((l) => JSON.parse(l)) : [];
    for (const x of auditRejects(frames, rejects, id)) all.push({ game: id, ...x });
  }
  if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(all, null, 1));
  // --before <json from an earlier engine>: add its "still rejected" column (labels are this run's).
  const beforeAt = process.argv.indexOf("--before");
  const before = beforeAt > 0 ? tally(JSON.parse(fs.readFileSync(process.argv[beforeAt + 1], "utf8"))) : null;
  console.log(`| rule | rejects | true catch | false positive | fp (flag) | stale | other | replayed |${before ? " still rejected before |" : ""} still rejected |\n|---|---|---|---|---|---|---|---|${before ? "---|" : ""}---|`);
  for (const [k, b] of Object.entries(tally(all)).sort((a, b) => b[1].n - a[1].n)) console.log(`| ${k} | ${b.n} | ${b.true} | ${b.fp} | ${b["fp-flag"]} | ${b.stale} | ${b.other} | ${b.replayed} |${before ? ` ${before[k]?.still ?? 0} |` : ""} ${b.still} |`);
}
