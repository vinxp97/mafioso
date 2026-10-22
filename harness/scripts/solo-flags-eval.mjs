// Night 5 solo flags, offline: the single-bot replay of the timed fixtures (soloEval.js) under each flag alone
// and all four together, against defaults. No network, no model.
//   node scripts/solo-flags-eval.mjs [--seeds=1,2,3,4,5,7] [--vote-kick=keep] [--json=out.json] [--configs=base,voteHold,...] [--dir=fixtures-dir]
import fs from "node:fs";
import path from "node:path";
import { soloReplay, scoreSolo, tableFacts } from "../src/soloEval.js";
import { soloFlagSummary, SOLO_CONFIGS } from "../src/soloFlagsEval.js";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const seeds = arg("seeds", "1,2,3,4,5,7").split(",").map(Number);
const voteKick = arg("vote-kick", "drop") === "keep" ? "keep" : "drop";
const jsonOut = arg("json", "");
const names = arg("configs", Object.keys(SOLO_CONFIGS).join(",")).split(",");
const dir = arg("dir", "") || new URL("../test/fixtures/solo-timeline/", import.meta.url).pathname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
const fixtures = files.map((f) => { const entries = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)); return { name: path.basename(f, ".jsonl"), entries, facts: tableFacts(entries) }; });
const out = {};
for (const name of names) {
  const scored = [];
  for (const seed of seeds) for (const fx of fixtures) for (const acc of Object.keys(fx.facts.pidOf).sort()) {
    const run = await soloReplay(fx.entries, acc, { seed, facts: fx.facts, voteKick, config: SOLO_CONFIGS[name] });
    scored.push({ seed, fixture: fx.name, ...scoreSolo(fx.entries, run, fx.facts) });
  }
  out[name] = soloFlagSummary(scored);
  console.log(name, JSON.stringify(out[name]));
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ seeds, voteKick, configs: out }, null, 1));
