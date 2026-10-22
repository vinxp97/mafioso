// Night 5 (Vinman 10/20): when the Sheriff's asked target answers with a power role (Cop or Journalist),
// ONE living mafia member counterclaims that role, a few seconds after the answer, once per game.
// A contested power claim is what lets the Sheriff shoot it (sheriffGate.shotStatus: "contested").
//   who     every mafia seat computes the same pick from public facts: living teammates (self included)
//           with no public role claim yet, non-Janitor first, then a hash of (day, target) over sorted ids.
//   never   a teammate's (fake) claim, a claim someone already counterclaimed, the Sheriff role (the
//           Janitor never CCs the Sheriff, nor does anyone else), or a second time in the game.
//   line    "<target> is lying, im the real <role>": it names only the target, never the Sheriff.
import { SHERIFF_ASK, sheriffAsks, sheriffSeat } from "./sheriffAsk.js";
import { claimedRoleIn, claimOpts } from "./chatStyle.js";
import { allies, myFaction } from "./faction.js";

export const MAFIA_CC = Object.freeze({ roles: Object.freeze(["Cop", "Journalist"]), minMs: 3_000, maxMs: 7_000, lateMarginMs: 5_000 });

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const hash = (text) => { let h = 2166136261; for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const publicLines = (view) => (view?.messages || []).filter((m) => m?.senderId && m.senderId !== "server" && m.public !== false);

function roleOfMate(view, id) {
  if (id === view.selfId) return String(view.role || "");
  return String(view.teammates?.[id]?.role || "");
}

/**
 * The teammates who may counterclaim. Default: every teammate. config.soloCounterclaim "on" (Night 5 solo flags,
 * off by default) with config.botSeats (the harness's own seats): only teammates that are bots, so a lone bot
 * among human teammates counterclaims itself instead of counting on a human who doesn't know the rule.
 */
export function counterclaimMates(view) {
  const mates = [...allies(view)];
  const bots = view?.config?.soloCounterclaim === "on" && Array.isArray(view.config.botSeats) ? new Set(view.config.botSeats.map(String)) : null;
  return bots ? mates.filter((id) => bots.has(String(id))) : mates;
}

/** The teammate (or self) who counterclaims for the faction, or null. Same answer on every mafia seat. */
export function mafiaCounterclaimer(view, target) {
  const lines = publicLines(view);
  const claimed = (id) => lines.some((m) => m.senderId === id && claimedRoleIn(m.content, claimOpts(view)));
  const pool = [view.selfId, ...counterclaimMates(view)].filter((id) => id !== target && alive(view, id) && !claimed(id)).sort();
  if (!pool.length) return null;
  const known = pool.every((id) => roleOfMate(view, id));
  const pref = known ? pool.filter((id) => !/janitor/i.test(roleOfMate(view, id))) : [];
  const from = pref.length ? pref : pool;
  return from[hash(`${view.phase?.name || ""}|${target}`) % from.length];
}

/**
 * This seat's counterclaim on the Sheriff's asked target, or null: { line, at, role, target, why }. `at` is
 * the earliest send time (the answer + MAFIA_CC.minMs..maxMs, seeded); after the Sheriff's counterclaim
 * window it is too late (null).
 */
export function mafiaCounterclaim(view, { now = view?.clock } = {}) {
  if (view?.phase?.phase !== "Day" || myFaction(view) !== "Mafia" || view?.config?.mafiaCounterclaim === "off") return null;
  const sheriff = sheriffSeat(view);
  const mates = new Set([view.selfId, ...allies(view)]);
  if (!sheriff || mates.has(sheriff) || !alive(view, view.selfId)) return null;
  // Once per game: a teammate already made a Cop or Journalist claim (a fake claim or an earlier CC).
  if (publicLines(view).some((m) => mates.has(m.senderId) && /^(cop|journalist)$/.test(String(claimedRoleIn(m.content, claimOpts(view)) || "")))) return null;
  for (const a of sheriffAsks(view, sheriff)) {
    const role = a.reply?.kind === "power" ? a.reply.role : null;
    if (!MAFIA_CC.roles.includes(role) || mates.has(a.target) || !alive(view, a.target) || a.counter) continue;
    if (mafiaCounterclaimer(view, a.target) !== view.selfId) return null;
    const at = Number(a.reply.at) + MAFIA_CC.minMs + (hash(`${view.selfId}|${a.target}|${a.reply.at}`) % (MAFIA_CC.maxMs - MAFIA_CC.minMs + 1));
    const clock = Number(now);
    if (Number.isFinite(clock) && Number.isFinite(Number(a.reply.at)) && clock - Number(a.reply.at) > SHERIFF_ASK.ccMs - MAFIA_CC.lateMarginMs) return null;
    const name = String(view.players?.[a.target]?.name || "");
    if (!name) return null;
    return { line: `${name} is lying, im the real ${role.toLowerCase()}`, at, role, target: a.target, why: `sheriff asked ${name}, ${role} answer uncontested` };
  }
  return null;
}
