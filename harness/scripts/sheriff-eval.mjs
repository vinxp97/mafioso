// Sheriff / claim-ask eval from self-play game logs (*.games.jsonl), the same counting for every arm.
// Usage: node scripts/sheriff-eval.mjs <dir> [<dir> ...]   (one dir per arm; prints one JSON line per arm)
// Counts per arm: town win % (mean ± sd over seeds), Day 1 shot rate, Sheriff shots on scum / town / claimed power
// roles, revealed-Sheriff lynches and town ballots on him, mafia lines accusing the Sheriff, illegal actions, asks.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimedRoleIn } from "mafioso-engine";

const MAFIA = new Set(["Mafioso", "Janitor", "Lawyer"]);
const POWER = new Set(["cop", "journalist", "sheriff", "doctor"]);
const ACCUSE = /\b(sus|sussy|suspicious|scum|scummy|mafia|maf|fake|faking|lying|liar|lies|guilty|shady|sketchy|red|evil)\b/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function analyzeGame(r) {
  const roles = r.roles || {};
  const sheriff = Object.keys(roles).find((n) => roles[n] === "Sheriff");
  const sn = String(sheriff || "").toLowerCase();
  const out = { win: r.winner === "Village" ? 1 : 0, shots: [], sheriffLynched: 0, townBallotsOnSheriff: 0, scumBallotsOnSheriff: 0, accuse: [], asks: 0, illegal: (r.stats?.illegal || []).length,
    day1: r.stats?.day1 ? { alive: !!r.stats.day1.sheriffAlive, shot: (r.stats.shots || []).some((s) => s.day === 1) } : null, deadCondemns: (r.stats?.deadCondemns || []).length };
  const claims = {}; // name -> claimed role (first claim)
  let outed = false, revealed = false;
  for (const line of r.log || []) {
    const say = /^(Day \d+) ([A-Z][a-z]+): (.*)$/.exec(line);
    if (say) {
      const [, , who, text] = say;
      const t = text.toLowerCase();
      const c = claimedRoleIn(text);
      if (c && !claims[who]) claims[who] = c;
      if (who === sheriff && /\bsheriff\b/.test(t) && c === "sheriff") outed = true;
      if (who === sheriff && /\b(claim|role|what are you)\b/.test(t) && !c) out.asks += 1;
      if (MAFIA.has(roles[who]) && sheriff && (outed || revealed)) {
        for (const seg of t.split(/[.;!?,]+|\bbut\b/)) {
          const named = new RegExp(`(?<![a-z0-9_])(${esc(sn)}|sheriff)(?![a-z0-9_])`).test(seg);
          const pushed = new RegExp(`\\b(vote|voting|lynch|hang|hammer|wagon|push)\\s+(on\\s+|for\\s+)?(${esc(sn)}|the sheriff|sheriff)\\b`).test(seg);
          const defend = /\b(not|isn'?t|never|don'?t|no)\s+(?:\w+\s+)?(sus|suspicious|scum|mafia|fake|lying|guilty|vote|lynch)\b|\b(town|confirmed|cleared|trust)\b/.test(seg);
          if (named && (ACCUSE.test(seg) || pushed) && !defend) { out.accuse.push(`${roles[who]} ${who}: ${text}`); break; }
        }
      }
      continue;
    }
    const shot = /^Day (\d+) ([A-Z][a-z]+) \(([A-Za-z]+)\) dies: shot by the Sheriff/.exec(line);
    if (shot) {
      revealed = true;
      const [, day, who, role] = shot;
      const claim = claims[who] || null;
      const contested = !!claim && Object.entries(claims).some(([n, c]) => n !== who && c === claim);
      out.shots.push({ day: Number(day), role, scum: MAFIA.has(role), claimedPower: !!(claim && POWER.has(claim)), contested, claim });
      continue;
    }
    const votes = /^Day \d+ votes: (.*)$/.exec(line);
    if (votes && revealed && sheriff) {
      for (const part of votes[1].split("; ")) {
        const m = /^(.+?) <- (.*)$/.exec(part);
        if (m && m[1] === sheriff) for (const v of m[2].split(",")) (MAFIA.has(roles[v]) ? out.scumBallotsOnSheriff++ : out.townBallotsOnSheriff++);
      }
      continue;
    }
    if (revealed && sheriff && new RegExp(`^Day \\d+ ${sheriff} \\(Sheriff\\) dies: lynched`).test(line)) out.sheriffLynched += 1;
  }
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

export function analyzeDir(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".games.jsonl")).sort();
  const perSeed = [];
  const all = [];
  for (const f of files) {
    const games = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => analyzeGame(JSON.parse(l)));
    perSeed.push({ file: f, win: mean(games.map((g) => g.win)) });
    all.push(...games);
  }
  const shots = all.flatMap((g) => g.shots);
  const d1 = all.map((g) => g.day1).filter((x) => x?.alive);
  return {
    dir, seeds: perSeed.length, games: all.length,
    townWinPct: { mean: 100 * mean(perSeed.map((s) => s.win)), sd: 100 * sd(perSeed.map((s) => s.win)), perSeed: perSeed.map((s) => Math.round(1000 * s.win) / 10) },
    day1ShotRate: { shot: d1.filter((x) => x.shot).length, of: d1.length },
    shots: { total: shots.length, scum: shots.filter((s) => s.scum).length, town: shots.filter((s) => !s.scum).length,
      claimedPower: shots.filter((s) => s.claimedPower).length, claimedPowerTown: shots.filter((s) => s.claimedPower && !s.scum).length,
      claimedPowerUncontested: shots.filter((s) => s.claimedPower && !s.contested).length, claimedPowerUncontestedTown: shots.filter((s) => s.claimedPower && !s.contested && !s.scum).length,
      realCopOrJournalist: shots.filter((s) => s.role === "Cop" || s.role === "Journalist").length },
    sheriffLynched: all.reduce((n, g) => n + g.sheriffLynched, 0),
    townBallotsOnRevealedSheriff: all.reduce((n, g) => n + g.townBallotsOnSheriff, 0),
    scumBallotsOnRevealedSheriff: all.reduce((n, g) => n + g.scumBallotsOnSheriff, 0),
    mafiaAccusationsOfSheriff: all.reduce((n, g) => n + g.accuse.length, 0), accuseExamples: all.flatMap((g) => g.accuse).slice(0, 5),
    illegal: all.reduce((n, g) => n + g.illegal, 0), asks: all.reduce((n, g) => n + g.asks, 0), deadCondemns: all.reduce((n, g) => n + g.deadCondemns, 0),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) for (const d of process.argv.slice(2)) console.log(JSON.stringify(analyzeDir(d)));
