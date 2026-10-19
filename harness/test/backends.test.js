import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateAction } from "mafioso-engine";
import {
  createExperientialComplete, createLmStudioComplete, createOpenAICompatibleComplete, createOpenCodeGoComplete,
  createOpenRouterComplete, createBackendComplete, OPENROUTER_DEFAULT_MODEL,
  explabsConfigFromEnv, opencodeGoConfigFromEnv, openrouterConfigFromEnv, parseSse, runLoopAsync, OPENCODE_GO_USER_AGENT,
} from "../src/index.js";

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

test("shared client sends extra headers and bearer on chat completions", async () => {
  const f = mockFetch(() => chatOk('{"action":"wait"}'));
  const complete = createOpenAICompatibleComplete({
    baseUrl: "https://example.test/v1/",
    model: "demo",
    apiKey: "k",
    headers: { "X-Trace": "abc" },
    fetch: f,
    label: "Example",
  });
  assert.equal(await complete({ system: "sys", user: "usr" }), '{"action":"wait"}');
  assert.equal(f.calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer k");
  assert.equal(f.calls[0].init.headers["X-Trace"], "abc");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  assert.equal(f.calls[0].body.model, "demo");
  assert.deepEqual(f.calls[0].body.response_format, { type: "json_object" });
  assert.equal(f.calls[0].body.stream, false);
});

test("Experiential Labs posts bearer, model, and json_object", async () => {
  const f = mockFetch(() => chatOk('{"action":"wait"}'));
  const complete = createExperientialComplete({
    model: "qwen3.8-27b",
    apiKey: "xpl_test",
    fetch: f,
    env: {},
  });
  assert.equal(await complete({ system: "s", user: "u" }), '{"action":"wait"}');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://api.experientiallabs.ai/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer xpl_test");
  assert.equal(f.calls[0].body.model, "qwen3.8-27b");
  assert.equal(f.calls[0].body.temperature, undefined);
  assert.deepEqual(f.calls[0].body.messages, [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ]);
  assert.deepEqual(f.calls[0].body.response_format, { type: "json_object" });
});

test("Experiential Labs reads env, overrides base URL, and refuses a missing key", async () => {
  const f = mockFetch(() => chatOk("ok"));
  const complete = createExperientialComplete({
    fetch: f,
    env: {
      EXPLABS_BASE_URL: "https://gateway.example/v1/",
      EXPLABS_MODEL: "qwen3.8-27b",
      EXPLABS_API_KEY: "xpl_from_env",
    },
  });
  assert.equal(await complete({ system: "s", user: "u" }), "ok");
  assert.equal(f.calls[0].url, "https://gateway.example/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer xpl_from_env");
  assert.equal(f.calls[0].body.model, "qwen3.8-27b");

  const idle = mockFetch(() => chatOk("nope"));
  assert.throws(() => createExperientialComplete({ model: "qwen3.8-27b", fetch: idle, env: {} }), /EXPLABS_API_KEY/);
  assert.throws(() => createExperientialComplete({ apiKey: "xpl_test", fetch: idle, env: {} }), /EXPLABS_MODEL/);
  assert.equal(idle.calls.length, 0);
  await assert.rejects(
    createExperientialComplete({
      model: "qwen3.8-27b", apiKey: "xpl_supersecret", fetch: mockFetch(() => ({ status: 401, body: { error: "unauthorized" } })), env: {},
    })({ system: "s", user: "prompt" }),
    (e) => {
      assert.match(e.message, /Experiential Labs POST \/chat\/completions -> 401/);
      assert.equal(e.message.includes("xpl_supersecret"), false);
      assert.equal(e.message.includes("prompt"), false);
      return true;
    },
  );
});

test("explabs env helper defaults", () => {
  assert.deepEqual(explabsConfigFromEnv({}), {
    baseUrl: "https://api.experientiallabs.ai/v1",
    model: "",
    apiKey: "",
  });
});

test("OpenCode Go sends bearer, user-agent, and a stable session header", async () => {
  const f = mockFetch(() => chatOk('{"action":"wait"}'));
  const complete = createOpenCodeGoComplete({
    model: "kimi-k2.6",
    apiKey: "oc-test",
    fetch: f,
    env: {},
  });
  assert.equal(await complete({ system: "s", user: "u" }), '{"action":"wait"}');
  await complete({ system: "s", user: "u2" });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.url === "https://opencode.ai/zen/go/v1/chat/completions"));
  assert.equal(f.calls[0].init.headers.authorization, "Bearer oc-test");
  assert.equal(f.calls[0].init.headers["user-agent"], OPENCODE_GO_USER_AGENT);
  const session = f.calls[0].init.headers["x-opencode-session"];
  assert.match(session, /^[0-9a-f-]{36}$/);
  assert.equal(f.calls[1].init.headers["x-opencode-session"], session);
  assert.equal(f.calls[0].body.model, "kimi-k2.6");
  assert.deepEqual(f.calls[0].body.response_format, { type: "json_object" });
});

