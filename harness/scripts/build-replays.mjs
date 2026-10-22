// Build sanitized protocol replay fixtures from live-harness logs; the logic is in src/replayBuild.js.
//   node scripts/build-replays.mjs <out-dir> <log>...
import fs from "node:fs";
import path from "node:path";
import { build, parseLog, realNamesIn } from "../src/replayBuild.js";

const [outDir, ...logs] = process.argv.slice(2);
if (!outDir || !logs.length) { console.error("usage: build-replays.mjs <out-dir> <log>..."); process.exit(2); }

const texts = logs.map((f) => fs.readFileSync(f, "utf8"));
const realNames = realNamesIn(texts);
fs.mkdirSync(outDir, { recursive: true });
const manifest = [];
const seenShapes = new Set();
let k = 0;
logs.forEach((file, i) => {
  for (const g of parseLog(texts[i])) {
    if (Object.keys(g.frames).length < 6) continue; // runs that never got past the handshake
    const r = build(g, { source: path.basename(file), realNames });
    const shape = JSON.stringify(r.out.map(({ t, ...e }) => e));
    if (seenShapes.has(shape)) continue; // same frames as an earlier run (e.g. two connect-only retries)
    seenShapes.add(shape);
    k += 1;
    const id = `g${String(k).padStart(2, "0")}`;
    fs.writeFileSync(path.join(outDir, `${id}.jsonl`), r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const { out, types, source, rejects, ...facts } = r;
    // Held/rejected lines (scrubbed like the frames), for offline audit replays: <id>.rejects.jsonl.
    if (rejects?.length) fs.writeFileSync(path.join(outDir, `${id}.rejects.jsonl`), rejects.map((x) => JSON.stringify(x)).join("\n") + "\n");
    manifest.push({ fixture: `${id}.jsonl`, sourceLog: source, ...facts, entries: out.length, observedFrameCounts: types });
  }
});
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
  note: "Rebuilt from live-harness logs (frame-type counts, meeting lines, sends, public chat, alerts, dead-seat lines, winners), not raw frame dumps. Ids, names and game ids are fake. seatBinding: seatmap (exact), recovered (the only binding the log allows), partial (ambiguousSeats could swap without contradicting the log), guessed (no evidence). roles: meetings (from the log's meeting lines), inferred (from sends; a town night actor's Cop/Journalist split may be swapped), setup order (made up). Payload shapes follow the server source.",
  fixtures: manifest,
}, null, 2) + "\n");
console.error(`wrote ${manifest.length} fixtures to ${outDir}`);
