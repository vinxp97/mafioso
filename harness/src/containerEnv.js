// How scripts/mac-container-run.sh gets its environment.
// The .env file path stays. MAFIOSO_ENV_FROM_PROCESS=1 reads the same keys from
// the process environment and does not write them to a file or to argv.

function nonempty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/** Names forwarded into the container. Values stay in the process environment. */
export const CONTAINER_FORWARDED_KEYS = Object.freeze([
  "DEV_API_BASE_URL",
  "DEV_API_CLIENT_ID",
  "DEV_API_CLIENT_SECRET",
  "DEV_SETUP_ID",
  "GAME_ID",
  "BOT_COUNT",
  "LOBBY_NAME",
  "MAFIOSO_LIVE",
  "MAFIOSO_LLM",
  "MAFIOSO_TRACE",
  "MAFIOSO_TRACE_DIR",
  "MAFIOSO_TRACE_REASONING",
  "MAFIOSO_TRANSPORT",
  "DEV_STREAM_PATH",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_TITLE",
  "OPENROUTER_REASONING",
  "LM_STUDIO_BASE_URL",
  "LM_STUDIO_MODEL",
  "LM_API_KEY",
  "EXPLABS_BASE_URL",
  "EXPLABS_MODEL",
  "EXPLABS_API_KEY",
  "EXPLABS_ZDR",
  "OPENCODE_BASE_URL",
  "OPENCODE_MODEL",
  "OPENCODE_API_KEY",
  "OPENCODE_SESSION",
  "MAFIOSO_HOST_GATEWAY",
  "MAFIOSO_LLM_CONCURRENCY",
  "MAFIOSO_REASONING",
]);

/** Host-only. The script reads it and does not pass it into the container. */
export const TRACE_MOUNT_KEY = "MAFIOSO_TRACE_MOUNT";

export function llmName(env) {
  return (nonempty(env.MAFIOSO_LLM) || "lmstudio").toLowerCase();
}

/** True when the selected backend has the credential it needs. LM Studio has a built-in placeholder. */
export function hasModelCredential(env) {
  const which = llmName(env);
  if (which === "openrouter") return nonempty(env.OPENROUTER_API_KEY) !== "";
  if (which === "experiential" || which === "explabs") return nonempty(env.EXPLABS_API_KEY) !== "";
  if (which === "opencode" || which === "opencode-go") return nonempty(env.OPENCODE_API_KEY) !== "";
  if (which === "lmstudio" || which === "lm-studio") return true;
  return false;
}

export function modelCredentialError(env) {
  const which = llmName(env);
  if (hasModelCredential(env)) return "";
  if (which === "openrouter") return "OPENROUTER_API_KEY empty";
  if (which === "experiential" || which === "explabs") return "EXPLABS_API_KEY empty";
  if (which === "opencode" || which === "opencode-go") return "OPENCODE_API_KEY empty";
  return `Unknown MAFIOSO_LLM: ${which}`;
}

/**
 * Refuse to launch from the process environment when the model credential is missing.
 * Prints nothing. The caller keeps the values in its own environment.
 * @param {NodeJS.ProcessEnv} env
 */
export function assertProcessContainerEnv(env) {
  const message = modelCredentialError(env);
  if (message) throw new Error(message);
}

/**
 * Names to pass as `container run -e NAME` (no value). DEV_API_BASE_URL is included
 * after the script points it at the gateway. A host trace mount drops MAFIOSO_TRACE_DIR
 * so the container keeps its own /app/logs/traces path.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function processContainerEnvNames(env) {
  const mount = nonempty(env[TRACE_MOUNT_KEY]);
  const names = [];
  for (const key of CONTAINER_FORWARDED_KEYS) {
    if (mount && key === "MAFIOSO_TRACE_DIR") continue;
    if (nonempty(env[key])) names.push(key);
  }
  return names;
}

/** @param {string} text */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * The .env file path: OPENROUTER_API_KEY must be non-empty, and DEV_API_BASE_URL
 * is rewritten to the host gateway. This is the same rule the shell script applies.
 * @param {string} text
 * @param {string} gateway
 */
export function envFileForContainer(text, gateway) {
  const parsed = parseEnvFile(text);
  if (!nonempty(parsed.OPENROUTER_API_KEY)) {
    const err = new Error("OPENROUTER_API_KEY empty");
    err.code = "EMPTY_KEY";
    throw err;
  }
  const gw = nonempty(gateway) || "192.168.64.1";
  parsed.DEV_API_BASE_URL = `http://${gw}:3000`;
  return parsed;
}