test("OpenCode Go uses OPENCODE_SESSION and env model; missing key does not fetch", async () => {
  const f = mockFetch(() => chatOk("ok"));
  const complete = createOpenCodeGoComplete({
    fetch: f,
    env: {
      OPENCODE_BASE_URL: "https://go.example/v1/",
      OPENCODE_MODEL: "glm-5.1",
      OPENCODE_API_KEY: "oc-env",
      OPENCODE_SESSION: "game-42",
    },
  });
  await complete({ system: "s", user: "u" });
  await complete({ system: "s", user: "again" });
  assert.equal(f.calls[0].url, "https://go.example/v1/chat/completions");
  assert.equal(f.calls[0].body.model, "glm-5.1");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer oc-env");
  assert.equal(f.calls[0].init.headers["x-opencode-session"], "game-42");
  assert.equal(f.calls[1].init.headers["x-opencode-session"], "game-42");

  const idle = mockFetch(() => chatOk("nope"));
  assert.throws(() => createOpenCodeGoComplete({ model: "mimo-v2.5", fetch: idle, env: {} }), /OPENCODE_API_KEY/);
  assert.throws(() => createOpenCodeGoComplete({ apiKey: "oc-test", fetch: idle, env: {} }), /OPENCODE_MODEL/);
  assert.equal(idle.calls.length, 0);
});

test("opencode env helper leaves session empty when unset", () => {
  assert.deepEqual(opencodeGoConfigFromEnv({}), {
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "",
    apiKey: "",
    session: "",
  });
  assert.equal(opencodeGoConfigFromEnv({ OPENCODE_SESSION: " abc " }).session, "abc");
});

test("explicit session option wins over a header and env", async () => {
  const f = mockFetch(() => chatOk("ok"));
  const complete = createOpenCodeGoComplete({
    model: "mimo-v2.5",
    apiKey: "oc-test",
    session: "from-opt",
    headers: { "x-opencode-session": "from-header", "x-extra": "1" },
    fetch: f,
    env: { OPENCODE_SESSION: "from-env" },
  });
  await complete({ system: "s", user: "u" });
  assert.equal(f.calls[0].init.headers["x-opencode-session"], "from-opt");
  assert.equal(f.calls[0].init.headers["x-extra"], "1");
  assert.equal(f.calls[0].init.headers["user-agent"], OPENCODE_GO_USER_AGENT);
});

test("OpenRouter posts bearer and the default MiniMax model", async () => {
  const f = mockFetch(() => chatOk('{"action":"wait"}'));
  const complete = createOpenRouterComplete({ apiKey: "sk-or-test", fetch: f, env: {} });
  assert.equal(await complete({ system: "s", user: "u" }), '{"action":"wait"}');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer sk-or-test");
  assert.equal(f.calls[0].body.model, OPENROUTER_DEFAULT_MODEL);
  assert.equal(OPENROUTER_DEFAULT_MODEL, "minimax/minimax-m3.1-flash");
  assert.equal(f.calls[0].init.headers["HTTP-Referer"], undefined);
  assert.equal(f.calls[0].init.headers["X-Title"], undefined);
  assert.deepEqual(f.calls[0].body.response_format, { type: "json_object" });
  assert.equal(f.calls[0].body.stream, false);
});

