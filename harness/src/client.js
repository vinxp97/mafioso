// Dev API client. Endpoints per /workspace/ultimafia-bot-api.md and
// Ultimafia scripts/devapi-smoke.js. All I/O goes through an injected fetch.
import { DEV_HOSTS, validateAction } from "mafioso-engine";

export const ALLOWED_HOSTS = DEV_HOSTS; // ["https://dev.ultimafia.gg","http://127.0.0.1:3000"]

export class HostNotAllowedError extends Error {}
export class IllegalActionError extends Error {}

export function assertAllowedBase(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { throw new HostNotAllowedError(`Invalid base URL: ${baseUrl}`); }
  if (!ALLOWED_HOSTS.includes(origin))
    throw new HostNotAllowedError(`Host not allowed: ${origin}. Mafioso only talks to ${ALLOWED_HOSTS.join(", ")} (never prod).`);
  return origin;
}

/** Credentials only from env, only when live mode explicitly enabled. */
export function liveCredentials(env = process.env) {
  if (env.MAFIOSO_LIVE !== "1") throw new Error("Live mode disabled (set MAFIOSO_LIVE=1)");
  const clientId = env.DEV_API_CLIENT_ID, clientSecret = env.DEV_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("DEV_API_CLIENT_ID / DEV_API_CLIENT_SECRET not set");
  return { clientId, clientSecret };
}

export class DevApiClient {
  /** @param {{baseUrl:string, fetch:Function, token?:string}} opts */
  constructor({ baseUrl, fetch, token = null }) {
    if (typeof fetch !== "function") throw new Error("fetch must be injected");
    this.base = assertAllowedBase(baseUrl);
    this.fetch = fetch;
    this.token = token;
  }

  async api(method, path, body) {
    const url = `${this.base}/api${path}`;
    assertAllowedBase(url);
    const res = await this.fetch(url, {
      method,
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    // never echo request bodies (may contain secrets)
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return data;
  }

  async getToken({ clientId, clientSecret }) {
    const r = await this.api("POST", "/dev/token", { clientId, clientSecret });
    this.token = r.token;
    return { tokenType: r.tokenType, expiresIn: r.expiresIn };
  }

  me() { return this.api("GET", "/dev/me"); }

  hostGame(opts = {}) {
    const body = { gameType: "Mafia", lobby: "Testing", lobbyName: "mafioso-test", spectating: true,
      stateLengths: { Day: 10, Night: 2 }, extendLength: 1, pregameWaitLength: 1, ...opts };
    body.private = true; // forced: never host public
    if (body.lobby !== "Testing") throw new Error("hostGame: only lobby Testing allowed");
    if (body.ranked || body.competitive) throw new Error("hostGame: ranked/competitive not allowed");
    if (!body.setup) throw new Error("hostGame: setup id required");
    return this.api("POST", "/game/host", body);
  }

  createAccounts({ gameId, count }) {
    if (!gameId || !(count >= 1 && count <= 50)) throw new Error("createAccounts: gameId and count 1..50 required");
    return this.api("POST", "/dev/accounts", { gameId, count });
  }

  leaveAccount(accountId) { return this.api("POST", `/dev/accounts/${encodeURIComponent(accountId)}/leave`); }

  /** Host user leaves the seat. Bearer can call POST /api/game/leave. */
  leaveGame(gameId) {
    if (!gameId) throw new Error("leaveGame: gameId required");
    return this.api("POST", "/game/leave", { gameId });
  }
  control(gameId, command, args) { return this.api("POST", `/dev/games/${encodeURIComponent(gameId)}/control`, { command, args }); }
  events(accountId, since = 0) { return this.api("GET", `/dev/accounts/${encodeURIComponent(accountId)}/events?since=${since}`); }

  /** Validates against view (if given) BEFORE any HTTP. */
  async send({ accountId, event, data, view }) {
    if (view) {
      const v = validateAction(view, { event, data });
      if (!v.ok) throw new IllegalActionError(`Illegal ${event}: ${v.reason}`);
    }
    return this.api("POST", `/dev/accounts/${encodeURIComponent(accountId)}/send`, { event, data });
  }
}
