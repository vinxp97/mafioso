// Bussing: a mafia seat votes (or accuses) its own teammate. Only when town is already on that
// teammate (the vote is coming anyway, so joining buys a town read), or as a deliberate town-read
// play the model chose while town already suspects the teammate. Never when it hands town the game.
import { allies, myFaction } from "./faction.js";
import { isAlive } from "./reducer.js";
import { NO_ONE } from "./types.js";

export const BUS = {
  wagonVotes: 2,        // non-scum votes on the teammate that make it a town wagon
  readVotes: 1,         // non-scum votes needed before a model "town-read" bus is allowed
  sureChance: 0.85,     // rules: chance to join when the teammate's lynch is near-certain
  wagonChance: 0.5,     // rules: chance to join a 2+ town wagon that isn't yet near-certain
  minScumAfter: 2,      // never bus the team down below this many living scum
};

const scumSeat = (view) => /^(mafia|cult)$/i.test(String(myFaction(view) || ""));

function voteTally(view, meeting) {
  const mates = allies(view);
  const total = new Map(), town = new Map();
  for (const [voter, raw] of Object.entries(meeting?.votes || {})) {
    for (const pick of (Array.isArray(raw) ? raw : [raw])) {
      if (pick == null || pick === "" || pick === NO_ONE) continue;
      const id = String(pick);
      total.set(id, (total.get(id) || 0) + 1);
      if (voter !== view.selfId && !mates.has(voter)) town.set(id, (town.get(id) || 0) + 1);
    }
  }
  return { total, town };
}

/** Living scum (self + known teammates) and living others. */
export function sideCounts(view) {
  const mates = allies(view);
  let scum = 0, town = 0;
  for (const id of Object.keys(view.players || {})) {
    if (!isAlive(view, id)) continue;
    if (id === view.selfId || mates.has(id)) scum++; else town++;
  }
  return { scum, town };
}

/**
 * May this seat vote/accuse teammate `target` in day meeting `meetingId`?
 * @returns {{ok:boolean, mode?:"wagon"|"townread", sure?:boolean, reason:string}}
 */
export function busCheck(view, meetingId, target, { deliberate = false } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!scumSeat(view)) return no("not scum");
  if (view.phase?.phase === "Night") return no("night");
  const meeting = view.meetings?.[meetingId];
  if (!meeting || meeting.name !== "Village") return no("not the day vote");
  if (!allies(view).has(String(target)) || !isAlive(view, String(target))) return no("not a living teammate");
  const { scum, town } = sideCounts(view);
  if (scum - 1 < BUS.minScumAfter) return no("would leave a lone scum");
  if (scum >= town - 1) return no("one lynch from parity: lynch town instead");
  const { total, town: townVotes } = voteTally(view, meeting);
  const onMate = townVotes.get(String(target)) || 0;
  let lead = 0;
  for (const [id, n] of total) if (id !== String(target)) lead = Math.max(lead, n);
  const leading = (total.get(String(target)) || 0) > lead && onMate >= 1;
  const living = scum + town;
  const sure = onMate + 1 > living / 2 || ((total.get(String(target)) || 0) - lead >= 2 && onMate >= BUS.wagonVotes);
  if (onMate >= BUS.wagonVotes || leading) return { ok: true, mode: "wagon", sure, reason: sure ? "lynch is near-certain" : "town wagon" };
  if (deliberate && onMate >= BUS.readVotes) return { ok: true, mode: "townread", sure: false, reason: "town-read play" };
  return no("town is not on this teammate");
}

/** Rules pick: a teammate to bus in this day meeting, or null. */
export function busPick(view, meetingId, rng = Math.random) {
  for (const id of allies(view)) {
    const c = busCheck(view, meetingId, id);
    if (!c.ok) continue;
    if (rng() < (c.sure ? BUS.sureChance : BUS.wagonChance)) return id;
  }
  return null;
}

/** A casual faction-chat line about the bus. Names only, no syntax. */
export function busNote(view, target, rng = Math.random) {
  const name = String(view.players?.[target]?.name || "u").toLowerCase();
  const lines = [`sorry ${name}, town is all over u, im hopping on`, `${name} ur cooked, ill vote u for the town cred`, `gotta bus u ${name}, gl`];
  return lines[Math.floor(rng() * lines.length) % lines.length];
}
