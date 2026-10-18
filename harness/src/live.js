// One process, N Dev API accounts, one private Testing game.
// Dry-run (MAFIOSO_LIVE !== "1") never connects and never sends.
// Game hosts are allowlisted. Prod is rejected. Secrets are not logged.
import { fileURLToPath } from "node:url";
import { emptyView, reduce as engineReduce, validateAction, isPublicSpeak, proposeSeatActions, rulesSeatActions, speechStamp, humanizeSpeak, selfAlive, agreedPlan, isAlive, createSeededRng, ALIGNMENT, factionKillMeeting, factionLeader, draftPlan, claimedRoleIn, roleClaimLine, publicLeak, machineLeak, chatShorten, cannedReaction, addressedBy, publicSpeechMeeting, isPublicSpeechMeeting, sanitizeChat, varyOpener, dayFraction, rulesBeliefBoard, beliefAlign, allies, memoryOf, scumFaction, agreedPlan as seenPlan, busNote, alertResult, capSpeechWords, townDayPick, townReads, townCounterLine, TOWN_READS, townVote, meetingActions, groundedLine, mafiaModeOf, scumVoteHoldMs, adaptivePressureLine, adaptiveVote, askReplyLine, askReplyChoice, sheriffAskLine, NEVER_LYNCH_SHERIFF, adaptiveClaimLine, planClaimDropReason, wrongLynchCostly, dayOneLynchOwed, hammerVote, hammerAskLine, hammerNextMs, confirmedLead, TOWN_VOTE, sheriffGunOwed, finalSpeak, sheriffShotReady } from "mafioso-engine";
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
    // Town day vote arm for this process only (TOWN_ARMS); unset keeps the default "rules".
    town: townArmFromEnv(env.MAFIOSO_TOWN),
    // Vinman 10/18 (11:05): the Sheriff's hammer ask; MAFIOSO_HAMMER=off turns it off for this process.
    hammer: /^(0|off|false|no)$/i.test(nonempty(env.MAFIOSO_HAMMER) || "") ? "off" : "on",
  };
}

