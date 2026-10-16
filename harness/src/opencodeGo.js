// OpenCode Go. OpenAI Chat Completions at https://opencode.ai/zen/go/v1.
// Docs: https://opencode.ai/docs/go/
// Authorization: Bearer $OPENCODE_API_KEY.
// Required header x-opencode-session: a stable id for this bot run (reused on every call).
// Example models: kimi-k2.6, mimo-v2.5, glm-5.1.
import { randomUUID } from "node:crypto";
import { createOpenAICompatibleComplete, normalizeOpenAIBase } from "./openaiCompatible.js";

export const OPENCODE_GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_USER_AGENT = "mafioso/0.1";

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Read OPENCODE_BASE_URL, OPENCODE_MODEL, OPENCODE_API_KEY, OPENCODE_SESSION.
 * session is "" when unset; the factory then generates one id for the client.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function opencodeGoConfigFromEnv(env = process.env) {
  const baseRaw = nonempty(env.OPENCODE_BASE_URL);
  return {
    baseUrl: baseRaw ? normalizeOpenAIBase(baseRaw, "OpenCode Go") : OPENCODE_GO_DEFAULT_BASE_URL,
    model: nonempty(env.OPENCODE_MODEL),
    apiKey: nonempty(env.OPENCODE_API_KEY),
    session: nonempty(env.OPENCODE_SESSION),
  };
}

/**
 * @param {{baseUrl?:string, model?:string|null, apiKey?:string|null, session?:string|null,
 *   headers?:Record<string,string>, fetch?:Function, temperature?:number, maxTokens?:number,
 *   env?:NodeJS.ProcessEnv}} [opts]
 *   session / OPENCODE_SESSION wins. Otherwise one random id is generated and sent on every call.
 * @returns {(input:{system?:string, user?:string})=>Promise<string>}
 */
export function createOpenCodeGoComplete(opts = {}) {
  if (opts == null || typeof opts !== "object") throw new Error("options must be an object");
  const env = opts.env ?? process.env;
  const baseUrl = nonempty(opts.baseUrl)
    ? opts.baseUrl
    : (nonempty(env.OPENCODE_BASE_URL) || OPENCODE_GO_DEFAULT_BASE_URL);
  const model = opts.model !== undefined ? nonempty(opts.model) : nonempty(env.OPENCODE_MODEL);
  const apiKey = opts.apiKey !== undefined ? nonempty(opts.apiKey) : nonempty(env.OPENCODE_API_KEY);
  if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
  if (!model) throw new Error("OPENCODE_MODEL is not set (examples: kimi-k2.6, mimo-v2.5, glm-5.1)");
  const session = nonempty(opts.session)
    || nonempty(env.OPENCODE_SESSION)
    || nonempty(opts.headers?.["x-opencode-session"])
    || randomUUID();
  const headers = {
    "user-agent": OPENCODE_GO_USER_AGENT,
    ...(opts.headers || {}),
    "x-opencode-session": session,
  };
  return createOpenAICompatibleComplete({
    baseUrl,
    model,
    apiKey,
    headers,
    fetch: opts.fetch,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    label: "OpenCode Go",
    discoverModels: false,
  });
}
