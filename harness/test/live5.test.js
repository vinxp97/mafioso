// Live game L5-1018 (10/18) on the live path, fake names (fixture smu-night1: Gil Sheriff, Ash Cop, Fin Journalist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainUpgrades, paceSpeech, SPEECH_PACE, REACT, reactWaitMs, counterclaimLine } from "../src/live.js";
import { seats } from "./fixtures/smu-night1.mjs";
import { gunDay } from "./live4.test.js";

const T0 = 1_800_000_000_000;
const seat = (name) => seats.find((s) => s.name === name);

test("L5 #2/#3: once voting starts, the Sheriff's ask goes out a beat after his claim (short day), paced 3-8s, no bursts", async () => {
  const { table, all, feed } = await gunDay(1, { dayMs: 90_000 });
  const gil = seat("Gil");
  const said = [];
  const chat = async (s, text, t) => { said.push({ who: s.acc, t }); await all("message", { senderId: s.pid, meetingId: "vil", content: text, t }, t); };
  await chat(gil, "im sheriff", T0 + 500);
  await chat(seat("Ash"), "im cop. gil inno", T0 + 6_000);
  await chat(seat("Bea"), "lol", T0 + 9_000);
  // Live, the village voted from the start; the day can close soon after all votes are in.
  await all("vote", { meetingId: "vil", voterId: seat("Bea").pid, target: seat("Cal")?.pid || seat("Ash").pid }, T0 + 9_500);
  for (let t = 10_000; t <= 40_000; t += 1_000) { await all("time", { time: 90_000 - t }, T0 + t); await drainUpgrades(table); }
  const lines = table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil" && p.accountId === gil.acc);
  const ask = lines.find((p) => /claim|role|what are you/i.test(p.data.content) && !/sheriff/i.test(p.data.content));
  assert.ok(ask, JSON.stringify(lines.map((p) => p.data.content)));
  assert.ok(ask.t - T0 <= 25_000, `ask at +${ask.t - T0}ms`);
  // Paced from the line it answers (the latest other line before it): at least REACT.minMs later.
  const before = said.filter((x) => x.t < ask.t && x.who !== gil.acc).map((x) => x.t).sort((a, b) => b - a)[0];
  assert.ok(ask.t - before >= REACT.minMs, `${ask.t - before}ms after the line it answers`);
  // No bursts: our public lines are tableGapMs apart, a seat's own lines ownGapMs apart.
  const pub = table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil" && p.t != null).sort((a, b) => a.t - b.t);
  for (let i = 1; i < pub.length; i++) assert.ok(pub[i].t - pub[i - 1].t >= SPEECH_PACE.tableGapMs - 1, `${pub[i].t - pub[i - 1].t}ms between lines`);
  for (const acc of new Set(pub.map((p) => p.accountId))) {
    const mine = pub.filter((p) => p.accountId === acc);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].t - mine[i - 1].t >= SPEECH_PACE.ownGapMs - 1);
  }
  void feed;
});

test("L5 #3: a reply that would land more than ~30s after the line it answers is dropped; claims are not", () => {
  const table = { config: {}, spokeAt: {}, proposed: [] };
  const view = { selfId: "me", phase: { phase: "Day" }, meetings: { vil: { id: "vil", name: "Village", speech: true, amMember: true } },
    messages: [{ meetingId: "vil", senderId: "x", t: 1_000, content: "who is sus" }] };
  const a = { event: "speak", data: { meetingId: "vil", content: "bea is sus" } };
  const fresh = paceSpeech(table, "A", view, a, 2_000, { entry: { t: 1_000 }, source: "llm" });
  assert.ok(fresh.wait >= REACT.minMs - 1_000 && fresh.wait <= REACT.maxMs, JSON.stringify(fresh));
  assert.match(paceSpeech(table, "A", view, a, 35_000, { entry: { t: 1_200 }, source: "llm" }).drop || "", /stale/);
  assert.equal(paceSpeech(table, "A", view, { ...a, data: { ...a.data, content: "im cop. bea guilty" } }, 35_000, { entry: { t: 1_200 }, source: "claim-rule", claim: true }).drop, undefined);
});

