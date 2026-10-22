// Seat logging: one `seatmap` line per game (seat label -> player id and in-game handle, from the server's own
// self/players frames), so build-replays can bind seats to players exactly instead of guessing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBotTable, onGameEntry, seatMapLine } from "../src/live.js";

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/replays/${f}`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("seatmap: one line once every seat has its self and players frames (recorded g15 join burst); handles, no account ids", async () => {
  const entries = fixture("g15.jsonl");
  const accounts = [...new Set(entries.map((e) => e.accountId))];
  const table = createBotTable(accounts.map((accountId) => ({ accountId })));
  const lines = [];
  table.onSeatMap = (l) => lines.push(l);
  for (const e of entries.filter((x) => x.event === "self" || x.event === "players")) {
    assert.equal(seatMapLine(table) === null, lines.length === 0);
    await onGameEntry(table, e, { dryRun: true });
  }
  assert.equal(lines.length, 1);
  const expected = accounts.map((a, i) => { const self = entries.find((x) => x.accountId === a && x.event === "self").data; return `s${i + 1}=${self}:"Player${self.slice(1)}"`; });
  assert.equal(lines[0], `seatmap ${expected.join(" ")}`);
  for (const a of accounts) assert.ok(!lines[0].includes(a), "no account ids in the line");
});

const script = fileURLToPath(new URL("../scripts/build-replays.mjs", import.meta.url));
function build(log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seatmap-"));
  const file = path.join(dir, "live-test.log.err");
  fs.writeFileSync(file, log);
  execFileSync(process.execPath, [script, path.join(dir, "out"), file], { stdio: "pipe" });
  const out = fs.readFileSync(path.join(dir, "out", "g01.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "out", "manifest.json"), "utf8"));
  return { out, manifest };
}
// Three seats; the second account sits in the player slot plYYYYYYY2 and is named GammaDelta34. Chat is first
// seen from GammaDelta34, so the old first-seen guess binds that name to seat 1.
const LOG = (seatmap) => [
  "game Gm7Xq2LpZ accounts=Ac1xQwErTy,Ac2xAsDfGh,Ac3xZxCvBn prompts=seed,seed,seed",
  'frames {"game:connected":3,"game:self":3,"game:players":3,"game:state":6,"game:meeting":3,"game:message":6,"game:vote":3}',
  ...(seatmap ? ['seatmap s1=plXXXXXXX1:"AlphaBeta12" s2=plYYYYYYY2:"GammaDelta34" s3=plZZZZZZZ3:"EpsiZeta56"'] : []),
  "send Ac1xQwErTy [Day 1] vote VilMeet01x plZZZZZZZ3 source=rules prompt=seed",
  "send Ac2xAsDfGh [Day 1] vote VilMeet01x plZZZZZZZ3 source=rules prompt=seed",
  "send Ac3xZxCvBn [Day 1] vote VilMeet01x plYYYYYYY2 source=rules prompt=seed",
  'chat [Day 1] Village GammaDelta34: "epsizeta56 is scum"',
  'chat [Day 1] Village AlphaBeta12: "agreed"',
  "",
].join("\n");

test("build-replays binds seats exactly from a seatmap line, and falls back to the old guess without one", () => {
  const exact = build(LOG(true));
  const self = (out, acc) => out.find((e) => e.accountId === acc && e.event === "self").data;
  const said = (out, text) => out.find((e) => e.event === "message" && e.data.content === text)?.data.senderId;
  assert.equal(self(exact.out, "acc02"), "p02");
  assert.equal(said(exact.out, "player03 is scum"), "p02", "GammaDelta34 is seat 2's player, and EpsiZeta56 is p03");
  const votes = exact.out.filter((e) => e.event === "vote" && e.accountId === "acc01").map((e) => [e.data.voterId, e.data.target]);
  assert.deepEqual(votes, [["p01", "p03"], ["p02", "p03"], ["p03", "p02"]], "votes land on the same slots as the seats");
  assert.equal(exact.manifest.fixtures[0].seatBinding, "seatmap");
  const blob = JSON.stringify(exact.out);
  for (const raw of ["GammaDelta34", "plYYYYYYY2", "Ac2xAsDfGh", "Gm7Xq2LpZ"]) assert.ok(!blob.toLowerCase().includes(raw.toLowerCase()), raw);

  const guessed = build(LOG(false));
  const line = guessed.out.find((e) => e.event === "message" && / is scum$/.test(e.data.content));
  assert.equal(line.data.senderId, "p01", "old behaviour: the first chat name is bound to p01");
  assert.equal(guessed.manifest.fixtures[0].seatBinding, "guessed");
});
