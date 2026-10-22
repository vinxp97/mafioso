// Mixed-table counterclaim scenarios (Night 6 part 4, offline, stubbed model): the bot is a Mafioso; a scripted claimed
// Sheriff asks the real Cop (odd seeds) or Journalist (even seeds), who answers with a power claim.
//   node scripts/cc-scenarios.mjs --cases=lone,team,teamCop --seeds=9001-9100 [--configs=base,all,guard,allGuard] [--team-reveal=on|off] [--out=dir]
import fs from "node:fs";
import path from "node:path";
import { playSelfplayGame } from "../src/selfplay.js";
import { scoreCcGame, summarizeCc } from "../src/ccScenario.js";
import { MIXED_CONFIGS } from "./mixed-table.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const CONFIGS = { base: {}, all: MIXED_CONFIGS.all, guard: { teamClaimGuard: "on" }, allGuard: { ...MIXED_CONFIGS.all, teamClaimGuard: "on" }, n6: MIXED_CONFIGS.n6, n6Wide: MIXED_CONFIGS.n6Wide };
// --raw-answers: the asked seat answers in its own style even when the default parse misses it (claim-parse eval).
const rawAnswers = argv.includes("--raw-answers");
const cases = arg("cases", "lone,team,teamCop").split(",");
const [s0, s1] = arg("seeds", "9001-9100").split("-").map(Number);
const configs = arg("configs", "base,all").split(",");
const out = arg("out", "");
for (const cc of cases) for (const c of configs) {
  const rows = [];
  for (let seed = s0; seed <= (s1 || s0); seed++) {
    const power = seed % 2 ? "Cop" : "Journalist";
    const r = await playSelfplayGame({ seed, game: 0, simLatency: "live1018", mixed: { botRole: "Mafioso", teamReveal: arg("team-reveal", "on") === "on", human: { scenario: { cc, power, ...(rawAnswers ? { rawAnswers: true } : {}) } } }, ...CONFIGS[c] });
    rows.push(scoreCcGame(r));
  }
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${cc}-${c}.jsonl`), rows.map((x) => JSON.stringify(x)).join("\n") + "\n"); }
  console.log(JSON.stringify({ case: cc, config: c, ...summarizeCc(rows), byPower: Object.fromEntries(["Cop", "Journalist"].map((p) => [p, summarizeCc(rows.filter((x) => x.power === p))])) }));
}