test("L5 #4: a counterclaim waits only the 3s minimum (the fake Journalist claim came ~6.6s before the game-ending lynch)", () => {
  const view = { selfId: "me", stateId: 4, players: { me: { id: "me", name: "Fin" }, x: { id: "x", name: "Cora" } }, dead: {}, meetings: { vil: { id: "vil", name: "Village", speech: true, amMember: true } },
    messages: [{ meetingId: "vil", senderId: "x", t: 10_000, content: "im journalist, nothing useful yet. not me" }] };
  const line = "cora is lying, im journalist. i got nothing on bea yet";
  assert.ok(counterclaimLine(view, line));
  assert.equal(reactWaitMs({}, "A", view, line, 10_100, { urgent: true }), REACT.minMs - 100);
  assert.ok(REACT.minMs < 6_600);
});

// Live game L6-1018 (10/18, Mafia won N2): the Sheriff (Gil) asked the Lawyer (Hap) at ~90s; the planned
// "im vt" reply never posted and the gun never fired before his ballot-net Village vote closed the day.
import { ballotNet } from "../src/live.js";
test("L6 A: the asked seat's reply posts, and the Sheriff shoots after it (or 15s after the ask)", async () => {
  const { table, all } = await gunDay(4, { dayMs: 180_000 });
  const gil = seat("Gil"), hap = seat("Hap");
  const rejects = [];
  table.onSpeechReject = (id, why, src, line) => rejects.push({ id, why: why.join(","), line });
  const chat = (s, text, t) => all("message", { senderId: s.pid, meetingId: "vil", content: text, t }, t);
  await chat(gil, "im sheriff", T0 + 500);
  await chat(seat("Ash"), "im cop. eli inno", T0 + 3_500);
  await chat(seat("Ash"), "results: eli inno", T0 + 9_500);
  table.proposed.length = 0;
  await chat(gil, "Hap claim before i shoot", T0 + 90_000);
  for (let t = 90_500; t <= 120_000; t += 500) { await all("time", { time: 180_000 - t }, T0 + t); await drainUpgrades(table); }
  const reply = table.proposed.find((p) => p.accountId === hap.acc && p.event === "speak");
  assert.ok(reply, `no reply from the asked seat: ${JSON.stringify(rejects.filter((r) => r.id === hap.acc))}`);
  const shot = table.proposed.find((p) => p.accountId === gil.acc && p.data.meetingId === "gun");
  assert.ok(shot, JSON.stringify(table.proposed.filter((p) => p.accountId === gil.acc)));
  assert.equal(shot.data.selection, hap.pid);
});

test("L6 A: at the ballot deadline an owed gun fires before the Sheriff's Village vote", async () => {
  const { table } = await gunDay(5, { dayMs: 180_000 });
  const gil = seat("Gil");
  const v = table.views[gil.acc];
  v.messages.push({ senderId: gil.pid, meetingId: "vil", content: "im sheriff", t: T0 + 500 });
  delete v.meetings.vil.votes?.[gil.pid];
  const out = await ballotNet(table, gil.acc, { ...v, voteKickWarning: true, clock: T0 + 179_000 }, T0 + 179_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.meetingId, "gun", JSON.stringify(out));
  assert.equal(out[0].source, "gun-net");
});

test("L6 D: any two non-claim bot lines are at least 2.5s apart; claims keep a 1s gap", () => {
  assert.equal(SPEECH_PACE.tableGapMs, 2_500);
  const table = { config: {}, spokeAt: {}, lastPublicAt: 10_000, lastSentAt: 10_000 };
  const view = { selfId: "me", messages: [] };
  const a = { event: "speak", data: { meetingId: "vil", content: "quiet day" } };
  assert.equal(paceSpeech(table, "A", view, a, 10_500, { source: "llm" }).wait, 2_000);
  assert.equal(paceSpeech(table, "A", view, { ...a, data: { ...a.data, content: "im vt" } }, 10_500, { source: "claim-rule", claim: true }).wait, 500);
});
