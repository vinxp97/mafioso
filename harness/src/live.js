// One process, N Dev API accounts, one private Testing game.
// Dry-run (MAFIOSO_LIVE !== "1") never connects and never sends.
// Game hosts are allowlisted. Prod is rejected. Secrets are not logged.
import { fileURLToPath } from "node:url";
import { emptyView, reduce as engineReduce, validateAction, isPublicSpeak, proposeSeatActions, rulesSeatActions, speechStamp, humanizeSpeak, selfAlive, agreedPlan, isAlive, createSeededRng, ALIGNMENT, factionKillMeeting, factionLeader, draftPlan, claimedRoleIn, roleClaimLine, publicLeak, machineLeak, chatShorten, cannedReaction, addressedBy, publicSpeechMeeting, isPublicSpeechMeeting, sanitizeChat, varyOpener, dayFraction, rulesBeliefBoard, beliefAlign, allies, memoryOf, scumFaction, agreedPlan as seenPlan, busNote, townDayPick, townReads, townCounterLine, TOWN_READS, mafiaModeOf, scumVoteWait } from "mafioso-engine";
import { assertAllowedBase, DevApiClient, liveCredentials } from "./client.js";
import { parseStreamFrame } from "./stream.js";
import { createLmStudioComplete } from "./lmstudio.js";
import { createExperientialComplete } from "./experiential.js";
import { createOpenCodeGoComplete } from "./opencodeGo.js";
import { createArenaScorer } from "./arena.js";
import { realClock } from "./clock.js";
import { ensurePromptStore, finishGame, outcomeForView, replayDigest, savePromptStore, selectPrompts } from "./prompts.js";

export const TOKEN_REFRESH_MS = 55 * 60 * 1000;
export const DEFAULT_DEV_BASE = "https://dev.ultimafia.gg";

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

export function redact(text, secrets) {
  let s = String(text ?? "");
  const list = [...(secrets || [])].filter((x) => typeof x === "string" && x.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of list) s = s.split(secret).join("[redacted]");
  return s;
}

export function tokenExpired(issuedAt, now = Date.now(), ttl = TOKEN_REFRESH_MS) {
  return now - issuedAt >= ttl;
}

export async function maybeRefreshToken({ issuedAt, now = Date.now(), refresh, ttl = TOKEN_REFRESH_MS }) {
  if (!tokenExpired(issuedAt, now, ttl)) return issuedAt;
  await refresh();
  return now;
}

/** Exponential backoff with jitter, capped. attempt is 0-based. */
export function backoffMs(attempt, { base = 500, cap = 30_000, rng = Math.random } = {}) {
  const exp = Math.min(cap, base * 2 ** Math.min(Math.max(0, attempt), 8));
  return Math.round(exp * (0.5 + rng() * 0.5));
}

export function liveConfigFromEnv(env = process.env) {
  const baseUrl = nonempty(env.DEV_API_BASE_URL) || DEFAULT_DEV_BASE;
  assertAllowedBase(baseUrl);
  const rawCount = nonempty(env.BOT_COUNT);
  let botCount = 9;
  if (rawCount) {
    const n = Number(rawCount);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("BOT_COUNT must be an integer 1..50");
    botCount = n;
  }
  const llm = (nonempty(env.MAFIOSO_LLM) || "lmstudio").toLowerCase();
  const epsilon = env.PROMPT_EPSILON == null || nonempty(env.PROMPT_EPSILON) === "" ? 0.2 : Number(env.PROMPT_EPSILON);
  const temperature = env.PROMPT_TEMPERATURE == null || nonempty(env.PROMPT_TEMPERATURE) === "" ? 0.5 : Number(env.PROMPT_TEMPERATURE);
  if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) throw new Error("PROMPT_EPSILON must be between 0 and 1");
  if (!Number.isFinite(temperature) || temperature < 0) throw new Error("PROMPT_TEMPERATURE must be >= 0");
  const arenaRaw = nonempty(env.MAFIOSO_ARENA_GAMES);
  let arenaGames = 0;
  if (arenaRaw) {
    const n = Number(arenaRaw);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error("MAFIOSO_ARENA_GAMES must be an integer 0..50");
    arenaGames = n;
  }
  const seedRaw = nonempty(env.MAFIOSO_ARENA_SEED);
  const arenaSeed = seedRaw ? Number(seedRaw) : 1;
  if (!Number.isInteger(arenaSeed)) throw new Error("MAFIOSO_ARENA_SEED must be an integer");
  const marginRaw = nonempty(env.MAFIOSO_ARENA_MARGIN);
  const arenaMargin = marginRaw ? Number(marginRaw) : 0;
  if (!Number.isFinite(arenaMargin) || arenaMargin < 0) throw new Error("MAFIOSO_ARENA_MARGIN must be >= 0");
  return {
    live: env.MAFIOSO_LIVE === "1",
    baseUrl: new URL(baseUrl).origin,
    botCount,
    llm,
    gameId: nonempty(env.GAME_ID),
    setupId: nonempty(env.DEV_SETUP_ID),
    promptDir: nonempty(env.MAFIOSO_PROMPT_DIR) || fileURLToPath(new URL("../data/prompts/runtime", import.meta.url)),
    evolve: env.MAFIOSO_EVOLVE !== "0",
    transport: (nonempty(env.MAFIOSO_TRANSPORT) || "stream").toLowerCase(),
    epsilon,
    temperature,
    arenaGames,
    arenaSeed,
    arenaMargin,
    lobbyName: nonempty(env.LOBBY_NAME) || "mafioso-bots",
  };
}

export function streamUrl(baseUrl, pathname = "/api/dev/stream") {
  const origin = assertAllowedBase(baseUrl);
  if (!pathname.startsWith("/api/dev/")) throw new Error("DEV_STREAM_PATH must be under /api/dev/");
  return origin + pathname;
}

/** MAFIOSO_LLM=lmstudio|experiential|opencode. fetch is only for the model, not the game API. */
export function createBackendComplete(env = process.env, { fetch } = {}) {
  const which = (nonempty(env.MAFIOSO_LLM) || "lmstudio").toLowerCase();
  const opts = { env, ...(fetch ? { fetch } : {}) };
  if (which === "lmstudio" || which === "lm-studio") return createLmStudioComplete(opts);
  if (which === "experiential" || which === "explabs") return createExperientialComplete(opts);
  if (which === "opencode" || which === "opencode-go") return createOpenCodeGoComplete(opts);
  throw new Error(`Unknown MAFIOSO_LLM: ${which}. Use lmstudio, experiential, or opencode.`);
}

export function withCfAccess(fetchImpl, { clientId = "", clientSecret = "" } = {}) {
  if (!clientId && !clientSecret) return fetchImpl;
  return async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (clientId) headers["cf-access-client-id"] = clientId;
    if (clientSecret) headers["cf-access-client-secret"] = clientSecret;
    return fetchImpl(url, { ...init, headers });
  };
}

export function normalizeGameId(data) {
  if (typeof data === "string" && data.trim()) return data.trim();
  const id = data?.gameId || data?.id;
  if (id != null && String(id).trim()) return String(id).trim();
  throw new Error("hostGame: response had no game id");
}

export function normalizeAccounts(data) {
  const list = Array.isArray(data) ? data : data?.accounts || data?.ids || [];
  if (!Array.isArray(list)) throw new Error("createAccounts: response was not a list");
  return list.map((item) => {
    if (typeof item === "string" && item.trim()) return { accountId: item.trim() };
    const accountId = item?.accountId || item?.id;
    if (accountId == null || !String(accountId).trim()) throw new Error("createAccounts: missing account id");
    return { accountId: String(accountId).trim() };
  });
}

/** Drop the developer seat after bots are seated. 400/404/409 means already unseated. */
export async function leaveHostIfSeated(client, gameId) {
  try {
    await client.leaveGame(gameId);
  } catch (err) {
    const message = String(err?.message || "");
    if (!/-> (400|404|409)/.test(message)) throw err;
  }
}

export async function openTestingGame(client, { gameId = "", setupId = "", botCount, lobbyName = "mafioso-bots" }) {
  let id = gameId;
  let hostedHere = false;
  if (!id) {
    if (!setupId) throw new Error("DEV_SETUP_ID is required to host (or set GAME_ID to join)");
    const hosted = await client.hostGame({ setup: setupId, lobbyName, lobby: "Testing", private: true });
    id = normalizeGameId(hosted);
    hostedHere = true;
  }
  // Seat bots before the host leaves. leaveGame first empties the lobby and POST /dev/accounts returns 400.
  const created = await client.createAccounts({ gameId: id, count: botCount });
  const accounts = normalizeAccounts(created);
  if (accounts.length !== botCount) throw new Error(`createAccounts returned ${accounts.length}, expected ${botCount}`);
  if (hostedHere) await leaveHostIfSeated(client, id);
  return { gameId: id, accounts };
}

export function zipAccounts(accounts, prompts) {
  if (accounts.length !== prompts.length) throw new Error(`account count ${accounts.length} != prompt count ${prompts.length}`);
  return accounts.map((a, i) => ({ accountId: a.accountId, promptId: prompts[i].id, promptText: prompts[i].text }));
}

