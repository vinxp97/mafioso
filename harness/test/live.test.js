import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT, validateAction } from "mafioso-engine";
import { DevApiClient, HostNotAllowedError } from "../src/client.js";
import {
  backoffMs, createBackendComplete, driveAccounts, iterateSse, liveConfigFromEnv,
  normalizeAccounts, openTestingGame, pollOnce, redact, runLiveCli, runStreamLoop,
  streamUrl, tokenExpired, TOKEN_REFRESH_MS, withCfAccess,
} from "../src/live.js";

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const out = await responder(url, init, body);
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: out.headers || {},
      body: out.stream,
      text: async () => (out.raw != null ? out.raw : JSON.stringify(out.body ?? {})),
    };
  };
  fn.calls = calls;
  return fn;
}

const day = (accountId, self, seq) => ([
  { accountId, seq, event: "self", data: self },
  { accountId, seq: seq + 1, event: "players", data: { p1: { id: "p1", name: "A" }, p2: { id: "p2", name: "B" } } },
  { accountId, seq: seq + 2, event: "state", data: { id: 1, name: "Day 1" } },
  { accountId, seq: seq + 3, event: "meeting", data: { id: "mVil", name: "Village", voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "*"], votes: {} } },
]);

test("config defaults to 9 bots, lmstudio, and the dev host; prod is rejected", () => {
  const cfg = liveConfigFromEnv({});
  assert.equal(cfg.live, false);
  assert.equal(cfg.botCount, 9);
  assert.equal(cfg.llm, "lmstudio");
  assert.equal(cfg.baseUrl, "https://dev.ultimafia.gg");
  assert.equal(liveConfigFromEnv({ DEV_API_BASE_URL: "http://127.0.0.1:3000/api" }).baseUrl, "http://127.0.0.1:3000");
  assert.throws(() => liveConfigFromEnv({ DEV_API_BASE_URL: "https://ultimafia.com" }), HostNotAllowedError);
  assert.throws(() => liveConfigFromEnv({ BOT_COUNT: "0" }), /BOT_COUNT/);
  assert.throws(() => streamUrl("https://dev.ultimafia.gg", "/api/game/host"), /\/api\/dev\//);
});

test("dry-run does not call fetch", async () => {
  const lines = [];
  const fetch = async () => { throw new Error("network"); };
  const code = await runLiveCli({ env: { MAFIOSO_LIVE: "0", DEV_API_CLIENT_SECRET: "super-secret-value" }, fetch, log: (m) => lines.push(m) });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /dry-run/);
  assert.equal(lines.join("\n").includes("super-secret-value"), false);
});

test("openTestingGame forces a private Testing lobby and can join an existing id", async () => {
  const f = mockFetch((url) => url.endsWith("/game/host") ? { body: "game-9" } : { body: { accounts: [{ id: "A" }, { accountId: "B" }] } });
  const client = new DevApiClient({ baseUrl: "http://127.0.0.1:3000", fetch: f, token: "t" });
  const opened = await openTestingGame(client, { setupId: "setup-1", botCount: 2 });
  assert.equal(opened.gameId, "game-9");
  assert.deepEqual(opened.accounts, [{ accountId: "A" }, { accountId: "B" }]);
  assert.equal(f.calls[0].url, "http://127.0.0.1:3000/api/game/host");
  assert.equal(f.calls[0].body.private, true);
  assert.equal(f.calls[0].body.lobby, "Testing");
  assert.equal(f.calls[0].body.spectating, true);
  assert.equal(f.calls[0].body.setup, "setup-1");
  assert.equal(f.calls[1].url, "http://127.0.0.1:3000/api/dev/accounts");
  assert.deepEqual(f.calls[1].body, { gameId: "game-9", count: 2 });
  assert.equal(f.calls[2].url, "http://127.0.0.1:3000/api/game/leave");
  assert.deepEqual(f.calls[2].body, { gameId: "game-9" });
  let hosted = false;
  let left = false;
  const joined = await openTestingGame({
    hostGame() { hosted = true; },
    leaveGame() { left = true; },
    createAccounts: async ({ count }) => Array.from({ length: count }, (_, i) => `bot-${i}`),
  }, { gameId: "already", botCount: 2 });
  assert.equal(hosted, false);
  assert.equal(left, false);
  assert.equal(joined.gameId, "already");
  assert.deepEqual(normalizeAccounts(["x"]), [{ accountId: "x" }]);

  const order = [];
  const seated = await openTestingGame({
    hostGame: async () => { order.push("host"); return "fj"; },
    createAccounts: async ({ count }) => { order.push(`accounts:${count}`); return Array.from({ length: count }, (_, i) => `b${i}`); },
    leaveGame: async () => { order.push("leave"); },
  }, { setupId: "frontier-justice", botCount: 9 });
  assert.equal(seated.accounts.length, 9);
  assert.deepEqual(order, ["host", "accounts:9", "leave"]);

  const failed = [];
  await assert.rejects(() => openTestingGame({
    hostGame: async () => { failed.push("host"); return "fj"; },
    createAccounts: async () => { failed.push("accounts"); throw new Error("POST /dev/accounts -> 400"); },
    leaveGame: async () => { failed.push("leave"); },
  }, { setupId: "frontier-justice", botCount: 9 }), /400/);
  assert.deepEqual(failed, ["host", "accounts"]);
});

