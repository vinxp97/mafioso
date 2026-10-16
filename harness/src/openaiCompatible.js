// Shared OpenAI Chat Completions client. Returns complete({system, user}) -> string
// for llmDecide / runLoopAsync. Not the game API: DEV_HOSTS is unchanged.
//
// POST {baseUrl}/chat/completions (baseUrl is the /v1 root) with system+user
// messages, stream:false, and response_format json_object. If the server rejects
// that field, retry once without it. An empty model GETs {baseUrl}/models and
// uses the first id when discoverModels is true.

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

function snippet(text, n = 180) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return `: ${s.length > n ? `${s.slice(0, n)}…` : s}`;
}

function finiteNumber(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

/** API root including /v1. Trailing slash stripped. http(s) only. */
export function normalizeOpenAIBase(raw, label = "OpenAI-compatible") {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error(`${label} base URL is empty`);
  let url;
  try { url = new URL(trimmed); } catch { throw new Error(`Invalid ${label} base URL: ${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Invalid ${label} base URL: ${raw}`);
  return url.toString().replace(/\/+$/, "");
}

function mergeHeaders(apiKey, extra, withContentType) {
  const headers = { accept: "application/json" };
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v == null || String(v).trim() === "") continue;
      headers[k] = String(v);
    }
  }
  if (withContentType) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Non-2xx that names the structured-output field. Auth and 404 are not retried. */
function rejectsResponseFormat(status, text) {
  if (status < 400 || status === 401 || status === 403 || status === 404) return false;
  return /response[_ ]format|json_object|json_schema/i.test(String(text ?? ""));
}

/**
 * @param {{baseUrl:string, model?:string|null, apiKey?:string|null, headers?:Record<string,string>,
 *   fetch?:Function, temperature?:number, maxTokens?:number, label?:string, discoverModels?:boolean}} opts
 *   Does not read process.env. Empty model lists /models when discoverModels is true (the default).
 *   apiKey "" omits Authorization. headers are copied onto every request; apiKey still sets authorization.
 * @returns {(input:{system?:string, user?:string})=>Promise<string>}
 */
export function createOpenAICompatibleComplete(opts = {}) {
  if (opts == null || typeof opts !== "object") throw new Error("options must be an object");
  const label = nonempty(opts.label) || "OpenAI-compatible";
  const baseUrl = normalizeOpenAIBase(opts.baseUrl, label);
  const discoverModels = opts.discoverModels !== false;
  const configuredModel = nonempty(opts.model);
  if (!configuredModel && !discoverModels) throw new Error(`${label} model is not set`);
  const apiKey = nonempty(opts.apiKey);
  const extraHeaders = opts.headers;
  const extraBody = opts.extraBody && typeof opts.extraBody === "object" ? opts.extraBody : null;
  const temperature = finiteNumber(opts.temperature);
  const maxTokens = finiteNumber(opts.maxTokens);
  const doFetch = opts.fetch !== undefined ? opts.fetch : globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== "function") throw new Error("fetch must be injected or available as global fetch");

  let resolvedModel = configuredModel;

  function parseJson(text, what) {
    try { return JSON.parse(text); }
    catch { throw new Error(`${label} ${what}: response was not JSON${snippet(text)}`); }
  }

  async function request(what, url, init) {
    let res;
    try { res = await doFetch(url, init); }
    catch (e) {
      const err = new Error(`${label} ${what} failed: ${e?.message || e}`);
      err.cause = e;
      throw err;
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  async function discoverModel() {
    const { ok, status, text } = await request("GET /models", `${baseUrl}/models`, {
      method: "GET",
      headers: mergeHeaders(apiKey, extraHeaders, false),
    });
    if (!ok) throw new Error(`${label} GET /models -> ${status}${snippet(text)}`);
    const data = parseJson(text, "GET /models");
    const id = data?.data?.[0]?.id;
    if (id == null || String(id).trim() === "")
      throw new Error(`${label} GET /models: no model id in response`);
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
    if (extraBody) Object.assign(body, extraBody);
    return body;
  }

  async function postChat(body) {
    const { ok, status, text } = await request("POST /chat/completions", `${baseUrl}/chat/completions`, {
      method: "POST",
      headers: mergeHeaders(apiKey, extraHeaders, true),
      body: JSON.stringify(body),
    });
    if (!ok) {
      const err = new Error(`${label} POST /chat/completions -> ${status}${snippet(text)}`);
      err.status = status;
      if (body.response_format && rejectsResponseFormat(status, text)) err.responseFormatRejected = true;
      throw err;
    }
    const data = parseJson(text, "POST /chat/completions");
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0)
      throw new Error(`${label} POST /chat/completions: missing assistant message content`);
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
