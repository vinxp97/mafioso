// Mixed-table scoring (Night 6): metrics for the one bot seat of a mixed-table game (selfplay.js, opts.mixed).
import { claimedRoleIn } from "mafioso-engine";
import { isFiller, wilson } from "./soloFlagsEval.js";

const SCUM = new Set(["Mafioso", "Janitor", "Lawyer"]);
const ASK = /\b(claim\??|claiming|what are you|whats your role|what'?s your role|role\?)\b/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Per-game bot metrics from a mixed-table result. */
export function scoreMixedGame(r) {
  const bot = r.mixed.bot; const role = r.mixed.botRole; const scum = SCUM.has(role);
  const names = Object.keys(r.roles);
  const line = (l) => /^(Day (\d+)) (\w+): (.*)$/.exec(l);
  const pub = r.log.map((l, i) => { const m = line(l); return m && { i, day: Number(m[2]), who: m[3], text: m[4] }; }).filter(Boolean);
  const times = new Map((r.stats.lineTimes || []).map((x) => [x.i, x.t]));
  const mine = pub.filter((x) => x.who === bot);
  const ballots = (r.stats.townBallots || []).filter((b) => b.voter === bot && !b.abstain);
  const claims = (r.stats.claims || []).filter((c) => c.seat === bot);
  const out = {
    seed: r.seed, role, winner: r.winner, error: r.error, botWon: r.winner === (scum ? "Mafia" : "Village"), villageWon: r.winner === "Village",
    lines: mine.length, filler: mine.filter((x) => isFiller(x.text)).length,
    ballots: ballots.length, ballotsOnScum: ballots.filter((b) => b.onScum).length,
    illegal: (r.stats.illegal || []).filter((x) => x.seat === bot).length,
    humanIllegal: r.stats.humanIllegal || 0,
    rejects: r.stats.sim?.rejects || {}, rechecks: r.stats.sim?.rechecks || 0,
    drops: (r.stats.chatDrops || []).filter((d) => d.seat === bot && d.reason !== "chat-audit: regenerated").length,
    vt: mine.filter((x) => /\b(vt|v\/t)\b/i.test(x.text)).length,
  };
  if (role === "Sheriff") {
    const c = claims.find((x) => x.claimed === "sheriff");
    const asks = mine.filter((x) => ASK.test(x.text)).map((x) => names.find((n) => n !== bot && new RegExp(`\\b${esc(n)}\\b`, "i").test(x.text))).filter(Boolean);
    const shots = (r.stats.shots || []).filter((s) => s.sheriff === bot);
    Object.assign(out, {
      sheriffClaimS: c ? c.t : null, sheriffClaimDay: c ? Number(/\d+/.exec(c.phase)[0]) : null,
      asks: asks.length, asksOnScum: asks.filter((n) => SCUM.has(r.roles[n])).length,
      shots: shots.length, shotsOnScum: shots.filter((s) => s.hit).length, shotsOnTown: shots.filter((s) => !s.hit).length, shotS: shots[0]?.t ?? null,
      // Night 6 part 4 (shot context, mixed tables only): fired at the deadline; fired before a scheduled answer.
      shotsDeadline: shots.filter((s) => s.deadline).length,
      shotsTownBeforeAnswer: shots.filter((s) => !s.hit && s.pendingAnswer != null).length,
      shotsScumBeforeAnswer: shots.filter((s) => s.hit && s.pendingAnswer != null).length,
    });
  }
  if (role === "Cop") {
    const cl = claims.filter((x) => x.claimed === "cop");
    const days = new Set(cl.map((x) => x.phase));
    Object.assign(out, {
      copClaims: cl.length, copClaimDays: days.size,
      copOneLine: cl.filter((x) => /\b(inno|innocent|guilty)\b/i.test(x.text)).length,
      copExtraLines: mine.filter((x) => /^(results?:|result -)/i.test(x.text)).length,
      copClaimS: cl[0]?.t ?? null, copClaimDay: cl[0] ? Number(/\d+/.exec(cl[0].phase)[0]) : null,
    });
  }
  if (scum) {
    // A human's true Cop or Journalist claim while the bot is alive: does the bot counterclaim that day?
    let opp = 0; let cc = 0; let askedOpp = 0; let askedCc = 0;
    const sheriffs = new Set((r.stats.claims || []).filter((c) => c.claimed === "sheriff").map((c) => c.seat));
    for (const x of pub) {
      if (x.who === bot) continue;
      const claimed = claimedRoleIn(x.text, { wide: true }); // scorer: the wide parse in every config (Night 6 part 5)
      if (!claimed || !["cop", "journalist"].includes(claimed) || r.roles[x.who]?.toLowerCase() !== claimed) continue;
      if (r.log.slice(0, x.i).some((l) => new RegExp(`^Day \\d+ ${esc(bot)} \\(`).test(l))) continue; // bot dead
      opp++;
      const later = mine.filter((y) => y.day === x.day && y.i > x.i);
      const hit = later.some((y) => claimedRoleIn(y.text) === claimed || new RegExp(`\\b${esc(x.who)}\\b.*\\b(lying|fake|liar)\\b`, "i").test(y.text));
      if (hit) cc++;
      // The engine's case: the claim answers a claimed Sheriff's ask that day.
      if (pub.some((y) => y.day === x.day && y.i < x.i && sheriffs.has(y.who) && ASK.test(y.text) && new RegExp(`\\b${esc(x.who)}\\b`, "i").test(y.text))) { askedOpp++; if (hit) askedCc++; }
    }
    out.ccOpp = opp; out.cc = cc; out.ccAskedOpp = askedOpp; out.ccAsked = askedCc;
    // Night 6 part 6: days where two mafia seats claimed the same power role, or the bot claimed two power roles.
    let dbl = 0;
    for (const d of new Set(pub.map((x) => x.day))) {
      const by = {}; const botRoles = new Set();
      for (const x of pub.filter((y) => y.day === d && SCUM.has(r.roles[y.who]))) { const c = claimedRoleIn(x.text, { wide: true }); if (c === "cop" || c === "journalist") { (by[c] ||= new Set()).add(x.who); if (x.who === bot) botRoles.add(c); } }
      if (Object.values(by).some((xs) => xs.size >= 2) || botRoles.size >= 2) dbl++;
    }
    out.doubleDays = dbl;
  }
  return out;
}

const sum = (xs, k) => xs.reduce((a, x) => a + (Number(x[k]) || 0), 0);
const pctW = (k, n) => { const w = wilson(k, n); return { k, n, pct: n ? Math.round(1000 * w.p) / 10 : null, ci95: n ? [Math.round(1000 * w.lo) / 10, Math.round(1000 * w.hi) / 10] : null }; };
const median = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };

