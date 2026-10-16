#!/usr/bin/env node
// One private Testing game, BOT_COUNT Dev API accounts, one process.
// MAFIOSO_LIVE=1 connects. Anything else prints a dry-run line and exits without network.
// Live runs belong on the Windows PC (Docker) or the VPS (http://127.0.0.1:3000).
import { runLiveCli } from "../src/live.js";

try {
  const code = await runLiveCli({ signals: process });
  process.exit(code ?? 0);
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
