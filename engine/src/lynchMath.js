// Vinman: town must compute whether its vote results in a loss. A no-lynch hands the mafia a free night kill;
// when that kill would leave the mafia at parity with town, the day must end in a lynch.
import { ALIGNMENT, alignmentOf, allies } from "./faction.js";
import { splitAppearance } from "./reducer.js";
import { memoryOf } from "./notes.js";

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];

/** A Village seat (town logic applies to it). */
export function townSeat(view) {
  return ALIGNMENT[splitAppearance(view?.role || "").role] === "Village";
}

/**
 * Mafia town must assume alive: the setup count (view.config.mafiaCount, else a third of the table: FJ 9p has 3)
 * minus scum confirmed dead. Town can't see the real count, so every unconfirmed scum counts as living. Never
 * more than the living players town can't clear (itself and revealed townies are not mafia).
 */
export function assumedMafiaAlive(view) {
  const ids = Object.keys(view?.players || {});
  const setup = Number(view?.config?.mafiaCount) || Math.floor(ids.length / 3);
  const scumDead = ids.filter((id) => !alive(view, id) && /^(Mafia|Cult)$/.test(alignmentOf(view?.reveals?.[id]) || "")).length;
  const living = ids.filter((id) => alive(view, id));
  const cleared = living.filter((id) => id === view.selfId ? townSeat(view) : alignmentOf(view?.reveals?.[id]) === "Village").length;
  return Math.max(0, Math.min(setup - scumDead, living.length - cleared));
}

const livingCount = (view) => Object.keys(view?.players || {}).filter((id) => alive(view, id)).length;

/**
 * Day only: after a no-lynch and the next night kill, assumed mafia >= living town (an autoloss).
 * Vinman: town may no-lynch whenever the kill would NOT be an autoloss, even into LYLO, e.g. 6 alive with a
 * mafia flipped dead (2 assumed alive) may no-lynch into a 5-way; with no mafia dead it may not.
 */
export function noLynchLoses(view) {
  if (view?.phase?.phase !== "Day") return false;
  const living = livingCount(view);
  const mafia = assumedMafiaAlive(view);
  return mafia > 0 && mafia >= living - mafia - 1;
}

/** Day only: LYLO, lynch or lose today: a wrong lynch leaves assumed mafia >= living town. */
export function lyloToday(view) {
  if (view?.phase?.phase !== "Day") return false;
  const mafia = assumedMafiaAlive(view);
  return mafia > 0 && mafia >= livingCount(view) - 1 - mafia;
}

/**
 * L3 (10/18): a wrong lynch today is costly when it loses the game now (LYLO) or hands the mafia parity with
 * tonight's kill. Then a wagon alone is no reason to vote an unread player.
 */
export function wrongLynchCostly(view) {
  if (view?.phase?.phase !== "Day") return false;
  const mafia = assumedMafiaAlive(view);
  return mafia > 0 && mafia >= livingCount(view) - 2 - mafia;
}

export const LYLO = "LYLO: lynch or lose today, a wrong lynch loses the game";

// Ultimafia's stalemate GameEndEvent "Meteor" (Games/types/Mafia/events/Meteor.js, Game.js inactivityCheck):
// after noDeathLimit-1 phases with no death the server warns in the phase the meteor is on, "...if nobody is
// condemned today!" (after a night death) or "...if nobody dies tonight!" (after a condemn, mafia alive). If that
// phase ends with no death, everyone dies and NO ONE wins. Any other night the mafia kill is optional. A Day warning is
// lifted only by a condemn (effects/Meteor.js death listener), which ends the day: a Sheriff's shot does not lift it.
const METEOR = /giant meteor will (land and end the game if nobody (is condemned today|dies tonight)|destroy the town)/i;

/** "Day" | "Night" when a meteor warning stands for the current phase (a Night one: nobody has died in it yet), else null. */
export function meteorOn(view) {
  const name = view?.phase?.name;
  if (!name) return null;
  const w = [...(view?.messages || [])].reverse().find((m) => m?.senderId === "server" && METEOR.test(String(m.content || "")));
  if (!w || w.phase !== name) return null;
  if (!/tonight/i.test(String(w.content))) return "Day";
  return (memoryOf(view).deaths || []).some((d) => d.phase === name) ? null : "Night";
}

export const METEOR_DAY = "meteor: someone must be condemned today or no one wins";
export const METEOR_NIGHT = "meteor: someone must die tonight or no one wins";

export const NO_LYNCH_LOSES = "no lynch loses: must lynch today";

/** A Sheriff this seat knows is dead (revealed Sheriff on a dead player). A cleaned Sheriff counts as alive. */
export function sheriffKnownDead(view) {
  return Object.entries(view?.reveals || {}).some(([id, a]) => splitAppearance(a).role === "Sheriff" && !alive(view, id));
}

/** Vinman: town never no-lynches Day 1 unless the Sheriff is dead. */
export function dayOneLynchOwed(view) {
  return view?.phase?.phase === "Day" && Number(view.phase.day) === 1 && !sheriffKnownDead(view);
}

export const DAY1_LYNCH_OWED = "day 1 with the Sheriff alive: town must lynch";

/** A living non-ally publicly claims (or was revealed as) Cop, Journalist or Sheriff: a kill worth taking. */
export function powerClaimerAlive(view) {
  const mates = allies(view);
  return Object.keys(view?.players || {}).some((id) => id !== view.selfId && !mates.has(id) && alive(view, id)
    && /\b(cop|journalist|sheriff)\b/i.test(`${view.claims?.[id]?.kind === "retract" ? "" : view.claims?.[id]?.role || ""} ${view.reveals?.[id] || ""}`));
}

/** Vinman: the mafia may skip the kill only with no night meteor on them and no Cop/Journalist/Sheriff claimer alive. */
export function killOptional(view) {
  return meteorOn(view) !== "Night" && !powerClaimerAlive(view);
}
