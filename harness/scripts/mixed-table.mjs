// Mixed-table eval (Night 6, offline): one bot seat in a fixed role, eight scripted human-like seats, stubbed model.
//   node scripts/mixed-table.mjs --roles=Sheriff,Cop --seeds=6001-6100 [--configs=base,all] [--out=dir]
// Writes <out>/<role>-<config>.jsonl (per-game bot metrics) and prints one summary line per role and config.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { playSelfplayGame } from "../src/selfplay.js";
import { scoreMixedGame, summarizeMixed } from "../src/mixedEval.js";
import { presetFlags } from "../src/presets.js";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const ALL = { voteHold: "on", soloCounterclaim: "on", groundedSpeech: "on", voteKickGuard: "on", gunOnce: "on", chatPassthrough: true };
// Night 6 part 4: lateGrace = the Sheriff's late-answer grace alone; allGrace = all + the grace.
export const MIXED_CONFIGS = { base: {}, all: ALL, lateGrace: { sheriffLateGrace: "on" }, allGrace: { ...ALL, sheriffLateGrace: "on" }, teamGuard: { teamClaimGuard: "on" },
  // Night 6 part 5: n6 = every Night 6 flag (all + late grace + team claim guard); n6Wide = n6 + the wide claim parse.
  // Night 6 part 6: the "recommended" preset (src/presets.js; a mixed table is a single-bot table, so voteHold is on).
  recommended: presetFlags("recommended", { solo: true }),
  n6: { ...ALL, sheriffLateGrace: "on", teamClaimGuard: "on" }, n6Wide: { ...ALL, sheriffLateGrace: "on", teamClaimGuard: "on", wideClaimParse: "on" }, wide: { wideClaimParse: "on" } };
const PAIR_BASE = { all: "base", lateGrace: "base", allGrace: "all", teamGuard: "base", n6Wide: "n6", wide: "base", recommended: "base" };
const main = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (main) await run();
async function run() {
  const roles = arg("roles", "Sheriff,Cop,Journalist,Villager,Mafioso,Janitor,Lawyer").split(",");
  const [s0, s1] = arg("seeds", "6001-6100").split("-").map(Number);
  const configs = arg("configs", "base,all").split(",");
  const out = arg("out", "");
  // --team-reveal=on: the scum bot learns its scripted teammates (Night 6 part 4 option). --dump-spoken: write the
  // scripted public lines with their true claim role to <out>/<role>-<config>.spoken.jsonl (claim-parse eval).
  const teamReveal = arg("team-reveal", "off") === "on";
  const dumpSpoken = argv.includes("--dump-spoken");
  let spoken = [];
  for (const role of roles) {
    const by = {};
    for (const c of configs) {
      by[c] = [];
      for (let seed = s0; seed <= (s1 || s0); seed++) {
        const r = await playSelfplayGame({ seed, game: 0, simLatency: "live1018", mixed: { botRole: role, ...(teamReveal ? { teamReveal: true } : {}) }, ...MIXED_CONFIGS[c] });
        by[c].push(scoreMixedGame(r));
        if (dumpSpoken) spoken.push(...(r.mixed.humans.spoken || []).map((x) => ({ seed, ...x })));
      }
      if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${role}-${c}.jsonl`), by[c].map((x) => JSON.stringify(x)).join("\n") + "\n"); }
      if (out && dumpSpoken) { fs.writeFileSync(path.join(out, `${role}-${c}.spoken.jsonl`), spoken.map((x) => JSON.stringify(x)).join("\n") + "\n"); spoken = []; }
      console.log(JSON.stringify({ role, config: c, ...summarizeMixed(by[c], by[PAIR_BASE[c]] || null), ...(by[PAIR_BASE[c]] ? { pairedWith: PAIR_BASE[c] } : {}) }));
    }
  }
}
