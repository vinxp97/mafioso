// Night 5 solo flags: the per-config summary of scored single-bot replay seats (soloEval.scoreSolo), and the
// filler / counterclaim / Wilson helpers the self-play side shares. Pure.
import { SPEECH_FLOOR } from "./live.js";

export const SOLO_CONFIGS = Object.freeze({
  base: {},
  voteHold: { voteHold: "on" },
  soloCounterclaim: { soloCounterclaim: "on" },
  groundedSpeech: { groundedSpeech: "on" },
  voteKickGuard: { voteKickGuard: "on" },
  all: { voteHold: "on", soloCounterclaim: "on", groundedSpeech: "on", voteKickGuard: "on" },
  gunOnce: { gunOnce: "on" },
  allGun: { voteHold: "on", soloCounterclaim: "on", groundedSpeech: "on", voteKickGuard: "on", gunOnce: "on" },
  // Night 6 eval presets: chatPassthrough alone, and with every Night 5 solo flag plus gunOnce.
  chatPass: { chatPassthrough: true },
  allPass: { voteHold: "on", soloCounterclaim: "on", groundedSpeech: "on", voteKickGuard: "on", gunOnce: "on", chatPassthrough: true },
  // Night 6 part 6: the "recommended" preset on an all-bot table (src/presets.js: no voteHold), and all off.
  off: {},
  recommended: { soloCounterclaim: "on", groundedSpeech: "on", voteKickGuard: "on", gunOnce: "on", chatPassthrough: true, sheriffLateGrace: "on", teamClaimGuard: "on", wideClaimParse: "on" },
});

const FLOOR = new Set(SPEECH_FLOOR.lines);
/** Filler: a canned floor line, or "watching <someone>" with nothing behind it. */
export function isFiller(text) {
  const t = String(text || "").trim().toLowerCase();
  return FLOOR.has(t) || /^watching \S+$/.test(t);
}

/** Wilson score interval (z = 1.96): { k, n, p, lo, hi } as fractions. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { k, n, p: null, lo: null, hi: null };
  const p = k / n; const z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { k, n, p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

const frac = (k, n) => ({ k, n, pct: n ? Math.round((1000 * k) / n) / 10 : null });

/** One config's numbers over scored seats (each { seed, fixture, ...scoreSolo }). */
export function soloFlagSummary(scored) {
  const town = scored.filter((s) => s.align === "Village");
  const dv = town.flatMap((s) => s.dayVotes.map((d) => ({ ...d, day: Number(String(d.phase).split(" ")[1]) })));
  const good = (xs, who) => { const v = xs.filter((d) => d[`${who}Good`] != null); return frac(v.filter((d) => d[`${who}Good`]).length, v.length); };
  const early = dv.filter((d) => d.day === 1); const late = dv.filter((d) => d.day >= 2);
  const lines = scored.flatMap((s) => s.lines || []);
  const mafia = scored.filter((s) => s.rules.r2_mafiaCounterclaim);
  const opps = mafia.flatMap((s) => s.rules.r2_mafiaCounterclaim.opportunities);
  const shots = scored.filter((s) => s.gun).flatMap((s) => s.gun.bot);
  const rules = {};
  for (const k of ["r1_sheriffWaitsOnVillager", "r2_mafiaCounterclaim", "r3_copOneLine", "r4_sheriffClaimDelay", "r5_noVt"]) {
    const cs = scored.map((s) => s.rules[k]).filter(Boolean).filter((c) => (k === "r3_copOneLine" ? c.cases.length : k === "r2_mafiaCounterclaim" ? c.opportunities.length || c.sent : true));
    rules[k] = `${cs.filter((c) => c.ok).length}/${cs.length}`;
  }
  return {
    seats: scored.length,
    townVote: { early: good(early, "bot"), late: good(late, "bot"), all: good(dv, "bot"), loggedEarly: good(early, "logged"), loggedLate: good(late, "logged"), noBallot: dv.filter((d) => d.bot == null).length, medianBallotS: median(dv.map((d) => d.botMs)) },
    filler: frac(lines.filter(isFiller).length, lines.length),
    linesPerDay: Math.round((10 * lines.length) / Math.max(1, scored.reduce((a, s) => a + s.dayVotes.length, 0))) / 10,
    counterclaim: { opportunities: opps.length, sent: opps.filter((o) => o.cc).length, rate: frac(opps.filter((o) => o.cc).length, opps.length), delaysMs: opps.filter((o) => o.cc).map((o) => o.cc.delayMs) },
    shots: { n: shots.length, under5s: shots.filter((g) => g.ms < 5000).length, artifacts: shots.filter((g) => g.artifact).length, mafia: shots.filter((g) => g.align === "Mafia").length },
    gunRevotes: scored.filter((s) => s.gun).reduce((a, s) => a + Math.max(0, s.gun.bot.length - 1), 0),
    illegal: scored.reduce((a, s) => a + (s.illegal?.length || 0), 0),
    errors: scored.reduce((a, s) => a + (s.errors?.length || 0), 0),
    rules,
  };
}

function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.floor(v.length / 2)] / 1000) : null;
}
