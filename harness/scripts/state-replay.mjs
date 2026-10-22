// Replay every fixture through the game-state model (engine/src/stateModel.js) and print the table.
//   node scripts/state-replay.mjs [--json] [dir...]   (default: test/fixtures/replays, test/fixtures/live-1018, test/fixtures/live-1019)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replayFixture } from "../src/stateReplay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const json = args.includes("--json");
const dirs = args.filter((a) => !a.startsWith("--"));
const roots = dirs.length ? dirs : ["replays", "live-1018", "live-1019"].map((d) => path.join(here, "../test/fixtures", d)).filter((d) => fs.existsSync(d));
const rows = [];
for (const dir of roots) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const f of manifest.fixtures) {
    const entries = fs.readFileSync(path.join(dir, f.fixture), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const r = replayFixture(entries, f);
    const actions = (r.kinds.vote || 0) + (r.kinds.unvote || 0) + (r.kinds.shot || 0) + (r.kinds.speak || 0) + (r.kinds.result || 0);
    const illegal = r.refused.filter((x) => x.type !== "phase" && x.type !== "death" && x.type !== "reveal" && x.type !== "end");
    rows.push({ fixture: f.fixture, roles: r.model.roles ? (Object.values(r.model.roles).every((x) => x) ? "all" : "partial") : "none", game: f.liveGame || null, phaseTags: f.phaseTags, phases: Object.keys(r.model.days).length + Object.keys(r.model.nights).length,
      events: r.events.length, actions, illegal: illegal.length, transitionsRefused: r.refused.length - illegal.length, winner: r.model.winner, deaths: r.model.deaths.length,
      claims: Object.values(r.model.claims).flat().length, results: r.model.results.length, outcomeMismatch: r.outcomes.length,
      refused: r.refused.map((x) => `${x.phase} ${x.type} ${x.voter || x.by || x.id || x.to || x.name || ""}${x.meeting ? ` ${x.meeting}` : ""}${x.target ? `->${x.target}` : ""}: ${x.reason}`), outcomes: r.outcomes });
  }
}
if (json) console.log(JSON.stringify(rows, null, 2));
else {
  console.log("| fixture | game | tags | roles | phases | events | actions | illegal | transitions refused | deaths | claims | results | winner | lynch mismatch |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.fixture} | ${r.game || ""} | ${r.phaseTags} | ${r.roles} | ${r.phases} | ${r.events} | ${r.actions} | ${r.illegal} | ${r.transitionsRefused} | ${r.deaths} | ${r.claims} | ${r.results} | ${r.winner || "-"} | ${r.outcomeMismatch} |`);
  const tot = (k) => rows.reduce((s, r) => s + r[k], 0);
  console.log(`| total | | | | ${tot("phases")} | ${tot("events")} | ${tot("actions")} | ${tot("illegal")} | ${tot("transitionsRefused")} | ${tot("deaths")} | ${tot("claims")} | ${tot("results")} | | ${tot("outcomeMismatch")} |`);
  for (const r of rows) for (const x of [...r.refused, ...r.outcomes.map((o) => `${o.phase} outcome: ballots say ${o.expected}, recorded ${o.got}`)]) console.log(`${r.fixture}: ${x}`);
}
