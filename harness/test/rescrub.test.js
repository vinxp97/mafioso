// Re-scrub (Night 6): no real handle may reach the re-sanitized copies. Real handles are read at test time from
// the box-only raw log directory and are never printed; the synthetic tests use invented names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHandles, fragmentsOf, rulesFor, scrubText, scrubContent, scan, rescrubDir, gameOf, RAW_DIR_DEFAULT } from "../src/rescrub.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rescrub-"));
function fakeRaw() {
  const d = tmp();
  fs.writeFileSync(path.join(d, "g1-abc.log.err"), 'x accounts=zzQq9Aa1,yyRr2Bb2\nseatmap s1=uidAAAA1:"MarloQuince12" s2=uidBBBB2:"Ot-PelkaZorbin7"\n');
  return d;
}

test("rescrub: fragments split on separators and camelCase; 3+ letters only", () => {
  assert.deepEqual(fragmentsOf("MarloQuince12"), ["marlo", "quince"]);
  assert.deepEqual(fragmentsOf("Ot-PelkaZorbin7"), ["pelka", "zorbin"]);
  assert.equal(gameOf("g01.rejects.jsonl"), 1); assert.equal(gameOf("fix/g3-So2.sanitized.log.err"), 3); assert.equal(gameOf("replay-on.json"), null);
});

test("rescrub: full handles, digit-less handles, ids, accounts and fragments are replaced, word-boundary aware", () => {
  const rules = rulesFor(loadHandles(fakeRaw()), 1);
  const c = {};
  const out = scrubText('MarloQuince12 said "voting marlo, quince is sus" @ marloquince; QUINCE\'s push; pelkas lol; uidAAAA1 zzQq9Aa1; marlowe stays', rules, c);
  assert.equal(out, 'Seat1 said "voting Nick1, Nick1 is sus" @ Seat1; Nick1\'s push; Nick2s lol; user1 acct1; marlowe stays');
  assert.deepEqual(c, { handle: 2, fragment: 4, id: 1, account: 1 });
  assert.deepEqual(scan(out, rules), []);
});

test("rescrub: JSON and JSONL stay valid; originals are untouched; a planted fragment is caught by the scan", () => {
  const raw = fakeRaw(); const src = tmp(); const dst = path.join(tmp(), "out");
  fs.writeFileSync(path.join(src, "g1.rejects.jsonl"), '{"line":"vote zorbin now","by":"Seat2"}\n{"line":"fine"}\n');
  fs.writeFileSync(path.join(src, "a.json"), JSON.stringify({ zorbin: ["marlo is lying"] }, null, 1));
  fs.writeFileSync(path.join(src, "clean.txt"), "nothing here\n");
  const before = fs.readFileSync(path.join(src, "g1.rejects.jsonl"), "utf8");
  const handles = loadHandles(raw);
  const report = rescrubDir(src, dst, handles);
  assert.equal(fs.readFileSync(path.join(src, "g1.rejects.jsonl"), "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, "g1.rejects.jsonl"), "utf8").split("\n")[0]).line, "vote Nick2 now");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dst, "a.json"), "utf8")), { Nick2: ["Nick1 is lying"] });
  assert.deepEqual(report.find((r) => r.file === "clean.txt").counts, {});
  const rules = rulesFor(handles, 1);
  for (const f of ["g1.rejects.jsonl", "a.json", "clean.txt"]) assert.deepEqual(scan(fs.readFileSync(path.join(dst, f), "utf8"), rules), []);
  const planted = "ok line\nsomeone said Pelka was town\n";
  assert.deepEqual(scan(planted, rules), [{ line: 2, kind: "fragment" }]);
  assert.throws(() => rescrubDir(src, src, handles), /must differ/);
});

// Box only: the real handle list and the real copies. Skipped (with the reason) anywhere else.
const RAW = process.env.RESCRUB_RAW_DIR || RAW_DIR_DEFAULT;
const COPIES = (process.env.RESCRUB_COPIES || "/workspace/restartq/live-night5-resanitized,/workspace/chat-pass-runs-resanitized,/workspace/chat-pass-eval-runs-resanitized").split(",");
const real = loadHandles(RAW);
const skipReal = !real ? `box-only: raw handle list ${RAW} is absent` : false;

function textFiles(dir) {
  const out = [];
  const visit = (d) => { for (const x of fs.readdirSync(d)) { const p = path.join(d, x); const st = fs.statSync(p); if (st.isDirectory()) visit(p); else if (/\.(log|err|txt|md|json|jsonl|mjs|js|csv)$/.test(x)) out.push(p); } };
  visit(dir); return out;
}

test("rescrub (box): no real handle, id, account or fragment in any re-sanitized copy", { skip: skipReal }, (t) => {
  let checked = 0;
  for (const dir of COPIES) {
    if (!fs.existsSync(dir)) { t.diagnostic(`copy ${dir} absent; skipped`); continue; }
    for (const f of textFiles(dir)) {
      const hits = scan(fs.readFileSync(f, "utf8"), rulesFor(real, gameOf(f)));
      // Only the file and line numbers are reported, never the token.
      assert.deepEqual(hits.map((h) => h.line), [], `${path.relative(dir, f)} still holds a handle (lines only shown)`);
      checked++;
    }
  }
  assert.ok(checked > 0, "no copies found");
});

test("rescrub (box): a real fragment planted into a copied line is caught, then scrubbed", { skip: skipReal }, () => {
  const rules = rulesFor(real, 1).filter((r) => r.kind === "fragment");
  assert.ok(rules.length > 0);
  for (const r of [rules[0], rules[Math.floor(rules.length / 2)], rules[rules.length - 1]]) {
    const text = `speech-reject acct3 [Day 1] source=llm line="Seat4 is fine"\nspeech-reject acct3 [Day 1] source=llm line="voting ${r.token[0].toUpperCase()}${r.token.slice(1)}, quiet"\n`;
    const hits = scan(text, rulesFor(real, 1));
    assert.ok(hits.some((h) => h.line === 2 && h.kind === "fragment"), "planted fragment not caught");
    assert.ok(!hits.some((h) => h.line === 1));
    assert.deepEqual(scan(scrubContent(text, "g1.log.err", rulesFor(real, 1)), rulesFor(real, 1)), []);
  }
});
