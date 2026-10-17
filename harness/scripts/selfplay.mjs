// Offline self-play: full Frontier Justice 9p games on the real harness decision path, no server.
// Usage: npm run selfplay -- --games 50 --seed 1 [--days 8] [--cop-rule vinman|wait] [--lawyer loyal|plain] [--mafia adaptive|script] [--out ../logs/selfplay] [--quiet]
// Never opens a socket and never calls a model.
import path from "node:path";
import { SELFPLAY_DIR, runSelfplay, writeSelfplay } from "../src/selfplay.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const games = Number(flag("--games", "50"));
const seed = Number(flag("--seed", "1"));
const maxDays = Number(flag("--days", "8"));
const outDir = path.resolve(flag("--out", SELFPLAY_DIR));
const quiet = args.includes("--quiet");
// --cop-rule vinman (default: claim once a Sheriff is out and alive, or a guilty, or counterclaimed) | wait
const copRule = flag("--cop-rule", "vinman");
// --lawyer loyal (default, FJ: litigates teammates only) | plain (also frames town as Guilty)
const lawyer = flag("--lawyer", "loyal");
// --mafia adaptive (default: Vinman's FJ strategy from the mafia side) | script (the old fixed plan)
const mafia = flag("--mafia", "adaptive");
if (!["adaptive", "script"].includes(mafia)) { console.error(`--mafia must be adaptive or script, got ${mafia}`); process.exit(2); }
if (!["vinman", "wait"].includes(copRule)) { console.error(`--cop-rule must be vinman or wait, got ${copRule}`); process.exit(2); }
if (!["loyal", "plain"].includes(lawyer)) { console.error(`--lawyer must be loyal or plain, got ${lawyer}`); process.exit(2); }
const started = Date.now();
const run = await runSelfplay({
  games, seed, maxDays, copRule, lawyer, mafia,
  onGame: (r) => { if (!quiet) console.error(`game ${r.game}: ${r.winner}${r.error ? ` (${r.error})` : ""} after ${r.days} day(s)`); },
});
const files = await writeSelfplay(run, { outDir });
const c = run.scorecard;
const pct = (x) => (x == null ? "n/a" : `${(100 * x).toFixed(1)}%`);
console.log(`self-play: ${games} games, seed ${seed}, cop rule ${copRule}, lawyer ${lawyer}, mafia ${mafia}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`win rate: Village ${pct(c.winRate.Village)}, Mafia ${pct(c.winRate.Mafia)}, draw/error ${c.winRate.counts.draw || 0}/${c.winRate.counts.error || 0}`);
console.log(`town ballots on scum: ${pct(c.townVotes.share)} (${c.townVotes.onScum}/${c.townVotes.cast}) vs random ${pct(c.townVotes.randomBaseline)}`);
console.log(`illegal actions: ${c.illegalActions.total}`);
console.log(`game length: mean ${c.gameLength.meanDays?.toFixed(2)} days (min ${c.gameLength.minDays}, max ${c.gameLength.maxDays})`);
if (c.topWeakness) console.log(`top weakness: ${c.topWeakness.title}: ${c.topWeakness.evidence}`);
console.log(`wrote ${files.json}\nwrote ${files.md}\nwrote ${files.jsonl}\nwrote ${files.games}`);
process.exit(c.illegalActions.total || c.errors.length ? 1 : 0);
