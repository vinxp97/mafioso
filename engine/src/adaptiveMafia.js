// Adaptive mafia (FJ). The old fixed script (fake Cop every day, bloc on one push) stays selectable with
// view.config.mafia = "script". "adaptive" plays Vinman's FJ strategy from the mafia side, using only what
// the faction legitimately knows: public play (claims, flips, votes), its own members, faction chat, and
// the Janitor's own clean result. Never another seat's hidden role.
//   - kill priority: Cop > Sheriff > Journalist (by public claim); otherwise a player town trusts, spread;
//   - fake claims vary: who claims, whether anyone does; no fake Cop once a real Cop has flipped Cop, is
//     verified, or is out and alive; never claim Sheriff; the Janitor claims Cop or Journalist;
//   - the Janitor saves the single clean for a claimed power role (or a late night);
//   - the Lawyer covers the teammate town suspects most (the Cop checks its top read);
//   - day votes blend in: the town wagon, else the publicly most suspicious townie; at most two scum on one
//     target unless the lynch wins the game.
import { allies, alignmentOf } from "./faction.js";
import { townReads } from "./townReads.js";
import { NO_ONE } from "./types.js";
import { agreedPlan } from "./scumPlan.js";
import { underPressure } from "./chatStyle.js";

export const MAFIA_MODES = Object.freeze(["adaptive", "script"]);
/** Engine default stays "script" (old views and tests); the harness defaults every seat to "adaptive". */
export function mafiaModeOf(view) {
  return view?.config?.mafia === "adaptive" ? "adaptive" : "script";
}

const POWER_PRIORITY = { Cop: 3, Sheriff: 2, Journalist: 1 };
const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const nameOf = (view, id) => String(view?.players?.[id]?.name || "").toLowerCase();

/** Deterministic 0..1 from the game state: varies across nights/seats, never reads hidden state. */
export function stateHash(...parts) {
  let x = 2166136261;
  for (const ch of parts.join("|")) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); }
  return ((x >>> 0) % 100000) / 100000;
}

/**
 * The game as a town observer sees it: no teammates, only public flips (dead players, and living
 * non-teammates the server revealed, e.g. the Sheriff after a shot). Used to ask "what does town think?".
 */
export function observerView(view) {
  const mates = allies(view);
  const reveals = {};
  for (const [id, r] of Object.entries(view?.reveals || {})) if (id !== view.selfId && (!alive(view, id) || !mates.has(id))) reveals[id] = r;
  const notes = { ...(view?.notes || {}), checks: {}, cleared: [], suspects: [] };
  return { ...view, selfId: "__observer__", role: "Villager", teammates: {}, reveals, notes };
}

/** Public suspicion of every living player (teammates and self included), plus the public record. */
export function publicReads(view) {
  return townReads(observerView(view));
}

/** Role this Janitor learned from its clean (live ":mop: You discover X's role is Cop."), by player id. */
export function cleanedRoles(view) {
  const out = {};
  for (const m of view?.messages || []) {
    if (m?.senderId && m.senderId !== "server") continue;
    const text = String(m?.content || "");
    if (/^:invest:/.test(text)) continue; // a role Cop's "You Learn that X's Role is Y", not a clean
    const hit = /(?:learn that|discover) (.+?)'s role is (?:a |an |the )?(.+?)\.*$/i.exec(text);
    if (!hit) continue;
    const id = Object.keys(view.players || {}).find((p) => nameOf(view, p) === hit[1].toLowerCase());
    if (id) out[id] = hit[2].trim();
  }
  return out;
}