test("OpenRouter reads env, optional headers, and refuses a missing key without fetching", async () => {
  const f = mockFetch(() => chatOk("ok"));
  const complete = createOpenRouterComplete({
    fetch: f,
    env: {
      OPENROUTER_BASE_URL: "https://gateway.example/v1/",
      OPENROUTER_MODEL: "other/model",
      OPENROUTER_API_KEY: "sk-or-from-env",
      OPENROUTER_HTTP_REFERER: "https://example.test/mafioso",
      OPENROUTER_TITLE: "mafioso",
    },
  });
  assert.equal(await complete({ system: "s", user: "u" }), "ok");
  assert.equal(f.calls[0].url, "https://gateway.example/v1/chat/completions");
  assert.equal(f.calls[0].body.model, "other/model");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer sk-or-from-env");
  assert.equal(f.calls[0].init.headers["HTTP-Referer"], "https://example.test/mafioso");
  assert.equal(f.calls[0].init.headers["X-Title"], "mafioso");

  const idle = mockFetch(() => chatOk("nope"));
  assert.throws(() => createOpenRouterComplete({ model: "minimax/minimax-m3.1-flash", fetch: idle, env: {} }), /OPENROUTER_API_KEY/);
  assert.equal(idle.calls.length, 0);
  await assert.rejects(
    createOpenRouterComplete({
      apiKey: "sk-or-supersecret", fetch: mockFetch(() => ({ status: 401, body: { error: "unauthorized" } })), env: {},
    })({ system: "s", user: "prompt" }),
    (e) => {
      assert.match(e.message, /OpenRouter POST \/chat\/completions -> 401/);
      assert.equal(e.message.includes("sk-or-supersecret"), false);
      assert.equal(e.message.includes("prompt"), false);
      return true;
    },
  );
});

test("openrouter env helper defaults the model and leaves the key and headers empty", () => {
  assert.deepEqual(openrouterConfigFromEnv({}), {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "minimax/minimax-m3.1-flash",
    apiKey: "",
    referer: "",
    title: "",
  });
  assert.equal(openrouterConfigFromEnv({ OPENROUTER_TITLE: " mafioso " }).title, "mafioso");
});

test("MAFIOSO_LLM=openrouter uses the OpenRouter factory", async () => {
  const f = mockFetch(() => chatOk("ok"));
  const complete = createBackendComplete({
    MAFIOSO_LLM: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
  }, { fetch: f });
  await complete({ system: "s", user: "u" });
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(f.calls[0].body.model, "minimax/minimax-m3.1-flash");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer sk-or-test");
  assert.throws(() => createBackendComplete({ MAFIOSO_LLM: "nope" }, { fetch: f }), /openrouter/);
});

test("LM Studio still forwards extra headers through the shared client", async () => {
  const f = mockFetch(() => chatOk("ok"));
  const complete = createLmStudioComplete({
    model: "qwen", apiKey: "lm-studio", headers: { "x-local": "yes" }, fetch: f, env: {},
  });
  await complete({ system: "s", user: "u" });
  assert.equal(f.calls[0].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(f.calls[0].init.headers["x-local"], "yes");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer lm-studio");
});

test("OpenCode Go complete stays inside runLoopAsync validation", async () => {
  const f = mockFetch((_url, _init, body) => {
    const user = body.messages.find((m) => m.role === "user").content;
    const content = user.includes("mMaf")
      ? '{"action":"vote","meeting":"mMaf","target":"p3"}'
      : '{"action":"vote","meeting":"mVil","target":"p9"}';
    return chatOk(content);
  });
  const complete = createOpenCodeGoComplete({
    model: "kimi-k2.6", apiKey: "oc-test", session: "loop-1", fetch: f, env: {},
  });
  const { proposed, views } = await runLoopAsync(games(), { complete });
  assert.deepEqual(proposed.map((p) => [p.data.meetingId, p.data.selection, p.source]),
    [["mVil", "p2", "fallback"], ["mMaf", "p3", "llm"]]);
  assert.equal(validateAction(views.A, proposed[1]).ok, true);
  assert.ok(f.calls.every((c) => c.init.headers["x-opencode-session"] === "loop-1"));
  assert.ok(f.calls.every((c) => c.url === "https://opencode.ai/zen/go/v1/chat/completions"));
});

test("speech calls turn reasoning off and cap tokens; plain text, no JSON mode", async () => {
  const { createOpenAICompatibleComplete } = await import("../src/openaiCompatible.js");
  const bodies = [];
  const complete = createOpenAICompatibleComplete({ baseUrl: "http://x/v1", model: "m", label: "t",
    fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: "ya" } }] }), { status: 200 }); } });
  await complete({ system: "s", user: "u", maxTokens: 40, json: false, reasoningEffort: "none" });
  assert.equal(bodies[0].reasoning_effort, "none");
  assert.equal(bodies[0].max_tokens, 40);
  assert.equal(bodies[0].response_format, undefined);
  await complete({ system: "s", user: "u" });
  assert.equal(bodies[1].reasoning_effort, undefined);
});