test("driveAccounts sends only validated actions and keeps each bot's prompt", async () => {
  const systems = [];
  const sent = [];
  const accounts = [
    { accountId: "A", promptId: "seed", promptText: "PROMPT-A\n" + SYSTEM_PROMPT },
    { accountId: "B", promptId: "other", promptText: "PROMPT-B\n" + SYSTEM_PROMPT },
  ];
  const entries = [
    ...day("A", "p1", 1),
    ...day("B", "p2", 1),
    { accountId: "Z", seq: 1, event: "self", data: "p9" },
    { accountId: "A", seq: 1, event: "self", data: "p1" },
    { accountId: "A", seq: 9, event: "winners", data: { groups: ["Village"], players: ["p1"] } },
    { accountId: "B", seq: 9, event: "winners", data: { players: ["p1"] } },
  ];
  const complete = async ({ system, user }) => {
    systems.push(system);
    if (String(user).includes("YOU: p1")) return '{"action":"vote","meeting":"mVil","target":"p9"}';
    return '{"action":"vote","meeting":"mVil","target":"p1"}';
  };
  const { proposed, results } = await driveAccounts(entries, {
    accounts, complete, dryRun: false,
    send: async (p) => { sent.push(p); },
  });
  assert.deepEqual(results.map((r) => [r.accountId, r.outcome, r.promptId]), [["A", "win", "seed"], ["B", "loss", "other"]]);
  assert.equal(sent.length, proposed.length);
  assert.ok(sent.length >= 1);
  for (const s of sent) assert.equal(validateAction(s.view, { event: s.event, data: s.data }).ok, true);
  assert.equal(sent.some((s) => s.data.selection === "p9"), false);
  assert.ok(systems.some((s) => s.startsWith("PROMPT-B")));
  const dry = [];
  await driveAccounts(day("A", "p1", 1), { accounts: [accounts[0]], dryRun: true, send: async (p) => dry.push(p) });
  assert.equal(dry.length, 0);
});

test("SSE chunks, backoff, token age, redact, and poll", async () => {
  const frames = [];
  for await (const frame of iterateSse(["event: game\ndata: {\"a\":", "1}\n\n: ping\n\n"])) frames.push(frame);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].entry, { a: 1 });
  assert.ok(backoffMs(3, { rng: () => 0 }) > backoffMs(0, { rng: () => 0 }));
  assert.equal(tokenExpired(0, TOKEN_REFRESH_MS - 1), false);
  assert.equal(tokenExpired(0, TOKEN_REFRESH_MS), true);
  assert.equal(redact("token super-secret-value used", ["super-secret-value"]), "token [redacted] used");
  const since = new Map();
  const entries = await pollOnce({
    events: async (id) => [{ seq: 2, event: "self", data: id === "A" ? "p1" : "p2" }],
  }, [{ accountId: "A" }, { accountId: "B" }], since);
  assert.equal(entries.length, 2);
  assert.equal(since.get("A"), 2);
  const sleeps = [];
  let n = 0;
  await runStreamLoop({
    maxAttempts: 2,
    sleep: async (ms) => { sleeps.push(ms); },
    backoff: () => 5,
    fetchStream: async () => {
      n++;
      if (n === 1) throw new Error("dropped");
      return ["event: game\ndata: {\"ok\":true}\n\n"];
    },
    onFrame: async (frame) => frame.entry.ok === true,
  });
  assert.equal(n, 2);
  assert.deepEqual(sleeps, [5]);
});

test("CF header stays off the model call; lmstudio targets host.docker.internal", async () => {
  const f = mockFetch(() => ({ body: { choices: [{ message: { content: "ok" } }] } }));
  const wrapped = withCfAccess(f, { clientId: "cf-id", clientSecret: "cf-secret-value" });
  await wrapped("http://127.0.0.1:3000/api/dev/token", { method: "POST", headers: {} });
  assert.equal(f.calls[0].init.headers["cf-access-client-secret"], "cf-secret-value");
  const complete = createBackendComplete({
    MAFIOSO_LLM: "lmstudio",
    LM_STUDIO_BASE_URL: "http://host.docker.internal:1234/v1",
    LM_STUDIO_MODEL: "qwen",
    LM_API_KEY: "lm-studio",
  }, { fetch: f });
  await complete({ system: "s", user: "u" });
  assert.equal(f.calls[1].url, "http://host.docker.internal:1234/v1/chat/completions");
  assert.equal(f.calls[1].init.headers["cf-access-client-secret"], undefined);
});