/** Which fake claims are still safe today, from public information only. */
export function claimOptions(view, reads = publicReads(view)) {
  const mates = allies(view);
  const team = new Set([view.selfId, ...mates]);
  const rec = reads.record;
  const holders = (role) => Object.entries(rec.claims).filter(([id, r]) => r === role && !team.has(id)).map(([id]) => id);
  const flipped = (role) => Object.entries(view.reveals || {}).some(([id, r]) => !alive(view, id) && String(r).split(" (")[0] === role);
  const cleaned = cleanedRoles(view);
  const copOut = holders("Cop").some((id) => alive(view, id));
  const copDead = holders("Cop").some((id) => !alive(view, id));
  const cop = !flipped("Cop") && !copOut && !copDead && !reads.verified.some((id) => rec.claims[id] === "Cop");
  const jOut = holders("Journalist").length > 0;
  const journalist = !flipped("Journalist") && !jOut;
  // A cleaned Cop/Journalist cannot be contradicted by a flip: the Janitor may take that role.
  // Only when that player never claimed it and no outsider holds the claim (else the claim is contradicted).
  const cleanedPower = Object.entries(cleaned).find(([id, r]) => /^(cop|journalist)$/i.test(r) && !rec.claims[id]
    && !holders(r[0].toUpperCase() + r.slice(1).toLowerCase()).some((h) => alive(view, h)));
  return { cop, journalist, cleanedRole: cleanedPower ? cleanedPower[1][0].toUpperCase() + cleanedPower[1].slice(1).toLowerCase() : null, liveCop: holders("Cop").find((id) => alive(view, id)) || null };
}

/** Night kill: Cop > Sheriff > Journalist claimers; else spread over the players town trusts most. */
export function adaptiveKill(view, pool, reads = publicReads(view)) {
  if (!pool.length) return null;
  const prio = (id) => POWER_PRIORITY[reads.record.claims[id]] || POWER_PRIORITY[String(view.reveals?.[id] || "").split(" (")[0]] || 0;
  const top = Math.max(...pool.map(prio));
  let cands = pool.filter((id) => prio(id) === top);
  if (top === 0) {
    // Keep the suspected townies alive as lynch fodder; kill among the three most trusted, varied by night.
    cands = cands.slice().sort((a, b) => (reads.score[a] || 0) - (reads.score[b] || 0) || String(a).localeCompare(String(b))).slice(0, 3);
  }
  cands.sort();
  return cands[Math.floor(stateHash(view.stateId, view.phase?.name, "kill", [...pool].sort().join(",")) * cands.length) % cands.length];
}

/** Most publicly suspicious living non-teammate a scum seat can push without looking odd. */
export function pushTarget(view, reads = publicReads(view), skip = []) {
  const mates = allies(view);
  const ok = Object.keys(view.players || {}).filter((id) => alive(view, id) && id !== view.selfId && !mates.has(id) && !skip.includes(id)
    && !reads.verified.includes(id) && !POWER_PRIORITY[reads.record.claims[id]] && alignmentOf(view.reveals?.[id]) !== "Village");
  ok.sort((a, b) => (reads.score[b] || 0) - (reads.score[a] || 0) || String(a).localeCompare(String(b)));
  const best = reads.score[ok[0]] || 0;
  const tier = ok.filter((id) => (reads.score[id] || 0) >= best - 0.5).slice(0, 3);
  return tier.length ? tier[Math.floor(stateHash(view.stateId, view.selfId, "push") * tier.length) % tier.length] : null;
}

/**
 * The leader's night plan. Same shape as the script plan, plus claimRole null = nobody claims.
 * base: the script draft (kill pool, lawyer ask).
 */
export function adaptiveDraft(view, base, killPool) {
  const reads = publicReads(view);
  const mates = allies(view);
  const team = [view.selfId, ...mates].filter((id) => alive(view, id)).sort();
  const killTarget = adaptiveKill(view, killPool, reads) || base.killTarget;
  const opts = claimOptions(view, reads);
  const roleOf = (id) => (id === view.selfId ? view.role : view.teammates?.[id]?.role || view.reveals?.[id] || "");
  const janitor = team.find((id) => /janitor/i.test(String(roleOf(id))));
  const h = (salt) => stateHash(view.stateId, team.join(","), salt);
  let claimRole = null, speakerId = null;
  // Vary whether anyone claims (about half the time when a claim is open) and who.
  if ((opts.cop || opts.journalist) && h("claim?") < 0.5) {
    speakerId = janitor && h("who") < 0.5 ? janitor : team[Math.floor(h("seat") * team.length) % team.length];
    claimRole = opts.cop ? "Cop" : opts.liveCop ? "Journalist" : null;
    // A fake Journalist needs a living Cop claimer to call fake: not the one we kill tonight.
    if (claimRole === "Journalist" && opts.liveCop === killTarget) claimRole = null;
    if (!claimRole) speakerId = null;
  }
  const lynchTarget = pushTarget(view, reads, [killTarget]) || base.lynchTarget;
  // Lawyer covers the teammate town suspects most (the Cop checks its top read); the claimer first on a tie.
  const lawPool = team.filter((id) => !/lawyer/i.test(String(roleOf(id))));
  lawPool.sort((a, b) => (reads.score[b] || 0) - (reads.score[a] || 0) || (b === speakerId) - (a === speakerId) || String(a).localeCompare(String(b)));
  const claimedPower = POWER_PRIORITY[reads.record.claims[killTarget]] > 0;
  const lateNight = Number(view.phase?.day) >= 3;
  return {
    ...base,
    killTarget,
    lynchTarget,
    claimRole,
    speakerId,
    lawyerTarget: lawPool[0] || base.lawyerTarget,
    // One clean: save it for a claimed power role, or spend it late.
    janitorTarget: claimedPower || lateNight ? killTarget : null,
    adaptive: true,
  };
}

