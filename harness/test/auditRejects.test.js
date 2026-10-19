// audit-fp 10/19: the rejected/held lines of live games L2-L8 (fixtures/live-1018/lNN.rejects.jsonl), replayed
// offline through today's validators and chatAudit (scripts/audit-rejects.mjs). No model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { auditRejects, tally, lineFromDetail, ruleOf } from "../scripts/audit-rejects.mjs";

const dir = new URL("./fixtures/live-1018/", import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const all = [];
for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  const id = `l0${n}`;
  for (const x of auditRejects(read(`${id}.jsonl`), read(`${id}.rejects.jsonl`), id)) all.push({ game: id, ...x });
}
const t = tally(all);

test("live-1018 rejects: 297, labelled true catch / false positive / stale per rule", () => {
  assert.equal(all.length, 297);
  const n = (label) => all.filter((x) => x.label.label === label).length;
  assert.deepEqual({ true: n("true"), fp: n("fp"), flag: n("fp-flag"), stale: n("stale"), other: n("other") }, { true: 135, fp: 6, flag: 7, stale: 148, other: 1 });
  // The suspected false-positive rules are true catches on this record.
  for (const r of ["lynch-sheriff", "accuses-sheriff", "attacks-sheriff", "doubts-sheriff", "claim-count", "faction-admit"]) assert.equal(t[r].fp + t[r]["fp-flag"], 0, r);
  assert.deepEqual([t.misquote.n, t.misquote.fp], [5, 5]);
  assert.deepEqual([t.flip.n, t.flip.true, t.flip.fp], [9, 8, 1]);
});

test("live-1018 rejects: every false positive passes today; every replayable true catch is still caught", () => {
  for (const x of all) {
    const r = x.today || x.rebuilt;
    if (!r) continue;
    const blocked = !r.ok || r.audit.length > 0;
    if (x.label.label === "fp") assert.equal(blocked, false, `${x.game} ${x.rule}: ${x.line || x.rebuiltLine}`);
    if (x.label.label === "true") assert.equal(blocked, true, `${x.game} ${x.rule}: ${x.line || x.rebuiltLine}`);
  }
  // The L-1 vt claim stays blocked by default (claimPressure "l1" is off).
  assert.ok(all.filter((x) => x.label.label === "fp-flag").every((x) => x.today && !x.today.ok));
});

test("audit-rejects helpers: rule names and lines rebuilt from the reject detail", () => {
  assert.equal(ruleOf(["held line invalid at send: chat-audit: CONTRADICTION dead-sus (calls player03 sus, who is dead)"]), "dead-sus (held)");
  assert.equal(ruleOf(["stale reply (48s after the line it answers)"]), "stale reply");
  assert.equal(lineFromDetail("misquote", ['chat-audit: CONTRADICTION misquote (player06 never said "inno, that\'s my top read")']), "player06 said inno, that's my top read");
  assert.equal(lineFromDetail("flip", ["chat-audit: CONTRADICTION flip (player09 cop? player09 flipped Cop:)"]), "player09 flipped cop");
  assert.equal(lineFromDetail("flip", ["chat-audit: CONTRADICTION flip (player03 flip? player03 is alive)"]), "player03's flip");
  assert.equal(lineFromDetail("flip", ["chat-audit: CONTRADICTION flip (cop flip? nobody flipped Cop)"]), null);
});
