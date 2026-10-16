// Per-game scores for Frontier Justice. Pure. No logs and no model calls.
import { defang } from "./sanitize.js";

export const KILL_PRIORITY = Object.freeze(["Cop", "Sheriff", "Journalist"]);

const ILLEGAL_RE = /malformed|unknown meeting|cannot vote|selection not in targets|vote locked|unvote not allowed|cannot speak|empty content|content too long|unsupported event/i;

export function wilsonInterval(successes, trials, z = 1.96) {
  const s = Number(successes) || 0;
  const n = Number(trials) || 0;
  if (n <= 0) return { successes: 0, trials: 0, rate: null, low: null, high: null };
  const phat = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return {
    successes: s,
    trials: n,
    rate: phat,
    low: clamp01(center - margin),
    high: clamp01(center + margin),
  };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function ratio(successes, trials) {
  const interval = wilsonInterval(successes, trials);
  return { successes: interval.successes, trials: interval.trials, rate: interval.rate };
}

export function priorityRole(livingRoles) {
  const living = new Set(livingRoles || []);
  return KILL_PRIORITY.find((role) => living.has(role)) || null;
}

function checkUseful(check) {
  if (check?.actorRole === "Cop") return check.targetAlignment === "Mafia" || check.targetAlignment === "Cult";
  if (check?.actorRole === "Journalist") {
    if (typeof check.sawReport === "boolean") return check.sawReport;
    return ["Cop", "Janitor", "Sheriff", "Lawyer", "Mafioso"].includes(check.targetRole);
  }
  return false;
}

function sourceBucket(source) {
  if (source === "selector" || source === "candidate") return "candidate";
  if (source === "llm") return "llm";
  if (source === "fallback" || source === "rules") return "rules";
  return null;
}

function countIllegal(rejections) {
  return (rejections || []).filter((line) => ILLEGAL_RE.test(String(line))).length;
}

/**
 * Score one game trace. Rates are null when that game had no trials.
 * Chat lines are defanged before they land on the record.
 */
export function scoreGame(trace = {}) {
  const seats = (trace.seats || []).map((seat) => {
    const messages = Number(seat.messages) || 0;
    const dayPhases = Number(seat.dayPhases) || 0;
    return {
      id: seat.id,
      role: seat.role || "unknown",
      alignment: seat.alignment || "unknown",
      kind: seat.kind || "rule",
      won: !!seat.won,
      messages,
      dayPhases,
      messageRate: dayPhases ? messages / dayPhases : 0,
      speechAllowed: Number(seat.speechAllowed) || 0,
      speechSent: Number(seat.speechSent) || 0,
    };
  });

  const byAlignment = {};
  if (trace.winner === "Village" || trace.winner === "Mafia" || trace.winner === "draw") {
    byAlignment.Village = ratio(trace.winner === "Village" ? 1 : 0, 1);
    byAlignment.Mafia = ratio(trace.winner === "Mafia" ? 1 : 0, 1);
  }

  const byRole = {};
  for (const seat of seats) {
    byRole[seat.role] ??= { successes: 0, trials: 0 };
    byRole[seat.role].trials += 1;
    if (seat.won) byRole[seat.role].successes += 1;
  }
  for (const key of Object.keys(byRole)) byRole[key] = ratio(byRole[key].successes, byRole[key].trials);

  const lynches = trace.lynches || [];
  const mis = lynches.filter((lynch) => lynch.targetAlignment === "Village").length;
  const townVotes = trace.townVotes || [];
  const onScum = townVotes.filter((vote) => vote.targetAlignment === "Mafia" || vote.targetAlignment === "Cult").length;
  const night = (trace.nightActions || []).filter((action) => action.open !== false);
  const taken = night.filter((action) => action.taken).length;
  const checks = trace.checks || [];
  const copChecks = checks.filter((check) => check.actorRole === "Cop");
  const journalistChecks = checks.filter((check) => check.actorRole === "Journalist");
  let killHits = 0;
  let killTrials = 0;
  for (const kill of trace.kills || []) {
    const want = priorityRole(kill.living);
    if (!want) continue;
    killTrials += 1;
    if (kill.targetRole === want) killHits += 1;
  }

  let candidate = 0;
  let llm = 0;
  let rules = 0;
  for (const decision of trace.decisions || []) {
    const bucket = decision.bucket || sourceBucket(decision.source);
    if (bucket === "candidate") candidate += 1;
    else if (bucket === "llm") llm += 1;
    else if (bucket === "rules") rules += 1;
  }
  const decided = candidate + llm + rules;
  const illegalProposed = Number(trace.illegal?.proposed) || 0;
  const illegalBlocked = Number(trace.illegal?.blocked) || 0;

  const speech = (trace.speech || [])
    .filter((line) => line && line.allowed !== false && line.text)
    .map((line) => ({ seat: line.seat, phase: line.phase || "", text: defang(line.text, 240) }));

  return {
    seed: trace.seed ?? null,
    game: trace.game ?? null,
    setup: trace.setup || "Frontier Justice",
    winner: trace.winner || "draw",
    winRate: { byAlignment, byRole },
    mislynchRate: ratio(mis, lynches.length),
    townVoteAccuracy: ratio(onScum, townVotes.length),
    nightActionUsage: ratio(taken, night.length),
    checkUsefulness: {
      cop: ratio(copChecks.filter(checkUseful).length, copChecks.length),
      journalist: ratio(journalistChecks.filter(checkUseful).length, journalistChecks.length),
    },
    killPriorityAdherence: ratio(killHits, killTrials),
    illegal: {
      proposed: illegalProposed,
      blocked: illegalBlocked,
      blockRate: ratio(illegalBlocked, illegalProposed).rate,
    },
    fallback: {
      candidate,
      llm,
      rules,
      rate: decided ? (llm + rules) / decided : null,
    },
    seats,
    speech,
  };
}

function pool(records, pick) {
  let successes = 0;
  let trials = 0;
  for (const record of records) {
    const part = pick(record);
    if (!part?.trials) continue;
    successes += part.successes || 0;
    trials += part.trials || 0;
  }
  return wilsonInterval(successes, trials);
}

function meanInterval(values, z = 1.96) {
  const xs = values.filter((value) => Number.isFinite(value));
  const n = xs.length;
  if (!n) return { mean: null, low: null, high: null, n: 0 };
  const mean = xs.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? xs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  const half = z * Math.sqrt(variance / n);
  return { mean, low: mean - half, high: mean + half, n };
}

/** Aggregate scored games. Proportions use a Wilson interval. */
export function summarizeMetrics(records = [], { z = 1.96 } = {}) {
  const games = records.length;
  const alignments = new Set();
  const roles = new Set();
  for (const record of records) {
    for (const key of Object.keys(record.winRate?.byAlignment || {})) alignments.add(key);
    for (const key of Object.keys(record.winRate?.byRole || {})) roles.add(key);
  }
  const byAlignment = {};
  for (const key of alignments) byAlignment[key] = pool(records, (record) => record.winRate?.byAlignment?.[key]);
  const byRole = {};
  for (const key of roles) byRole[key] = pool(records, (record) => record.winRate?.byRole?.[key]);

  let candidate = 0;
  let llm = 0;
  let rules = 0;
  let proposed = 0;
  let blocked = 0;
  const rates = [];
  for (const record of records) {
    candidate += record.fallback?.candidate || 0;
    llm += record.fallback?.llm || 0;
    rules += record.fallback?.rules || 0;
    proposed += record.illegal?.proposed || 0;
    blocked += record.illegal?.blocked || 0;
    for (const seat of record.seats || []) if (Number.isFinite(seat.messageRate)) rates.push(seat.messageRate);
  }
  const decided = candidate + llm + rules;
  const speechAllowed = records.reduce((sum, record) => sum + (record.speech || []).length, 0);

  return {
    games,
    winRate: { byAlignment, byRole },
    mislynchRate: pool(records, (record) => record.mislynchRate),
    townVoteAccuracy: pool(records, (record) => record.townVoteAccuracy),
    nightActionUsage: pool(records, (record) => record.nightActionUsage),
    checkUsefulness: {
      cop: pool(records, (record) => record.checkUsefulness?.cop),
      journalist: pool(records, (record) => record.checkUsefulness?.journalist),
    },
    killPriorityAdherence: pool(records, (record) => record.killPriorityAdherence),
    illegal: { proposed, blocked, blockRate: wilsonInterval(blocked, proposed, z) },
    fallback: {
      candidate,
      llm,
      rules,
      rate: decided ? (llm + rules) / decided : null,
      ...wilsonInterval(llm + rules, decided, z),
    },
    messageRate: meanInterval(rates, z),
    speechAllowed,
  };
}

export { countIllegal };
