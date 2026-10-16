// One process, N Dev API accounts, one private Testing game.
// Dry-run (MAFIOSO_LIVE !== "1") never connects and never sends.
// Game hosts are allowlisted. Prod is rejected. Secrets are not logged.
import { fileURLToPath } from "node:url";
import { emptyView, reduce as engineReduce, validateAction, isPublicSpeak, proposeSeatActions, rulesSeatActions, speechStamp, humanizeSpeak, selfAlive, agreedPlan, isAlive, createSeededRng, ALIGNMENT, factionKillMeeting, factionLeader, publicLeak } from "mafioso-engine";
import { assertAllowedBase, DevApiClient, liveCredentials } from "./client.js";
import { parseStreamFrame } from "./stream.js";
import { createLmStudioComplete } from "./lmstudio.js";
import { createExperientialComplete } from "./experiential.js";
import { createOpenCodeGoComplete } from "./opencodeGo.js";
import { createArenaScorer } from "./arena.js";
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

export function createBotTable(accounts) {
  return {
    views: {}, seen: new Set(), proposed: [], lastSeq: {}, speechStamp: {},
    byId: new Map(accounts.map((a) => [a.accountId, a])),
  };
}

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
      if (playerId) table.views[id] = engineReduce(table.views[id] ?? emptyView(), { event: "self", data: String(playerId) });
    }
    // Our own seats' display names, so speech can say "Bob" even if the players frame was missed.
    const named = ids.map((id) => byId.get(id)).filter((a) => a?.playerId && a?.name);
    for (const id of ids) {
      const v = (table.views[id] ||= emptyView());
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

export function gameFinished(table, accountIds) {
  return accountIds.length > 0 && accountIds.every((id) => table.views[id]?.finished);
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
    system: prompt?.purpose === "memory" || prompt?.purpose === "scheduler" || prompt?.purpose === "candidates"
      ? prompt.system
      : (promptText || prompt?.system),
    user: prompt?.user,
    purpose: prompt?.purpose,
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
function localSpeechOk(table, id, clock) {
  const t = clock ?? Date.now();
  const mine = (table.spokeAt?.[id] || []).filter((x) => t - x < 60_000);
  if (mine.length >= 3) return false;
  return !mine.length || t - Math.max(...mine) >= 8_000;
}

/** Send (or propose) validated actions for one seat; dedups per state, allows a changed vote. */
export const VOTE_GAP_MS = 3000;
export const VOTE_BACKOFF_MS = 6000;

function voteDelay(table, id, view, action) {
  const now = Date.now();
  let wait = 0;
  const kill = factionKillMeeting(view);
  // Only the first voter decides; teammates copy after a human-like 1-5s pause.
  if (kill && kill.id === action.data.meetingId && factionLeader(view) !== view.selfId && !table.copied?.[`${id}|${view.stateId}`]) {
    (table.copied ||= {})[`${id}|${view.stateId}`] = true;
    wait = 1000 + Math.floor(Math.random() * 4000);
  }
  const last = table.lastVoteAt?.[id];
  if (last != null) wait = Math.max(wait, last + VOTE_GAP_MS - now);
  const back = table.voteBackoff?.[id];
  if (back != null) wait = Math.max(wait, back - now);
  return Math.max(0, wait);
}

function deferVote(table, id, action, wait, { source, entry, send, onError }) {
  const stateId = table.views[id]?.stateId;
  // Reserve the slot now so later votes from this seat queue behind this one.
  (table.lastVoteAt ||= {})[id] = Date.now() + wait;
  const p = new Promise((resolve) => setTimeout(resolve, wait)).then(async () => {
    const view = table.views[id];
    if (!view || view.stateId !== stateId || !selfAlive(view) || table.stopped?.[id]) return;
    if (!validateAction(view, action).ok) return;
    const back = table.voteBackoff?.[id];
    if (back != null && back > Date.now()) { deferVote(table, id, action, back - Date.now(), { source, entry, send, onError }); return; }
    table.lastVoteAt[id] = Date.now();
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
  (table.voteBackoff ||= {})[id] = Date.now() + VOTE_BACKOFF_MS;
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
    if (!validateAction(view, action).ok) continue;
    const pub = isPublicSpeak(view, action);
    // PLAN lines only ever go to this seat's own private faction chat.
    if (action.event === "speak" && /\bPLAN\b/.test(String(action.data?.content || ""))) {
      const m = view.meetings?.[action.data.meetingId];
      if (pub || !m || !(m.name === "Mafia" || m.name === "Cult")) continue;
    }
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
      const n = (table.voteCount ||= {})[vk] || 0;
      if (n >= 2 || (n === 1 && source === "rules")) continue;
      // Copy/teammate votes and the server's vote rate limit: send later, re-checked at send time.
      const wait = voteDelay(table, id, view, action);
      if (wait > 0) { table.voteCount[vk] = n + 1; table.lastVote[vk] = JSON.stringify(action.data.selection); deferVote(table, id, action, wait, { source, entry, send: dryRun ? null : send, onError }); continue; }
      table.voteCount[vk] = n + 1;
      table.lastVote[vk] = JSON.stringify(action.data.selection);
      (table.lastVoteAt ||= {})[id] = Date.now();
    }
    table.seen.add(key);
    if (pub) {
      action = humanizeSpeak(view, action);
      if (!String(action.data?.content || "").trim()) continue;
      if (publicLeak(view, action.data.content)) { table.leaksBlocked = (table.leaksBlocked || 0) + 1; continue; }
      table.speechStamp[id] = stamp;
      ((table.spokeAt ||= {})[id] ||= []).push(clock ?? Date.now());
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
      const keep = plan.actions.filter((a) => !(a.event === "vote" && scumLocked(now, a)));
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

function scumLocked(view, action) {
  const m = view.meetings?.[action.data.meetingId];
  if (!m || view.phase?.phase !== "Night") return false;
  if (m.name === "Mafia" || m.name === "Cult") return !!agreedPlan(view);
  return /janitor|lawyer/i.test(String(view.role || ""));
}

export async function onGameEntry(table, entry, { complete, send, dryRun = true, rng, now, onError, onSchedule, fast = false, limiter = null, onAdded } = {}) {
  const id = entry?.accountId ?? "_";
  if (!table.byId.has(id)) return [];
  if (entry.seq != null && table.lastSeq[id] != null && entry.seq <= table.lastSeq[id]) return [];
  if (entry.seq != null) table.lastSeq[id] = entry.seq;
  table.views[id] = engineReduce(table.views[id] ?? emptyView(), entry);
  if (entry?.event === "roleReveal" || entry?.event === "players" || entry?.event === "self") {
    for (const inj of noteSeatRole(table, id, table.views[id])) {
      if (table.views[inj.accountId]) table.views[inj.accountId] = engineReduce(table.views[inj.accountId], { event: "teammates", data: inj.data });
    }
  }
  if (/voting too quickly/i.test(JSON.stringify(entry?.data ?? ""))) noteVoteThrottle(table, id, { send: dryRun ? null : send, onError });
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
    // Rules first, right now: every open night action and vote gets a legal pick before any model call.
    const rules = rulesSeatActions(view, { rng, now: clock });
    const instant = rules.actions.filter((a) => a.event === "vote" || (a.event === "speak" && !isPublicSpeak(view, a)));
    const added = await emitActions(table, id, instant, { ...ctx, source: "rules", clock });
    if (complete) {
      startUpgrade(table, id, {
        ...ctx, complete, rng, limiter, onSchedule, onAdded,
        clockOf: () => (now != null ? now : Date.now()),
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
  while (table.upgrades?.size) await Promise.all([...table.upgrades]);
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

/**
 * Reconnect until shouldStop or the stream handler asks to stop.
 * fetchStream throws or returns an async iterable / ReadableStream of SSE bytes.
 */
export async function runStreamLoop({ fetchStream, onFrame, shouldStop = () => false, sleep = defaultSleep, backoff = backoffMs, maxAttempts = Infinity, onError, ourIds, settle }) {
  let attempt = 0;
  while (!shouldStop()) {
    try {
      const body = await fetchStream();
      attempt = 0;
      for await (const frame of iterateSse(body)) {
        if (frame.type === "accounts_dropped") {
          const raw = JSON.stringify(frame.entry ?? {});
          if (onError) onError(new Error(`accounts_dropped frame ${raw.slice(0, 300)}`));
          if (!ourIds || ourIds.some((a) => raw.includes(a))) throw new Error("accounts_dropped");
          continue;
        }
        const stop = await onFrame(frame);
        if (stop || shouldStop()) return;
      }
      if (settle) await settle();
      if (shouldStop()) return;
    } catch (e) {
      if (onError) onError(e);
      if (shouldStop()) throw e;
      if (attempt >= maxAttempts) throw e;
    }
    if (attempt >= maxAttempts) return;
    await sleep(backoff(attempt));
    attempt++;
  }
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

export async function runLiveCli({ env = process.env, fetch: fetchImpl, log = console.error, sleep, now = Date.now, rng = Math.random } = {}) {
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
  const table = createBotTable(accounts);
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
  const logSends = (added) => { for (const p of added) say(`send ${p.accountId} [${p.phase}] ${p.event} ${p.data?.meetingId || ""} ${p.data?.selection || (p.data?.content ? JSON.stringify(String(p.data.content).slice(0, 100)) : "")} source=${p.source} prompt=${p.promptId}`); };
  let winnersLogged = false;
  table.onDeferred = (p) => logSends([p]);
  const seats = createSeatQueues(async (entry) => {
    // Winners only for our game: our seat, matching gameId when the envelope has one, after the game started.
    const wv = table.views[entry.accountId];
    if (entry.event === "winners" && !winnersLogged && table.byId.has(entry.accountId)
      && (entry.gameId == null || entry.gameId === opened.gameId) && wv?.phase && wv.phase.phase !== "Pregame") {
      winnersLogged = true; say(`winners game=${opened.gameId} ${JSON.stringify(entry.data).slice(0, 400)}`);
    }
    const added = await onGameEntry(table, entry, {
      complete, rng, dryRun: false, fast: true, limiter, onAdded: logSends,
      send: (p) => client.send(p),
      onError: (err, who) => say(`seat-error ${who} ${err?.stack || err?.message || err}`),
      onSchedule: (who, sch) => say(`sched ${who} ${sch.speak ? "speak" : "skip"} u=${sch.urgency}/${sch.threshold} path=${sch.path} reason=${sch.reason}`),
    });
    logSends(added);
  }, { isStopped: (id, entry) => !!table.stopped?.[id] && entry?.event !== "winners" && entry?.event !== "finished", onError: (err, who) => say(`seat-error ${who} ${err?.stack || err?.message || err}`) });
  say(`llm concurrency=${concurrency}`);
  const frameCounts = {}; let lastTrace = 0;
  const onFrame = async (frame) => {
    const ft = `${frame.type}${frame.entry?.event ? ":" + frame.entry.event : ""}`;
    frameCounts[ft] = (frameCounts[ft] || 0) + 1;
    if (Date.now() - lastTrace > 20000) { lastTrace = Date.now(); say(`frames ${JSON.stringify(frameCounts)}`); }
    if (frame.type !== "game" || !frame.entry) return false;
    const done = seats.push(frame.entry);
    if (frame.entry.event === "winners" || frame.entry.event === "finished") await done;
    return gameFinished(table, accounts.map((a) => a.accountId));
  };
  if (cfg.transport === "poll") {
    const since = new Map();
    let spins = 0;
    while (!gameFinished(table, accounts.map((a) => a.accountId)) && spins < 10_000) {
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
    await runStreamLoop({
      sleep, backoff: (n) => backoffMs(n, { rng }),
      shouldStop: () => gameFinished(table, accounts.map((a) => a.accountId)),
      fetchStream: async () => {
        await refresh();
        const res = await gameFetch(url, { headers: { accept: "text/event-stream", authorization: `Bearer ${client.token}` } });
        if (!res.ok) throw new Error(`GET /dev/stream -> ${res.status}`);
        if (!res.body) throw new Error("GET /dev/stream: empty body");
        return res.body;
      },
      onFrame,
      ourIds: accounts.map((a) => a.accountId),
      settle: async () => { await seats.drain(); await drainUpgrades(table); },
      onError: (err) => say(`stream-error ${err?.stack || err?.message || err}`),
    });
  }
  await seats.drain();
  await drainUpgrades(table);
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
