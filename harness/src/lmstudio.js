// LM Studio on the local machine. Thin wrapper over createOpenAICompatibleComplete.
// Default http://127.0.0.1:1234/v1. Bearer any non-empty key (default lm-studio).
// Empty model GETs /v1/models and uses the first id.
import { createOpenAICompatibleComplete, normalizeOpenAIBase } from "./openaiCompatible.js";

export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const LM_STUDIO_DEFAULT_API_KEY = "lm-studio";

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/** @param {string} raw */
export function normalizeLmStudioBase(raw) {
  return normalizeOpenAIBase(raw, "LM Studio");
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

/**
 * @param {{baseUrl?:string, model?:string|null, apiKey?:string|null, headers?:Record<string,string>,
 *   fetch?:Function, temperature?:number, maxTokens?:number, env?:NodeJS.ProcessEnv}} [opts]
 *   Explicit model/apiKey (including null or "") win over env. Omit them to read env.
 *   Pass env:{} in tests so a developer shell cannot leak into assertions.
 * @returns {(input:{system?:string, user?:string})=>Promise<string>}
 */
export function createLmStudioComplete(opts = {}) {
  if (opts == null || typeof opts !== "object") throw new Error("options must be an object");
  const env = opts.env ?? process.env;
  // Only read LM_STUDIO_BASE_URL when the caller did not pass a baseUrl.
  const baseUrl = nonempty(opts.baseUrl)
    ? opts.baseUrl
    : (nonempty(env.LM_STUDIO_BASE_URL) || LM_STUDIO_DEFAULT_BASE_URL);
  // null/"" → discover. undefined → env (which may itself be empty).
  const model = opts.model !== undefined ? opts.model : nonempty(env.LM_STUDIO_MODEL);
  const apiKey = opts.apiKey !== undefined
    ? nonempty(opts.apiKey)
    : (nonempty(env.LM_API_KEY) || LM_STUDIO_DEFAULT_API_KEY);
  return createOpenAICompatibleComplete({
    baseUrl,
    model,
    apiKey,
    headers: opts.headers,
    fetch: opts.fetch,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    label: "LM Studio",
    discoverModels: true,
  });
}
