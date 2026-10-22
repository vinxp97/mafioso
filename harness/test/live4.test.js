// Live game L4-1018 (10/18): after the Sheriff's shot the server re-sent the "Shoot Gun" meeting AFTER
// leftMeeting (Player.js vote handler: meeting.vote() fires the instant gun and leaves the meeting, then
// this.sendMeeting(meeting) runs because the state did not change), with amMember false. The bot kept it
// as an open meeting, kept voting into it, and never cast its Village ballot: vote-kicked, mafia parity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRng } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, ballotNet, BALLOT_NET } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { seats, players, meetingsFor } from "./fixtures/smu-night1.mjs";

const T0 = 1_800_000_000_000;
const seat = (name) => seats.find((s) => s.name === name);
const village = () => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(players), "*"], votes: {} });
const gun = (extra = {}) => ({ id: "gun", name: "Shoot Gun", actionName: "Shoot Gun", voting: true, instant: true, canVote: true, amMember: true, targets: [...Object.keys(players).filter((p) => p !== seat("Gil").pid), "*"], votes: {}, ...extra });

export async function gunDay(seed, { town = "suspicion", dayMs = 300_000 } = {}) {
  const clock = createVirtualClock(T0 - 60_000);
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })), { clock, rng: createSeededRng(seed), mafia: "adaptive", town });
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1) };
  const feed = (s, event, data, t) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  const all = async (event, data, t) => { for (const s of seats) await feed(s, event, data, t); };
  for (const s of seats) { await feed(s, "self", s.pid, T0 - 60_000); await feed(s, "players", players, T0 - 60_000); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role }, T0 - 60_000);
  for (const s of seats) { await feed(s, "state", { id: 1, name: "Night 1" }, T0 - 60_000); for (const m of meetingsFor(s)) await feed(s, "meeting", m, T0 - 60_000); }
  await drainUpgrades(table);
  table.proposed.length = 0;
  for (const s of seats) {
    await feed(s, "state", { id: 2, name: "Day 1" }, T0);
    await feed(s, "timerInfo", { name: "main", start: T0, delay: dayMs }, T0);
    await feed(s, "meeting", village(), T0);
  }
  await feed(seat("Gil"), "meeting", gun(), T0);
  await all("death", seat("Dot").pid, T0);
  return { table, feed, all, clock };
}

async function shotThenDay(variant) {
  const { table, feed, all } = await gunDay(1);
  const gil = seat("Gil"), ivo = seat("Ivo");
  await all("message", { senderId: gil.pid, meetingId: "vil", content: "im sheriff", t: T0 + 1_000 }, T0 + 1_000);
  // Live sequence: the Sheriff's gun vote, the instant shot (server line + death), the re-sent gun meeting
  // (finished, still a member, his vote on the now-dead target), and leftMeeting frames.
  await feed(gil, "vote", { meetingId: "gun", voterId: gil.pid, target: ivo.pid }, T0 + 30_000);
  await all("message", { senderId: "server", content: `:gun: ${gil.name} pulls a gun and shoots at ${ivo.name}!`, t: T0 + 30_000 }, T0 + 30_000);
  await all("death", ivo.pid, T0 + 30_000);
  await feed(ivo, "leftMeeting", "vil", T0 + 30_000);
  if (variant === "left") await feed(gil, "leftMeeting", "gun", T0 + 30_000);
  await feed(gil, "meeting", gun(variant === "left" ? { amMember: false, canVote: undefined, votes: {} } : { votes: { [gil.pid]: ivo.pid } }), T0 + 30_000);
  return { table, feed, all, gil };
}

for (const variant of ["kept", "left"]) {
  test(`L4 #1 (${variant}): the fired gun stays used; the Sheriff's ballot goes to the Village`, async () => {
    const { table, all, gil } = await shotThenDay(variant);
    const view = table.views[gil.acc];
    assert.ok(!view.meetings.gun || view.meetings.gun.used, "the fired gun is spent");
    table.proposed.length = 0;
    for (let t = 40_000; t <= 290_000; t += 10_000) { await all("time", { time: 300_000 - t }, T0 + t); await drainUpgrades(table); }
    const mine = table.proposed.filter((p) => p.accountId === gil.acc && p.event === "vote");
    assert.equal(mine.some((p) => p.data.meetingId === "gun"), false, JSON.stringify(mine));
    assert.ok(mine.some((p) => p.data.meetingId === "vil"), `no Village ballot: ${JSON.stringify(mine)}`);
  });
}

test("L4 #1 safety net: a seat with no ballot votes before the vote-kick check (late day or the kick warning)", async () => {
  const { table, feed } = await gunDay(2);
  const bea = seat("Bea");
  const view = () => table.views[bea.acc];
  table.pendingVotes = {}; table.latestPick = {};
  delete view().meetings.vil.votes?.[bea.pid];
  assert.deepEqual(await ballotNet(table, bea.acc, view(), T0 + 10_000), [], "not before the deadline");
  // Late day (fraction >= BALLOT_NET.fraction): its current legal pick goes out, overriding every hold.
  const late = await ballotNet(table, bea.acc, { ...view(), clock: T0 + 285_000 }, T0 + 285_000);
  assert.equal(late.length, 1); assert.equal(late[0].data.meetingId, "vil"); assert.equal(late[0].source, "ballot-net");
  assert.notEqual(late[0].data.selection, bea.pid);
  // The vote-kick warning (server checkVeg) fires it at once, even early.
  const t2 = await gunDay(3); const v2 = t2.table.views[bea.acc];
  t2.table.pendingVotes = {}; delete v2.meetings.vil.votes?.[bea.pid];
  await t2.feed(bea, "youAreBeingVoteKicked", { status: true }, T0 + 20_000);
  // onGameEntry runs the net on the warning frame itself.
  const kicked = t2.table.proposed.filter((p) => p.accountId === bea.acc && p.source === "ballot-net");
  assert.equal(kicked.length, 1);
  // A standing ballot: nothing.
  await t2.feed(bea, "vote", { meetingId: "vil", voterId: bea.pid, target: kicked[0].data.selection }, T0 + 21_000);
  assert.deepEqual(await ballotNet(t2.table, bea.acc, t2.table.views[bea.acc], T0 + 40_000), []);
  assert.ok(BALLOT_NET.fraction < 1);
});
