// Vinman: town must compute whether its vote results in a loss. A no-lynch hands the mafia a free night kill;
// when that kill would leave the mafia at parity with town, the day must end in a lynch.
import { ALIGNMENT, alignmentOf } from "./faction.js";
import { splitAppearance } from "./reducer.js";

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

/** Day only: after a no-lynch and the next night kill, assumed mafia >= living town. */
export function noLynchLoses(view) {
  if (view?.phase?.phase !== "Day") return false;
  const living = Object.keys(view?.players || {}).filter((id) => alive(view, id)).length;
  const mafia = assumedMafiaAlive(view);
  return mafia > 0 && mafia >= living - mafia - 1;
}

export const NO_LYNCH_LOSES = "no lynch loses: must lynch today";
