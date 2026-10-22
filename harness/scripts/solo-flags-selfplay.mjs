// Night 5 solo flags, self-play side: summarize runs of `selfplay.mjs --games N --seed S [flag]` per config.
//   node scripts/solo-flags-selfplay.mjs <runsDir> [--json=out.json] [--configs=base,gunOnce,...]
// <runsDir>/<config>-s<seed>/selfplay-seed<seed>-n<N>.{json,games.jsonl}; configs as in SOLO_CONFIGS.
// Village win rate with a Wilson 95% interval, the paired difference to base (same seed and game index = the
// same deal), town ballots on scum on Day 1 vs Day 2+, filler share of public lines, mafia counterclaim rate on
// the Sheriff's asked Cop/Journalist answers, illegal actions; gun re-votes from gun.jsonl (runs made with --count-gun).
import fs from "node:fs";
import path from "node:path";
import { isFiller, wilson, SOLO_CONFIGS } from "../src/soloFlagsEval.js";

const argv = process.argv.slice(2);
const root = argv.find((a) => !a.startsWith("--"));
const jsonOut = (argv.find((a) => a.startsWith("--json=")) || "").split("=")[1];
const MAFIA = new Set(["Mafioso", "Janitor", "Lawyer"]);
const ASK = /\b(claim\??|claiming|whats your role|what'?s your role)\b/i;
const CLAIM = /\b(?:im|i'?m|i am)\s+(?:the\s+|a\s+)?(cop|journalist)\b/i;

function loadConfig(name) {
  const games = []; const gun = { games: 0, sends: 0, revotes: 0, gamesWithRevote: 0 }; let illegal = 0; let runs = 0; let vegs = 0; let lynches = 0; let lynchScum = 0;
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith(`${name}-s`) && fs.statSync(path.join(root, x)).isDirectory())) {
    const dir = path.join(root, d);
    for (const f of fs.readdirSync(dir)) {
      if (f === "gun.jsonl") for (const l of fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean)) { const r = JSON.parse(l); gun.games += 1; gun.sends += r.sends; gun.revotes += r.revotes; gun.gamesWithRevote += r.revotes > 0 ? 1 : 0; }
      if (f.endsWith(".games.jsonl")) for (const l of fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n")) games.push(JSON.parse(l));
      if (/^selfplay-seed\d+-n\d+\.json$/.test(f)) { const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); illegal += c.illegalActions?.total || 0; runs += 1; vegs += Number(c.vegs) || 0; lynches += c.lynches?.total || 0; lynchScum += c.lynches?.scum || 0; }
    }
  }
  return { games, illegal, runs, vegs, lynches, lynchScum, gun };
}

function counterclaims(g) {
  const sheriff = Object.keys(g.roles).find((n) => g.roles[n] === "Sheriff");
  const lines = g.log.map((l) => /^(Day \d+) (\w+): (.*)$/.exec(l)).filter(Boolean).map(([, day, who, text]) => ({ day, who, text }));
  const opps = [];
  for (const [i, l] of lines.entries()) {
    if (l.who !== sheriff || !ASK.test(l.text)) continue;
    for (const target of Object.keys(g.roles)) {
      if (target === sheriff || MAFIA.has(g.roles[target]) || !new RegExp(`\\b${target}\\b`, "i").test(l.text)) continue;
      const ans = lines.slice(i + 1).find((x) => x.day === l.day && x.who === target && CLAIM.test(x.text));
      if (!ans || opps.some((o) => o.day === l.day && o.target === target)) continue;
      const role = CLAIM.exec(ans.text)[1].toLowerCase();
      const at = lines.indexOf(ans);
      const cc = lines.slice(at + 1).some((x) => x.day === l.day && MAFIA.has(g.roles[x.who]) && new RegExp(`\\b${target}\\b.*\\bis lying\\b.*\\b${role}\\b`, "i").test(x.text));
      opps.push({ day: l.day, target, role, cc });
    }
  }
  return opps;
}

function summarize(name, { games, illegal, runs, vegs, lynches, lynchScum, gun }, base) {
  const won = games.filter((g) => g.winner === "Village").length;
  const ballots = games.flatMap((g) => g.stats.townBallots || []);
  const acc = (xs) => { const k = xs.filter((b) => b.onScum).length; return { k, n: xs.length, pct: xs.length ? Math.round((1000 * k) / xs.length) / 10 : null }; };
  const pub = games.flatMap((g) => g.log.map((l) => /^Day \d+ \w+: (.*)$/.exec(l)?.[1]).filter((t) => t != null));
  const opps = games.flatMap(counterclaims);
  let paired = null;
  if (base) {
    const key = (g) => `${g.seed}|${g.game}`;
    const b = new Map(base.games.map((g) => [key(g), g.winner === "Village" ? 1 : 0]));
    const d = games.filter((g) => b.has(key(g))).map((g) => (g.winner === "Village" ? 1 : 0) - b.get(key(g)));
    const n = d.length; const mean = d.reduce((a, x) => a + x, 0) / n;
    const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    const half = (1.96 * sd) / Math.sqrt(n);
    paired = { n, diffPts: Math.round(1000 * mean) / 10, ci95: [Math.round(1000 * (mean - half)) / 10, Math.round(1000 * (mean + half)) / 10], better: d.filter((x) => x > 0).length, worse: d.filter((x) => x < 0).length, withinNoise: mean - half <= 0 && mean + half >= 0 };
  }
  const w = wilson(won, games.length);
  return {
    config: name, runs, games: games.length,
    villageWin: { k: won, n: games.length, pct: Math.round(1000 * w.p) / 10, ci95: [Math.round(1000 * w.lo) / 10, Math.round(1000 * w.hi) / 10] },
    pairedVsBase: paired,
    townBallots: { day1: acc(ballots.filter((b) => b.day === 1)), day2plus: acc(ballots.filter((b) => b.day >= 2)), all: acc(ballots) },
    filler: { k: pub.filter(isFiller).length, n: pub.length, pct: pub.length ? Math.round((1000 * pub.filter(isFiller).length) / pub.length) / 10 : null },
    counterclaim: { opportunities: opps.length, cc: opps.filter((o) => o.cc).length, pct: opps.length ? Math.round((1000 * opps.filter((o) => o.cc).length) / opps.length) / 10 : null },
    lynchOnScum: { k: lynchScum, n: lynches, pct: lynches ? Math.round((1000 * lynchScum) / lynches) / 10 : null }, vegs,
    gunRevotes: gun.games ? gun : null,
    illegal, errors: games.filter((g) => g.error).length,
  };
}

const names = ((argv.find((a) => a.startsWith("--configs=")) || "").split("=")[1] || Object.keys(SOLO_CONFIGS).join(",")).split(",");
if (!names.includes("base")) names.unshift("base");
const loaded = Object.fromEntries(names.map((n) => [n, loadConfig(n)]));
const out = names.filter((n) => loaded[n].games.length).map((n) => summarize(n, loaded[n], n === "base" ? null : loaded.base));
for (const r of out) console.log(JSON.stringify(r));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