/** Summary of one role x config; base (same role) for the paired win difference. */
export function summarizeMixed(games, base = null) {
  const g = games.filter((x) => !x.error);
  const s = {
    games: games.length, errors: games.length - g.length,
    botWin: pctW(g.filter((x) => x.botWon).length, g.length), villageWin: pctW(g.filter((x) => x.villageWon).length, g.length),
    townBallotsOnScum: pctW(sum(g, "ballotsOnScum"), sum(g, "ballots")),
    filler: pctW(sum(g, "filler"), sum(g, "lines")), linesPerGame: g.length ? Math.round((10 * sum(g, "lines")) / g.length) / 10 : 0,
    staleRejects: g.reduce((a, x) => a + (x.rejects["stale reply"] || 0), 0), rechecks: sum(g, "rechecks"), drops: sum(g, "drops"),
    illegal: sum(g, "illegal"), humanIllegal: sum(g, "humanIllegal"), vt: sum(g, "vt"),
  };
  if (g.some((x) => "sheriffClaimS" in x)) Object.assign(s, {
    sheriffClaimed: pctW(g.filter((x) => x.sheriffClaimS != null).length, g.length), sheriffClaimMedianS: median(g.filter((x) => x.sheriffClaimDay === 1).map((x) => x.sheriffClaimS)),
    asks: sum(g, "asks"), asksOnScum: pctW(sum(g, "asksOnScum"), sum(g, "asks")),
    shots: sum(g, "shots"), shotsOnScum: pctW(sum(g, "shotsOnScum"), sum(g, "shots")), shotsOnTown: sum(g, "shotsOnTown"), shotMedianS: median(g.map((x) => x.shotS)),
    shotsDeadline: sum(g, "shotsDeadline"), shotsTownBeforeAnswer: sum(g, "shotsTownBeforeAnswer"), shotsScumBeforeAnswer: sum(g, "shotsScumBeforeAnswer"),
  });
  if (g.some((x) => "copClaims" in x)) Object.assign(s, {
    copClaimed: pctW(g.filter((x) => x.copClaims > 0).length, g.length), copClaimLines: sum(g, "copClaims"), copClaimDays: sum(g, "copClaimDays"),
    copOneLine: pctW(sum(g, "copOneLine"), sum(g, "copClaims")), copExtraLines: sum(g, "copExtraLines"),
    copClaimMedianS: median(g.filter((x) => x.copClaimDay === 1).map((x) => x.copClaimS)),
  });
  if (g.some((x) => "doubleDays" in x)) s.doubleClaimGames = g.filter((x) => x.doubleDays > 0).length;
  if (g.some((x) => "ccOpp" in x)) { s.counterclaim = pctW(sum(g, "cc"), sum(g, "ccOpp")); s.counterclaimAsked = pctW(sum(g, "ccAsked"), sum(g, "ccAskedOpp")); }
  if (base) {
    s.pairedBotWin = pairedDiff(base, g, (x) => (x.botWon ? 1 : 0), 100);
    if ("shotsOnTown" in s) { s.pairedShotsOnTown = pairedDiff(base, g, (x) => x.shotsOnTown || 0); s.pairedShotsOnScum = pairedDiff(base, g, (x) => x.shotsOnScum || 0); }
  }
  return s;
}

/** Paired by-seed difference (config minus base) of f, mean and a 95% normal interval; scale 100 reports points. */
export function pairedDiff(base, games, f, scale = 1) {
  const b = new Map(base.filter((x) => !x.error).map((x) => [x.seed, f(x)]));
  const d = games.filter((x) => !x.error && b.has(x.seed)).map((x) => f(x) - b.get(x.seed));
  const n = d.length; const mean = n ? d.reduce((a, x) => a + x, 0) / n : 0;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1)); const half = n ? (1.96 * sd) / Math.sqrt(n) : 0;
  const r = (x) => Math.round(10 * scale * x) / 10;
  return { n, [scale === 100 ? "diffPts" : "diffPerGame"]: r(mean), ci95: [r(mean - half), r(mean + half)], withinNoise: mean - half <= 0 && mean + half >= 0 };
}