/**
 * `clock` ({ now, setTimer }) drives every delay and timestamp the table makes (default: wall clock);
 * `rng` drives every jitter (default: Math.random). Tests pass a virtual clock and a seeded rng.
 */
// mafia: "adaptive" (default for live and self-play) or "script" (the old fixed fake-Cop + bloc plan).
export function createBotTable(accounts, { clock = realClock, rng = Math.random, copRule = "vinman", mafia = "adaptive" } = {}) {
  return {
    views: {}, seen: new Set(), proposed: [], lastSeq: {}, speechStamp: {},
    byId: new Map(accounts.map((a) => [a.accountId, a])),
    clock, rng, config: { copRule, mafia },
  };
}
/** A fresh seat view carrying the table's strategy config (engine "botConfig" frame). */
const seatView = (table) => (table?.config ? engineReduce(emptyView(), { event: "botConfig", data: table.config }) : emptyView());
const nowOf = (table) => (table?.clock || realClock).now();
const rngOf = (table) => table?.rng || Math.random;
const waitOn = (table, ms) => new Promise((r) => (table?.clock || realClock).setTimer(r, ms));

/**
 * Per-seat async queues. Entries for one accountId run strictly in order; different seats run
 * concurrently. A failing entry is reported and does not stop that seat's queue.
 */
export function createSeatQueues(handler, { onError, isStopped } = {}) {
  const stopped = (id, entry) => typeof isStopped === "function" && isStopped(id, entry);
  const tails = new Map();
  return {
    push(entry) {
      const id = entry?.accountId ?? "_";
      const next = (tails.get(id) || Promise.resolve())
        .then(() => (stopped(id, entry) ? undefined : handler(entry)))
        .catch((err) => { if (onError) onError(err, id); });
      tails.set(id, next);
      return next;
    },
    drain() { return Promise.all([...tails.values()]); },
    get size() { return tails.size; },
  };
}

export async function seedSelfIds(client, table, ids, { sleep = defaultSleep, tries = 20, log = () => {} } = {}) {
  let missing = ids;
  for (let i = 0; i < tries && missing.length; i++) {
    let list = [];
    try { list = await client.api("GET", "/dev/accounts"); } catch (e) { log(`seed-self error ${e?.message || e}`); break; }
    const rows = Array.isArray(list) ? list : Array.isArray(list?.accounts) ? list.accounts : null;
    if (!rows) break; // endpoint missing (e.g. a mock): let the stream's own "self" frame set it
    const byId = new Map(rows.map((a) => [a.id || a.accountId, a]));
    for (const id of missing) {
      const playerId = byId.get(id)?.playerId;
      if (playerId) table.views[id] = engineReduce(table.views[id] ?? seatView(table), { event: "self", data: String(playerId) });
    }
    // Our own seats' display names, so speech can say "Bob" even if the players frame was missed.
    const named = ids.map((id) => byId.get(id)).filter((a) => a?.playerId && a?.name);
    for (const id of ids) {
      const v = (table.views[id] ||= seatView(table));
      for (const a of named) {
        const pid = String(a.playerId);
        if (!v.players[pid]?.name) v.players[pid] = { ...(v.players[pid] || {}), id: pid, name: String(a.name) };
      }
    }
    missing = ids.filter((id) => !table.views[id]?.selfId);
    if (missing.length) await sleep(1000);
  }
  log(`seeded selfId for ${ids.length - missing.length}/${ids.length} seats`);
  return missing;
}

/**
 * The game is over once any of our seats holds the winners result (it is game-wide), or every seat is
 * finished or gone. Waiting for "winners" on every seat hung runs pr9 and live-final: seats that were
 * vote-kicked or left never get it, so the harness idled after the game ended until stopped by hand.
 */
export const WINNERS_GRACE_MS = 10_000;
export function gameFinished(table, accountIds, { now = Date.now, graceMs = 0 } = {}) {
  if (!accountIds.length) return false;
  if (accountIds.every((id) => table.views[id]?.finished || table.views[id]?.leftGame)) return true;
  if (!accountIds.some((id) => table.views[id]?.winners)) return false;
  // Give the other seats a moment to receive their own winners frame (scoring needs it), then stop anyway.
  table.winnersAt ??= now();
  return now() - table.winnersAt >= graceMs;
}

export function resultsFromTable(table) {
  const rows = [];
  for (const [accountId, acc] of table.byId) {
    const view = table.views[accountId];
    const outcome = outcomeForView(view);
    if (!outcome) continue;
    rows.push({ accountId, promptId: acc.promptId, outcome, role: view?.role || "unknown" });
  }
  return rows;
}

/** Action and speech calls may wear this seat's evolved system text. Memory, the scheduler, and candidate generation keep their own system prompts. */
export function bindSeatComplete(complete, promptText) {
  if (typeof complete !== "function") return null;
  return (prompt) => complete({
    system: prompt?.purpose === "memory" || prompt?.purpose === "scheduler" || prompt?.purpose === "candidates" || prompt?.purpose === "speech"
      ? prompt.system
      : (promptText || prompt?.system),
    user: prompt?.user,
    purpose: prompt?.purpose,
    ...(prompt?.maxTokens != null ? { maxTokens: prompt.maxTokens } : {}),
    ...(prompt?.json === false ? { json: false } : {}),
    ...(prompt?.reasoningEffort ? { reasoningEffort: prompt.reasoningEffort } : {}),
  });
}

/**
 * Reduce one envelope and decide for this account only.
 * Public chat waits on this seat's scheduler. Votes and night actions do not.
 * Sends only when dryRun is false. send() is expected to validate again.
 */
