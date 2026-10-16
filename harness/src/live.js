// One process, N Dev API accounts, one private Testing game.
// Dry-run (MAFIOSO_LIVE !== "1") never connects and never sends.
// Game hosts are allowlisted. Prod is rejected. Secrets are not logged.
import { fileURLToPath } from "node:url";
import { emptyView, reduce as engineReduce, decide, validateAction, llmDecide, supplementActions } from "mafioso-engine";
import { assertAllowedBase, DevApiClient, liveCredentials } from "./client.js";
import { parseStreamFrame } from "./stream.js";
import { createLmStudioComplete } from "./lmstudio.js";
import { createExperientialComplete } from "./experiential.js";
import { createOpenCodeGoComplete } from "./opencodeGo.js";
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
    views: {}, seen: new Set(), proposed: [], lastSeq: {},
    byId: new Map(accounts.map((a) => [a.accountId, a])),
  };
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

/**
 * Reduce one envelope and, if this account still owes a vote, decide.
 * Sends only when dryRun is false. send() is expected to validate again.
 */
export async function onGameEntry(table, entry, { complete, send, dryRun = true, rng } = {}) {
  const id = entry?.accountId ?? "_";
  if (!table.byId.has(id)) return [];
  if (entry.seq != null && table.lastSeq[id] != null && entry.seq <= table.lastSeq[id]) return [];
  if (entry.seq != null) table.lastSeq[id] = entry.seq;
  table.views[id] = engineReduce(table.views[id] ?? emptyView(), entry);
  const view = table.views[id];
  const open = decide(view, { rng });
  if (!open.length) return [];
  const keyOf = (a) => `${id}|${view.stateId}|${a.event}|${a.data.meetingId}`;
  if (open.every((a) => table.seen.has(keyOf(a)))) return [];
  const promptText = table.byId.get(id)?.promptText;
  const bound = complete
    ? (promptText ? ({ user }) => complete({ system: promptText, user }) : complete)
    : null;
  const decided = bound
    ? await llmDecide(view, { complete: bound, rng })
    : { actions: open, source: "rules" };
  const added = [];
  for (const action of supplementActions(decided.actions, open, view)) {
    if (!validateAction(view, action).ok) continue;
    if (table.seen.has(keyOf(action))) continue;
    table.seen.add(keyOf(action));
    const proposal = {
      accountId: id,
      afterSeq: entry.seq,
      source: decided.source,
      promptId: table.byId.get(id)?.promptId,
      ...action,
    };
    table.proposed.push(proposal);
    added.push(proposal);
    if (!dryRun && send) await send({ accountId: id, event: action.event, data: action.data, view });
  }
  return added;
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
export async function runStreamLoop({ fetchStream, onFrame, shouldStop = () => false, sleep = defaultSleep, backoff = backoffMs, maxAttempts = Infinity }) {
  let attempt = 0;
  while (!shouldStop()) {
    try {
      const body = await fetchStream();
      attempt = 0;
      for await (const frame of iterateSse(body)) {
        if (frame.type === "accounts_dropped") throw new Error("accounts_dropped");
        const stop = await onFrame(frame);
        if (stop || shouldStop()) return;
      }
      if (shouldStop()) return;
    } catch (e) {
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
  const refresh = async () => {
    issuedAt = await maybeRefreshToken({
      issuedAt, now: now(), ttl: TOKEN_REFRESH_MS,
      refresh: async () => { await client.getToken(creds); },
    });
  };
  const onFrame = async (frame) => {
    if (frame.type !== "game" || !frame.entry) return false;
    const added = await onGameEntry(table, frame.entry, {
      complete, rng, dryRun: false,
      send: (p) => client.send(p),
    });
    for (const p of added) say(`send ${p.accountId} ${p.event} ${p.data?.meetingId || ""} ${p.data?.selection || ""} source=${p.source} prompt=${p.promptId}`);
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
    });
  }
  const results = resultsFromTable(table);
  let store = store0;
  if (cfg.evolve && results.length) {
    const done = await finishGame({ store, results, complete, summary: replayDigest(table.views), now: now() });
    store = done.store;
    await savePromptStore(cfg.promptDir, store);
    say(`scored ${results.length} bots; new prompts=${done.children.map((c) => c.id).join(",") || "none"}; skipped=${done.skipped.map((s) => s.reason).join(",") || "none"}`);
  } else {
    say(`game ended; scored=${results.length}; evolve=${cfg.evolve ? "yes" : "no"}`);
  }
  return 0;
}
