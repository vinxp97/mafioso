import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reduceAll, validateAction } from "mafioso-engine";
import { DevApiClient, HostNotAllowedError, IllegalActionError, assertAllowedBase, liveCredentials,
  parseSse, replayStream, runLoop } from "../src/index.js";

function mockFetch(responder = () => ({})) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const out = responder(url, init);
    return { ok: out.status ? out.status < 400 : true, status: out.status ?? 200, text: async () => JSON.stringify(out.body ?? out) };
  };
  fn.calls = calls; return fn;
}
const DEV = "https://dev.ultimafia.gg";
const sse = () => parseSse(fs.readFileSync(new URL("./fixtures/stream.sse", import.meta.url), "utf8"));
const games = () => sse().filter((f) => f.type === "game").map((f) => f.entry);

test("allowlist: dev and localhost ok, prod and others rejected", () => {
  assert.equal(assertAllowedBase("https://dev.ultimafia.gg/x"), DEV);
  assert.equal(assertAllowedBase("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(assertAllowedBase("http://192.168.64.1:3000"), "http://192.168.64.1:3000");
  for (const bad of ["https://ultimafia.gg", "https://ultimafia.com", "https://qa.ultimafia.gg", "https://www.ultimafia.gg",
    "http://dev.ultimafia.gg", "https://dev.ultimafia.gg.evil.com", "http://127.0.0.1:3010", "nope"])
    assert.throws(() => new DevApiClient({ baseUrl: bad, fetch: mockFetch() }), HostNotAllowedError, bad);
});

test("fetch must be injected", () => assert.throws(() => new DevApiClient({ baseUrl: DEV })));

test("token request shape; bearer used afterwards", async () => {
  const f = mockFetch((u) => u.endsWith("/dev/token") ? { token: "tok", tokenType: "Bearer", expiresIn: 3600 } : { userId: "u" });
  const c = new DevApiClient({ baseUrl: DEV, fetch: f });
  const r = await c.getToken({ clientId: "cid", clientSecret: "fake" });
  assert.deepEqual(r, { tokenType: "Bearer", expiresIn: 3600 }, "secret/token not returned");
  assert.equal(f.calls[0].url, `${DEV}/api/dev/token`);
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(f.calls[0].body, { clientId: "cid", clientSecret: "fake" });
  await c.me();
  assert.equal(f.calls[1].init.headers.authorization, "Bearer tok");
});

test("errors never leak request body", async () => {
  const c = new DevApiClient({ baseUrl: DEV, fetch: mockFetch(() => ({ status: 401, body: { error: "x" } })) });
  await assert.rejects(c.getToken({ clientId: "cid", clientSecret: "SECRET123" }), (e) => !e.message.includes("SECRET123"));
});

test("hostGame forces Testing + private; createAccounts bounds", async () => {
  const f = mockFetch(() => "gid1");
  const c = new DevApiClient({ baseUrl: DEV, fetch: f, token: "t" });
  assert.equal(await c.hostGame({ setup: "s1", private: false }), "gid1");
  assert.equal(f.calls[0].body.private, true);
  assert.equal(f.calls[0].body.lobby, "Testing");
  assert.throws(() => c.hostGame({ setup: "s1", lobby: "Main" }));
  assert.throws(() => c.hostGame({ setup: "s1", ranked: true }));
  await c.createAccounts({ gameId: "gid1", count: 3 });
  assert.deepEqual(f.calls[1].body, { gameId: "gid1", count: 3 });
  assert.throws(() => c.createAccounts({ gameId: "g", count: 51 }));
});

test("live credentials only when explicitly enabled", () => {
  assert.throws(() => liveCredentials({ DEV_API_CLIENT_ID: "a", DEV_API_CLIENT_SECRET: "b" }), /disabled/);
  assert.deepEqual(liveCredentials({ MAFIOSO_LIVE: "1", DEV_API_CLIENT_ID: "a", DEV_API_CLIENT_SECRET: "b" }), { clientId: "a", clientSecret: "b" });
});

test("SSE parse + replay: per-account views, dedup seq, keepalive ignored", () => {
  const frames = sse();
  assert.equal(frames.filter((f) => f.type === "accounts_dropped").length, 1);
  const views = replayStream(games());
  assert.equal(views.A.selfId, "p1");
  assert.equal(views.B.selfId, "p2");
  assert.equal(views.A.phase.name, "Night 1");
  assert.deepEqual(views.A.meetings.mMaf.targets, ["p2", "p3"]);
});

test("runLoop proposes only validated actions, one per meeting per state", () => {
  const { views, proposed } = runLoop(games());
  assert.deepEqual(proposed.map((p) => [p.accountId, p.data.meetingId, p.data.selection]),
    [["A", "mVil", "p2"], ["A", "mMaf", "p2"]]);
  // last proposal is legal in final view
  assert.equal(validateAction(views.A, proposed[1]).ok, true);
});

test("send blocked before HTTP when illegal; allowed when legal", async () => {
  const f = mockFetch(() => ({ ok: true }));
  const c = new DevApiClient({ baseUrl: DEV, fetch: f, token: "t" });
  const view = replayStream(games()).A;
  await assert.rejects(c.send({ accountId: "A", event: "vote", data: { meetingId: "mMaf", selection: "p1" }, view }), IllegalActionError);
  await assert.rejects(c.send({ accountId: "A", event: "speak", data: { meetingId: "nope", content: "hi" }, view }), IllegalActionError);
  assert.equal(f.calls.length, 0);
  await c.send({ accountId: "A", event: "vote", data: { meetingId: "mMaf", selection: "p3" }, view });
  assert.equal(f.calls[0].url, `${DEV}/api/dev/accounts/A/send`);
  assert.deepEqual(f.calls[0].body, { event: "vote", data: { meetingId: "mMaf", selection: "p3" } });
});

import { runLoopAsync } from "../src/index.js";
test("runLoopAsync: rules mode matches runLoop; llm mode uses model and stays legal", async () => {
  const rules = await runLoopAsync(games());
  assert.deepEqual(rules.proposed.map((p) => p.data), runLoop(games()).proposed.map((p) => p.data));
  const complete = async ({ user }) => user.includes("mMaf") ? '{"action":"vote","meeting":"mMaf","target":"p3"}'
    : '{"action":"vote","meeting":"mVil","target":"p9"}';
  const { proposed, views } = await runLoopAsync(games(), { complete });
  assert.deepEqual(proposed.map((p) => [p.data.meetingId, p.data.selection, p.source]),
    [["mVil", "p2", "fallback"], ["mMaf", "p3", "llm"]]);
  assert.equal(validateAction(views.A, proposed[1]).ok, true);
});