function townArmFromEnv(raw) {
  const arm = (nonempty(raw) || "rules").toLowerCase();
  if (!TOWN_ARMS.includes(arm)) throw new Error(`MAFIOSO_TOWN must be one of ${TOWN_ARMS.join("|")}`);
  return arm;
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
// reasoning: the model thinks before it answers (see reasoningModel); speech gets a larger token budget.
export function createBotTable(accounts, { clock = realClock, rng = Math.random, copRule = "vinman", sheriffRule = "vinman", lawyer = "loyal", mafia = "adaptive", town = "rules", chatAudit: auditMode = "enforce", townVoteDelayMs = null, reasoning = false, hammer = "on", hammerGate = null, pace = "on" } = {}) {
  return {
    views: {}, seen: new Set(), proposed: [], lastSeq: {}, speechStamp: {},
    byId: new Map(accounts.map((a) => [a.accountId, a])),
    clock, rng, config: { copRule, sheriffRule, lawyer, mafia, town, hammer, pace, ...(hammerGate ? { hammerGate } : {}), chatAudit: auditMode, ...(townVoteDelayMs ? { townVoteDelayMs } : {}), ...(reasoning ? { reasoning: true } : {}) },
  };
}

// Models that spend hidden tokens thinking even when asked not to (Muse ignores reasoning_effort "none").
const REASONING_MODEL_RE = /muse|glimmer|qwen3|deepseek-r|\br1\b|reason|think|gpt-oss|gpt-5|magistral/i;
/** MAFIOSO_REASONING=1/0 forces it; otherwise the configured model name of the chosen backend decides. */
export function reasoningModel(env = process.env) {
  const forced = nonempty(env.MAFIOSO_REASONING);
  if (forced) return /^(1|true|yes|on)$/i.test(forced);
  const which = (nonempty(env.MAFIOSO_LLM) || "lmstudio").toLowerCase();
  const model = which.startsWith("exp") ? env.EXPLABS_MODEL : which.startsWith("opencode") ? env.OPENCODE_MODEL : env.LM_STUDIO_MODEL;
  return REASONING_MODEL_RE.test(String(model || ""));
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
  return speechWaitMs(table, id, clock) === 0;
}

/** How long until this seat may speak again under our own chat limits (0 = now). */
function speechWaitMs(table, id, clock) {
  const t = clock ?? nowOf(table);
  const mine = (table.spokeAt?.[id] || []).filter((x) => t - x < 60_000).sort((a, b) => a - b);
  if (!mine.length) return 0;
  const cool = mine[mine.length - 1] + CHAT_LIMITS.cooldownMs - t;
  const minute = mine.length >= CHAT_LIMITS.perMinute ? mine[mine.length - CHAT_LIMITS.perMinute] + 60_000 - t : 0;
  return Math.max(0, cool, minute);
}

/**
 * Vinman 10/18 (11:05): reactive lines (counterclaims, answers to the Sheriff's ask or to a claim, counter-stories,
 * accused replies, canned reactions) wait a human beat after the line they answer: REACT.minMs..maxMs, seeded per
 * seat and line, never the same second. The hold is fixed when the line first becomes due, so ongoing chatter
 * cannot push it back forever.
 */
export const REACT = { minMs: 3000, maxMs: 8000 };
/** Does this claim line counter another living player's claim of the same role? */
export function counterclaimLine(view, line) {
  const role = claimedRoleIn(line);
  if (!role) return false;
  return (view?.messages || []).some((m) => m?.senderId && m.senderId !== view.selfId && m.senderId !== "server" && m.public !== false
    && isAlive(view, m.senderId) && claimedRoleIn(m.content) === role);
}
export function reactWaitMs(table, id, view, line, clock = nowOf(table), { urgent = false } = {}) {
  const pm = publicSpeechMeeting(view);
  if (!pm || !line) return 0;
  const k = `${id}|${view.stateId}|${line}`;
  const due = (table.reactDue ||= {});
  if (due[k] == null) {
    const last = (view.messages || []).filter((m) => m.meetingId === pm.id && m.senderId && m.senderId !== "server" && m.senderId !== view.selfId && Number.isFinite(Number(m.t))).slice(-1)[0];
    const hold = urgent ? REACT.minMs : REACT.minMs + (seedOf(`${id}|${last?.senderId}|${last?.t}|${line}`) % (REACT.maxMs - REACT.minMs + 1));
    due[k] = last ? Math.max(Number(clock), Number(last.t) + hold) : Number(clock);
  }
  return Math.max(0, due[k] - Number(clock));
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
  // A plain Villager claim costs nothing to fake: it does not protect a wagon.
  return !!c?.role && c.role !== "Villager" && c.kind !== "retract" && ALIGNMENT[c.role] === "Village" && !mem.suspects?.has?.(id);
}

/**
 * The wagon to join, or null. Game GAME05: following any 2+ wagon let a town seat hammer a mafia
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
export function beliefDayPick(view, meeting, rng = Math.random, skip = () => false) {
  const board = rulesBeliefBoard(view).entries;
  const mem = memoryOf(view);
  const mates = allies(view);
  const reads = townReads(view).score;
  const pool = (meeting.targets || []).filter((t) => t !== "*" && t !== view.selfId && !view.dead?.[t] && !mates.has(t) && view.players?.[t] && !skip(t));
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
 * Adaptive mafia vote timing: each scum seat holds its first village vote for a delay sampled from town's
 * measured distribution (scumVoteHoldMs, from its own vote gate), never past late day or the Vote Kick
 * window (no veg). The 2-15s stagger then applies to scum and town alike.
 */
function scumVoteNow(view, meetingId, now, sinceGateMs) {
  if (sinceGateMs >= scumVoteHoldMs(view)) return true;
  const frac = dayFraction(view, { now });
  if (frac != null && frac >= 0.85) return true;
  return Object.values(view.meetings || {}).some((x) => /vote\s*kick/i.test(String(x?.name || "")));
}

/** Town day-vote arms for self-play: "rules" (the live path below), "suspicion" (townVote), "random". */
export const TOWN_ARMS = Object.freeze(["rules", "suspicion", "random"]);

/** Random-town baseline: one uniform pick among the legal (allowed) options per seat per day, kept while legal. */
function randomLegalVote(table, key, view, meeting) {
  const e = meeting && meetingActions(view, meeting);
  if (!e || e.closed || !e.allowed.length) return null;
  const memo = (table.randomVote ||= {});
  if (!e.allowed.includes(memo[key])) memo[key] = e.allowed[Math.floor(rngOf(table)() * e.allowed.length)];
  return memo[key];
}

/** Rewrite a seat's day village vote: gated, BeliefBoard spread for town, PLAN for scum. */
function shapeDayVotes(table, id, view, actions, now, { source }) {
  const out = [];
  for (const a of actions) {
    if (a.event !== "vote" || !isDayVillageVote(view, a.data.meetingId)) { out.push(a); continue; }
    if (!dayVoteReady(table, view, a.data.meetingId, now)) continue;
    const gk = `${id}|${view.stateId}`;
    (table.gateAt ||= {})[gk] ??= now;
    // Vinman 10/18 (11:05): the Sheriff's hammer ask decides every seat's ballot (self-vote / his deciding vote).
    const hv = table.config?.hammer === "off" ? null : hammerVote(view, { now });
    if (hv?.hold) continue;
    if (hv?.target && validateAction(view, { ...a, data: { ...a.data, selection: hv.target } }).ok) { out.push({ ...a, data: { ...a.data, selection: hv.target } }); continue; }
    const scum = !!scumFaction(view);
    if (scum && mafiaModeOf(view) === "adaptive" && !scumVoteNow(view, a.data.meetingId, now, now - table.gateAt[gk])) continue;
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
    const arm = !scum && table.config?.town;
    if (arm === "random" || arm === "suspicion") {
      // Self-play arms (TOWN_ARMS): both pick from legalActions for this meeting.
      const tv = arm === "random" ? null : townVote(view, view.meetings[a.data.meetingId], { follow: true });
      const pick = arm === "random" ? randomLegalVote(table, gk, view, view.meetings[a.data.meetingId]) : tv?.target;
      if (tv && table.onTownVote) table.onTownVote(id, tv, townReads(view).score);
      if (pick != null) out.push({ ...a, data: { ...a.data, selection: pick } });
      continue;
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
      // Vinman 10/18 (11:05): with no read of its own worth the name, a villager follows confirmed town.
      const lead = confirmedLead(view, meeting, reads);
      if (lead && (!own || own[1] < TOWN_VOTE.deferBelow) && validateAction(view, { ...a, data: { ...a.data, selection: lead.target } }).ok && !trusted(lead.target)) follow = lead.target;
      if (own && own[1] >= TOWN_READS.ownRead && (!follow || (reads.score[follow] || 0) <= own[1] - TOWN_READS.ownReadMargin)) follow = own[0];
      // L3 (10/18): a costly wrong lynch (loses now, or parity with tonight's kill), or Day 1 with the Sheriff
      // alive: a wagon on an unread player is not followed; the reads decide (townVote's costly rule).
      if (follow && (reads.score[follow] || 0) <= 0 && (wrongLynchCostly(view) || dayOneLynchOwed(view))) {
        const tv = townVote(view, meeting, { follow: true });
        if (table.onTownVote && tv) table.onTownVote(id, tv, reads.score);
        follow = tv?.target ?? null;
        if (follow === "*") { out.push({ ...a, data: { ...a.data, selection: "*" } }); continue; }
      }
      if (follow && !trusted(follow)) { out.push({ ...a, data: { ...a.data, selection: follow } }); continue; }
      if (source === "rules") {
        const pick = beliefDayPick(view, meeting, rngOf(table), trusted);
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
  // A hard rule refused no-one for a town seat (Day 1 with the Sheriff alive, an autoloss, a day meteor):
  // vote the top suspicion instead of leaving the seat unvoted.
  for (const [i, a] of out.entries()) {
    if (a.event !== "vote" || a.data.selection !== "*" || scumFaction(view) || !isDayVillageVote(view, a.data.meetingId) || validateAction(view, a).ok) continue;
    const pick = townVote(view, view.meetings[a.data.meetingId])?.target;
    if (pick && pick !== "*") out[i] = { ...a, data: { ...a.data, selection: pick } };
  }
  // Vinman 10/18: no seat votes the revealed Sheriff (a hard rule): re-aim such a vote instead of dropping it.
  for (const [i, a] of out.entries()) {
    if (a.event !== "vote" || !isDayVillageVote(view, a.data.meetingId)) continue;
    const v = validateAction(view, a);
    if (v.ok || v.reason !== NEVER_LYNCH_SHERIFF) continue;
    const meeting = view.meetings[a.data.meetingId];
    const pick = scumFaction(view) ? adaptiveVote(view, meeting, seenPlan(view)) : townVote(view, meeting)?.target;
    if (pick && validateAction(view, { ...a, data: { ...a.data, selection: pick } }).ok) out[i] = { ...a, data: { ...a.data, selection: pick } };
  }
  // The seat's latest day pick per meeting: a delayed ballot sends this one if it changed (deferVote).
  for (const a of out) if (a.event === "vote" && isDayVillageVote(view, a.data.meetingId)) ((table.latestPick ||= {})[`${id}|${view.stateId}|${a.data.meetingId}`] = a.data.selection);
  // Vote timing: the first village vote this seat lets through today, measured from its own vote gate.
  for (const a of out) {
    if (a.event !== "vote" || !isDayVillageVote(view, a.data.meetingId)) continue;
    const gk = `${id}|${view.stateId}`;
    if ((table.firstShaped ||= {})[gk] != null) continue;
    table.firstShaped[gk] = now;
    table.onDayVoteShaped?.({ id, day: view.phase?.name || "", scum: !!scumFaction(view), sinceGateMs: now - (table.gateAt?.[gk] ?? now) });
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

/**
 * Adaptive scum: a delayed village vote picked before two teammates landed on the same target would make
 * an all-three bloc, short of the endgame. Re-picked at send time.
 */
function thirdScumVote(view, action) {
  if (action?.event !== "vote" || !scumFaction(view) || mafiaModeOf(view) !== "adaptive") return false;
  if (!isDayVillageVote(view, action.data?.meetingId)) return false;
  const mates = allies(view);
  const team = [view.selfId, ...mates].filter((id) => isAlive(view, id)).length;
  const town = Object.keys(view.players || {}).filter((id) => isAlive(view, id) && id !== view.selfId && !mates.has(id)).length;
  if (team >= town - 1) return false;
  const votes = view.meetings?.[action.data.meetingId]?.votes || {};
  return Object.entries(votes).filter(([v, t]) => mates.has(v) && String(t) === String(action.data.selection)).length >= 2;
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
    // Live L2-1018: ballots queued as "*" went out after the seat's pick had moved to a wagon. Send the
    // latest pick when it changed and is legal now; otherwise the queued ballot, checked as before.
    const latest = table.latestPick?.[pk];
    if (latest != null && JSON.stringify(latest) !== JSON.stringify(action.data.selection)) {
      const next = { ...action, data: { ...action.data, selection: latest } };
      if (validateAction(view, next).ok) {
        table.onBallotUpdate?.(id, action.data.selection, latest);
        action = next;
        (table.lastVote ||= {})[pk] = JSON.stringify(latest);
      }
    }
    if (!validateAction(view, action).ok) return;
    if (staleKillVote(view, action)) return;
    if (thirdScumVote(view, action)) {
      // Re-pick with today's votes in view (the cap now sees both teammates); never drop it (no veg).
      const alt = adaptiveVote(view, view.meetings[action.data.meetingId], agreedPlan(view));
      if (alt && String(alt) !== String(action.data.selection)) action = { ...action, data: { ...action.data, selection: String(alt) } };
      if (!validateAction(view, action).ok) return;
    }
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

async function emitActions(table, id, actions, { source, entry, dryRun, send, onError, clock, claim = false }) {
  const view = table.views[id];
  const stamp = speechStamp(view);
  const added = [];
  for (let action of actions || []) {
    // A scum fake claim in the first seconds of the day waits, then is re-checked against the newer view
    // (the Sheriff's opening "im sheriff" may still be on its way; a fake guilty on him is blocked then).
    const settle = isPublicSpeak(view, action) && claimedRoleIn(action.data.content) ? scumClaimSettleMs(view, clock ?? nowOf(table)) : 0;
    if (settle > 0) {
      const stateId = view.stateId, held = action, key = `${id}|${stateId}|${action.data.content}`;
      if ((table.settleHeld ||= new Set()).has(key)) continue;
      table.settleHeld.add(key);
      const p = waitOn(table, settle).then(async () => {
        table.settleHeld.delete(key);
        if (table.views[id]?.stateId !== stateId) return;
        const later = await emitActions(table, id, [held], { source, entry, dryRun, send, onError, clock: nowOf(table), claim });
        if (later.length && claim) ((table.claimSent ||= {})[id] ||= new Set()).add(held.data.content);
      });
      (table.upgrades ||= new Set()).add(p);
      p.finally(() => table.upgrades.delete(p));
      continue;
    }
    // Public lines are cut to chat size (and ids turned into names) before validation.
    if (isPublicSpeak(view, action)) {
      action = humanizeSpeak(view, action);
      action = { ...action, data: { ...action.data, content: varyOpener(view, chatShorten(action.data.content), rngOf(table), action.data.meetingId) } };
      // A model line stays within 3-12 words even after the opener swap.
      if (source === "llm") action.data.content = capSpeechWords(action.data.content);
    }
    let verdict = validateAction(view, action);
    // chat-audit: a public line that states a wrong fact or leaks is dropped (logged) and replaced, when the
    // town's reads have one, by a grounded line (groundedLine), which goes through the same checks.
    if (!verdict.ok && /^chat-audit/.test(String(verdict.reason)) && isPublicSpeak(view, action)) {
      table.onChatAudit?.(id, String(verdict.reason), action.data.content, source);
      const alt = groundedLine(view);
      const next = alt && alt !== action.data.content ? { ...action, data: { ...action.data, content: alt } } : null;
      if (next && validateAction(view, next).ok) { action = next; verdict = { ok: true }; table.onChatAudit?.(id, "chat-audit: regenerated", alt, source); }
    }
    if (!verdict.ok) {
      if (isPublicSpeak(view, action)) {
        const r = String(verdict.reason || "?").replace(/\(.*$/, "").trim();
        (table.speechRejects ||= {})[r] = ((table.speechRejects || {})[r] || 0) + 1;
        table.onSpeechReject?.(id, [String(verdict.reason || "?")], source, action.data.content);
      }
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
    // One line per new event, except a role claim: it is news by itself (one claim per game is still enforced below).
    if (pub && !claim && table.speechStamp[id] === stamp) continue;
    // L6 (10/18): a seat the Sheriff asked answers him first; its model chatter waits until the reply is out.
    if (pub && !claim && askReplyLine(view)) { table.onSpeechReject?.(id, ["owes the Sheriff an answer first"], source, action.data.content); continue; }
    const ckey = `${id}|${view.stateId}|${action.data?.content}`;
    if (pub && claim && table.claimPending?.has(ckey)) continue;
    if (pub && !claim && !localSpeechOk(table, id, clock)) continue;
    if (table.seen.has(key) && !(pub && claim)) continue;
    if (action.event === "vote") {
      const vk = `${id}|${view.stateId}|${action.data.meetingId}`;
      if ((table.lastVote ||= {})[vk] === JSON.stringify(action.data.selection)) continue;
      // One initial vote, then at most one model upgrade to a different valid target. No churn.
      // Exception: this seat has no vote standing and none on the way (the server cleared it when its
      // target died, or a deferred vote was dropped at send time), or someone died since this seat last
      // voted (new evidence). Then the count starts over, so a seat is never left without a vote.
      if (voteMayRestart(table, id, view, action.data.meetingId, vk)) table.voteCount[vk] = 0;
      // L6 (10/18): the Sheriff's gun is one instant shot; an earlier unsent gun pick must never block it.
      if (/shoot|gun/i.test(String(view.meetings?.[action.data.meetingId]?.name || ""))) table.voteCount[vk] = 0;
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
      // L5 (10/18): pacing at send time (paceSpeech): the reply beat from the line answered, own and table
      // spacing, stale replies dropped. A held line goes out later through deferSpeech.
      const now = clock ?? nowOf(table);
      const pace = paceSpeech(table, id, view, action, now, { entry, claim: claim || !!claimed, source });
      if (pace.drop) { table.onSpeechReject?.(id, [pace.drop], source, action.data.content); continue; }
      // A claim under our own chat cooldown is held for it, never dropped.
      const coolWait = claim || claimed ? speechWaitMs(table, id, now) : 0;
      if (coolWait > pace.wait) Object.assign(pace, { wait: coolWait, due: now + coolWait });
      if (pace.wait > 0) {
        if (claim || claimed) (table.claimPending ||= new Set()).add(ckey);
        deferSpeech(table, id, action, pace, { source, entry, dryRun, send, onError, claim: claim || !!claimed }); continue;
      }
      if (claimed) (table.claimedRole ||= {})[id] = claimed;
      table.speechStamp[id] = stamp;
      ((table.spokeAt ||= {})[id] ||= []).push(now);
      notePublicSend(table, id, now);
    }
    const proposal = {
      accountId: id, afterSeq: entry?.seq, source, phase: view.phase?.name || "",
      promptId: table.byId.get(id)?.promptId, ...finalSpeak(view, action), t: clock ?? nowOf(table),
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

/**
 * L5 (10/18) speech pacing, applied at the moment a public line would go out (after the queue / model call):
 *  - a reply beat: REACT.minMs..maxMs after the line being answered (the latest other public line when the
 *    triggering frame arrived), seeded per seat and line;
 *  - a seat's own lines at least ownGapMs apart, and our seats' lines at least tableGapMs apart (no bursts);
 *  - a reply whose answered line is older than staleMs at send time is dropped (claims and rule lines exempt).
 * Live L5 (10/18): LLM lines went out 0.01-0.3s after the line they answered, in bursts.
 */
// L6 (10/18): tableGapMs 1.5s -> 2.5s between any two bot lines (8 of 16 live gaps were under 3s). Claims and
// counterclaims (news, and the answer to the Sheriff's ask) keep a 1s gap and skip the seat's own 6s gap.
export const SPEECH_PACE = Object.freeze({ ownGapMs: 6_000, tableGapMs: 2_500, claimGapMs: 1_000, staleMs: 30_000 });
const RULE_SOURCES = /^(claim-rule|hammer-rule|rules|counter-rule|ask-rule)/;

function answeredLine(view, at) {
  const pm = publicSpeechMeeting(view);
  if (!pm) return null;
  return (view.messages || []).filter((m) => m.meetingId === pm.id && m.senderId && m.senderId !== "server" && m.senderId !== view.selfId
    && Number.isFinite(Number(m.t)) && (at == null || Number(m.t) <= at)).slice(-1)[0] || null;
}

export function paceSpeech(table, id, view, action, now, { entry, claim = false, source = "", anchor } = {}) {
  if (table.config?.pace === "off") return { wait: 0 };
  const trigger = Number.isFinite(Number(entry?.t)) ? Number(entry.t) : now;
  const a = anchor !== undefined ? anchor : answeredLine(view, trigger);
  const at = a ? Number(a.t) : null;
  const exempt = claim || RULE_SOURCES.test(String(source || ""));
  // Only a line that was a fresh reply when it was triggered can go stale.
  if (!exempt && at != null && trigger - at <= SPEECH_PACE.staleMs && now - at > SPEECH_PACE.staleMs) return { drop: `stale reply (${Math.round((now - at) / 1000)}s after the line it answers)`, anchor: a };
  // Claims are news: the shortest beat (the claim path already held its own REACT wait).
  const hold = claim ? REACT.minMs : REACT.minMs + (seedOf(`${id}|${a?.senderId}|${a?.t}|${action.data?.content}`) % (REACT.maxMs - REACT.minMs + 1));
  const reply = at != null && trigger - at <= SPEECH_PACE.staleMs ? at + hold : -Infinity;
  const own = (table.spokeAt?.[id] || []).reduce((x, y) => Math.max(x, y), -Infinity) + (claim ? SPEECH_PACE.claimGapMs : SPEECH_PACE.ownGapMs);
  // Other seats' reserved slots: a claim does not queue behind them (its own 1s gap from the last real send).
  const any = (claim ? (table.lastSentAt ?? -Infinity) + SPEECH_PACE.claimGapMs : (table.lastPublicAt ?? -Infinity) + SPEECH_PACE.tableGapMs);
  const due = Math.max(reply, own, any, now);
  return { wait: due - now, anchor: a, due };
}

function notePublicSend(table, id, now) {
  table.lastPublicAt = Math.max(table.lastPublicAt ?? -Infinity, now);
  table.lastSentAt = Math.max(table.lastSentAt ?? -Infinity, now);
}

function deferSpeech(table, id, action, pace, { source, entry, dryRun, send, onError, claim }, tries = 0) {
  const stateId = table.views[id]?.stateId;
  // Reserve the table slot so other seats queue behind this line.
  table.lastPublicAt = Math.max(table.lastPublicAt ?? -Infinity, pace.due);
  const p = waitOn(table, pace.wait).then(async () => {
    const view = table.views[id];
    const done = () => table.claimPending?.delete(`${id}|${stateId}|${action.data.content}`);
    if (!view || view.stateId !== stateId || !selfAlive(view) || table.stopped?.[id]) return done();
    // L6 (10/18): a held line dropped at send time is logged (live, an ask reply vanished without a trace).
    const why = !validateAction(view, action).ok ? `held line invalid at send: ${validateAction(view, action).reason}` : publicLeak(view, action.data.content) ? "held line leaks" : machineLeak(view, action.data.content) ? "held line machine text" : null;
    if (why) { table.onSpeechReject?.(id, [why], source, action.data.content); return done(); }
    const claimed = claimedRoleIn(action.data.content);
    if (claimed && table.claimedRole?.[id]) { table.onSpeechReject?.(id, ["held claim: already claimed"], source, action.data.content); return done(); }
    const now = nowOf(table);
    // Re-check at the real send time (other lines may have gone out meanwhile); this line's own slot is free.
    if (table.lastPublicAt === pace.due) table.lastPublicAt = -Infinity;
    const again = paceSpeech(table, id, view, action, now, { entry, claim, source, anchor: pace.anchor });
    if (again.drop) { table.onSpeechReject?.(id, [again.drop], source, action.data.content); return done(); }
    if (again.wait > 50 && tries < 4) { deferSpeech(table, id, action, again, { source, entry, dryRun, send, onError, claim }, tries + 1); return; }
    if (claimed) (table.claimedRole ||= {})[id] = claimed;
    table.speechStamp[id] = speechStamp(view);
    ((table.spokeAt ||= {})[id] ||= []).push(now);
    notePublicSend(table, id, now);
    done();
    if (claim) ((table.claimSent ||= {})[id] ||= new Set()).add(action.data.content);
    const proposal = { accountId: id, afterSeq: entry?.seq, source: `${source}+paced`, phase: view.phase?.name || "", promptId: table.byId.get(id)?.promptId, ...finalSpeak(view, action), t: now };
    table.proposed.push(proposal);
    table.onDeferred?.(proposal);
    if (!dryRun && send) {
      try { await send({ accountId: id, event: action.event, data: action.data, view }); }
      catch (err) { if (onError) onError(err, id); }
    }
  });
  (table.upgrades ||= new Set()).add(p);
  p.finally(() => table.upgrades.delete(p));
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

/**
 * The rule line due for this seat now: an answer to the Sheriff's "claim?" (askReplyLine), the Cop / Journalist /
 * Sheriff claim, the Sheriff's own ask before he shoots (sheriffAskLine), or adaptive scum's pressure claim.
 */
export function claimLineFor(view) {
  if (view?.phase?.phase !== "Day") return null;
  return askReplyLine(view) || roleClaimLine(view) || sheriffAskLine(view, { now: view.clock })?.line
    || hammerAskLine(view, { now: view.clock })
    || planClaimLine(view)?.line
    || (scumFaction(view) && mafiaModeOf(view) === "adaptive" ? adaptivePressureLine(view)?.line : null);
}

/**
 * The faction's planned fake claim (adaptiveClaimLine), sent by the rules path rather than left to the model:
 * live game L2-1018 had two planned fake-Cop claims that never went out because only the LLM could say
 * them. It goes out once the Sheriff's out-window has passed (PLAN_CLAIM_AFTER_MS into the day).
 */
export const PLAN_CLAIM_AFTER_MS = 15_000;
export function planClaimLine(view) {
  if (view?.phase?.phase !== "Day" || !scumFaction(view) || mafiaModeOf(view) !== "adaptive") return null;
  const start = Number(view.phaseStartedAt), now = Number(view.clock);
  if (Number.isFinite(start) && Number.isFinite(now) && now - start < PLAN_CLAIM_AFTER_MS) return null;
  const mine = (view.messages || []).filter((m) => m?.senderId === view.selfId && m.public !== false);
  if (mine.some((m) => claimedRoleIn(m.content))) return null;
  const plan = agreedPlan(view);
  return plan ? adaptiveClaimLine(view, plan) : null;
}

/** Once per seat per day: log why a planned fake claim is adapted or dropped (table.onPlanClaim). */
function notePlanClaim(table, id, view) {
  if (!table.onPlanClaim || view?.phase?.phase !== "Day" || !scumFaction(view) || mafiaModeOf(view) !== "adaptive") return;
  const seen = (table.planNoted ||= {});
  // L3 (10/18): why this seat answers the Sheriff's ask the way it does (vt vs a fake claim).
  const ar = askReplyChoice(view);
  const ak = `${id}|${view.stateId}|ask`;
  if (ar && !seen[ak]) { seen[ak] = true; table.onPlanClaim(id, `ask-reply: ${ar.why} -> "${ar.line}"`); }
  const c = planClaimLine(view);
  const drop = c ? null : planClaimDropReason(view);
  const what = c?.adapt ? `adapt: ${c.adapt}` : drop ? `drop: ${drop}` : null;
  const k = `${id}|${view.stateId}|${what}`;
  if (!what || seen[k]) return;
  seen[k] = true;
  table.onPlanClaim(id, what);
}

/**
 * A scum seat's unprompted fake claim waits the first few seconds of the day, so the Sheriff's opening
 * "im sheriff" is in view (and chatAudit can stop a fake guilty on him) before the claim goes out.
 * Answering the Sheriff's ask is not held.
 */
export const SCUM_CLAIM_SETTLE_MS = 6_000;
function scumClaimSettleMs(view, clock) {
  if (!scumFaction(view) || view?.phase?.phase !== "Day" || askReplyLine(view)) return 0;
  const start = Number(view.phaseStartedAt);
  if (!Number.isFinite(start) || !Number.isFinite(Number(clock))) return 0;
  return Math.max(0, start + SCUM_CLAIM_SETTLE_MS - Number(clock));
}

/** A claim line is due and not already sent (the server echo may still be on its way). */
function claimDue(table, id, view) {
  const line = claimLineFor(view);
  return !!line && !(claimedRoleIn(line) && table.claimedRole?.[id]) && !table.claimSent?.[id]?.has(line) && !!publicSpeechMeeting(view);
}

/**
 * Send the due claim now. Claims are re-checked on every entry and are never dropped: if our chat cooldown
 * blocks it, it is queued for the moment the cooldown ends (and re-checked then).
 */
async function sendClaim(table, id, ctx, clock = ctx.clockOf?.() ?? nowOf(table)) {
  const view = table.views[id];
  if (view && selfAlive(view)) notePlanClaim(table, id, view);
  if (!view || !selfAlive(view) || table.stopped?.[id] || !claimDue(table, id, view)) return [];
  const line = claimLineFor(view);
  // L5 (10/18): a counterclaim takes the shortest human beat (REACT.minMs). Live D2, the fake Journalist
  // claimed 6.6s before the lynch ended the game; the real one's 3-8s hold lost the race.
  const urgent = counterclaimLine(view, line);
  const wait = Math.max(speechWaitMs(table, id, clock), reactWaitMs(table, id, view, line, clock, { urgent }));
  if (wait > 0) { queueClaim(table, id, ctx, wait); return []; }
  const added = await emitActions(table, id, [{ event: "speak", data: { meetingId: publicSpeechMeeting(view).id, content: line } }], { ...ctx, source: "claim-rule", clock, claim: true });
  if (added.length) ((table.claimSent ||= {})[id] ||= new Set()).add(line);
  return added;
}

/**
 * Hammer ask (engine hammer.js), outside the day-vote gate: a seat the revealed Sheriff asked self-votes after
 * its human beat (REACT); the Sheriff casts his deciding vote once all have, or bandwagons a refuser; his
 * re-ask and refusal deadlines get a timer. Logged through table.onHammer.
 */
async function hammerStep(table, id, ctx) {
  const view = table.views[id];
  if (!view || table.config?.hammer === "off" || view.phase?.phase !== "Day" || !selfAlive(view)) return [];
  const now = ctx.clockOf?.() ?? nowOf(table);
  const next = hammerNextMs(view, { now });
  if (next != null) queueRecheck(table, id, ctx, next + 50);
  const hv = hammerVote(view, { now });
  const m = Object.values(view.meetings || {}).find((x) => x?.name === "Village" && x.voting);
  if (!hv?.target || !m) return [];
  const mine = m.votes?.[view.selfId];
  if ((Array.isArray(mine) ? mine[0] : mine) === hv.target) return [];
  const hold = hv.target === view.selfId ? reactWaitMs(table, id, view, `hammer-self|${hv.target}`, now) : 0;
  if (hold > 0) { queueRecheck(table, id, ctx, hold); return []; }
  const k = `${id}|${view.stateId}|${hv.target}`;
  if ((table.hammerSent ||= new Set()).has(k)) return [];
  const vote = { event: "vote", data: { meetingId: m.id, selection: hv.target } };
  if (!validateAction(view, vote).ok) return [];
  table.hammerSent.add(k);
  ((table.latestPick ||= {})[`${id}|${view.stateId}|${m.id}`] = hv.target);
  table.onHammer?.(id, hv);
  return emitActions(table, id, [vote], { ...ctx, source: "hammer-rule", clock: now });
}

/**
 * L4 (10/18) safety net: a living seat with no Village vote standing (and none queued) casts its current legal
 * pick before the server's vote-kick check. Server: Game.createNextStateTimer -> checkVeg at the main timer's
 * end opens the Vote Kick (VegKickMeeting) and a vegKickCountdown; a seat is kickable unless alive and
 * hasVotedInAllMeetings(). So the net fires late in the day (fraction or remaining time) and at once on the
 * vote-kick warning or a Vote Kick meeting. It overrides every hold (Sheriff, hammer, adaptive scum).
 */
export const BALLOT_NET = Object.freeze({ fraction: 0.9, remainingMs: 20_000, retryMs: 8_000, sheriffFraction: 0.96, sheriffRemainingMs: 12_000 });

function ballotDeadline(view, now) {
  if (view.voteKickWarning) return "vote-kick warning";
  if (Object.values(view.meetings || {}).some((m) => /^vote ?kick$/i.test(String(m?.name || "")))) return "vote kick open";
  // A Sheriff whose gun is still owed (Vinman: his Village vote waits for the shot) gets the last seconds.
  const owed = sheriffGunOwed(view);
  const frac = owed ? BALLOT_NET.sheriffFraction : BALLOT_NET.fraction;
  const rem = owed ? BALLOT_NET.sheriffRemainingMs : BALLOT_NET.remainingMs;
  const f = dayFraction(view, { now });
  if (f != null && f >= frac) return `fraction ${f.toFixed(2)}`;
  const tm = view.timer?.stateId === view.stateId ? view.timer : null;
  if (tm?.last != null && tm.first != null && tm.last < tm.first && tm.last <= rem) return `remaining ${tm.last}`;
  return null;
}

export async function ballotNet(table, id, view, now, { send, dryRun, onError, entry } = {}) {
  if (!view?.selfId || view.phase?.phase !== "Day" || !selfAlive(view) || view.finished) return [];
  const gunFirst = await gunNet(table, id, view, now, { send, dryRun, onError, entry });
  if (gunFirst.length) return gunFirst;
  const m = Object.values(view.meetings || {}).find((x) => x?.name === "Village" && x.voting && x.amMember !== false && x.canVote !== false && !x.used);
  if (!m) return [];
  const mine = m.votes?.[view.selfId];
  if (mine != null && !(Array.isArray(mine) && !mine.length)) return [];
  const pk = `${id}|${view.stateId}|${m.id}`;
  if ((table.pendingVotes?.[pk] || 0) > 0 && !view.voteKickWarning) return [];
  const why = ballotDeadline(view, now);
  if (!why) return [];
  const last = table.netSentAt?.[pk];
  if (last != null && now - last < BALLOT_NET.retryMs) return [];
  const e = meetingActions(view, m);
  if (!e || e.closed) return [];
  const ok = (t) => t != null && validateAction(view, { event: "vote", data: { meetingId: m.id, selection: t } }).ok;
  const real = (t) => t !== view.selfId && t !== "*";
  const pref = [table.latestPick?.[pk], ...(e.picks || []).filter(real), ...e.allowed.filter(real), ...(e.picks || []), ...e.allowed];
  const pick = pref.find(ok);
  if (pick == null) return [];
  (table.netSentAt ||= {})[pk] = now;
  const action = { event: "vote", data: { meetingId: m.id, selection: pick } };
  (table.lastVote ||= {})[pk] = JSON.stringify(pick);
  (table.lastVoteAt ||= {})[id] = now;
  (table.lastVoteAction ||= {})[id] = action;
  table.onBallotNet?.(id, pick, why, now);
  const proposal = { accountId: id, afterSeq: entry?.seq, source: "ballot-net", phase: view.phase?.name || "", promptId: table.byId.get(id)?.promptId, ...action };
  table.proposed.push(proposal);
  if (send && !dryRun) {
    try { await send({ accountId: id, event: action.event, data: action.data, view }); }
    catch (err) { if (onError) onError(err, id); }
  }
  return [proposal];
}

/**
 * L6 (10/18): the Sheriff never shot on Day 1. His Village vote (ballot net, vote kick open) went in while the
 * gun was still loaded, and with all votes in the day closed at once. At the ballot deadline the owed gun
 * fires first, at the rule's late target (sheriffShotReady: an unanswered ask is shootable, last call shoots
 * unasked). The Village vote follows on the next pass.
 */
async function gunNet(table, id, view, now, { send, dryRun, onError, entry } = {}) {
  if (!sheriffGunOwed(view) || !ballotDeadline(view, now)) return [];
  const gun = Object.values(view.meetings || {}).find((m) => /shoot|gun/i.test(String(m?.name || "")) && m.voting && m.amMember !== false && m.canVote !== false && !m.used);
  if (!gun) return [];
  const r = sheriffShotReady({ ...view, clock: now }, { now });
  if (!r.ok || !(gun.targets || []).includes(r.target)) return [];
  const k = `${id}|${view.stateId}|gun`;
  if ((table.gunNetAt ||= {})[k] != null && now - table.gunNetAt[k] < BALLOT_NET.retryMs) return [];
  table.gunNetAt[k] = now;
  const action = { event: "vote", data: { meetingId: gun.id, selection: r.target } };
  if (!validateAction({ ...view, clock: now }, action).ok) return [];
  table.onBallotNet?.(id, r.target, `gun first: ${r.why || "owed"}`, now);
  const proposal = { accountId: id, afterSeq: entry?.seq, source: "gun-net", phase: view.phase?.name || "", promptId: table.byId.get(id)?.promptId, ...action };
  table.proposed.push(proposal);
  if (send && !dryRun) {
    try { await send({ accountId: id, event: action.event, data: action.data, view }); }
    catch (err) { if (onError) onError(err, id); }
  }
  return [proposal];
}

/** Re-run this seat's upgrade pass after a reactive hold (one pending re-check per seat). */
function queueRecheck(table, id, ctx, wait) {
  const k = `${id}|${table.views[id]?.stateId}`;
  if ((table.recheckQueued ||= new Set()).has(k)) return;
  table.recheckQueued.add(k);
  const p = waitOn(table, wait).then(async () => {
    table.recheckQueued.delete(k);
    if (ctx.complete && ctx.clockOf) return startUpgrade(table, id, ctx);
    // Rules-only (fast, no model): the due claim and the hammer step, at the new time.
    const added = [...await sendClaim(table, id, ctx, nowOf(table)), ...await hammerStep(table, id, { ...ctx, clockOf: () => nowOf(table) })];
    if (ctx.onAdded) ctx.onAdded(added);
  });
  (table.upgrades ||= new Set()).add(p);
  p.finally(() => table.upgrades.delete(p));
}

function queueClaim(table, id, ctx, wait) {
  const stateId = table.views[id]?.stateId;
  const k = `${id}|${stateId}`;
  if ((table.claimQueued ||= new Set()).has(k)) return;
  table.claimQueued.add(k);
  const p = waitOn(table, wait).then(async () => {
    table.claimQueued.delete(k);
    if (table.views[id]?.stateId !== stateId) return;
    const added = await sendClaim(table, id, ctx, nowOf(table));
    if (ctx.onAdded) ctx.onAdded(added);
  });
  (table.upgrades ||= new Set()).add(p);
  p.finally(() => table.upgrades.delete(p));
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
        const added = await sendClaim(table, id, ctx);
        if (ctx.onAdded) ctx.onAdded(added);
        if (added.length) continue;
        const hammered = await hammerStep(table, id, ctx);
        if (ctx.onAdded) ctx.onAdded(hammered);
        const pm = publicSpeechMeeting(view);
        // Town counter-story from the public evidence (townCounterLine), at most once per seat per day.
        const ck = `${id}|${view.stateId}`;
        if (pm && !(table.counterSaid ||= new Set()).has(ck)) {
          const counter = townCounterLine(view);
          const hold = counter ? reactWaitMs(table, id, view, counter, ctx.clockOf()) : 0;
          if (hold > 0) queueRecheck(table, id, ctx, hold);
          else if (counter) {
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
          const hold = line ? reactWaitMs(table, id, view, line, t) : 0;
          if (hold > 0) queueRecheck(table, id, ctx, hold);
          else if (line) {
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
      if (plan.speechRejections?.length) table.onSpeechReject?.(id, plan.speechRejections, "llm");
      const now = table.views[id];
      if (!now || now.stateId !== stateId || !selfAlive(now)) { ctx.onStale?.(id); continue; }
      const sch = plan.schedule;
      if (ctx.onSchedule && sch && sch.meetingId && !night) {
        const key = `${sch.speak ? "speak" : "skip"}|${sch.path}|${sch.reason}`;
        if (table.lastSchedule?.[id] !== key) { (table.lastSchedule ||= {})[id] = key; ctx.onSchedule(id, sch); }
      }
      // Scum votes stay on the seen PLAN: the model may not move a faction kill, clean, or litigate.
      // A claim that became due while the model was thinking (e.g. the Sheriff just outed) beats the stale line.
      const claimFirst = claimDue(table, id, now);
      const keep = shapeDayVotes(table, id, now, plan.actions.filter((a) => !(a.event === "vote" && scumLocked(now, a)) && !(claimFirst && isPublicSpeak(now, a))), ctx.clockOf(), { source: plan.source });
      // The public line carries its own author (llm / rules / accused-rule), not the vote's label.
      const speech = keep.filter((a) => isPublicSpeak(now, a));
      const added = await emitActions(table, id, keep.filter((a) => !speech.includes(a)), { ...ctx, source: plan.source, clock: ctx.clockOf() });
      if (speech.length) {
        // Reactive hold (REACT): a line answering a fresh message waits its human beat, then goes if still current.
        const hold = Math.max(...speech.map((a) => reactWaitMs(table, id, now, String(a.data?.content || ""), ctx.clockOf())));
        const src = plan.speechSource || plan.source;
        if (hold > 0) {
          const p = waitOn(table, hold).then(async () => {
            const v2 = table.views[id];
            if (!v2 || v2.stateId !== stateId || !selfAlive(v2) || table.stopped?.[id]) return;
            const late = await emitActions(table, id, speech, { ...ctx, source: src, clock: ctx.clockOf() });
            if (ctx.onAdded) ctx.onAdded(late);
          });
          (table.upgrades ||= new Set()).add(p);
          p.finally(() => table.upgrades.delete(p));
        } else added.push(...await emitActions(table, id, speech, { ...ctx, source: src, clock: ctx.clockOf() }));
      }
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
  if (entry?.event === "message" && table.onAlert) { const r = alertResult(table.views[id], entry.data); if (r) table.onAlert(id, r); }
  if ((entry?.event === "players" || entry?.event === "self") && table.onSeatMap && !table.seatMapLogged) {
    const line = seatMapLine(table);
    if (line) { table.seatMapLogged = true; table.onSeatMap(line); }
  }
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
  const netted = await ballotNet(table, id, view, clock ?? nowOf(table), ctx);
  if (netted.length && onAdded) onAdded(netted);
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
    // A due claim goes out on the entry that made it due (e.g. "im sheriff"), not behind a model call.
    added.push(...await sendClaim(table, id, { ...ctx, onAdded }, clock ?? nowOf(table)));
    if (!complete) added.push(...await hammerStep(table, id, { ...ctx, onAdded, clockOf: () => clock ?? nowOf(table) }));
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
  const speech = plan.actions.filter((a) => isPublicSpeak(view, a));
  const added = await emitActions(table, id, plan.actions.filter((a) => !speech.includes(a)), { ...ctx, source: plan.source, clock });
  if (speech.length) added.push(...await emitActions(table, id, speech, { ...ctx, source: plan.speechSource || plan.source, clock }));
  return added;
}

/**
 * One line mapping each bot seat to its player slot, from the server's own self/players frames:
 * `seatmap s1=<playerId>:"<handle>" s2=...` in account order (the order of the `game ... accounts=` line).
 * Seat labels and in-game handles only: no account ids, emails or tokens. Null until every seat is known.
 */
export function seatMapLine(table) {
  const ids = [...table.byId.keys()];
  const parts = ids.map((id, i) => {
    const v = table.views[id];
    const pid = v?.selfId;
    const name = pid && v.players?.[pid]?.name;
    return pid && name ? `s${i + 1}=${pid}:${JSON.stringify(String(name))}` : null;
  });
  return parts.every(Boolean) ? `seatmap ${parts.join(" ")}` : null;
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
      // The stream has no replay. Game GAME03 filled and started while the bots were being seated,
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
  const table = createBotTable(accounts, { clock, rng, reasoning: reasoningModel(env), town: cfg.town, hammer: cfg.hammer });
  say(`town vote arm=${table.config.town}`);
  // Suspicion arm: one line per town day pick with the seat's top reads, to compare ballots with reads.
  table.onTownVote = (who, tv, score) => say(`town-vote ${who} [${table.views[who]?.phase?.name || ""}] t=${clock.now()} target=${tv.target} why=${JSON.stringify(String(tv.why).slice(0, 120))} reads=${JSON.stringify(Object.entries(score).filter(([, s]) => s).sort((x, y) => y[1] - x[1]).slice(0, 4))}`);
  say(`llm reasoning=${!!table.config.reasoning}`);
  // One line per parsed Cop / Journalist / Janitor result, so live alert parsing can be checked against the game.
  // Seat label -> player slot and handle, once every seat knows itself (lets build-replays bind seats exactly).
  table.onSeatMap = (line) => say(line);
  table.onBallotUpdate = (who, from, to) => say(`ballot-update ${who} [${table.views[who]?.phase?.name || ""}] t=${clock.now()} queued=${from} sent=${to}`);
  // L4 (10/18): the late-day ballot safety net (ballotNet).
  table.onBallotNet = (who, pick, why, t) => say(`ballot-net ${who} [${table.views[who]?.phase?.name || ""}] t=${t} pick=${pick} why=${JSON.stringify(why)}`);
  table.onPlanClaim = (who, what) => say(`plan-claim ${who} [${table.views[who]?.phase?.name || ""}] ${what}`);
  table.onHammer = (who, hv) => say(`hammer ${who} [${table.views[who]?.phase?.name || ""}] t=${clock.now()} target=${hv.target} why=${JSON.stringify(hv.why)}`);
  table.onAlert = (who, r) => say(`alert ${who} [${table.views[who]?.phase?.name || ""}] kind=${r.kind} target=${JSON.stringify(String(r.target).slice(0, 30))} result=${JSON.stringify(String(r.result).slice(0, 160))}`);
  table.onSpeechReject = (who, reasons, source, content) => say(`speech-reject ${who} [${table.views[who]?.phase?.name || ""}] source=${source} reasons=${JSON.stringify(reasons.map((r) => String(r).slice(0, 120)))}${content ? ` line=${JSON.stringify(String(content).slice(0, SPEECH_LOG_MAX))}` : ""}`);
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
  if (!table.seatMapLogged) { const line = seatMapLine(table); if (line) { table.seatMapLogged = true; say(line); } }
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
  const logSends = (added) => { for (const p of added) say(`send ${p.accountId} [${p.phase}] t=${clock.now()} ${p.event} ${p.data?.meetingId || ""} ${p.data?.selection || (p.data?.content ? JSON.stringify(String(p.data.content).slice(0, SPEECH_LOG_MAX)) : "")} source=${p.source} prompt=${p.promptId}`); };
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
      onChat: (line) => say(`${line} t=${clock.now()}`),
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

