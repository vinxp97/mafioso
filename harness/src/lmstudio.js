// OpenAI-compatible LM Studio client. Returns complete({system, user}) -> string
// for llmDecide / runLoopAsync. Game traffic stays on DevApiClient + DEV_HOSTS.
//
// POST {baseUrl}/chat/completions with system+user messages, stream:false, and
// response_format json_object. If the server rejects that field, retry once
// without it. An empty model GETs {baseUrl}/models and uses the first id.

export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const LM_STUDIO_DEFAULT_API_KEY = "lm-studio";

function nonempty(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s;
}

function snippet(text, n = 180) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return `: ${s.length > n ? `${s.slice(0, n)}…` : s}`;
}

/** API root including /v1. Trailing slash stripped. http(s) only. */
export function normalizeLmStudioBase(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("LM Studio base URL is empty");
  let url;
  try { url = new URL(trimmed); } catch { throw new Error(`Invalid LM Studio base URL: ${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Invalid LM Studio base URL: ${raw}`);
  return url.toString().replace(/\/+$/, "");
}

/**
 * Read LM_STUDIO_BASE_URL, LM_STUDIO_MODEL, LM_API_KEY.
 * Missing values become the local defaults (model "" means "list /models").
 * @param {NodeJS.ProcessEnv} [env]
 */
export function lmStudioConfigFromEnv(env = process.env) {
  const baseRaw = nonempty(env.LM_STUDIO_BASE_URL);
  return {
    baseUrl: baseRaw ? normalizeLmStudioBase(baseRaw) : LM_STUDIO_DEFAULT_BASE_URL,
    model: nonempty(env.LM_STUDIO_MODEL),
    apiKey: nonempty(env.LM_API_KEY) || LM_STUDIO_DEFAULT_API_KEY,
  };
}

function finiteNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

function authHeaders(apiKey) {
  const headers = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Non-2xx that names the structured-output field. Auth and 404 are not retried. */
function rejectsResponseFormat(status, text) {
  if (status < 400 || status === 401 || status === 403 || status === 404) return false;
  return /response[_ ]format|json_object|json_schema/i.test(String(text ?? ""));
}

function parseJson(text, what) {
  try { return JSON.parse(text); }
  catch { throw new Error(`LM Studio ${what}: response was not JSON${snippet(text)}`); }
}

/**
 * @param {{baseUrl?:string, model?:string|null, apiKey?:string|null, fetch?:Function,
 *   temperature?:number, maxTokens?:number, env?:NodeJS.ProcessEnv}} [opts]
 *   Explicit model/apiKey (including null or "") win over env. Omit them to read env.
 *   Pass env:{} in tests so a developer shell cannot leak into assertions.
 * @returns {(input:{system?:string, user?:string})=>Promise<string>}
 */
export function createLmStudioComplete(opts = {}) {
  if (opts == null || typeof opts !== "object") throw new Error("options must be an object");
  const env = opts.env ?? process.env;
  // Only parse LM_STUDIO_BASE_URL when the caller did not pass a baseUrl,
  // so a bad env value cannot block an explicit URL.
  const baseUrl = normalizeLmStudioBase(
    nonempty(opts.baseUrl) ? opts.baseUrl : lmStudioConfigFromEnv(env).baseUrl,
  );
  // null/"" → discover. undefined → env (which may itself be empty).
  const configuredModel = opts.model !== undefined ? nonempty(opts.model) : nonempty(env.LM_STUDIO_MODEL);
  const apiKey = opts.apiKey !== undefined
    ? nonempty(opts.apiKey)
    : (nonempty(env.LM_API_KEY) || LM_STUDIO_DEFAULT_API_KEY);
  const temperature = finiteNumber(opts.temperature);
  const maxTokens = finiteNumber(opts.maxTokens);
  const doFetch = opts.fetch !== undefined ? opts.fetch : globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== "function") throw new Error("fetch must be injected or available as global fetch");

  let resolvedModel = configuredModel;

  async function request(label, url, init) {
    let res;
    try { res = await doFetch(url, init); }
    catch (e) {
      const err = new Error(`LM Studio ${label} failed: ${e?.message || e}`);
      err.cause = e;
      throw err;
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  async function discoverModel() {
    const { ok, status, text } = await request("GET /models", `${baseUrl}/models`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    if (!ok) throw new Error(`LM Studio GET /models -> ${status}${snippet(text)}`);
    const data = parseJson(text, "GET /models");
    const id = data?.data?.[0]?.id;
    if (id == null || String(id).trim() === "")
      throw new Error("LM Studio GET /models: no model id in response (load a model in LM Studio)");
    return String(id).trim();
  }

  async function ensureModel() {
    if (resolvedModel) return resolvedModel;
    resolvedModel = await discoverModel();
    return resolvedModel;
  }

  function buildBody(model, system, user, json) {
    const body = {
      model,
      messages: [
        { role: "system", content: String(system ?? "") },
        { role: "user", content: String(user ?? "") },
      ],
      stream: false,
    };
    if (json) body.response_format = { type: "json_object" };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    return body;
  }

  async function postChat(body) {
    const { ok, status, text } = await request("POST /chat/completions", `${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!ok) {
      const err = new Error(`LM Studio POST /chat/completions -> ${status}${snippet(text)}`);
      err.status = status;
      if (body.response_format && rejectsResponseFormat(status, text)) err.responseFormatRejected = true;
      throw err;
    }
    const data = parseJson(text, "POST /chat/completions");
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0)
      throw new Error("LM Studio POST /chat/completions: missing assistant message content");
    return content;
  }

  return async function complete({ system, user } = {}) {
    const model = await ensureModel();
    try {
      return await postChat(buildBody(model, system, user, true));
    } catch (e) {
      if (!e?.responseFormatRejected) throw e;
      return await postChat(buildBody(model, system, user, false));
    }
  };
}
