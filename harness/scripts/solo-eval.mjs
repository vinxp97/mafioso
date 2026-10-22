// Night 5 offline single-bot eval: every seat of each fixture, one at a time, on Mafioso's rules path (no model
// calls), against the log for everyone else. See src/soloEval.js.
//   node scripts/solo-eval.mjs [--seed=7] [--vote-kick=keep] [--json=out.json] <fixture.jsonl>...     (default: test/fixtures/solo-timeline/*)
import fs from "node:fs";
import path from "node:path";
import { soloReplay, scoreSolo, tableFacts, surveyFixture, aggregate } from "../src/soloEval.js";

const argv = process.argv.slice(2);
const seed = Number((argv.find((a) => a.startsWith("--seed=")) || "--seed=7").split("=")[1]);
const voteKick = argv.includes("--vote-kick=keep") ? "keep" : "drop";
const jsonOut = (argv.find((a) => a.startsWith("--json=")) || "").split("=")[1];
let files = argv.filter((a) => !a.startsWith("--"));
if (!files.length) { const d = new URL("../test/fixtures/solo-timeline/", import.meta.url).pathname; files = fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(d, f)); }
const scored = []; const surveys = {};
for (const file of files) {
  const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const facts = tableFacts(entries);
  const name = path.basename(file, ".jsonl");
  surveys[name] = surveyFixture(entries);
  for (const acc of Object.keys(facts.pidOf).sort()) {
    const run = await soloReplay(entries, acc, { seed, facts, voteKick });
    scored.push({ fixture: name, ...scoreSolo(entries, run, facts) });
  }
}
const agg = aggregate(scored);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ seed, surveys, agg, scored }, null, 1));
console.log(JSON.stringify({ seed, voteKick, seats: agg.seats, rules: agg.rules, errors: agg.errors.length }, null, 1));
for (const [role, r] of Object.entries(agg.roles)) console.log(role, JSON.stringify(r));
for (const s of agg.sheriff) console.log("sheriff", JSON.stringify(s));
for (const c of agg.counterclaims) console.log("cc", JSON.stringify(c));
