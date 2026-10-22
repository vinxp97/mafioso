// Night 5 single-bot eval found it: a table with ONE bot seat (the target setup: one Mafioso among humans) whose
// first vote of the game is the Sheriff's gun threw in emitActions (table.voteCount was never created: at an
// all-bot table some other seat's ballot always made it first), so the shot was lost on every try.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBotTable, onGameEntry } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { createSeededRng } from "mafioso-engine";

const timed = (n) => fs.readFileSync(new URL(`./fixtures/solo-timeline/${n}.jsonl`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const seatOf = (E, role) => { const r = E.find((e) => e.event === "roleReveal" && e.data.role === role); return E.find((e) => e.event === "self" && e.data === r.data.playerId).accountId; };

test("live table: a single-seat table whose first vote ever is the Sheriff's gun no longer throws (the shot went missing)", async () => {
  const E = timed("l10"); const acc = seatOf(E, "Sheriff");
  const mine = E.filter((e) => e.accountId === acc);
  const clock = createVirtualClock(mine[0].t);
  const table = createBotTable([{ accountId: acc }], { clock, rng: createSeededRng(7) });
  const errors = [];
  for (const e of mine) { if (e.t > clock.now()) clock.advance(e.t - clock.now()); await onGameEntry(table, e, { dryRun: true, fast: true, onError: (err) => errors.push(String(err?.message || err)) }); }
  assert.deepEqual(errors, []);
  assert.ok(table.proposed.some((p) => p.accountId === acc && p.event === "vote" && p.data.meetingId && /p\d+/.test(p.data.selection)));
});
