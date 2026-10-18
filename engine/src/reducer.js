// Pure reducer: reduce(view, {event, data}) -> new view. Rewritten from the
// mutable GameState class in UM-Autobot-Player/src/state.js (same event semantics).
import { reduceClaims } from "./claims.js";
import { emptyBeliefs } from "./beliefs.js";
import { emptyDigest } from "./digest.js";
import { emptyLedger } from "./factLedger.js";
import { applySeatMemory, emptyMemory } from "./memory.js";
import { emptyNotes, applyNotes } from "./notes.js";
import { isPublicSpeechMeeting } from "./scheduler.js";
import { noteFactionPlan } from "./scumPlan.js";

// items/Gun.js: ":gun: X pulls a gun and shoots at Y!" (the shooter is the Sheriff in Frontier Justice).
const GUN_LINE = /^(?::gun:\s*)?(.+?) pulls a gun and shoots (?:at )?(.+?)!*$/i;
const isGun = (m) => /\b(shoot|gun)\b/i.test(`${m?.name || ""} ${m?.actionName || ""}`);
/** This seat already acted in an instant meeting: it is spent for the state (kept in v.usedMeetings across re-sends). */
function markUsed(v, m) {
  m.used = true;
  const k = `${v.stateId}|${m.id}`;
  if (!(v.usedMeetings ||= []).includes(k)) v.usedMeetings.push(k);
  if (v.usedMeetings.length > 50) v.usedMeetings.shift();
}
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
  if (frame.t != null && Number.isFinite(Number(frame.t)) && !(Number(frame.t) < (v.clock ?? -Infinity))) v.clock = Number(frame.t);
  switch (event) {
    case "time": case "timerInfo": {
      // Day timer for late-day rules. Shapes vary, so keep the numbers we can read.
      const d = data && typeof data === "object" ? data : {};
      if (d.name && d.name !== "main") break;
      const tm = (v.timer && v.timer.stateId === v.stateId) ? v.timer : { stateId: v.stateId };
      const length = Number(d.delay ?? d.length ?? d.duration ?? d.total);
      if (Number.isFinite(length) && length > 0) tm.length = length;
      const start = Number(d.start ?? d.startTime ?? d.started);
      if (Number.isFinite(start) && start > 0) tm.start = start;
      if (event === "time" && Number.isFinite(Number(d.time))) {
        const val = Number(d.time);
        if (tm.first == null) tm.first = val;
        tm.last = val;
      }
      v.timer = tm;
      break;
    }
    case "botConfig": v.config = { ...(v.config || {}), ...(clone(data) || {}) }; break;
    case "self": v.selfId = String(data); updateRole(v); break;
    case "players": v.players = clone(data) || {}; break;
    case "playerJoin": if (data?.id) v.players[data.id] = clone(data); break;
    case "playerLeave": if (v.players[data]) v.players[data].left = true; break;
    case "left": case "gameLeft": v.leftGame = true; break;
    case "kicked": v.kicked = true; break;
    // Harness-injected: this seat's own faction teammates, known to it in FJ from game start.
    case "teammates": {
      v.teammates = {};
      for (const t of Array.isArray(data) ? data : []) {
        if (!t?.id || t.id === v.selfId) continue;
        v.teammates[t.id] = { id: t.id, name: t.name || null, role: t.role || null };
        if (t.role) (v.reveals ||= {})[t.id] = t.role;
        if (!v.players[t.id]) v.players[t.id] = { id: t.id, name: t.name || t.id };
        else if (t.name && !v.players[t.id].name) v.players[t.id].name = t.name;
      }
      break;
    }
    case "state": {
      const p = parsePhase(data?.name);
      const sid = data?.id ?? v.stateId;
      const changed = !v.phase || v.phase.name !== p.name || sid !== v.stateId;
      if (changed) v.meetings = {}; // meetings are per-state
      if (changed) v.phaseStartedAt = frame.t != null && Number.isFinite(Number(frame.t)) ? Number(frame.t) : null;
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
      break;
    }
    case "meeting": {
      if (data?.id) {
        const m = clone(data);
        // Live servers name the faction meeting "Mafia Kill"; the engine keys on "Mafia"/"Cult".
        // Live FJ splits the faction into "Mafia" chat ("Mafia Meeting"), "Mafia Kill" (vote) and
        // "Mafia Action" (End Meeting? Yes/No, must act). Tag them; the chat keeps the bare name.
        const fac = String(m.name || "").match(/^(mafia|cult)(?:\s+(kill|meeting|chat|action))?$/i);
        if (fac) {
          const f = fac[1][0].toUpperCase() + fac[1].slice(1).toLowerCase();
          const kind = (fac[2] || "").toLowerCase();
          m.rawName = m.name; m.faction = f;
          m.factionRole = kind === "kill" ? "kill" : kind === "action" ? "action" : "chat";
          if (m.factionRole === "chat") m.name = f;
        }
        // L4 (10/18): the server re-sends a meeting right after a vote that made this seat leave it (the gun
        // fires, leftMeeting, then Player.js sendMeeting since the state did not change), with amMember false.
        // A meeting this seat left, or is not a member of, is not open for it: drop it.
        const wasMine = v.meetings[data.id]?.amMember === true;
        if (v.meetings[data.id]?.used || (v.usedMeetings || []).includes(`${v.stateId}|${data.id}`) || (v.gunFired === v.stateId && isGun(m))) m.used = true;
        if ((m.amMember === false && wasMine) || (v.leftMeetings || []).includes(`${v.stateId}|${data.id}`)) delete v.meetings[data.id];
        else v.meetings[data.id] = m;
      }
      // The one-shot "players" frame can be missed (sent before the stream attaches, or past the
      // event cap). Meeting members and targets are seated players, so learn them here.
      for (const m of Array.isArray(data?.members) ? data.members : []) if (m?.id && !v.players[m.id]) v.players[m.id] = { id: m.id };
      // Only id-shaped targets; boolean/button options (Yes, No, Kick) are not players.
      for (const t of Array.isArray(data?.targets) ? data.targets : []) if (typeof t === "string" && t !== "*" && !/^(yes|no|kick)$/i.test(t) && !v.players[t]) v.players[t] = { id: t };
      break;
    }
    case "leftMeeting": {
      const id = typeof data === "object" && data ? data.meetingId ?? data.id : data;
      delete v.meetings[id];
      (v.leftMeetings ||= []).push(`${v.stateId}|${id}`);
      if (v.leftMeetings.length > 50) v.leftMeetings.shift();
      break;
    }
    // Server re-sends a meeting's member list when it changes ({ meetingId, members: [{ id, canVote }] }).
    case "members": {
      const m = v.meetings[data?.meetingId];
      const list = Array.isArray(data?.members) ? data.members : [];
      if (m) m.members = clone(list);
      for (const mem of list) if (mem?.id && !v.players[mem.id]) v.players[mem.id] = { id: mem.id };
      break;
    }
    // Night/day obituaries ({ obituaries: [{ id, playerInfo, ... }] }): the dead, also on a reconnect
    // that missed the "death" frame.
    case "obituaries":
      for (const o of Array.isArray(data?.obituaries) ? data.obituaries : []) if (o?.id) v.dead[o.id] = true;
      break;
    // Sent when this seat has not voted in every core meeting and is about to be veg-kicked.
    case "youAreBeingVoteKicked": v.voteKickWarning = !!data?.status; break;
    case "start": v.started = true; break;
    case "isStarted": v.started = !!data; break;
    case "isSpectator": v.spectator = true; break;
    case "message": case "quote":
      if (data) {
        const msg = clone(data);
        if (msg.t == null && frame.t != null) msg.t = frame.t;
        if (msg.phase == null) msg.phase = v.phase?.name || "";
        const meeting = msg.meetingId ? v.meetings[msg.meetingId] : null;
        if (typeof msg.public !== "boolean") msg.public = meeting ? isPublicSpeechMeeting(meeting) : msg.senderId !== "server";
        v.messages.push(msg);
        v.claims = reduceClaims(v.claims || {}, data);
        // L3 (10/18): live town views never got a reveal frame for the shooter, so the revealed-Sheriff rules
        // (never lynch him, never vote him) did not apply. The gun line itself names him; in FJ only the
        // Sheriff has a gun. Kept as a fallback: a real reveal frame always wins.
        if (msg.senderId === "server" || msg.senderId == null) {
          const shot = GUN_LINE.exec(String(msg.content || "").trim());
          const by = shot && Object.keys(v.players || {}).find((id) => String(v.players[id]?.name || "").toLowerCase() === shot[1].trim().toLowerCase());
          if (by && !v.reveals[by]) v.reveals[by] = "Sheriff";
          if (by && by === v.selfId) { v.gunFired = v.stateId; for (const m of Object.values(v.meetings)) if (isGun(m)) markUsed(v, m); }
        }
      }
      break;
    case "speakCooldown": {
      const ms = typeof data === "number" ? data : Number(data?.ms ?? data?.remaining);
      const until = Number(data?.until ?? data?.t);
      if (Number.isFinite(until) && until > 1e11) v.speechHoldUntil = until;
      else if (Number.isFinite(ms) && ms > 0) v.speechHoldUntil = Number(frame.t ?? 0) + ms;
      break;
    }
    case "vote": case "unvote": {
      const m = v.meetings[data?.meetingId];
      if (!m) break;
      m.votes = m.votes || {};
      if (event === "vote") {
        // L4 (10/18): a vote in an instant meeting (the gun) fires it at once: the meeting is used, even
        // though the server keeps it in the view (finished, still a member) and the target then dies.
        if (m.instant && data.voterId === v.selfId) markUsed(v, m);
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
    default: break; // ignored or unknown (see classifyEvent); the reducer stays pure either way
  }
  if (event === "death" || event === "exorcised" || event === "meeting" || event === "vote" || event === "obituaries") pruneDeadVotes(v);
  applyNotes(v, frame);
  if ((event === "message" || event === "quote") && data) noteFactionPlan(v, data);
  applySeatMemory(v, frame, { prevPhase });
  return v;
}

export const reduceAll = (frames, view = emptyView()) => frames.reduce(reduce, view);
/**
 * Server bug (Games/core/Meeting.js generateTargets): the unvote loop returns at the first voter whose vote is
 * still valid, so votes cast later on a player who just died can stay, and the day can condemn a dead player.
 * The view keeps such a vote apart (meeting.staleVotes) and out of meeting.votes, so every seat whose vote
 * sits on a dead player sees itself as not voted and re-votes a living target at once.
 */
export function pruneDeadVotes(v) {
  for (const m of Object.values(v.meetings || {})) {
    // An instant meeting's vote already fired (the gun shot its target): it is not a stale vote to redo.
    if (!m?.votes || m.instant || m.used) continue;
    for (const [voter, t] of Object.entries(m.votes)) {
      const list = Array.isArray(t) ? t : [t];
      const deadHit = list.filter((x) => typeof x === "string" && x !== "*" && v.dead?.[x]);
      if (!deadHit.length) continue;
      (m.staleVotes ||= {})[voter] = t;
      const keep = list.filter((x) => !deadHit.includes(x));
      if (Array.isArray(t) && keep.length) m.votes[voter] = keep;
      else delete m.votes[voter];
    }
  }
}

/** False once this seat died, was lynched or shot (death), was kicked (playerLeave), or left the game. */
export const selfAlive = (v) => !v?.selfId || (!v.dead?.[v.selfId] && !v.players?.[v.selfId]?.left && !v.leftGame && !v.kicked);

export const isAlive = (v, id) => !!v.players[id] && !v.players[id].left && !v.dead[id];

function seedMeetings(v) {
  for (const m of Object.values(v.history[v.stateId]?.meetings || {}))
    if (m?.id && !v.meetings[m.id] && !(v.leftMeetings || []).includes(`${v.stateId}|${m.id}`)) v.meetings[m.id] = clone(m);
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

/** Every server event the reducer folds into the view. */
export const HANDLED_EVENTS = Object.freeze([
  "time", "timerInfo", "self", "players", "playerJoin", "playerLeave", "left", "gameLeft", "kicked", "teammates",
  "state", "history", "reveal", "roleReveal", "meeting", "leftMeeting", "members", "message", "quote",
  "speakCooldown", "vote", "unvote", "death", "exorcised", "revival", "obituaries", "winners", "finished",
  "youAreBeingVoteKicked", "start", "isStarted", "isSpectator",
  "botConfig", // local only: the harness sets per-seat strategy (copRule); no server event has this name
]);

/** Server events seen on the dev stream that carry nothing a seat decides on, each with the reason. */
export const IGNORED_EVENTS = Object.freeze({
  connected: "socket handshake; the dev stream is already connected when we see it",
  authSuccess: "socket auth ack; dev API seats are authenticated by the harness token",
  loaded: "client page-load signal; state/meeting frames follow and carry the content",
  options: "lobby options (private/anonymous/etc.); no effect on legal actions, meetings carry those",
  setup: "setup card (role list); FJ roles come from the harness setup and roleReveal",
  stateEvents: "names of client UI state events (sound/animation hooks)",
  emojis: "custom emoji table for the chat UI",
  spectatorCount: "spectator count for the UI",
  spectators: "spectator list for the UI; spectators cannot vote or speak in game meetings",
  dev: "client flag for dev-role users (dev API seats get it on join); no effect on play",
  kudos: "post-game kudos vote UI state; bots do not give kudos",
  clearTimer: "timer cleared at a phase change; the next state frame resets the view timer",
  audio: "sound cue (veg, jinx, explosion)",
  deathSounds: "death sound URLs for the client to play; the death itself arrives as death/obituaries",
  gunshot: "sound cue for a gun; the result arrives as death/message frames",
  condemn: "sound cue for a condemn; the result arrives as death/obituaries",
  "readyCheck init": "lobby ready check UI; dev seats are auto-verified (game GAME04 reached success with no bot action)",
  "readyCheck update": "lobby ready check progress UI",
  "readyCheck cancel": "lobby ready check UI",
  "readyCheck success": "lobby ready check passed; the game start frames follow",
  typing: "typing indicator for the chat UI",
  firstGame: "new-user hint for the client UI",
  lastWill: "this seat's own last will text echoed back; bots do not write wills",
  rehosted: "lobby rehost link after the game; the harness opens its own games",
  banned: "account-level ban notice; the dev API refuses sends and the harness sees send errors",
  error: "server error toast; failed sends already surface as HTTP errors from the dev API",
  alert: "UI alert; game-relevant alerts arrive as server messages",
});

/** "handled" | "ignored" | "unknown", plus the reason for ignored events. */
export function classifyEvent(name) {
  const n = String(name ?? "");
  if (HANDLED_EVENTS.includes(n)) return { kind: "handled" };
  if (Object.prototype.hasOwnProperty.call(IGNORED_EVENTS, n)) return { kind: "ignored", reason: IGNORED_EVENTS[n] };
  return { kind: "unknown" };
}
