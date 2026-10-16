#!/usr/bin/env node
// One-shot ping of a local LM Studio server. Not used by `npm test`.
// The process must reach that host (same machine as LM Studio, unless you tunnel).
//
//   cd harness
//   export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1   # optional
//   export LM_STUDIO_MODEL=qwen2.5-7b-instruct           # optional; empty = first loaded
//   export LM_API_KEY=lm-studio                          # optional; any non-empty string
//   node scripts/lmstudio-smoke.mjs
import { createLmStudioComplete, lmStudioConfigFromEnv } from "../src/lmstudio.js";

const cfg = lmStudioConfigFromEnv();
const complete = createLmStudioComplete({ fetch: globalThis.fetch });
console.error(`LM Studio ${cfg.baseUrl} model=${cfg.model || "(first loaded)"}`);
try {
  const text = await complete({
    system: "You reply with one JSON object and nothing else.",
    user: 'Reply exactly {"action":"wait"}',
  });
  console.log(text);
} catch (err) {
  const cause = err?.cause?.message;
  console.error(cause ? `${err.message}: ${cause}` : (err?.message || err));
  process.exit(1);
}
