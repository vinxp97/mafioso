// Re-scrub a directory of sanitized logs or derived files into a new copy (originals are only read).
//   node scripts/rescrub.mjs <srcDir> <dstDir> [--raw=/workspace/live-night5-raw] [--json=report.json]
// Prints counts only, never a token. Exits 1 if the copy still holds any handle, id, account or fragment.
import fs from "node:fs";
import path from "node:path";
import { loadHandles, rescrubDir, rulesFor, scan, gameOf, RAW_DIR_DEFAULT } from "../src/rescrub.js";

const argv = process.argv.slice(2);
const [src, dst] = argv.filter((a) => !a.startsWith("--"));
const opt = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const handles = loadHandles(opt("raw", RAW_DIR_DEFAULT));
if (!handles) { console.error("rescrub: raw handle directory not found; nothing done"); process.exit(2); }
if (fs.existsSync(dst)) { console.error(`rescrub: ${dst} exists; remove it or pick a new destination`); process.exit(2); }
const report = rescrubDir(src, dst, handles);
const total = {}; let changed = 0;
for (const r of report) { const n = Object.values(r.counts || {}).reduce((a, x) => a + x, 0); if (n) changed++; for (const [k, v] of Object.entries(r.counts || {})) total[k] = (total[k] || 0) + v; }
const left = [];
for (const r of report.filter((x) => !x.binary)) { const hits = scan(fs.readFileSync(path.join(dst, r.file), "utf8"), rulesFor(handles, gameOf(r.file))); if (hits.length) left.push({ file: r.file, lines: [...new Set(hits.map((h) => h.line))] }); }
console.log(JSON.stringify({ src, dst, files: report.length, filesChanged: changed, replaced: total, remaining: left.length }));
const json = opt("json", "");
if (json) fs.writeFileSync(json, JSON.stringify({ src, dst, files: report.map((r) => ({ file: r.file, counts: r.counts || null })), replaced: total, remaining: left }, null, 1));
process.exit(left.length ? 1 : 0);
