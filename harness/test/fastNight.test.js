import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyView, reduce, createSeededRng } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry } from "../src/live.js";

const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
const players = Object.fromEntries(ids.map((id, i) => [id, { id, name: ["Ann", "Bob", "Cat", "Dan", "Eve", "Fay"][i] }]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seat(table, acc, self, role, meetings, { day = false, night = 1 } = {}) {
  table.views[acc] = reduce(emptyView(), { event: "self", data: self });
  const out = [
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role } },
    ...(role === "Janitor" || role === "Mafioso" ? [{ event: "reveal", data: { playerId: "p5", role: role === "Janitor" ? "Mafioso" : "Janitor" } }] : []),
    { event: "state", data: { id: day ? 3 : 2 * night, name: day ? "Day 1" : `Night ${night}` } },
    ...meetings.map((data) => ({ event: "meeting", data })),
  ];
  return out.map((e, i) => ({ accountId: acc, seq: i + 1, t: 1000 + i, ...e }));
}

test("slow model: every town night action goes out at once from rules, with no model call", async () => {
  const table = createBotTable([{ accountId: "C" }, { accountId: "J" }]);
  const limiter = createLlmLimiter(1);
  // The model never answers until the test says so: if the rules vote waited on it, we would never get here.
  let release; const gate = new Promise((r) => { release = r; });
  let answered = false;
  const complete = async ({ purpose }) => {
    await gate; answered = true;
    if (purpose === "candidates") return JSON.stringify({ options: [{ kind: "vote", meeting: "mCop", target: "p6", why: "quiet" }, { kind: "vote", meeting: "mCop", target: "p4", why: "x" }, { kind: "vote", meeting: "mCop", target: "p6", why: "y" }] });
    return '{"action":"vote","meeting":"mCop","target":"p6"}';
  };
  const cop = seat(table, "C", "p1", "Cop", [{ id: "mCop", name: "Cop", actionName: "Learn Alignment", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p6"], votes: {} }], { night: 2 });
  const sent = [];
  for (const e of cop) sent.push(...await onGameEntry(table, e, { complete, dryRun: true, fast: true, limiter, rng: () => 0 }));
  const instant = sent.find((a) => a.data.meetingId === "mCop");
  assert.ok(instant, "rules vote sent");
  assert.equal(instant.source, "rules");
  assert.equal(answered, false, "the rules vote did not wait for the model");
  release();
  await drainUpgrades(table);
  const votes = table.proposed.filter((a) => a.data.meetingId === "mCop");
  assert.ok(votes.length >= 1);
  assert.equal(limiter.stats.started, 0, "town nights never ask the model");
  for (const v of votes) assert.ok(["p2", "p3", "p4", "p6"].includes(v.data.selection));
});

test("queued model calls are dropped once the phase changes", async () => {
  const limiter = createLlmLimiter(1);
  let state = 1;
  const slow = () => sleep(100);
  const a = limiter.run(slow, { isStale: () => state !== 1 });
  const b = limiter.run(slow, { isStale: () => state !== 1 }).catch((e) => e.message);
  state = 2;
  await a;
  assert.equal(await b, "stale");
  assert.equal(limiter.stats.dropped, 1);
});

test("Night 1 Cop and Journalist pick a seeded random legal target with zero model calls", async () => {
  const { nightOneRandomPicks } = await import("../src/live.js");
  for (const role of ["Cop", "Journalist"]) {
    const table = createBotTable([{ accountId: "S" }]);
    let calls = 0;
    const complete = async () => { calls++; return "{}"; };
    const frames = seat(table, "S", "p1", role, [{ id: "mInv", name: role, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p6", "*"], votes: {} }]);
    frames.splice(3, 0, { accountId: "S", seq: 0.5, t: 1001, event: "death", data: "p3" });
    for (const [i, e] of frames.entries()) await onGameEntry(table, { ...e, seq: i + 1 }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: createSeededRng(9) });
    await drainUpgrades(table);
    assert.equal(calls, 0, `${role}: no model calls`);
    const v = table.proposed.filter((a) => a.data.meetingId === "mInv");
    assert.equal(v.length, 1, `${role}: one vote`);
    assert.ok(["p2", "p4", "p6"].includes(v[0].data.selection), `${role}: legal ${v[0].data.selection}`);
    assert.equal(v[0].source, "n1-random");
    // Same seat, same night: same pick.
    assert.deepEqual(nightOneRandomPicks(table.views.S, "S"), [{ event: "vote", data: { meetingId: "mInv", selection: v[0].data.selection } }]);
  }
});
