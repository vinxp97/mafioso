import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateAction } from "mafioso-engine";
import { createLmStudioComplete, lmStudioConfigFromEnv, parseSse, runLoopAsync } from "../src/index.js";

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const out = await responder(url, init, body);
    const status = out.status ?? 200;
    const payload = out.raw != null ? out.raw : JSON.stringify(out.body ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

const chatOk = (content) => ({ body: { choices: [{ message: { role: "assistant", content } }] } });
const sse = () => parseSse(fs.readFileSync(new URL("./fixtures/stream.sse", import.meta.url), "utf8"));
const games = () => sse().filter((f) => f.type === "game").map((f) => f.entry);

test("happy path posts chat completions and returns content", async () => {
  const f = mockFetch(() => chatOk('{"action":"wait"}'));
  const complete = createLmStudioComplete({
    baseUrl: "http://127.0.0.1:1234/v1/",
    model: "qwen2.5",
    apiKey: "lm-studio",
    fetch: f,
    temperature: 0.2,
    maxTokens: 256,
    env: {},
  });
  assert.equal(f.calls.length, 0, "no network until complete()");
  const out = await complete({ system: "sys", user: "usr" });
  assert.equal(out, '{"action":"wait"}');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer lm-studio");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  assert.equal(f.calls[0].body.model, "qwen2.5");
  assert.equal(f.calls[0].body.stream, false);
  assert.equal(f.calls[0].body.temperature, 0.2);
  assert.equal(f.calls[0].body.max_tokens, 256);
  assert.deepEqual(f.calls[0].body.response_format, { type: "json_object" });
  assert.deepEqual(f.calls[0].body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "usr" },
  ]);
});

test("empty model lists /models and uses the first id", async () => {
  const f = mockFetch((url) => url.endsWith("/models")
    ? { body: { object: "list", data: [{ id: "qwen-local" }, { id: "other" }] } }
    : chatOk("ok"));
  const complete = createLmStudioComplete({
    baseUrl: "http://127.0.0.1:1234/v1", model: "", apiKey: "k", fetch: f, env: {},
  });
  assert.equal(await complete({ system: "s", user: "u" }), "ok");
  assert.equal(f.calls[0].url, "http://127.0.0.1:1234/v1/models");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer k");
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[1].body.model, "qwen-local");
  await complete({ system: "s", user: "u2" });
  assert.equal(f.calls.length, 3, "model id is cached");
  assert.equal(f.calls[2].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(f.calls[2].body.model, "qwen-local");
});

