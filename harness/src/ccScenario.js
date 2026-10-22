// Mixed-table counterclaim scenarios (Night 6 part 4): scoring. The scenario itself lives in mixedTable.js
// (cfg.scenario): a scripted claimed Sheriff asks the real Cop or Journalist, who answers with a power claim.
import { claimedRoleIn } from "mafioso-engine";
import { wilson } from "./soloFlagsEval.js";

const SCUM = new Set(["Mafioso", "Janitor", "Lawyer"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Per-game counterclaim metrics from a scenario result (playSelfplayGame with opts.mixed.human.scenario). */
export function scoreCcGame(r) {
  const sc = r.mixed?.scenario; const bot = r.mixed?.bot;
  const out = { seed: r.seed, error: r.error || null, winner: r.winner, botWon: r.winner === "Mafia", power: sc?.power, opp: false };
  if (!sc || !sc.powerSeat) return out;
  const role = sc.power.toLowerCase();
  const times = new Map((r.stats.lineTimes || []).map((x) => [x.i, x.t]));
  const pub = r.log.map((l, i) => { const m = /^Day (\d+) (\w+): (.*)$/.exec(l); return m && { i, day: Number(m[1]), who: m[2], text: m[3], t: times.get(i) }; }).filter((x) => x && x.day === 1);
  const deadAt = (n) => { const i = r.log.findIndex((l) => new RegExp(`^Day 1 ${esc(n)} \\(`).test(l)); return i < 0 ? Infinity : i; };
  // Scorer: the wide parse in every config, so raw-style answers are found whatever the bot parses (Night 6 part 5).
  const answer = pub.find((x) => x.who === sc.powerSeat && claimedRoleIn(x.text, { wide: true }) === role);
  const scum = (n) => SCUM.has(r.roles[n]);
  const claimsOf = (n, rl) => pub.filter((x) => x.who === n && claimedRoleIn(x.text, { wide: true }) === rl);
  // Mafia seats claiming each power role on Day 1 (any time), and the counterclaim lines after the answer.
  const mafia = Object.keys(r.roles).filter(scum);
  const byRole = {}; for (const rl of ["cop", "journalist"]) byRole[rl] = mafia.filter((n) => claimsOf(n, rl).length);
  out.doubleAny = Object.values(byRole).some((xs) => xs.length >= 2);
  out.botPowerClaims = ["cop", "journalist"].flatMap((rl) => claimsOf(bot, rl).map(() => rl));
  out.botRepeat = out.botPowerClaims.length >= 2;
  if (!answer || answer.i > deadAt(bot)) return out;
  out.opp = true;
  // A counterclaim claims the role ("X is lying, im the real cop"); a scripted read like "x lying" is not one.
  const after = pub.filter((x) => x.i > answer.i && scum(x.who) && claimedRoleIn(x.text, { wide: true }) === role);
  const pre = byRole[role].filter((n) => claimsOf(n, role).some((x) => x.i < answer.i));
  const ccSeats = new Set([...pre, ...after.map((x) => x.who)]);
  out.ccCount = ccSeats.size; out.ccPre = pre.length; out.ccAfter = new Set(after.map((x) => x.who)).size;
  out.ccByBot = after.some((x) => x.who === bot);
  const first = after.find((x) => x.who === bot);
  out.ccDelayS = first && Number.isFinite(first.t) && Number.isFinite(answer.t) ? first.t - answer.t : null;
  out.double = out.ccCount >= 2 || out.doubleAny || out.botRepeat;
  const shot = (r.stats.shots || []).find((s) => s.day === 1 && s.sheriff === sc.sheriffSeat);
  out.shot = shot ? (shot.target === bot ? "bot" : shot.target === sc.powerSeat ? "power" : scum(shot.target) ? "mafiaMate" : "town") : null;
  const shootEv = sc.events.find((e) => e.kind === "shoot"); out.shotContested = shootEv ? shootEv.contested : null;
  const lynch = (r.stats.lynches || []).find((l) => l.day === 1);
  out.lynch = lynch ? (lynch.target === bot ? "bot" : lynch.target === sc.powerSeat ? "power" : lynch.scum ? "mafiaMate" : "town") : "none";
  const botAsk = sc.events.find((e) => e.kind === "ask" && e.bot);
  out.botAsked = !!botAsk;
  return out;
}

const pct = (k, n) => { const w = wilson(k, n); return { k, n, pct: n ? Math.round(1000 * w.p) / 10 : null, ci95: n ? [Math.round(1000 * w.lo) / 10, Math.round(1000 * w.hi) / 10] : null }; };
const count = (xs, f) => xs.filter(f).length;
const hist = (xs, k) => xs.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {});

export function summarizeCc(games) {
  const g = games.filter((x) => !x.error); const o = g.filter((x) => x.opp);
  const d = o.map((x) => x.ccDelayS).filter((x) => x != null).sort((a, b) => a - b);
  return {
    games: games.length, errors: games.length - g.length, opp: o.length,
    exactlyOne: pct(count(o, (x) => x.ccCount === 1), o.length), zero: pct(count(o, (x) => x.ccCount === 0), o.length),
    double: pct(count(g, (x) => x.double), g.length), botPowerClaimRepeat: count(g, (x) => x.botRepeat),
    ccByBot: count(o, (x) => x.ccByBot), ccDelayS: d.length ? { min: d[0], median: d[Math.floor(d.length / 2)], max: d.at(-1), sameSecond: count(d, (x) => x <= 0) } : null,
    shot: hist(o, "shot"), shotContested: count(o, (x) => x.shotContested), lynchDay1: hist(o, "lynch"),
    botWin: pct(count(g, (x) => x.botWon), g.length),
  };
}
