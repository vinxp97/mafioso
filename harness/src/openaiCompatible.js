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

/** message.content when it is a string. Null is "". A non-string is returned unchanged so the caller still rejects it. */
function defaultVisibleText(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : content == null ? "" : content;
}

/** Non-2xx that names the structured-output field. Auth and 404 are not retried. */
function rejectsResponseFormat(status, text) {
  if (status < 400 || status === 401 || status === 403 || status === 404) return false;
  return /response[_ ]format|json_object|json_schema/i.test(String(text ?? ""));
}

/**
 * @param {{baseUrl:string, model?:string|null, apiKey?:string|null, headers?:Record<string,string>,
 *   extraBody?:Record<string,unknown>|null, fetch?:Function, temperature?:number, maxTokens?:number,
 *   label?:string, discoverModels?:boolean, reasoningEffort?:string,
 *   readReply?:(data:object)=>string}} opts
 *   Does not read process.env. Empty model lists /models when discoverModels is true (the default).
 *   apiKey "" omits Authorization. headers are copied onto every request; apiKey still sets authorization.
 *   extraBody is merged into each chat body (OpenRouter uses it for `reasoning`).
 *   readReply picks the assistant string (OpenRouter ignores a separate reasoning field).
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
  const defaultEffort = opts.reasoningEffort || undefined;
  const onCall = typeof opts.onCall === "function" ? opts.onCall : null;
  // When set, message.reasoning is reported to onCall. It is never part of the returned string.
  const captureReasoning = opts.captureReasoning === true;
  const readReply = typeof opts.readReply === "function" ? opts.readReply : defaultVisibleText;
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

  function buildBody(model, system, user, json, callMax, effort) {
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
    const mt = callMax !== undefined ? callMax : maxTokens;
    if (mt !== undefined) body.max_tokens = mt;
    if (extraBody) Object.assign(body, extraBody);
    // reasoning_effort "none" turns off thinking on LM Studio Qwen. OpenRouter's unified
    // `reasoning` object (MiniMax mandatory) wins: speech still passes "none", which we drop.
    if (effort) {
      if (!(body.reasoning && String(effort).toLowerCase() === "none")) body.reasoning_effort = effort;
    }
    return body;
  }

  function report(info) {
    if (!onCall) return;
    try { onCall(info); } catch { /* a trace hook must not change the reply */ }
  }

  function usageOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
      else if (value && typeof value === "object") {
        const nested = usageOf(value);
        if (nested) out[key] = nested;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  function reasoningOf(message) {
    if (!captureReasoning || !message) return { reasoning: "", reasoningDetails: null };
    const raw = message.reasoning;
    let reasoning = "";
    if (typeof raw === "string") reasoning = raw;
    else if (raw != null) {
      try { reasoning = JSON.stringify(raw); } catch { reasoning = ""; }
    }
    return { reasoning, reasoningDetails: message.reasoning_details ?? null };
  }

  async function postChat(body, { allowEmpty = false } = {}) {
    const started = Date.now();
    let ok, status, text;
    try {
      ({ ok, status, text } = await request("POST /chat/completions", `${baseUrl}/chat/completions`, {
        method: "POST",
        headers: mergeHeaders(apiKey, extraHeaders, true),
        body: JSON.stringify(body),
      }));
    } catch (e) {
      report({ type: "error", model: body.model, latencyMs: Date.now() - started, status: null, error: e?.message || String(e) });
      throw e;
    }
    if (!ok) {
      const err = new Error(`${label} POST /chat/completions -> ${status}${snippet(text)}`);
      err.status = status;
      if (body.response_format && rejectsResponseFormat(status, text)) err.responseFormatRejected = true;
      // A response_format rejection is retried once by complete(). Record that as retry, not as a failed call.
      if (!err.responseFormatRejected) {
        report({
          type: status === 429 ? "rate_limit" : "error",
          model: body.model,
          latencyMs: Date.now() - started,
          status,
          error: err.message,
        });
      }
      throw err;
    }
    const data = parseJson(text, "POST /chat/completions");
    const choice = data?.choices?.[0];
    const message = choice?.message;
    // A length cutoff is a partial chat line. Drop it (the caller falls back) instead of sending the stub.
    if (allowEmpty && choice?.finish_reason === "length") {
      const err = new Error("truncated (finish_reason length)");
      err.chatReject = "truncated (finish_reason length)";
      report({
        type: "error",
        model: body.model,
        latencyMs: Date.now() - started,
        status,
        usage: usageOf(data?.usage),
        error: err.chatReject,
      });
      throw err;
    }
    // Only the visible reply. A separate reasoning field is not chat (readReply may ignore it).
    const content = readReply(data);
    const meta = {
      model: body.model,
      latencyMs: Date.now() - started,
      status,
      usage: usageOf(data?.usage),
      ...reasoningOf(message),
    };
    // Plain-text (chat line) calls: an empty reply is the caller's to judge (a reasoning model that spent its budget).
    if (allowEmpty && (content == null || content === "")) return { content: "", ...meta };
    if (typeof content !== "string" || content.length === 0) {
      const err = new Error(`${label} POST /chat/completions: missing assistant message content`);
      report({ type: "error", ...meta, error: err.message });
      throw err;
    }
    return { content, ...meta };
  }

  function finish(result, input) {
    report({
      type: "llm.call",
      model: result.model,
      latencyMs: result.latencyMs,
      status: result.status,
      usage: result.usage,
      reasoning: result.reasoning || "",
      reasoningDetails: result.reasoningDetails,
      raw: result.content,
      purpose: input?.purpose || "",
      system: input?.system,
      user: input?.user,
    });
    return result.content;
  }

  // Per call: maxTokens caps output (short chat lines); json:false asks for plain text.
  return async function complete(input = {}) {
    const { system, user, maxTokens: callMax, json = true, reasoningEffort } = input;
    const model = await ensureModel();
    const cap = finiteNumber(callMax);
    const effort = reasoningEffort || defaultEffort;
    if (!json) return finish(await postChat(buildBody(model, system, user, false, cap, effort), { allowEmpty: true }), input);
    try {
      return finish(await postChat(buildBody(model, system, user, true, cap, effort)), input);
    } catch (e) {
      if (!e?.responseFormatRejected) throw e;
      report({ type: "retry", model, reason: "response_format", status: e.status ?? null });
      return finish(await postChat(buildBody(model, system, user, false, cap, effort)), input);
    }
  };
}
