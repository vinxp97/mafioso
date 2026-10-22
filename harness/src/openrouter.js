// OpenRouter. OpenAI Chat Completions at https://openrouter.ai/api/v1.
// Docs: https://openrouter.ai/docs/api/reference/overview
// Reasoning: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
// Authorization: Bearer $OPENROUTER_API_KEY. Default model minimax/minimax-m3.1-flash.
// Optional attribution headers (omitted when unset): HTTP-Referer, X-Title.
// MiniMax (and other mandatory-reasoning models) need reasoning.effort; speech still
// asks for reasoning_effort "none", which we drop when OpenRouter reasoning is on.
import { createOpenAICompatibleComplete, normalizeOpenAIBase } from "./openaiCompatible.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "minimax/minimax-m3.1-flash";
/** Default effort when OPENROUTER_REASONING is unset. MiniMax free rejects requests without it. */
export const OPENROUTER_DEFAULT_REASONING_EFFORT = "low";
const REASONING_EFFORTS = Object.freeze(["max", "xhigh", "high", "medium", "low", "minimal"]);

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Parse OPENROUTER_REASONING into an OpenRouter `reasoning` object, or null to omit it.
 * Unset / empty -> { effort: "low", exclude: true }.
 * off|none|0|false|no|disabled -> null.
 * on|true|1|yes|enabled -> { effort: "low", exclude: true }.
 * max|xhigh|high|medium|low|minimal -> that effort with exclude: true.
 * capture: true (MAFIOSO_TRACE_REASONING) sets exclude false so the provider returns
 * message.reasoning. That text is for the trace only; complete() still returns content.
 * @param {string|null|undefined} raw
 * @param {{capture?:boolean}} [opts]
 * @returns {{effort:string, exclude:boolean}|null}
 */
export function parseOpenRouterReasoning(raw, opts = {}) {
  const exclude = opts.capture === true ? false : true;
  const v = nonempty(raw).toLowerCase();
  if (!v) return { effort: OPENROUTER_DEFAULT_REASONING_EFFORT, exclude };
  if (/^(0|off|none|false|no|disabled)$/.test(v)) return null;
  if (/^(1|true|yes|on|enabled)$/.test(v)) return { effort: OPENROUTER_DEFAULT_REASONING_EFFORT, exclude };
  if (REASONING_EFFORTS.includes(v)) return { effort: v, exclude };
  throw new Error(`OPENROUTER_REASONING must be off|low|medium|high|minimal|max|xhigh (got ${JSON.stringify(raw)})`);
}

/**
 * Read OPENROUTER_BASE_URL, OPENROUTER_MODEL, OPENROUTER_API_KEY,
 * OPENROUTER_HTTP_REFERER, OPENROUTER_TITLE, OPENROUTER_REASONING.
 * Does not call the network. model falls back to minimax/minimax-m3.1-flash.
 * apiKey is "" when unset. referer and title are "" when unset (those headers are then omitted).
 * reasoning is { effort, exclude:true } by default (low); null when reasoning is off.
 * This helper does not read MAFIOSO_TRACE_REASONING. The factory does, and only there exclude becomes false.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function openrouterConfigFromEnv(env = process.env) {
  const baseRaw = nonempty(env.OPENROUTER_BASE_URL);
  return {
    baseUrl: baseRaw ? normalizeOpenAIBase(baseRaw, "OpenRouter") : OPENROUTER_DEFAULT_BASE_URL,
    model: nonempty(env.OPENROUTER_MODEL) || OPENROUTER_DEFAULT_MODEL,
    apiKey: nonempty(env.OPENROUTER_API_KEY),
    referer: nonempty(env.OPENROUTER_HTTP_REFERER),
    title: nonempty(env.OPENROUTER_TITLE),
    reasoning: parseOpenRouterReasoning(env.OPENROUTER_REASONING),
  };
}

/**
 * @param {{baseUrl?:string, model?:string|null, apiKey?:string|null, referer?:string|null, title?:string|null,
 *   reasoning?:{effort?:string, exclude?:boolean}|null|false, headers?:Record<string,string>, fetch?:Function,
 *   temperature?:number, maxTokens?:number, env?:NodeJS.ProcessEnv}} [opts]
 *   API key is required. An empty model uses minimax/minimax-m3.1-flash.
 *   HTTP-Referer and X-Title are sent only when set (env, referer/title, or headers).
 *   reasoning defaults from OPENROUTER_REASONING (low). Pass null/false to omit.
 * @returns {(input:{system?:string, user?:string})=>Promise<string>}
 */
export function createOpenRouterComplete(opts = {}) {
  if (opts == null || typeof opts !== "object") throw new Error("options must be an object");
  const env = opts.env ?? process.env;
  const baseUrl = nonempty(opts.baseUrl)
    ? opts.baseUrl
    : (nonempty(env.OPENROUTER_BASE_URL) || OPENROUTER_DEFAULT_BASE_URL);
  const model = nonempty(opts.model !== undefined ? opts.model : env.OPENROUTER_MODEL) || OPENROUTER_DEFAULT_MODEL;
  const apiKey = opts.apiKey !== undefined ? nonempty(opts.apiKey) : nonempty(env.OPENROUTER_API_KEY);
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const referer = opts.referer !== undefined ? nonempty(opts.referer) : nonempty(env.OPENROUTER_HTTP_REFERER);
  const title = opts.title !== undefined ? nonempty(opts.title) : nonempty(env.OPENROUTER_TITLE);
  const headers = { ...(opts.headers || {}) };
  if (referer && headers["HTTP-Referer"] == null) headers["HTTP-Referer"] = referer;
  if (title && headers["X-Title"] == null) headers["X-Title"] = title;

  // Default exclude stays true. The trace flag asks the provider to return chain-of-thought
  // in message.reasoning; createOpenAICompatibleComplete does not put that field in the reply.
  const captureReasoning = opts.captureReasoning === true || env.MAFIOSO_TRACE_REASONING === "1";
  let reasoning;
  if (opts.reasoning === false || opts.reasoning === null) reasoning = null;
  else if (opts.reasoning && typeof opts.reasoning === "object") {
    const effort = nonempty(opts.reasoning.effort) || OPENROUTER_DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.includes(effort.toLowerCase())) {
      throw new Error(`OpenRouter reasoning.effort must be one of ${REASONING_EFFORTS.join("|")}`);
    }
    reasoning = { effort: effort.toLowerCase(), exclude: captureReasoning ? false : opts.reasoning.exclude !== false };
  } else {
    reasoning = parseOpenRouterReasoning(env.OPENROUTER_REASONING, { capture: captureReasoning });
  }

  // Leave room for low-effort reasoning + a short chat line / JSON action when the caller omits maxTokens.
  const maxTokens = opts.maxTokens !== undefined ? opts.maxTokens : (reasoning ? 1024 : undefined);

  return createOpenAICompatibleComplete({
    baseUrl,
    model,
    apiKey,
    headers,
    fetch: opts.fetch,
    temperature: opts.temperature,
    maxTokens,
    label: "OpenRouter",
    discoverModels: false,
    onCall: opts.onCall,
    captureReasoning,
    ...(reasoning ? { extraBody: { reasoning } } : {}),
  });
}