/** Faction-chat line for an adaptive plan: names only, natural language. */
export function formatAdaptivePlan(plan, view) {
  const nm = (id) => (id && view?.players?.[id]?.name ? String(view.players[id].name).toLowerCase() : null);
  const kill = nm(plan.killTarget);
  if (!kill) return null;
  const parts = [`kill ${kill} tonight`];
  const lynch = nm(plan.lynchTarget);
  if (plan.claimRole && plan.speakerId) {
    const who = plan.speakerId === view.selfId ? "ill" : nm(plan.speakerId);
    parts.push(`${who} fake ${plan.claimRole.toLowerCase()} tmrw${lynch ? ` and push ${lynch}` : ""}`);
  } else parts.push(`no fake claims tmrw, lay low${lynch ? ` and lean ${lynch}` : ""}`);
  const law = plan.lawyerTarget === view.selfId ? "me" : nm(plan.lawyerTarget);
  if (law) parts.push(`lawyer go on ${law}`);
  if (plan.janitorTarget == null) parts.push("save the clean");
  return parts.join(", ").slice(0, 200);
}

/** The claim line this seat says today, or null (re-checked at day: the board may have changed). */
export function adaptiveClaimLine(view, plan, reads = publicReads(view)) {
  if (!plan?.claimRole || plan.speakerId !== view.selfId) return null;
  const opts = claimOptions(view, reads);
  const janitor = /janitor/i.test(String(view.role || ""));
  const role = janitor && opts.cleanedRole ? opts.cleanedRole : opts.cop && plan.claimRole === "Cop" ? "Cop" : opts.journalist && opts.liveCop ? "Journalist" : null;
  if (!role) return null;
  if (role === "Journalist") return opts.liveCop ? { role, target: opts.liveCop, line: `im journalist. ${nameOf(view, opts.liveCop)} got no report, fake cop` } : null;
  const target = plan.lynchTarget && alive(view, plan.lynchTarget) && !allies(view).has(plan.lynchTarget) ? plan.lynchTarget : pushTarget(view, reads);
  return target ? { role, target, line: `im cop. ${nameOf(view, target)} guilty` } : null;
}

/**
 * Under pressure (L-1 or the leading wagon late) a scum seat claims like a townie would: Journalist when
 * that claim is open (nobody outside claims it, none flipped) about half the time, else plain Villager.
 * Never Cop (no results to show) and never Sheriff. Once per game.
 */
