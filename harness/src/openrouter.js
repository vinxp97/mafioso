// OpenRouter. OpenAI Chat Completions at https://openrouter.ai/api/v1.
// Docs: https://openrouter.ai/docs/api/reference/overview
// Authorization: Bearer $OPENROUTER_API_KEY. Default model minimax/minimax-m3.1-flash.
// Optional attribution headers (omitted when unset): HTTP-Referer, X-Title.
import { createOpenAICompatibleComplete, normalizeOpenAIBase } from "./openaiCompatible.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "minimax/minimax-m3.1-flash";

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Read OPENROUTER_BASE_URL, OPENROUTER_MODEL, OPENROUTER_API_KEY,
 * OPENROUTER_HTTP_REFERER, OPENROUTER_TITLE. Does not call the network.
 * model falls back to minimax/minimax-m3.1-flash. apiKey is "" when unset.
 * referer and title are "" when unset (those headers are then omitted).
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
  };
}

/**
 * @param {{baseUrl?:string, model?:string|null, apiKey?:string|null, referer?:string|null, title?:string|null,
 *   headers?:Record<string,string>, fetch?:Function, temperature?:number, maxTokens?:number,
 *   env?:NodeJS.ProcessEnv}} [opts]
 *   API key is required. An empty model uses minimax/minimax-m3.1-flash.
 *   HTTP-Referer and X-Title are sent only when set (env, referer/title, or headers).
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
  return createOpenAICompatibleComplete({
    baseUrl,
    model,
    apiKey,
    headers,
    fetch: opts.fetch,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    label: "OpenRouter",
    discoverModels: false,
  });
}