test("null model also discovers; omitted model uses LM_STUDIO_MODEL", async () => {
  const listed = mockFetch((url) => url.endsWith("/models")
    ? { body: { data: [{ id: "from-list" }] } }
    : chatOk("listed"));
  const discover = createLmStudioComplete({
    fetch: listed, model: null, env: { LM_STUDIO_MODEL: "from-env" },
  });
  assert.equal(await discover({ system: "s", user: "u" }), "listed");
  assert.equal(listed.calls[1].body.model, "from-list");

  const f = mockFetch(() => chatOk("env"));
  const fromEnv = createLmStudioComplete({
    fetch: f,
    env: { LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1/", LM_STUDIO_MODEL: "qwen-env", LM_API_KEY: "local-key" },
  });
  assert.equal(await fromEnv({ system: "s", user: "u" }), "env");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(f.calls[0].body.model, "qwen-env");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer local-key");
});

test("non-2xx throws a clear error and does not echo the request", async () => {
  const f = mockFetch(() => ({ status: 503, body: { error: "model not loaded" } }));
  const complete = createLmStudioComplete({
    model: "qwen", fetch: f, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio", env: {},
  });
  await assert.rejects(
    () => complete({ system: "s", user: "SECRET-PROMPT" }),
    (e) => {
      assert.match(e.message, /LM Studio POST \/chat\/completions -> 503/);
      assert.match(e.message, /model not loaded/);
      assert.equal(e.message.includes("SECRET-PROMPT"), false);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
});

test("missing content and empty /models list throw", async () => {
  const missing = createLmStudioComplete({
    model: "qwen", env: {},
    fetch: mockFetch(() => ({ body: { choices: [{ message: { role: "assistant" } }] } })),
  });
  await assert.rejects(() => missing({ system: "s", user: "u" }), /missing assistant message content/);

  const emptyList = createLmStudioComplete({
    model: null, env: {},
    fetch: mockFetch(() => ({ body: { data: [] } })),
  });
  await assert.rejects(() => emptyList({ system: "s", user: "u" }), /GET \/models: no model id/);

  const badList = createLmStudioComplete({
    model: "", env: {},
    fetch: mockFetch(() => ({ status: 500, body: { error: "down" } })),
  });
  await assert.rejects(() => badList({ system: "s", user: "u" }), /GET \/models -> 500/);
});

test("response_format rejection retries once without the field", async () => {
  let n = 0;
  const f = mockFetch((_url, _init, body) => {
    n += 1;
    if (body?.response_format)
      return { status: 400, body: { error: { message: "response_format is not supported", param: "response_format" } } };
    return chatOk('{"action":"wait"}');
  });
  const complete = createLmStudioComplete({
    model: "qwen", fetch: f, baseUrl: "http://127.0.0.1:1234/v1", env: {},
  });
  assert.equal(await complete({ system: "s", user: "u" }), '{"action":"wait"}');
  assert.equal(n, 2);
  assert.deepEqual(f.calls[0].body.response_format, { type: "json_object" });
  assert.equal(f.calls[1].body.response_format, undefined);
  assert.equal(f.calls[1].body.model, "qwen");
});

test("format rejection that still fails does not retry forever; unrelated 400 does not retry", async () => {
  const stuck = mockFetch(() => ({ status: 400, body: { error: "json_object response_format unsupported" } }));
  const complete = createLmStudioComplete({ model: "qwen", fetch: stuck, env: {} });
  await assert.rejects(() => complete({ system: "s", user: "u" }), /POST \/chat\/completions -> 400/);
  assert.equal(stuck.calls.length, 2);
  assert.equal(stuck.calls[1].body.response_format, undefined);

  const other = mockFetch(() => ({ status: 400, body: { error: "context length exceeded" } }));
  const complete2 = createLmStudioComplete({ model: "qwen", fetch: other, env: {} });
  await assert.rejects(() => complete2({ system: "s", user: "u" }), /context length exceeded/);
  assert.equal(other.calls.length, 1);
});

test("empty apiKey omits Authorization; bad fetch and bad base URL throw", () => {
  const f = mockFetch(() => chatOk("x"));
  const complete = createLmStudioComplete({ model: "qwen", apiKey: "", fetch: f, env: { LM_API_KEY: "nope" } });
  return complete({ system: "s", user: "u" }).then(() => {
    assert.equal(f.calls[0].init.headers.authorization, undefined);
    assert.throws(() => createLmStudioComplete({ fetch: "nope", env: {} }), /fetch/);
    assert.throws(() => createLmStudioComplete({ baseUrl: "ftp://127.0.0.1/v1", fetch: f, env: {} }), /Invalid LM Studio base URL/);
  });
});

test("env helper defaults and overrides", () => {
  assert.deepEqual(lmStudioConfigFromEnv({}), {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    apiKey: "lm-studio",
  });
  assert.deepEqual(lmStudioConfigFromEnv({
    LM_STUDIO_BASE_URL: "http://127.0.0.1:9999/v1/",
    LM_STUDIO_MODEL: " qwen ",
    LM_API_KEY: "secret",
  }), {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "qwen",
    apiKey: "secret",
  });
});

test("runLoopAsync with LM Studio complete yields validated legal actions", async () => {
  const f = mockFetch((_url, _init, body) => {
    const user = body.messages.find((m) => m.role === "user").content;
    const content = user.includes("mMaf")
      ? '{"action":"vote","meeting":"mMaf","target":"p3"}'
      : '{"action":"vote","meeting":"mVil","target":"p9"}';
    return chatOk(content);
  });
  const complete = createLmStudioComplete({
    baseUrl: "http://127.0.0.1:1234/v1", model: "qwen", fetch: f, env: {},
  });
  const { proposed, views } = await runLoopAsync(games(), { complete });
  assert.deepEqual(proposed.map((p) => [p.data.meetingId, p.data.selection, p.source]),
    [["mVil", "p2", "fallback"], ["mMaf", "p3", "llm"]]);
  // Final view is Night, so only the night proposal is still legal there.
  assert.equal(validateAction(views.A, proposed[1]).ok, true);
  assert.ok(f.calls.every((c) => c.url === "http://127.0.0.1:1234/v1/chat/completions"));
  assert.ok(f.calls.length >= 2);
});
