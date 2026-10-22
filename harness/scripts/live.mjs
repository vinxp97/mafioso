#!/usr/bin/env node
// One private Testing game, BOT_COUNT Dev API accounts, one process.
// SIGTERM and SIGINT leave each bot, close the stream, flush the trace, then exit 130.
// MAFIOSO_LIVE=1 connects. Anything else prints a dry-run line and exits without network.
// MAFIOSO_LLM=lmstudio|experiential|opencode|openrouter (createBackendComplete). Default lmstudio.
// Live runs belong on the Windows PC (Docker) or the VPS (http://127.0.0.1:3000).
import { runLiveCli } from "../src/live.js";

try {
  const code = await runLiveCli({ signals: process });
  process.exit(code ?? 0);
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
