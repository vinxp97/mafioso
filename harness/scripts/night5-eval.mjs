#!/usr/bin/env node
// Night 5 eval: node harness/scripts/night5-eval.mjs <game.log.err> [more logs...] [--json]
// Speech success, chat-checker rejects, timing, the five Night 5 claim checks, refused actions. Read-only.
import { readFileSync } from "node:fs";
import { evaluateLog, summarize } from "../src/night5Eval.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) { console.error("usage: night5-eval.mjs <log> [log...] [--json]"); process.exit(2); }
const reports = files.map((f) => ({ file: f, ...evaluateLog(readFileSync(f, "utf8")) }));
if (asJson) console.log(JSON.stringify(reports, null, 2));
else for (const r of reports) console.log(`## ${r.file}\n${summarize(r)}\n`);
if (reports.length > 1) {
  const a = reports.reduce((s, r) => ({ att: s.att + r.speech.llmAttempts, sent: s.sent + r.speech.llmSent }), { att: 0, sent: 0 });
  console.log(`## all ${reports.length} games: LLM ${a.sent}/${a.att} sent (${a.att ? ((100 * a.sent) / a.att).toFixed(1) : "n/a"}%)`);
}
