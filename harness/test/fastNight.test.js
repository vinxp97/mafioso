import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyView, reduce } from "mafioso-engine";
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

test("slow model: every night action goes out at once from rules, then the model upgrades it", async () => {
  const table = createBotTable([{ accountId: "C" }, { accountId: "J" }]);
  const limiter = createLlmLimiter(1);
  const complete = async ({ purpose }) => {
    await sleep(300);
    if (purpose === "candidates") return JSON.stringify({ options: [{ kind: "vote", meeting: "mCop", target: "p6", why: "quiet" }, { kind: "vote", meeting: "mCop", target: "p4", why: "x" }, { kind: "vote", meeting: "mCop", target: "p6", why: "y" }] });
    return '{"action":"vote","meeting":"mCop","target":"p6"}';
  };
  const cop = seat(table, "C", "p1", "Cop", [{ id: "mCop", name: "Cop", actionName: "Learn Alignment", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p6"], votes: {} }], { night: 2 });
  const t0 = Date.now();
  const sent = [];
  for (const e of cop) sent.push(...await onGameEntry(table, e, { complete, dryRun: true, fast: true, limiter, rng: () => 0 }));
  const instant = sent.find((a) => a.data.meetingId === "mCop");
  assert.ok(instant, "rules vote sent");
  assert.equal(instant.source, "rules");
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  await drainUpgrades(table);
  const votes = table.proposed.filter((a) => a.data.meetingId === "mCop");
  assert.ok(votes.length >= 1);
  assert.ok(limiter.stats.started >= 1, "model was asked");
  for (const v of votes) assert.ok(["p2", "p3", "p4", "p6"].includes(v.data.selection));
});

test("queued model calls are dropped once the phase changes", async () => {
  const table = createBotTable([{ accountId: "A" }, { accountId: "B" }]);
  const limiter = createLlmLimiter(1);
  let calls = 0;
  const complete = async () => { calls++; await sleep(200); return "not json"; };
  const mk = (acc, self) => seat(table, acc, self, "Cop", [{ id: `m${acc}`, name: "Cop", voting: true, canVote: true, amMember: true, targets: ["p3", "p4"], votes: {} }], { night: 2 });
  for (const e of [...mk("A", "p1"), ...mk("B", "p2")]) await onGameEntry(table, e, { complete, dryRun: true, fast: true, limiter, rng: () => 0 });
  // Day comes while B's request is still queued behind A's.
  for (const acc of ["A", "B"]) await onGameEntry(table, { accountId: acc, seq: 99, t: 5000, event: "state", data: { id: 3, name: "Day 1" } }, { dryRun: true, fast: true, limiter });
  await drainUpgrades(table);
  assert.ok(limiter.stats.dropped >= 1, `dropped=${limiter.stats.dropped} calls=${calls}`);
});

test("Janitor always cleans on Night 1 with a failed or slow model, on the PLAN or the Mafia kill vote", async () => {
  const clean = { id: "mCln", name: "Clean", actionName: "Clean", voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p6", "*"], votes: {} };
  for (const mode of ["plan", "vote", "none"]) {
    const table = createBotTable([{ accountId: "J" }]);
    const mafia = { id: "mMaf", name: "Mafia Kill", actionName: "Mafia Kill", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p6", "*"], members: [{ id: "p4" }, { id: "p5" }], votes: mode === "vote" ? { p5: "p2" } : {} };
    const frames = seat(table, "J", "p4", "Janitor", [mafia, clean]);
    if (mode === "plan") frames.push({ accountId: "J", seq: 50, t: 2000, event: "message", data: { senderId: "p5", meetingId: "mMaf", content: "PLAN kill=p3 lynch=p1 claim=Cop lawyer=p5 speaker=p5" } });
    const failing = async () => { await sleep(50); throw new Error("model down"); };
    const sent = [];
    for (const e of frames) sent.push(...await onGameEntry(table, e, { complete: failing, dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: () => 0 }));
    await drainUpgrades(table);
    const cleans = table.proposed.filter((a) => a.data.meetingId === "mCln");
    assert.ok(cleans.length, `${mode}: clean sent`);
    const last = cleans.at(-1).data.selection;
    assert.notEqual(last, "*", `${mode}: never skips`);
    if (mode === "plan") assert.equal(last, "p3");
    if (mode === "vote") assert.equal(last, "p2");
    const kill = table.proposed.filter((a) => a.data.meetingId === "mMaf" && a.event === "vote").at(-1);
    assert.ok(kill, `${mode}: kill vote sent`);
    assert.equal(kill.data.selection, last, `${mode}: clean matches the kill`);
  }
});

test("Night 1 Cop and Journalist pick a seeded random legal target with zero model calls", async () => {
  const { nightOneRandomPicks } = await import("../src/live.js");
  for (const role of ["Cop", "Journalist"]) {
    const table = createBotTable([{ accountId: "S" }]);
    let calls = 0;
    const complete = async () => { calls++; return "{}"; };
    const frames = seat(table, "S", "p1", role, [{ id: "mInv", name: role, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p6", "*"], votes: {} }]);
    frames.splice(3, 0, { accountId: "S", seq: 0.5, t: 1001, event: "death", data: "p3" });
    for (const [i, e] of frames.entries()) await onGameEntry(table, { ...e, seq: i + 1 }, { complete, dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: Math.random });
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
