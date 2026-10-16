// Minimal explicit alignment map + ally/enemy sets. Claims are NOT trusted for allies
// (anyone can lie); only server reveals and shared faction meetings count.
import { splitAppearance } from "./reducer.js";

export const ALIGNMENT = {
  Villager: "Village", Cop: "Village", Doctor: "Village", Oracle: "Village", Caroler: "Village",
  "Town Crier": "Village", Sheriff: "Village", Tracker: "Village", Watcher: "Village",
  Detective: "Village", Bodyguard: "Village", Blacksmith: "Village",
  Mafioso: "Mafia", Godfather: "Mafia", Janitor: "Mafia", Hooker: "Mafia", Lawyer: "Mafia",
  Cultist: "Cult", "Cult Leader": "Cult",
  Fool: "Independent", "Serial Killer": "Independent", Survivor: "Independent",
};
export const FACTION_MEETINGS = { Mafia: "Mafia", Cult: "Cult" };

export function alignmentOf(appearance, map = ALIGNMENT) {
  const r = splitAppearance(appearance).role;
  return r ? map[r] ?? null : null;
}

const memberIds = (m) => (m?.members || []).map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);

/** Faction the bot belongs to, from own role or membership in a faction meeting. */
export function myFaction(view) {
  const a = view.role ? ALIGNMENT[view.role] : null;
  if (a) return a;
  for (const m of Object.values(view.meetings))
    if (m.amMember && Object.values(FACTION_MEETINGS).includes(m.name)) return m.name;
  return null;
}

/** Known faction mates (excludes self). Village never knows allies from claims. */
export function allies(view) {
  const out = new Set();
  const f = myFaction(view);
  if (!f || f === "Village" || f === "Independent") return out;
  for (const [id, app] of Object.entries(view.reveals || {}))
    if (id !== view.selfId && alignmentOf(app) === f) out.add(id);
  for (const m of Object.values(view.meetings))
    if (m.amMember && m.name === FACTION_MEETINGS[f]) for (const id of memberIds(m)) if (id !== view.selfId) out.add(id);
  return out;
}

/** Revealed players of a different known alignment. */
export function enemies(view) {
  const f = myFaction(view);
  const mine = allies(view);
  const out = new Set();
  if (!f) return out;
  for (const [id, app] of Object.entries(view.reveals || {})) {
    const a = alignmentOf(app);
    if (id !== view.selfId && a && a !== f && !mine.has(id)) out.add(id);
  }
  return out;
}
