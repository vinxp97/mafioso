// Experiential Labs hosted gateway. OpenAI Chat Completions.
// Docs: https://platform.experientiallabs.ai/docs/openai-compatibility
// Base https://api.experientiallabs.ai/v1. Authorization: Bearer $EXPLABS_API_KEY
// (keys look like xpl_...). Example model: qwen3.8-27b.
import { createOpenAICompatibleComplete, normalizeOpenAIBase } from "./openaiCompatible.js";

export const EXPLABS_DEFAULT_BASE_URL = "https://api.experientiallabs.ai/v1";
export const EXPLABS_EXAMPLE_MODEL = "qwen3.8-27b";

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Read EXPLABS_BASE_URL, EXPLABS_MODEL, EXPLABS_API_KEY. Does not call the network.
 * apiKey is "" when unset (the factory then refuses to build a client).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function explabsConfigFromEnv(env = process.env) {
  const baseRaw = nonempty(env.EXPLABS_BASE_URL);
  return {
    baseUrl: baseRaw ? normalizeOpenAIBase(baseRaw, "Experiential Labs") : EXPLABS_DEFAULT_BASE_URL,
    model: nonempty(env.EXPLABS_MODEL),
    apiKey: nonempty(env.EXPLABS_API_KEY),
  };
}

/**
 * @param {{baseUrl?:string, model?:string|null, apiKey?:string|null, headers?:Record<string,string>,
 *   fetch?:Function, temperature?:number, maxTokens?:number, env?:NodeJS.ProcessEnv}} [opts]
 *   Requires an API key and a model (no /models discovery; the catalog's first id is not a safe default).
 *   Omit temperature unless the chosen model accepts sampling params.
 * @returns {(input:{system?:string, user?:string})=>Promise<string>}
 */
export function createExperientialComplete(opts = {}) {
  if (opts == null || typeof opts !== "object") throw new Error("options must be an object");
  const env = opts.env ?? process.env;
  const baseUrl = nonempty(opts.baseUrl)
    ? opts.baseUrl
    : (nonempty(env.EXPLABS_BASE_URL) || EXPLABS_DEFAULT_BASE_URL);
  const model = opts.model !== undefined ? nonempty(opts.model) : nonempty(env.EXPLABS_MODEL);
  const apiKey = opts.apiKey !== undefined ? nonempty(opts.apiKey) : nonempty(env.EXPLABS_API_KEY);
  if (!apiKey) throw new Error("EXPLABS_API_KEY is not set");
  if (!model) throw new Error(`EXPLABS_MODEL is not set (example: ${EXPLABS_EXAMPLE_MODEL})`);
  return createOpenAICompatibleComplete({
    baseUrl,
    model,
    apiKey,
    headers: opts.headers,
    fetch: opts.fetch,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    label: "Experiential Labs",
    discoverModels: false,
  });
}