export function adaptivePressureLine(view, reads = publicReads(view)) {
  if (view?.phase?.phase !== "Day" || !underPressure(view)) return null;
  const mine = (view.messages || []).filter((m) => m?.senderId === view.selfId && m.public !== false);
  if (mine.some((m) => /\b(?:im|i'?m|i am)\s+(?:just\s+)?(?:a\s+)?(cop|journalist|villager|sheriff)\b/i.test(String(m.content || "")))) return null;
  const opts = claimOptions(view, reads);
  if (opts.journalist && stateHash(view.stateId, view.selfId, "pressure") < 0.5) return { role: "Journalist", line: "im journalist, nothing useful yet. not me" };
  return { role: "Villager", line: "im just a villager, no power role. not me" };
}

/** This scum seat's day vote target. */
export function adaptiveVote(view, village, plan, reads = publicReads(view)) {
  const mates = allies(view);
  const team = new Set([view.selfId, ...mates]);
  const targets = (village?.targets || []).filter((t) => t !== view.selfId);
  const livingTeam0 = [...team].filter((id) => alive(view, id)).length;
  const livingTown0 = Object.keys(view.players || {}).filter((id) => alive(view, id) && !team.has(id)).length;
  // Voting a player the server revealed as town (a Sheriff who shot) is an obvious tell, short of the endgame.
  const valid = (t) => t && targets.includes(t) && !team.has(t) && alive(view, t)
    && (livingTeam0 >= livingTown0 - 1 || alignmentOf(view.reveals?.[t]) !== "Village");
  const votes = village?.votes || {};
  const scumOn = (t) => Object.entries(votes).filter(([v, x]) => mates.has(v) && x === t).length;
  const townOn = {};
  for (const [v, x] of Object.entries(votes)) if (!team.has(v) && x != null && x !== NO_ONE) townOn[x] = (townOn[x] || 0) + 1;
  const livingTeam = [...team].filter((id) => alive(view, id)).length;
  const livingTown = Object.keys(view.players || {}).filter((id) => alive(view, id) && !team.has(id)).length;
  // One lynch from parity: the lynch wins the game, so the team votes together.
  const endgame = livingTeam >= livingTown - 1;
  // My own public claim: stay consistent with it.
  const mine = (view.messages || []).filter((m) => m?.senderId === view.selfId && m.public !== false && /\bim (cop|journalist)\b/i.test(String(m.content || "")));
  if (mine.length && plan?.lynchTarget && valid(plan.lynchTarget)) return plan.lynchTarget;
  const claim = adaptiveClaimLine(view, plan, reads);
  if (claim && valid(claim.target)) return claim.target;
  const wagon = Object.entries(townOn).filter(([t]) => valid(t)).sort((a, b) => b[1] - a[1])[0];
  // Teammates may vote on the same tick without seeing each other: with three alive, one seat (by hash, per
  // day) never takes the team's main target, so the cap holds even then.
  const living = [...team].filter((id) => alive(view, id)).sort();
  const splitter = !endgame && living.length >= 3 && living[Math.floor(stateHash(view.stateId, living.join(","), "split") * living.length) % living.length] === view.selfId;
  const main = wagon && wagon[1] >= 2 ? wagon[0] : plan?.lynchTarget;
  const cap = (t) => endgame || (scumOn(t) < 2 && !(splitter && t === main));
  if (wagon && wagon[1] >= 2 && cap(wagon[0])) return wagon[0];
  if (plan?.lynchTarget && valid(plan.lynchTarget) && cap(plan.lynchTarget)) return plan.lynchTarget;
  const alt = pushTarget(view, reads, Object.keys(votes).length ? targets.filter((t) => !cap(t)) : []);
  if (valid(alt)) return alt;
  return targets.find(valid) || null;
}

/**
 * Town's first-village-vote delay after its own vote gate opens, in ms, as quantiles (0%, 10%, ..., 100%).
 * Measured in self-play (seeds 1-3, adaptive mafia, scorecard mafia.voteTiming.townDelayQuantilesMs): every
 * town seat lets its first vote through on the tick its gate opens, so the table is a point mass at 0; the
 * spread in landing times comes from the shared 2-15s stagger and the tick, which scum get too. Live play
 * (model-paced town) should measure its own and pass it as view.config.townVoteDelayMs.
 */
export const TOWN_VOTE_DELAY_MS = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Sample a quantile table at u in [0,1) by linear interpolation. */
export function sampleQuantiles(q, u) {
  const x = Math.min(0.999999, Math.max(0, u)) * (q.length - 1);
  const i = Math.floor(x);
  return q[i] + (q[Math.min(q.length - 1, i + 1)] - q[i]) * (x - i);
}

/** This scum seat's hold before its first village vote today (ms after its vote gate), drawn from town's. */
export function scumVoteHoldMs(view, table = view?.config?.townVoteDelayMs || TOWN_VOTE_DELAY_MS) {
  return Math.round(sampleQuantiles(table, stateHash(view?.stateId, view?.selfId, "votetime")));
}

/** Is this seat the faction's claimer today, and with which role (for the early-claim gate)? */
export function planClaim(view) {
  const plan = agreedPlan(view);
  if (mafiaModeOf(view) !== "adaptive") return { planSpeaker: plan?.speakerId === view?.selfId, planRole: plan?.claimRole };
  const c = plan ? adaptiveClaimLine(view, plan) : null;
  return { planSpeaker: !!c, planRole: c?.role || null };
}
