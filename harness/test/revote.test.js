// A seat whose day vote was cleared because its target died (Sheriff shot) votes again: no veg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { seats, players } from "./fixtures/smu-night1.mjs";

const T0 = 1_800_000_000_000;
const village = (s, targets, votes = {}) => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...targets.filter((i) => i !== s.pid), "*"], votes });

test("after a vote target dies and the server clears those votes, every living seat has a vote again", async () => {
  const clock = createVirtualClock(T0);
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })), { clock, rng: createSeededRng(3), mafia: "script" });
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1) };
  const feed = (s, event, data, t) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  let all = Object.keys(players);
  for (const s of seats) { await feed(s, "self", s.pid, T0); await feed(s, "players", players, T0); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role }, T0);
  for (const s of seats) { await feed(s, "state", { id: 3, name: "Day 1" }, T0); await feed(s, "meeting", village(s, all), T0); }
  const tick = async (from, to) => { for (let k = from; k <= to; k++) for (const s of seats) if (all.includes(s.pid)) await feed(s, "time", { time: 300000 - k * 5000 }, T0 + k * 5000); await drainUpgrades(table); };
  await tick(1, 40);
  const pid = (acc) => seats.find((s) => s.acc === acc).pid;
  const standing = {};
  for (const p of table.proposed.filter((x) => x.event === "vote" && x.data.meetingId === "vil")) standing[pid(p.accountId)] = p.data.selection;
  assert.equal(Object.keys(standing).length, 9, "every seat voted before the shot");
  // The most-voted player is shot; the server clears votes on him and re-sends the meeting.
  const counts = {};
  for (const t of Object.values(standing)) if (t !== "*") counts[t] = (counts[t] || 0) + 1;
  const dead = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const cleared = Object.keys(standing).filter((v) => standing[v] === dead && v !== dead);
  assert.ok(cleared.length > 0);
  all = all.filter((i) => i !== dead);
  const votes = Object.fromEntries(Object.entries(standing).filter(([v, t]) => t !== dead && v !== dead));
  const before = table.proposed.length;
  for (const s of seats) {
    for (const [voterId, target] of Object.entries(standing)) await feed(s, "vote", { meetingId: "vil", voterId, target }, T0 + 205000);
    await feed(s, "death", dead, T0 + 206000);
    if (s.pid !== dead) await feed(s, "meeting", village(s, all, votes), T0 + 206000);
  }
  await tick(42, 50);
  const after = table.proposed.slice(before).filter((x) => x.event === "vote" && x.data.meetingId === "vil");
  for (const v of cleared) {
    const again = after.filter((x) => pid(x.accountId) === v);
    assert.ok(again.length > 0, `${players[v].name} re-voted after the target died`);
    assert.ok(again.every((x) => x.data.selection !== dead));
  }
});
