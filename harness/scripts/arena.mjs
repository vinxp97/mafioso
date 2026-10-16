// Offline Frontier Justice arena. Writes logs/replays/*.jsonl and prints a summary.
// Never opens a socket. --live only checks the dev allowlist.
import { summarizeMetrics } from "mafioso-engine";
import path from "node:path";
import { createMockComplete, DEFAULT_LOG_DIR, readMetrics, runArena } from "../src/arena.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const summaryOnly = args.includes("--summary") && args.includes("--file") && !args.includes("--games");
if (summaryOnly) {
  const records = await readMetrics(flag("--file"));
  console.log(JSON.stringify(summarizeMetrics(records), null, 2));
  process.exit(0);
}

const games = Number(flag("--games", "4"));
const seed = Number(flag("--seed", "1"));
const mafiosoSeats = Number(flag("--mafioso", "3"));
const mode = args.includes("--live") ? "live" : "offline";
const file = flag("--file", "") || null;
const records = await runArena({
  games,
  seed,
  mafiosoSeats,
  complete: createMockComplete(),
  maxDays: Number(flag("--days", "4")),
  write: true,
  file,
  mode,
  baseUrl: flag("--base", "https://dev.ultimafia.gg"),
  lobby: flag("--lobby", "Testing"),
  private: flag("--private", "true") !== "false",
});
console.error(`wrote ${file ? path.resolve(file) : path.join(DEFAULT_LOG_DIR, `arena-${seed}.jsonl`)}`);
if (args.includes("--summary") || !args.includes("--quiet")) {
  console.log(JSON.stringify(summarizeMetrics(records), null, 2));
}