const QUIET_EVENTS = new Set(["time", "clearTimer", "timerInfo"]);
const LLM_TIMEOUT_MS = 45_000;
const TICK_DECIDE_MS = 5_000;
function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`model call timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
}

/** Our own send log, so the 8s cooldown and 3-per-minute cap hold before the server echoes our line back. */
export const CHAT_LIMITS = { cooldownMs: 3500, perMinute: 6, fillerGapMs: 20000, fillerChance: 0.4 };

function localSpeechOk(table, id, clock) {
  const t = clock ?? nowOf(table);
  const mine = (table.spokeAt?.[id] || []).filter((x) => t - x < 60_000);
  if (mine.length >= CHAT_LIMITS.perMinute) return false;
  return !mine.length || t - Math.max(...mine) >= CHAT_LIMITS.cooldownMs;
}

/** Send (or propose) validated actions for one seat; dedups per state, allows a changed vote. */
export const VOTE_GAP_MS = 3000;
export const VOTE_BACKOFF_MS = 6000;

// ---- Day village vote: discuss first, then a staggered BeliefBoard vote. ----
// Day vote stagger is COPY_VOTE below (2-15s for every seat, PR10). No scum extra delay: a fixed one would be a tell.
export const DAY_VOTE = { fraction: 0.6, remainingMs: 60000, otherLines: 8, sheriffWindowMs: 120000 };

export function isDayVillageVote(view, meetingId) {
  const m = view?.meetings?.[meetingId];
  return view?.phase?.phase === "Day" && !!m && m.voting && (m.name === "Village" || (m.speech && !m.faction && !/shoot|gun|kick/i.test(`${m.name} ${m.actionName || ""}`)));
}

// Real discussion only: one- and two-word filler ("ya", "idk") does not count.
function publicLinesThisDay(view, meetingId) {
  return (view.messages || []).filter((x) => x.meetingId === meetingId && x.senderId && x.senderId !== "server"
    && String(x.content || "").trim().split(/\s+/).length >= 3);
}

/** The Sheriff (known to the harness) has outed or passed, is dead, or his window has run out. */
export function sheriffWindowDone(table, view, meetingId, now) {
  const sheriff = Object.values(table.roster || {}).find((r) => /sheriff/i.test(String(r.role || "")));
  if (!sheriff) return true;
  if (view.dead?.[sheriff.id]) return true;
  if (publicLinesThisDay(view, meetingId).some((x) => x.senderId === sheriff.id)) return true;
  const start = Number(view.phaseStartedAt);
  return Number.isFinite(start) && now - start >= DAY_VOTE.sheriffWindowMs;
}

export function dayVoteReady(table, view, meetingId, now) {
  const why = dayVoteReason(table, view, meetingId, now);
  if (why && table.onDayGate) table.onDayGate(view.selfId, why, now);
  return !!why;
}

function dayVoteReason(table, view, meetingId, now) {
  const frac = dayFraction(view, { now });
  if (frac != null && frac >= DAY_VOTE.fraction) return `fraction ${frac.toFixed(2)}`;
  const tm = view.timer?.stateId === view.stateId ? view.timer : null;
  if (tm?.last != null && tm.first != null && tm.last < tm.first && tm.last <= DAY_VOTE.remainingMs) return `remaining ${tm.last}`;
  const others = publicLinesThisDay(view, meetingId).filter((x) => x.senderId !== view.selfId).length;
  if (others >= DAY_VOTE.otherLines && sheriffWindowDone(table, view, meetingId, now)) return `discussion ${others}`;
  return null;
}

export const CONSOLIDATE = { minVotes: 2, townBelief: 0.8, suspectVoterShare: 0.5 };

/** This seat's mafia lean on a player: +suspect, +BeliefBoard Mafia, -cleared/-Village read. */
function notesLean(view, mem, board, id, reads = null) {
  const b = board[id];
  const al = b ? beliefAlign(b.role) : null;
  let s = 0;
  if (mem.suspects?.has?.(id)) s += 2;
  if (al === "Mafia" || al === "Cult") s += 3 * (b.probability || 0.5);
  if (mem.cleared?.has?.(id)) s -= 4;
  if (al === "Village") s -= 3 * (b.probability || 0.5);
  return s + (reads?.[id] || 0) / 2;
}

/** A public, uncontested Village-role claim (a counterclaimed role is already a suspect). */
function claimedTown(view, mem, id) {
  const c = view?.claims?.[id];
  return !!c?.role && c.kind !== "retract" && ALIGNMENT[c.role] === "Village" && !mem.suspects?.has?.(id);
}

/**
 * The wagon to join, or null. Game 1fo007iEq: following any 2+ wagon let a town seat hammer a mafia
 * wagon on town 4-3. Now a wagon is skipped when its target is a claimed or cleared town player, or
 * when most of its voters are players this seat suspects. Among the rest, the wagon this seat's own
 * notes agree with wins; a tie with no notes preference is not followed.
 */
export function townFollow(view, meeting) {
  const wagons = {};
  for (const [voter, t] of Object.entries(meeting?.votes || {})) {
    if (voter === view.selfId) continue;
    const sel = Array.isArray(t) ? t[0] : t;
    if (sel && sel !== "*") (wagons[sel] ||= []).push(voter);
  }
  const mem = memoryOf(view);
  const board = rulesBeliefBoard(view).entries;
  const reads = townReads(view).score;
  const ok = Object.entries(wagons).filter(([lead, voters]) => {
    if (voters.length < CONSOLIDATE.minVotes) return false;
    if (lead === view.selfId || view.dead?.[lead] || !(meeting.targets || []).includes(lead)) return false;
    if (mem.cleared?.has?.(lead) || claimedTown(view, mem, lead)) return false;
    const b = board[lead];
    if (b && beliefAlign(b.role) === "Village" && (b.probability || 0) >= CONSOLIDATE.townBelief) return false;
    const sus = voters.filter((x) => notesLean(view, mem, board, x, reads) > 0).length;
    return sus / voters.length <= CONSOLIDATE.suspectVoterShare;
  }).map(([lead, voters]) => ({ lead, votes: voters.length, lean: notesLean(view, mem, board, lead, reads) }));
  if (!ok.length) return null;
  // Notes first (agreeing wagon beats a bigger one), then size.
  ok.sort((x, y) => (y.lean > 0) - (x.lean > 0) || y.votes - x.votes || y.lean - x.lean);
  const [top, next] = ok;
  if (next && (top.lean > 0) === (next.lean > 0) && top.votes === next.votes && top.lean === next.lean) return null;
  // A wagon this seat's notes lean against is never joined just for its size.
  if (top.lean < 0) return null;
  return top.lead;
}

/** Town seats: weighted pick from the top three suspects on this seat's BeliefBoard. */
export function beliefDayPick(view, meeting, rng = Math.random) {
  const board = rulesBeliefBoard(view).entries;
  const mem = memoryOf(view);
  const mates = allies(view);
  const reads = townReads(view).score;
  const pool = (meeting.targets || []).filter((t) => t !== "*" && t !== view.selfId && !view.dead?.[t] && !mates.has(t) && view.players?.[t]);
  const score = (id) => {
    const b = board[id];
    const al = b ? beliefAlign(b.role) : null;
    let sc = 0;
    if (al === "Mafia" || al === "Cult") sc += 10 * (b.probability || 0.5);
    else if (al === "Village") sc -= 6 * (b.probability || 0.5);
    if (mem.suspects?.has?.(id)) sc += 2;
    if (mem.cleared?.has?.(id)) sc -= 4;
    sc += reads[id] || 0;
    return sc + rng() * 0.5;
  };
  const ranked = pool.map((id) => [id, score(id)]).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (!ranked.length) return null;
  const r = rng();
  return ranked[r < 0.85 ? 0 : Math.min(1, ranked.length - 1)];
}

/**
 * Adaptive mafia: don't lead the vote. Each scum seat waits for 0-2 non-teammate votes (varies by seat and
 * day, scumVoteWait), but never past late day or the Vote Kick window (no veg).
 */
function scumVoteNow(view, meetingId, now) {
  const m = view.meetings?.[meetingId];
  const team = new Set([view.selfId, ...allies(view)]);
  const others = Object.entries(m?.votes || {}).filter(([v, t]) => !team.has(v) && t != null && !(Array.isArray(t) && !t.length)).length;
  if (others >= scumVoteWait(view)) return true;
  const frac = dayFraction(view, { now });
  if (frac != null && frac >= 0.85) return true;
  return Object.values(view.meetings || {}).some((x) => /vote\s*kick/i.test(String(x?.name || "")));
}

/** Rewrite a seat's day village vote: gated, BeliefBoard spread for town, PLAN for scum. */
function shapeDayVotes(table, id, view, actions, now, { source }) {
  const out = [];
  for (const a of actions) {
    if (a.event !== "vote" || !isDayVillageVote(view, a.data.meetingId)) { out.push(a); continue; }
    if (!dayVoteReady(table, view, a.data.meetingId, now)) continue;
    const scum = !!scumFaction(view);
    if (scum && mafiaModeOf(view) === "adaptive" && !scumVoteNow(view, a.data.meetingId, now)) continue;
    if (scum && allies(view).has(String(a.data.selection))) {
      // Bus: say it casually in faction chat (once per day), never as syntax. Skipped if no faction chat.
      const fc = Object.values(view.meetings || {}).find((m) => m?.speech && m.amMember && /^(mafia|cult)$/i.test(String(m.name || "")));
      const k = `${id}|${view.stateId}`;
      if (fc && !(table.busNoted ||= {})[k]) {
        table.busNoted[k] = true;
        const note = { event: "speak", data: { meetingId: fc.id, content: busNote(view, a.data.selection, rngOf(table)) } };
        if (validateAction(view, note).ok && !machineLeak(view, note.data.content)) out.push(note);
      }
    }
    if (!scum) {
      // Evidence first (townReads): a strong read is the vote; contested Cop claims mean no lynch.
      const read = townDayPick(view, view.meetings[a.data.meetingId]);
      if (read && validateAction(view, { ...a, data: { ...a.data, selection: read.target } }).ok) {
        if (table.onTownRead) table.onTownRead(id, read);
        out.push({ ...a, data: { ...a.data, selection: read.target } });
        continue;
      }
      // Never vote a player the public evidence verifies as town (a verified claimer, a revealed Sheriff).
      const reads = townReads(view);
      const trusted = (t) => reads.verified.includes(t) || (reads.score[t] ?? 0) <= TOWN_READS.credible;
      const meeting = view.meetings[a.data.meetingId];
      // Town consolidates late: follow a 2+ vote leader unless this seat believes that player is town.
      // Own evidence beats the crowd: with a real read (votes with flipped mafia, pushing town flips...)
      // clearly above the wagon's target, vote the read rather than join the wagon.
      const own = (meeting?.targets || []).filter((t) => t !== "*" && t !== view.selfId && !view.dead?.[t] && !trusted(t))
        .map((t) => [t, reads.score[t] || 0]).sort((x, y) => y[1] - x[1])[0];
      let follow = townFollow(view, meeting);
      if (own && own[1] >= TOWN_READS.ownRead && (!follow || (reads.score[follow] || 0) <= own[1] - TOWN_READS.ownReadMargin)) follow = own[0];
      if (follow && !trusted(follow)) { out.push({ ...a, data: { ...a.data, selection: follow } }); continue; }
      if (source === "rules") {
        const pick = beliefDayPick(view, meeting, rngOf(table));
        if (pick && !trusted(pick)) { out.push({ ...a, data: { ...a.data, selection: pick } }); continue; }
      }
      if (trusted(String(a.data.selection))) {
        const alt = (meeting?.targets || []).includes("*") ? "*" : null;
        if (alt) out.push({ ...a, data: { ...a.data, selection: alt } });
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

export const COPY_VOTE = { minMs: 2000, maxMs: 15000, spacingMs: 2000 };
/** Random copy-vote wait in [2s, 15s], at least 2s from teammates already scheduled for this slot. Never above 15s. */
export function copyDelay(table, slot, rng = Math.random) {
  const taken = ((table.copySlots ||= {})[slot] ||= []);
  let wait = COPY_VOTE.minMs + Math.floor(rng() * (COPY_VOTE.maxMs - COPY_VOTE.minMs + 1));
  for (let i = 0; i < 20 && taken.some((t) => Math.abs(t - wait) < COPY_VOTE.spacingMs); i++) {
    wait = COPY_VOTE.minMs + Math.floor(rng() * (COPY_VOTE.maxMs - COPY_VOTE.minMs + 1));
  }
  if (taken.some((t) => Math.abs(t - wait) < COPY_VOTE.spacingMs)) {
    const start = Math.floor(rng() * (COPY_VOTE.maxMs - COPY_VOTE.minMs));
    for (let k = 0; k <= COPY_VOTE.maxMs - COPY_VOTE.minMs; k += 250) {
      const c = COPY_VOTE.minMs + ((start + k) % (COPY_VOTE.maxMs - COPY_VOTE.minMs + 1));
      if (!taken.some((t) => Math.abs(t - c) < COPY_VOTE.spacingMs)) { wait = c; break; }
    }
  }
  wait = Math.min(COPY_VOTE.maxMs, Math.max(COPY_VOTE.minMs, wait));
  taken.push(wait);
  return wait;
}

function voteDelay(table, id, view, action) {
  const now = nowOf(table);
  let wait = 0;
  const kill = factionKillMeeting(view);
  // Only the first voter decides; teammates copy after a human-like 2-15s pause, >=2s apart.
  if (kill && kill.id === action.data.meetingId && !table.copied?.[`${id}|${view.stateId}`]) {
    (table.copied ||= {})[`${id}|${view.stateId}`] = true;
    // Leader votes after the night's chatter; teammates copy 2-15s later.
    wait = factionLeader(view) === view.selfId
      ? (table.fastMode ? SCUM_CHAT.killAfterMs + Math.floor(rngOf(table)() * SCUM_CHAT.killJitterMs) : 0)
      : copyDelay(table, `kill|${view.stateId}`, rngOf(table));
  }
  // Day village vote: first vote of the day is staggered 2-15s.
  if (table.fastMode && isDayVillageVote(view, action.data.meetingId) && !table.dayStaggered?.[`${id}|${view.stateId}`]) {
    (table.dayStaggered ||= {})[`${id}|${view.stateId}`] = true;
    // Random 2-15s, jittered >=2s apart across seats, never above 15s.
    wait = Math.min(COPY_VOTE.maxMs, Math.max(wait, copyDelay(table, `day|${view.stateId}`, rngOf(table))));
  }
  const last = table.lastVoteAt?.[id];
  if (last != null) wait = Math.max(wait, last + VOTE_GAP_MS - now);
  const back = table.voteBackoff?.[id];
  if (back != null) wait = Math.max(wait, back - now);
  return Math.max(0, wait);
}

const deadCount = (view) => Object.values(view?.dead || {}).filter(Boolean).length;

/** May this seat's vote count for this meeting start over? (see emitActions) */
function voteMayRestart(table, id, view, meetingId, vk) {
  if (!table.voteCount?.[vk]) return false;
  if (deadCount(view) > (table.voteEpoch?.[vk] ?? Infinity)) return true;
  if ((table.pendingVotes?.[vk] || 0) > 0) return false;
  const mine = view.meetings?.[meetingId]?.votes?.[view.selfId];
  const standing = mine != null && !(Array.isArray(mine) && !mine.length);
  if (standing) return false;
  // A vote sent a moment ago may not be echoed yet.
  const last = table.lastVoteAt?.[id];
  return !(last != null && nowOf(table) - last < VOTE_GAP_MS);
}

/** A delayed faction kill vote picked before the team agreed a target: the agreed plan now wins. */
function staleKillVote(view, action) {
  if (action?.event !== "vote") return false;
  const kill = factionKillMeeting(view);
  if (!kill || action.data?.meetingId !== kill.id) return false;
  const target = agreedPlan(view)?.killTarget;
  return !!target && String(action.data?.selection) !== String(target);
}

function deferVote(table, id, action, wait, { source, entry, send, onError }) {
  const stateId = table.views[id]?.stateId;
  const pk = `${id}|${stateId}|${action.data?.meetingId}`;
  (table.pendingVotes ||= {})[pk] = (table.pendingVotes[pk] || 0) + 1;
  const settled = () => { table.pendingVotes[pk] = Math.max(0, (table.pendingVotes[pk] || 0) - 1); };
  // Reserve the slot now so later votes from this seat queue behind this one.
  (table.lastVoteAt ||= {})[id] = nowOf(table) + wait;
  const p = waitOn(table, wait).then(async () => {
    settled();
    const view = table.views[id];
    if (!view || view.stateId !== stateId || !selfAlive(view) || table.stopped?.[id]) return;
    if (!validateAction(view, action).ok) return;
    if (staleKillVote(view, action)) return;
    const back = table.voteBackoff?.[id];
    if (back != null && back > nowOf(table)) { deferVote(table, id, action, back - nowOf(table), { source, entry, send, onError }); return; }
    table.lastVoteAt[id] = nowOf(table);
    (table.lastVoteAction ||= {})[id] = action;
    const proposal = { accountId: id, afterSeq: entry?.seq, source: `${source}+delay`, phase: view.phase?.name || "", promptId: table.byId.get(id)?.promptId, ...action };
    table.proposed.push(proposal);
    table.onDeferred?.(proposal);
    if (send) {
      try { await send({ accountId: id, event: action.event, data: action.data, view }); }
      catch (err) { if (onError) onError(err, id); }
    }
  });
  (table.upgrades ||= new Set()).add(p);
  p.finally(() => table.upgrades.delete(p));
}

/** Server said "voting too quickly": hold this seat's votes and resend the last one later. */
export function noteVoteThrottle(table, id, { send, onError } = {}) {
  (table.voteBackoff ||= {})[id] = nowOf(table) + VOTE_BACKOFF_MS;
  const last = table.lastVoteAction?.[id];
  if (last && send) deferVote(table, id, last, VOTE_BACKOFF_MS, { source: "throttle", entry: null, send, onError });
}

/** Harness knows every seat's role: give each scum seat its own teammates (game knowledge in FJ). */
export function noteSeatRole(table, id, view) {
  if (!view?.selfId || !view.role) return [];
  (table.roster ||= {})[view.selfId] = { id: view.selfId, accountId: id, role: view.role, name: view.players?.[view.selfId]?.name || null };
  const out = [];
  const align = (r) => ALIGNMENT[r] || null;
  for (const me of Object.values(table.roster)) {
    const f = align(me.role);
    if (f !== "Mafia" && f !== "Cult") continue;
    const mates = Object.values(table.roster).filter((o) => o.id !== me.id && align(o.role) === f).map(({ id: pid, name, role }) => ({ id: pid, name, role }));
    const key = JSON.stringify(mates);
    if ((table.matesKey ||= {})[me.accountId] === key) continue;
    table.matesKey[me.accountId] = key;
    out.push({ accountId: me.accountId, data: mates });
  }
  return out;
}

async function emitActions(table, id, actions, { source, entry, dryRun, send, onError, clock }) {
  const view = table.views[id];
  const stamp = speechStamp(view);
  const added = [];
  for (let action of actions || []) {
    // Public lines are cut to chat size (and ids turned into names) before validation.
    if (isPublicSpeak(view, action)) {
      action = humanizeSpeak(view, action);
      action = { ...action, data: { ...action.data, content: varyOpener(view, chatShorten(action.data.content), rngOf(table), action.data.meetingId) } };
    }
    const verdict = validateAction(view, action);
    if (!verdict.ok) {
      if (isPublicSpeak(view, action)) { const r = String(verdict.reason || "?").replace(/\(.*$/, "").trim(); (table.speechRejects ||= {})[r] = ((table.speechRejects || {})[r] || 0) + 1; }
      continue;
    }
    const pub = isPublicSpeak(view, action);
    // Machine coordination text never goes to ANY chat (validateAction also bans it; belt and braces).
    if (action.event === "speak" && machineLeak(view, action.data?.content)) continue;
    const key = pub
      ? `${id}|${stamp}|speak|${action.data.meetingId}|${action.data.content}`
      : action.event === "vote"
        ? `${id}|${view.stateId}|vote|${action.data.meetingId}|${JSON.stringify(action.data.selection)}`
        : `${id}|${view.stateId}|${action.event}|${action.data.meetingId}|${action.data.content ?? ""}`;
    if (pub && table.speechStamp[id] === stamp) continue;
    if (pub && !localSpeechOk(table, id, clock)) continue;
    if (table.seen.has(key)) continue;
    if (action.event === "vote") {
      const vk = `${id}|${view.stateId}|${action.data.meetingId}`;
      if ((table.lastVote ||= {})[vk] === JSON.stringify(action.data.selection)) continue;
      // One initial vote, then at most one model upgrade to a different valid target. No churn.
      // Exception: this seat has no vote standing and none on the way (the server cleared it when its
      // target died, or a deferred vote was dropped at send time), or someone died since this seat last
      // voted (new evidence). Then the count starts over, so a seat is never left without a vote.
      if (voteMayRestart(table, id, view, action.data.meetingId, vk)) table.voteCount[vk] = 0;
      const n = (table.voteCount ||= {})[vk] || 0;
      if (n >= 2 || (n === 1 && source === "rules")) continue;
      // Copy/teammate votes and the server's vote rate limit: send later, re-checked at send time.
      const wait = voteDelay(table, id, view, action);
      (table.voteEpoch ||= {})[vk] = deadCount(view);
      if (wait > 0) { table.voteCount[vk] = n + 1; table.lastVote[vk] = JSON.stringify(action.data.selection); deferVote(table, id, action, wait, { source, entry, send: dryRun ? null : send, onError }); continue; }
      table.voteCount[vk] = n + 1;
      table.lastVote[vk] = JSON.stringify(action.data.selection);
      (table.lastVoteAt ||= {})[id] = nowOf(table);
    }
    table.seen.add(key);
    if (pub) {
      action = humanizeSpeak(view, action);
      if (!String(action.data?.content || "").trim()) continue;
      if (publicLeak(view, action.data.content)) { table.leaksBlocked = (table.leaksBlocked || 0) + 1; continue; }
      // One role claim per seat per game: no duplicate "I'm Sheriff." lines.
      const claimed = claimedRoleIn(action.data.content);
      if (claimed && table.claimedRole?.[id]) continue;
      if (claimed) (table.claimedRole ||= {})[id] = claimed;
      table.speechStamp[id] = stamp;
      ((table.spokeAt ||= {})[id] ||= []).push(clock ?? nowOf(table));
    }
    const proposal = {
      accountId: id, afterSeq: entry?.seq, source, phase: view.phase?.name || "",
      promptId: table.byId.get(id)?.promptId, ...action,
    };
    table.proposed.push(proposal);
    added.push(proposal);
    if (!dryRun && send) {
      try { await send({ accountId: id, event: action.event, data: action.data, view }); }
      catch (err) { if (onError) onError(err, id); }
    }
  }
  return added;
}

/** Night actions first, then votes, then speech. Lower runs first. */
export function seatPriority(view) {
  if (view?.phase?.phase === "Night") return 0;
  // Being named, asked or voted: reply before generic votes or chatter.
  const pm = publicSpeechMeeting(view);
  if (pm && addressedBy(view, pm.id)) return 0.5;
  const openVote = Object.values(view?.meetings || {}).some((m) => m?.voting && m.canVote && m.amMember && (m.votes?.[view.selfId] == null));
  return openVote ? 1 : 2;
}

/**
 * Global model limiter: at most `concurrency` calls in flight, highest priority first.
 * A queued call whose isStale() turns true (phase changed, seat died) is dropped with Error("stale").
 */
export function createLlmLimiter(concurrency = Infinity) {
  const queue = []; let active = 0; let seq = 0;
  const stats = { started: 0, dropped: 0 };
  const pump = () => {
    while (active < concurrency && queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = queue.shift();
      if (job.isStale && job.isStale()) { stats.dropped++; job.reject(new Error("stale")); continue; }
      active++; stats.started++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  return {
    run(fn, { priority = 2, isStale } = {}) {
      return new Promise((resolve, reject) => { queue.push({ fn, priority, isStale, resolve, reject, seq: seq++ }); pump(); });
    },
    get pending() { return queue.length; },
    get active() { return active; },
    stats,
  };
}

/** Wrap a seat's model with the limiter; every call is tied to the state it was asked in. */
function limitedComplete(table, id, base, limiter, stateId, priority) {
  if (!limiter) return base;
  const isStale = () => table.views[id]?.stateId !== stateId || !selfAlive(table.views[id]) || !!table.stopped?.[id];
  return (input) => limiter.run(() => base(input), { priority, isStale });
}

/** Model pass for one seat on its latest view; results only land if the state has not moved on. */
function startUpgrade(table, id, ctx) {
  (table.pending ||= {});
  if (table.pending[id]) { (table.dirty ||= {})[id] = true; return; }
  table.pending[id] = true;
  const run = async () => {
    do {
      if (table.dirty) table.dirty[id] = false;
      const view = table.views[id];
      if (!view || !selfAlive(view) || view.finished) break;
      const stateId = view.stateId;
      const night = view.phase?.phase === "Night";
      const base = bindSeatComplete(ctx.complete, table.byId.get(id)?.promptText);
      const timed = (input) => withTimeout(base(input), LLM_TIMEOUT_MS);
      const model = limitedComplete(table, id, timed, ctx.limiter, stateId, seatPriority(view));
      // Town barely thinks at night: rules picks only, the model budget goes to day speech.
      if (night && !scumFaction(view)) break;
      // Cop / Journalist / Sheriff claims come from rules (report-driven), ahead of any model line. After
      // the claim, the same rule only adds new results (no second claim).
      if (!night) {
        const claim = roleClaimLine(view);
        const pm = publicSpeechMeeting(view);
        if (claim && pm) {
          const added = await emitActions(table, id, [{ event: "speak", data: { meetingId: pm.id, content: claim } }], { ...ctx, source: "claim-rule", clock: ctx.clockOf() });
          if (ctx.onAdded) ctx.onAdded(added);
          if (added.length) continue;
        }
        // Town counter-story from the public evidence (townCounterLine), at most once per seat per day.
        const ck = `${id}|${view.stateId}`;
        if (pm && !(table.counterSaid ||= new Set()).has(ck)) {
          const counter = townCounterLine(view);
          if (counter) {
            table.counterSaid.add(ck);
            const added = await emitActions(table, id, [{ event: "speak", data: { meetingId: pm.id, content: counter } }], { ...ctx, source: "counter-rule", clock: ctx.clockOf() });
            if (ctx.onAdded) ctx.onAdded(added);
            if (added.length) continue;
          }
        }
      }
      // Filler: a cheap canned reaction instead of queueing behind a busy GPU, never when addressed.
      if (!night && ctx.limiter?.pending >= 2) {
        const pm = publicSpeechMeeting(view);
        const t = ctx.clockOf();
        const last = Math.max(0, ...(table.spokeAt?.[id] || []));
        const lively = (view.messages || []).filter((m) => m.meetingId === pm?.id && m.senderId && m.senderId !== view.selfId && Number(m.t) >= t - 30000).length >= 2;
        if (pm && lively && !addressedBy(view, pm.id) && t - last >= CHAT_LIMITS.fillerGapMs && rngOf(table)() < CHAT_LIMITS.fillerChance) {
          const line = cannedReaction(view, rngOf(table));
          if (line) {
            const added = await emitActions(table, id, [{ event: "speak", data: { meetingId: pm.id, content: line } }], { ...ctx, source: "canned", clock: t });
            if (ctx.onAdded) ctx.onAdded(added);
            if (added.length) continue;
          }
        }
      }
      let plan;
      try {
        plan = await proposeSeatActions(view, {
          complete: model, rng: ctx.rng, now: ctx.clockOf(),
          // One call per decision at night; speech takes one generator call (engine-only scheduling).
          llmFallback: false, speechFirst: true, memory: false, maxRetries: 0, scheduleComplete: null,
        });
      } catch (err) {
        if (String(err?.message) !== "stale" && ctx.onError) ctx.onError(err, id);
        continue;
      }
      const now = table.views[id];
      if (!now || now.stateId !== stateId || !selfAlive(now)) { ctx.onStale?.(id); continue; }
      const sch = plan.schedule;
      if (ctx.onSchedule && sch && sch.meetingId && !night) {
        const key = `${sch.speak ? "speak" : "skip"}|${sch.path}|${sch.reason}`;
        if (table.lastSchedule?.[id] !== key) { (table.lastSchedule ||= {})[id] = key; ctx.onSchedule(id, sch); }
      }
      // Scum votes stay on the seen PLAN: the model may not move a faction kill, clean, or litigate.
      const keep = shapeDayVotes(table, id, now, plan.actions.filter((a) => !(a.event === "vote" && scumLocked(now, a))), ctx.clockOf(), { source: plan.source });
      const added = await emitActions(table, id, keep, { ...ctx, source: plan.source, clock: ctx.clockOf() });
      if (ctx.onAdded) ctx.onAdded(added);
    } while (table.dirty?.[id]);
  };
  const p = run().finally(() => { table.pending[id] = false; });
  (table.upgrades ||= new Set()).add(p);
  p.finally(() => table.upgrades.delete(p));
}

// Night 1 Cop and Journalist have nothing to reason about yet: seeded random legal target, no model call.
export function isNightOneInvestigator(view) {
  return view?.phase?.phase === "Night" && view.phase.day === 1 && /^(cop|journalist)$/i.test(String(view.role || ""));
}

function seedOf(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function nightOneRandomPicks(view, accountId) {
  const out = [];
  for (const m of Object.values(view.meetings || {})) {
    if (!m || m.voting === false || m.canVote === false || m.amMember === false) continue;
    const pool = (m.targets || []).filter((t) => t !== "*" && t !== view.selfId && isAlive(view, t));
    if (!pool.length) continue;
    const rng = createSeededRng(seedOf(`${accountId}|${view.selfId}|${view.stateId}|${m.id}`));
    out.push({ event: "vote", data: { meetingId: m.id, selection: pool[Math.floor(rng() * pool.length)] } });
  }
  return out;
}

// ---- Mafia night chatter: 1-2 short private lines per night in the faction chat, no model call. ----
export const SCUM_CHAT = { minDelayMs: 300, maxDelayMs: 1500, gapMs: 2000, killAfterMs: 4500, killJitterMs: 2000 };

function factionChat(view) {
  return Object.values(view?.meetings || {}).find((m) => m?.amMember && m.speech && (m.name === "Mafia" || m.name === "Cult")) || null;
}

export function scumChatterLines(view, rng = Math.random, count = null) {
  const plan = seenPlan(view) || (factionLeader(view) === view.selfId ? draftPlan(view) : null);
  const nm = (pid) => (pid && view.players?.[pid]?.name) || null;
  const kill = nm(plan?.killTarget), lynch = nm(plan?.lynchTarget), claim = String(plan?.claimRole || "villager").toLowerCase();
  const pool = [
    kill && `ok ${kill.toLowerCase()} it is`, kill && `ya go ${kill.toLowerCase()}`, "sounds good", "ok im in",
    lynch && `ill push ${lynch.toLowerCase()} tmrw`, lynch && `${lynch.toLowerCase()} is an easy wagon`,
    `if pressed i fakeclaim ${claim === "cop" ? "villager" : claim}`, "dont all vote the same guy first", "who do we think cop is",
  ].filter(Boolean);
  // Don't echo a teammate's line from tonight.
  const said = new Set((view.messages || []).filter((m) => m.phase === view.phase?.name).map((m) => String(m.content || "").toLowerCase()));
  for (let i = pool.length - 1; i >= 0; i--) if (said.has(pool[i])) pool.splice(i, 1);
  const out = [];
  while (out.length < (count ?? 2) && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out.slice(0, count ?? (1 + (rng() < 0.5 ? 1 : 0)));
}

function scheduleScumChatter(table, id, view, ctx) {
  if (view?.phase?.phase !== "Night" || !scumFaction(view)) return;
  const chat = factionChat(view);
  if (!chat) return;
  const key = `${id}|${view.stateId}`;
  if ((table.scumChat ||= {})[key]) return;
  // Night opens: talk first (leader's PLAN is already out), the kill votes follow after a short delay.
  table.scumChat[key] = true;
  const stateId = view.stateId;
  const team = [view.selfId, ...Object.keys(view.teammates || {})].filter(Boolean).sort();
  const rank = Math.max(0, team.indexOf(view.selfId));
  let at = SCUM_CHAT.minDelayMs + rank * Math.floor(SCUM_CHAT.gapMs / 2) + Math.floor(rngOf(table)() * (SCUM_CHAT.maxDelayMs - SCUM_CHAT.minDelayMs));
  for (const _slot of [0]) {
    const wait = at; at += SCUM_CHAT.gapMs + Math.floor(rngOf(table)() * 4000);
    const p = waitOn(table, wait).then(async () => {
      const v = table.views[id];
      if (!v || v.stateId !== stateId || !selfAlive(v) || !v.meetings?.[chat.id]) return;
      // Pick at send time, never a line a teammate already used tonight.
      const used = ((table.scumSaid ||= {})[`${chat.id}|${v.phase?.name}`] ||= new Set());
      const line = scumChatterLines(v, rngOf(table), 9).find((l) => !used.has(l));
      if (!line) return;
      used.add(line);
      const added = await emitActions(table, id, [{ event: "speak", data: { meetingId: chat.id, content: line } }], { ...ctx, source: "scum-chat", clock: nowOf(table) });
      if (ctx.onAdded) ctx.onAdded(added);
    });
    (table.upgrades ||= new Set()).add(p);
    p.finally(() => table.upgrades.delete(p));
  }
}

function scumLocked(view, action) {
  const m = view.meetings?.[action.data.meetingId];
  if (!m || view.phase?.phase !== "Night") return false;
  if (m.name === "Mafia" || m.name === "Cult") return !!agreedPlan(view);
  return /janitor|lawyer/i.test(String(view.role || ""));
}

export const SPEECH_LOG_MAX = 500;

/**
 * One log line for an incoming PUBLIC chat message (claim-tagger training data), or null.
 * Only meetings this seat knows are public (Village etc.); faction chat, whispers, server lines and
 * unknown meetings are never logged. Deduped across our seats. Sender name kept (anonymized later).
 */
export function publicChatLogLine(table, accountId, entry) {
  if (entry?.event !== "message" || !entry.data) return null;
  const d = entry.data;
  const view = table.views[accountId];
  const m = view?.meetings?.[d.meetingId];
  if (!d.senderId || d.senderId === "server" || !m || !isPublicSpeechMeeting(m)) return null;
  const text = String(d.content ?? "").trim();
  if (!text) return null;
  const key = `${d.meetingId}|${d.senderId}|${d.time ?? d.t ?? entry.t ?? ""}|${text}`;
  const seen = (table.chatLogged ||= new Set());
  if (seen.has(key)) return null;
  seen.add(key);
  const name = view.players?.[d.senderId]?.name || d.senderId;
  return `chat [${view.phase?.name || ""}] ${m.name} ${name}: ${sanitizeChat(text, SPEECH_LOG_MAX)}`;
}

export async function onGameEntry(table, entry, { complete, send, dryRun = true, rng, now, onError, onSchedule, fast = false, limiter = null, onAdded, onChat } = {}) {
  const id = entry?.accountId ?? "_";
  if (!table.byId.has(id)) return [];
  rng = rng ?? rngOf(table);
  if (entry.seq != null && table.lastSeq[id] != null && entry.seq <= table.lastSeq[id]) return [];
  if (entry.seq != null) table.lastSeq[id] = entry.seq;
  table.views[id] = engineReduce(table.views[id] ?? seatView(table), entry);
  if (onChat) { const line = publicChatLogLine(table, id, entry); if (line) onChat(line); }
  if (entry?.event === "roleReveal" || entry?.event === "players" || entry?.event === "self") {
    for (const inj of noteSeatRole(table, id, table.views[id])) {
      if (table.views[inj.accountId]) table.views[inj.accountId] = engineReduce(table.views[inj.accountId], { event: "teammates", data: inj.data });
    }
  }
  if (/voting too quickly/i.test(JSON.stringify(entry?.data ?? ""))) noteVoteThrottle(table, id, { send: dryRun ? null : send, onError });
  if (entry?.event === "meeting" && entry.data?.id && table.onMeeting) {
    const m = table.views[id]?.meetings?.[entry.data.id];
    const k = `${id}|${entry.data.id}`;
    if (m && !(table.meetLogged ||= new Set()).has(k)) { table.meetLogged.add(k); table.onMeeting(id, m); }
  }
  const view = table.views[id];
  const clock = entry?.t != null && Number.isFinite(Number(entry.t)) ? Number(entry.t) : now;
  // A dead, lynched, or kicked seat stops: no scheduler, no generator, no sends.
  if (view.selfId && !selfAlive(view)) {
    if (!table.stopped?.[id]) { (table.stopped ||= {})[id] = true; if (onSchedule) onSchedule(id, { speak: false, urgency: 0, threshold: 0, path: "dead", reason: "seat is dead; queue stopped", meetingId: "-" }); }
    return [];
  }
  // Ticks still wake a seat every few seconds so a silent day can open, without a model call per tick.
  if (QUIET_EVENTS.has(entry?.event)) {
    const last = table.lastTick?.[id];
    if (clock == null || (last != null && clock - last < TICK_DECIDE_MS)) return [];
    (table.lastTick ||= {})[id] = clock;
  }
  const ctx = { dryRun, send, onError, entry };
  if (fast && isNightOneInvestigator(view)) {
    return emitActions(table, id, nightOneRandomPicks(view, id), { ...ctx, source: "n1-random", clock });
  }
  if (fast) {
    table.fastMode = true;
    // Rules first, right now: every open night action and vote gets a legal pick before any model call.
    const rules = rulesSeatActions(view, { rng, now: clock });
    const instant = shapeDayVotes(table, id, view, rules.actions.filter((a) => a.event === "vote" || (a.event === "speak" && !isPublicSpeak(view, a))), clock ?? nowOf(table), { source: "rules" });
    const added = await emitActions(table, id, instant, { ...ctx, source: "rules", clock });
    scheduleScumChatter(table, id, view, { ...ctx, onAdded });
    if (complete) {
      startUpgrade(table, id, {
        ...ctx, complete, rng, limiter, onSchedule, onAdded,
        clockOf: () => (now != null ? now : nowOf(table)),
      });
    }
    return added;
  }
  const promptText = table.byId.get(id)?.promptText;
  const seatComplete = complete ? bindSeatComplete(complete, promptText) : null;
  const bound = seatComplete ? (input) => withTimeout(seatComplete(input), LLM_TIMEOUT_MS) : null;
  let plan;
  try {
    plan = bound
      ? await proposeSeatActions(view, { complete: bound, rng, now: clock, scheduleComplete: bound })
      : rulesSeatActions(view, { rng, now: clock });
  } catch (err) {
    if (onError) onError(err, id);
    plan = rulesSeatActions(view, { rng, now: clock });
  }
  const sch = plan.schedule;
  if (onSchedule && sch && sch.meetingId && view.phase?.phase !== "Night") {
    const key = `${sch.speak ? "speak" : "skip"}|${sch.path}|${sch.reason}`;
    if (table.lastSchedule?.[id] !== key) {
      (table.lastSchedule ||= {})[id] = key;
      onSchedule(id, sch);
    }
  }
  return emitActions(table, id, plan.actions, { ...ctx, source: plan.source, clock });
}

/** Wait for queued model upgrades (tests, end of game). */
export async function drainUpgrades(table) {
  if (!table.clock?.virtual) { while (table.upgrades?.size) await Promise.all([...table.upgrades]); return; }
  // Virtual clock: let ready work run, then fire the next due timer; repeat until nothing is left.
  for (;;) {
    await new Promise((r) => setImmediate(r));
    if (table.clock.pending) { table.clock.runNext(); continue; }
    if (!table.upgrades?.size) return;
    await Promise.race([Promise.all([...table.upgrades]), new Promise((r) => setImmediate(r))]);
  }
}

export async function driveAccounts(entries, opts) {
  const table = createBotTable(opts.accounts);
  for (const entry of entries) await onGameEntry(table, entry, opts);
  return { views: table.views, proposed: table.proposed, results: resultsFromTable(table) };
}

export async function* iterateSse(source) {
  let buf = "";
  const push = function* (chunk) {
    buf += String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = parseStreamFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (frame) yield frame;
    }
  };
  if (source != null && typeof source.getReader === "function") {
    const reader = source.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield* push(typeof value === "string" ? value : dec.decode(value, { stream: true }));
      }
    } finally { reader.releaseLock?.(); }
  } else if (source != null) {
    for await (const chunk of source) {
      yield* push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    }
  }
  if (buf.trim()) {
    const frame = parseStreamFrame(buf);
    if (frame) yield frame;
  }
}

/** Restart-resilience limits: how many failed reconnects, and how long, before giving up on the game. */
export const RESTART = { maxTries: 3, windowMs: 60_000 };

/**
 * Ask the server whether our game still exists. "alive" | "lost" | "unknown".
 * Lost means the server answered but no longer knows our seats (404 on their event buffers,
 * or GET /dev/accounts lists none of them / lists them in another game). Network errors are "unknown".
 */
export async function probeGame(client, { gameId, accountIds }) {
  let rows = null;
  try {
    const list = await client.api("GET", "/dev/accounts");
    rows = Array.isArray(list) ? list : Array.isArray(list?.accounts) ? list.accounts : null;
  } catch (e) {
    if (!/-> 40[34]\b/.test(String(e?.message || ""))) return "unknown";
  }
  if (rows) {
    const ours = rows.filter((a) => accountIds.includes(a.id || a.accountId));
    if (!ours.length) return "lost";
    if (gameId && ours.every((a) => a.gameId != null && a.gameId !== gameId)) return "lost";
    return "alive";
  }
  // No account list: fall back to one seat's event buffer.
  try { await client.events(accountIds[0], 0); return "alive"; } catch (e) {
    return /-> (404|410)\b/.test(String(e?.message || "")) ? "lost" : "unknown";
  }
}

/**
 * Reconnect until shouldStop or the stream handler asks to stop.
 * fetchStream throws or returns an async iterable / ReadableStream of SSE bytes.
 * With `restart` ({ checkGame, maxTries, windowMs, now }), a disconnect or an accounts_dropped frame
 * for our seats starts an outage: reconnect with backoff and resume through backfill (seq-deduped);
 * abort if the game is gone or the outage exceeds maxTries failures / windowMs.
 * Returns { status: "finished" } or { status: "aborted", reason: "server_restart", detail }.
 */
export async function runStreamLoop({ fetchStream, onFrame, shouldStop = () => false, sleep = defaultSleep, backoff = backoffMs, maxAttempts = Infinity, onError, ourIds, settle, backfill, onInfo, restart = null }) {
  const staleSeen = new Set();
  const lim = restart ? { ...RESTART, now: Date.now, ...restart } : null;
  let attempt = 0;
  let failures = 0; let outageStart = null; let inOutage = false;
  const finished = { status: "finished" };
  const abort = (detail) => {
    if (onInfo) onInfo(`restart: giving up (${detail}) after ${failures} failed reconnects`);
    return { status: "aborted", reason: "server_restart", detail };
  };
  const check = async () => (lim?.checkGame ? (await lim.checkGame().catch(() => "unknown")) : "unknown");
  while (!shouldStop()) {
    try {
      const body = await fetchStream();
      attempt = 0;
      if (lim && inOutage) {
        // Reconnected after a drop: a restarted server accepts the stream but may have forgotten the game.
        const st = await check();
        if (st === "lost") return abort("game no longer known after reconnect");
        if (onInfo) onInfo(`restart: reconnected (game ${st}); resuming from buffered events`);
        inOutage = false; // failures/outage clock reset only once the live stream delivers a frame
      }
      // The stream has no replay. Game qAl36MVss filled and started while the bots were being seated,
      // so self/roleReveal/state went out before we subscribed; every seat idled into Vote Kick.
      // The stream is already subscribed here, so pull each seat's buffered events first; the
      // per-seat seq guard drops the duplicates the stream then repeats.
      if (backfill) {
        for (const entry of (await backfill()) || []) {
          if (await onFrame({ type: "game", entry })) return finished;
        }
      }
      for await (const frame of iterateSse(body)) {
        if (frame.type === "accounts_dropped") {
          const raw = JSON.stringify(frame.entry ?? {});
          if (!ourIds || ourIds.some((a) => raw.includes(a))) {
            if (onError) onError(new Error(`accounts_dropped frame ${raw.slice(0, 300)}`));
            throw new Error("accounts_dropped");
          }
          // Records from older server boots (redis, TTL-expired). Not ours: note once, keep going.
          const ids = (frame.entry?.accounts || []).map((a) => `${a.id}@${a.gameId}`).join(",");
          if (!staleSeen.has(ids)) { staleSeen.add(ids); if (onInfo) onInfo(`stale accounts_dropped (not ours, ignored): ${ids.slice(0, 200)}`); }
          continue;
        }
        if (lim && failures && frame.type === "game") { failures = 0; outageStart = null; }
        const stop = await onFrame(frame);
        if (stop || shouldStop()) return finished;
      }
      if (settle) await settle();
      if (shouldStop()) return finished;
      if (lim) throw new Error("stream ended");
    } catch (e) {
      if (onError) onError(e);
      if (shouldStop()) throw e;
      if (!lim && attempt >= maxAttempts) throw e;
      if (lim) {
        failures++; inOutage = true; outageStart ??= lim.now();
        const st = await check();
        // accounts_dropped storms also happen while the game lives on (stale boots, brief blips):
        // only a lost game counts as a restart; otherwise reconnect and resume.
        if (st === "lost") return abort(`game lost (${String(e?.message || e).slice(0, 80)})`);
        if (failures > lim.maxTries) return abort(`${failures - 1} reconnects failed`);
        if (lim.now() - outageStart >= lim.windowMs) return abort(`outage over ${lim.windowMs}ms`);
      }
    }
    if (!lim && attempt >= maxAttempts) return finished;
    let wait = backoff(attempt);
    if (lim) wait = Math.max(0, Math.min(wait, lim.windowMs - (lim.now() - (outageStart ?? lim.now()))));
    await sleep(wait);
    attempt++;
  }
  return finished;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One poll of GET /dev/accounts/:id/events. since map is updated. */
export async function pollOnce(client, accounts, sinceById) {
  const entries = [];
  for (const a of accounts) {
    const since = sinceById.get(a.accountId) || 0;
    const page = await client.events(a.accountId, since);
    const list = Array.isArray(page) ? page : page?.events || [];
    for (const e of list) {
      const entry = { accountId: a.accountId, ...e };
      entries.push(entry);
      if (e.seq != null) sinceById.set(a.accountId, Math.max(sinceById.get(a.accountId) || 0, e.seq));
    }
  }
  return entries;
}

export async function runLiveCli({ env = process.env, fetch: fetchImpl, log = console.error, sleep, now = Date.now, rng = Math.random, clock = realClock, signals = null, exit = (c) => process.exit(c) } = {}) {
  const cfg = liveConfigFromEnv(env);
  const secrets = [env.DEV_API_CLIENT_SECRET, env.DEV_API_CLIENT_ID, env.LM_API_KEY, env.EXPLABS_API_KEY, env.OPENCODE_API_KEY, env.CF_ACCESS_CLIENT_ID, env.CF_ACCESS_CLIENT_SECRET, env.OPENCODE_SESSION];
  const say = (m) => log(redact(m, secrets));
  if (!cfg.live) {
    say("dry-run: MAFIOSO_LIVE is not 1, not connecting and not sending");
    return 0;
  }
  const creds = liveCredentials(env);
  const baseFetch = fetchImpl || globalThis.fetch;
  if (typeof baseFetch !== "function") throw new Error("fetch must be injected or available as global fetch");
  const gameFetch = withCfAccess(baseFetch, { clientId: env.CF_ACCESS_CLIENT_ID || "", clientSecret: env.CF_ACCESS_CLIENT_SECRET || "" });
  const client = new DevApiClient({ baseUrl: cfg.baseUrl, fetch: gameFetch });
  let issuedAt = now();
  await client.getToken(creds);
  say(`token ok; hosting on ${cfg.baseUrl} bots=${cfg.botCount} llm=${cfg.llm}`);
  const store0 = await ensurePromptStore(cfg.promptDir);
  const chosen = selectPrompts(store0, cfg.botCount, { epsilon: cfg.epsilon, temperature: cfg.temperature, rng });
  const complete = createBackendComplete(env, { fetch: baseFetch });
  const opened = await openTestingGame(client, { gameId: cfg.gameId, setupId: cfg.setupId, botCount: cfg.botCount, lobbyName: cfg.lobbyName });
  const accounts = zipAccounts(opened.accounts, chosen);
  say(`game ${opened.gameId} accounts=${accounts.map((a) => a.accountId).join(",")} prompts=${accounts.map((a) => a.promptId).join(",")}`);
  const table = createBotTable(accounts, { clock, rng });
  // A manual Ctrl+C / kill leaves one structured line, so the scorecard can tell "stopped by hand" from a hang.
  if (signals) {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      signals.once(sig, () => {
        for (const a of accounts) (table.stopped ||= {})[a.accountId] = true;
        say(`game_end status=stopped reason=${sig.toLowerCase()} game=${opened.gameId}`);
        exit(130);
      });
    }
  }
  // The server sends "self" once, on join, before our stream connects, and the event buffer is capped,
  // so seed each seat's playerId from GET /dev/accounts. Without selfId every seat decides nothing.
  await seedSelfIds(client, table, accounts.map((a) => a.accountId), { sleep, log: say });
  const refresh = async () => {
    issuedAt = await maybeRefreshToken({
      issuedAt, now: now(), ttl: TOKEN_REFRESH_MS,
      refresh: async () => { await client.getToken(creds); },
    });
  };
  // One serial queue per seat: a slow model call for one seat never holds up another.
  // Local backends serve one request at a time: queue them globally with night actions first.
  const concurrency = Number(env.MAFIOSO_LLM_CONCURRENCY) > 0 ? Number(env.MAFIOSO_LLM_CONCURRENCY) : (cfg.llm === "lmstudio" ? 1 : 4);
  const limiter = createLlmLimiter(concurrency);
  const logSends = (added) => { for (const p of added) say(`send ${p.accountId} [${p.phase}] ${p.event} ${p.data?.meetingId || ""} ${p.data?.selection || (p.data?.content ? JSON.stringify(String(p.data.content).slice(0, SPEECH_LOG_MAX)) : "")} source=${p.source} prompt=${p.promptId}`); };
  let winnersLogged = false;
  table.onDeferred = (p) => logSends([p]);
  table.onMeeting = (who, m) => say(`meeting ${who} [${table.views[who]?.phase?.name || ""}] ${m.id} name=${JSON.stringify(m.rawName || m.name)} role=${m.factionRole || "-"} vote=${!!m.voting} canVote=${m.canVote !== false} targets=${(m.targets || []).length}`);
  const seats = createSeatQueues(async (entry) => {
    // Winners only for our game: our seat, matching gameId when the envelope has one, after the game started.
    const wv = table.views[entry.accountId];
    if (entry.event === "winners" && !winnersLogged && table.byId.has(entry.accountId)
      && (entry.gameId == null || entry.gameId === opened.gameId) && wv?.phase && wv.phase.phase !== "Pregame") {
      winnersLogged = true; say(`winners game=${opened.gameId} ${JSON.stringify(entry.data).slice(0, 400)}`);
    }
    const added = await onGameEntry(table, entry, {
      onChat: (line) => say(line),
      complete, rng, dryRun: false, fast: true, limiter, onAdded: logSends,
      send: (p) => client.send(p),
      onError: (err, who) => say(`seat-error ${who} ${err?.stack || err?.message || err}`),
      onSchedule: (who, sch) => say(`sched ${who} ${sch.speak ? "speak" : "skip"} u=${sch.urgency}/${sch.threshold} path=${sch.path} reason=${sch.reason}`),
    });
    logSends(added);
  }, { isStopped: (id, entry) => !!table.stopped?.[id] && entry?.event !== "winners" && entry?.event !== "finished", onError: (err, who) => say(`seat-error ${who} ${err?.stack || err?.message || err}`) });
  say(`llm concurrency=${concurrency}`);
  const endOpts = { now, graceMs: WINNERS_GRACE_MS };
  const frameCounts = {}; let lastTrace = 0;
  const onFrame = async (frame) => {
    const ft = `${frame.type}${frame.entry?.event ? ":" + frame.entry.event : ""}`;
    frameCounts[ft] = (frameCounts[ft] || 0) + 1;
    if (clock.now() - lastTrace > 20000) { lastTrace = clock.now(); say(`frames ${JSON.stringify(frameCounts)}`); }
    if (frame.type !== "game" || !frame.entry) return false;
    const done = seats.push(frame.entry);
    if (frame.entry.event === "winners" || frame.entry.event === "finished") await done;
    return gameFinished(table, accounts.map((a) => a.accountId), endOpts);
  };
  let outcome = { status: "finished" };
  if (cfg.transport === "poll") {
    const since = new Map();
    let spins = 0;
    while (!gameFinished(table, accounts.map((a) => a.accountId), endOpts) && spins < 10_000) {
      await refresh();
      const entries = await pollOnce(client, accounts, since);
      if (!entries.length) break;
      for (const entry of entries) {
        if (await onFrame({ type: "game", entry })) break;
      }
      spins++;
    }
  } else if (cfg.transport !== "stream") {
    throw new Error(`Unknown MAFIOSO_TRANSPORT: ${cfg.transport}. Use stream or poll.`);
  } else {
    const pathname = nonempty(env.DEV_STREAM_PATH) || "/api/dev/stream";
    const url = streamUrl(cfg.baseUrl, pathname);
    const ourIds = accounts.map((a) => a.accountId);
    outcome = await runStreamLoop({
      restart: { checkGame: () => probeGame(client, { gameId: opened.gameId, accountIds: ourIds }), now },
      sleep, backoff: (n) => backoffMs(n, { rng }),
      shouldStop: () => gameFinished(table, accounts.map((a) => a.accountId), endOpts),
      fetchStream: async () => {
        await refresh();
        const res = await gameFetch(url, { headers: { accept: "text/event-stream", authorization: `Bearer ${client.token}` } });
        if (!res.ok) throw new Error(`GET /dev/stream -> ${res.status}`);
        if (!res.body) throw new Error("GET /dev/stream: empty body");
        return res.body;
      },
      onFrame,
      ourIds: accounts.map((a) => a.accountId),
      backfill: async () => {
        const since = new Map(accounts.map((a) => [a.accountId, table.lastSeq[a.accountId] || 0]));
        const got = await pollOnce(client, accounts, since).catch((e) => { say(`backfill-error ${e?.message || e}`); return []; });
        got.sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
        say(`backfill ${got.length} buffered events (${[...new Set(got.map((e) => e.event))].filter((e) => !/time/.test(e)).slice(0, 12).join(",")})`);
        return got;
      },
      onInfo: say,
      settle: async () => { await seats.drain(); await drainUpgrades(table); },
      onError: (err) => say(`stream-error ${err?.stack || err?.message || err}`),
    });
  }
  if (outcome?.status === "aborted") {
    // Stop every seat so no queued model call or delayed vote fires into a dead game.
    for (const a of accounts) (table.stopped ||= {})[a.accountId] = true;
    await seats.drain().catch(() => {});
    say(`game_end status=aborted reason=${outcome.reason} game=${opened.gameId}`);
    return 0;
  }
  await seats.drain();
  await drainUpgrades(table);
  const winView = accounts.map((a) => table.views[a.accountId]).find((v) => v?.winners);
  say(`game_end status=finished game=${opened.gameId}${winView ? ` winner=${(winView.winners.groups || []).join("/") || "?"}` : ""}`);
  const results = resultsFromTable(table);
  let store = store0;
  if (cfg.evolve && results.length) {
    const scorePrompt = cfg.arenaGames > 0
      ? createArenaScorer({
        seed: cfg.arenaSeed,
        games: cfg.arenaGames,
        mafiosoSeats: Math.min(3, cfg.botCount),
        complete,
        maxDays: 4,
      })
      : undefined;
    const done = await finishGame({
      store, results, complete, summary: replayDigest(table.views), now: now(),
      scorePrompt, margin: cfg.arenaMargin,
    });
    store = done.store;
    await savePromptStore(cfg.promptDir, store);
    say(`scored ${results.length} bots; new prompts=${done.children.map((c) => c.id).join(",") || "none"}; skipped=${done.skipped.map((s) => s.reason).join(",") || "none"}`);
  } else {
    say(`game ended; scored=${results.length}; evolve=${cfg.evolve ? "yes" : "no"}`);
  }
  return 0;
}