test("live cli hosts on 127.0.0.1:3000, sends legal votes, and stores a child prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mafioso-live-"));
  const lines = [];
  const sse = [
    ...day("A", "p1", 1),
    ...day("B", "p2", 10),
    { accountId: "A", seq: 8, event: "winners", data: { groups: ["Village"], players: ["p1"] } },
    { accountId: "B", seq: 18, event: "winners", data: { players: ["p1"] } },
  ].map((e) => `event: game\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const f = mockFetch((url, init) => {
    if (url.endsWith("/dev/token")) return { body: { token: "tok", tokenType: "Bearer", expiresIn: 3600 } };
    if (url.endsWith("/game/host")) return { body: "g-live" };
    if (url.endsWith("/dev/accounts") && init.method === "POST") return { body: [{ id: "A" }, { id: "B" }] };
    if (url.endsWith("/game/leave")) return { body: { ok: true } };
    if (url.endsWith("/dev/stream")) return { stream: [sse] };
    if (url.includes("/send")) return { body: { ok: true } };
    if (url.includes("/chat/completions")) {
      const user = JSON.parse(init.body).messages.find((m) => m.role === "user").content;
      const content = user.includes("IMPROVE THE SYSTEM PROMPT")
        ? JSON.stringify({ system: `${SYSTEM_PROMPT}\nPrefer a quiet vote.`, notes: "quieter" })
        : '{"action":"vote","meeting":"mVil","target":"*"}';
      return { body: { choices: [{ message: { content } }] } };
    }
    return { status: 404, body: { error: "unexpected" } };
  });
  const code = await runLiveCli({
    fetch: f,
    log: (m) => lines.push(m),
    sleep: async () => { throw new Error("reconnect"); },
    now: () => 1_700_000_000_000,
    rng: () => 0.99,
    env: {
      MAFIOSO_LIVE: "1",
      DEV_API_BASE_URL: "http://127.0.0.1:3000",
      DEV_API_CLIENT_ID: "cid",
      DEV_API_CLIENT_SECRET: "super-secret-value",
      DEV_SETUP_ID: "setup-1",
      BOT_COUNT: "2",
      MAFIOSO_LLM: "lmstudio",
      LM_STUDIO_BASE_URL: "http://host.docker.internal:1234/v1",
      LM_STUDIO_MODEL: "qwen",
      LM_API_KEY: "lm-studio",
      MAFIOSO_PROMPT_DIR: dir,
      PROMPT_EPSILON: "0",
      PROMPT_TEMPERATURE: "0",
      CF_ACCESS_CLIENT_ID: "cf-id",
      CF_ACCESS_CLIENT_SECRET: "cf-secret-value",
    },
  });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.equal(text.includes("super-secret-value"), false);
  assert.equal(text.includes("cf-secret-value"), false);
  assert.match(text, /127\.0\.0\.1:3000/);
  const hosts = f.calls.filter((c) => c.url.endsWith("/game/host"));
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].body.private, true);
  assert.equal(hosts[0].body.lobby, "Testing");
  const accountCall = f.calls.findIndex((c) => c.url.endsWith("/dev/accounts") && c.init.method === "POST");
  const leaveCall = f.calls.findIndex((c) => c.url.endsWith("/game/leave"));
  assert.ok(accountCall > f.calls.indexOf(hosts[0]));
  assert.ok(leaveCall > accountCall);
  assert.deepEqual(f.calls[accountCall].body, { gameId: "g-live", count: 2 });
  assert.equal(hosts[0].init.headers["cf-access-client-secret"], "cf-secret-value");
  const sends = f.calls.filter((c) => c.url.includes("/send"));
  assert.ok(sends.length >= 1);
  assert.ok(sends.every((c) => c.url.startsWith("http://127.0.0.1:3000/api/dev/accounts/")));
  assert.ok(f.calls.every((c) => !c.url.includes("ultimafia.com")));
  const chats = f.calls.filter((c) => c.url.includes("host.docker.internal:1234"));
  assert.ok(chats.length >= 1);
  assert.equal(chats[0].init.headers["cf-access-client-secret"], undefined);
  const store = JSON.parse(await fs.readFile(path.join(dir, "prompts.json"), "utf8"));
  const seed = store.prompts.find((p) => p.id === "seed");
  assert.equal(seed.gamesPlayed, 2);
  assert.equal(seed.scores.wins, 1);
  assert.equal(seed.scores.losses, 1);
  const child = store.prompts.find((p) => p.parentId === "seed");
  assert.ok(child);
  assert.match(child.text, /Prefer a quiet vote/);
  assert.match(child.text, /Never say or hint that you are an AI/);
});
