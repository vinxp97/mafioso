// Pure reducer: reduce(view, {event, data}) -> new view. Rewritten from the
// mutable GameState class in UM-Autobot-Player/src/state.js (same event semantics).
import { reduceClaims } from "./claims.js";
import { emptyBeliefs } from "./beliefs.js";
import { emptyDigest } from "./digest.js";
import { emptyLedger } from "./factLedger.js";
import { applySeatMemory, emptyMemory } from "./memory.js";
import { emptyNotes, applyNotes } from "./notes.js";
import { noteFactionPlan } from "./scumPlan.js";
const clone = (x) => (x === undefined ? x : structuredClone(x));

/** @returns {import('./types.js').GameView} */
export function emptyView() {
  return { selfId: null, players: {}, dead: {}, phase: null, meetings: {},
    messages: [], winners: null, leftGame: false, finished: false,
    stateId: -1, history: {}, reveals: {}, role: null, claims: {}, notes: emptyNotes(),
    ledger: emptyLedger(), beliefs: emptyBeliefs(), digest: emptyDigest(), memory: emptyMemory() };
}

export function parsePhase(name) {
  const m = /^(\w+)(?:\s+(\d+))?$/.exec(String(name || ""));
  return { name: String(name || ""), phase: m ? m[1] : String(name), day: m && m[2] ? Number(m[2]) : 0 };
}

/** Accepts a raw game event or a Dev API envelope. */
export function reduce(view, frame) {
  const v = clone(view ?? emptyView());
  const prevPhase = v.phase?.name || "";
  if (!frame || typeof frame.event !== "string") return v;
  const { event, data } = frame;
  switch (event) {
    case "self": v.selfId = String(data); updateRole(v); break;
    case "players": v.players = clone(data) || {}; break;
    case "playerJoin": if (data?.id) v.players[data.id] = clone(data); break;
    case "playerLeave": if (v.players[data]) v.players[data].left = true; break;
    case "left": case "gameLeft": v.leftGame = true; break;
    case "state": {
      const p = parsePhase(data?.name);
      const sid = data?.id ?? v.stateId;
      if (!v.phase || v.phase.name !== p.name || sid !== v.stateId) v.meetings = {}; // meetings are per-state
      v.phase = p;
      v.stateId = sid;
      seedMeetings(v); // reconnect: history may arrive before state
      break;
    }
    case "history": {
      v.history = clone(data) || {};
      for (const st of Object.values(v.history)) {
        Object.assign(v.reveals, st?.roles || {});
        for (const [id, d] of Object.entries(st?.dead || {})) if (d) v.dead[id] = true;
        if (st?.winners) { v.winners = clone(st.winners); v.finished = true; }
      }
      seedMeetings(v);
      updateRole(v);
      break;
    }
    case "reveal": case "roleReveal": {
      if (data?.playerId) v.reveals[data.playerId] = data.role;
      updateRole(v);
    }
    case "meeting": if (data?.id) v.meetings[data.id] = clone(data); break;
    case "leftMeeting": delete v.meetings[data]; break;
    case "message": case "quote":
      if (data) { v.messages.push(clone(data)); v.claims = reduceClaims(v.claims || {}, data); }
      break;
    case "vote": case "unvote": {
      const m = v.meetings[data?.meetingId];
      if (!m) break;
      m.votes = m.votes || {};
      if (event === "vote") {
        if (m.multi) m.votes[data.voterId] = [...new Set([...(m.votes[data.voterId] || []), data.target])];
        else m.votes[data.voterId] = data.target;
      } else if (m.multi && Array.isArray(m.votes[data.voterId])) {
        m.votes[data.voterId] = m.votes[data.voterId].filter((t) => t !== data.target);
      } else delete m.votes[data.voterId];
      break;
    }
    case "death": case "exorcised": if (data) v.dead[data] = true; break;
    case "revival": if (data) v.dead[data] = false; break;
    case "winners": v.winners = clone(data); v.finished = true; break;
    case "finished": v.finished = true; break;
    default: break; // unknown events ignored (pure)
  }
  applyNotes(v, frame);
  if ((event === "message" || event === "quote") && data) noteFactionPlan(v, data);
  applySeatMemory(v, frame, { prevPhase });
  return v;
}

export const reduceAll = (frames, view = emptyView()) => frames.reduce(reduce, view);
export const isAlive = (v, id) => !!v.players[id] && !v.players[id].left && !v.dead[id];

function seedMeetings(v) {
  for (const m of Object.values(v.history[v.stateId]?.meetings || {}))
    if (m?.id && !v.meetings[m.id]) v.meetings[m.id] = clone(m);
}

/** "Cop:Humble/Loud" -> {role:"Cop", modifiers:["Humble","Loud"]} (Autobot knowledge.splitAppearance). */
export function splitAppearance(a) {
  if (!a) return { role: null, modifiers: [] };
  const [role, mods] = String(a).split(":");
  return { role, modifiers: (mods || "").split("/").filter(Boolean) };
}

function updateRole(v) {
  v.role = v.selfId && v.reveals[v.selfId] ? splitAppearance(v.reveals[v.selfId]).role : null;
}
