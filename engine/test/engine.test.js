import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { emptyView, reduce, reduceAll, legalVotes, validateAction, decide,
  stringifyMessage, parseMessage } from "../src/index.js";

const load = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const day = () => reduceAll(load("game1.jsonl"));

test("wire round-trip", () => {
  const s = stringifyMessage("vote", { meetingId: "m:1", selection: "p2" });
  assert.equal(s, 'vote:object:{"meetingId":"m:1","selection":"p2"}');
  assert.deepEqual(parseMessage(s), ["vote", { meetingId: "m:1", selection: "p2" }]);
  assert.deepEqual(parseMessage("p"), ["p", undefined]);
  assert.deepEqual(parseMessage("n:number:3"), ["n", 3]);
});

test("reducer: self, players, phase, meetings", () => {
  const v = day();
  assert.equal(v.selfId, "p1");
  assert.deepEqual(v.phase, { name: "Day 1", phase: "Day", day: 1 });
  assert.equal(v.players.p4.left, true);
  assert.ok(!v.meetings.mPre, "pregame meeting cleared on phase change");
  assert.ok(!v.meetings.mGrave, "leftMeeting removes");
  assert.deepEqual(v.meetings.mVil.targets, ["p1", "p2", "p3", "*"]);
  assert.equal(v.meetings.mVil.votes.p2, "p1");
  assert.equal(v.messages.length, 1);
});

test("reducer is pure", () => {
  const v0 = emptyView(); const v1 = reduce(v0, { event: "self", data: "x" });
  assert.equal(v0.selfId, null); assert.equal(v1.selfId, "x");
  assert.deepEqual(reduce(v1, { event: "bogus" }), v1);
});

test("legalVotes + validateAction", () => {
  const v = day();
  assert.deepEqual(legalVotes(v).map((l) => l.meetingId), ["mVil"]);
  assert.equal(validateAction(v, { event: "vote", data: { meetingId: "mVil", selection: "p3" } }).ok, true);
  assert.equal(validateAction(v, { event: "vote", data: { meetingId: "mVil", selection: "p9" } }).ok, false);
  assert.equal(validateAction(v, { event: "vote", data: { meetingId: "nope", selection: "p2" } }).ok, false);
  const pre = reduceAll(load("game1.jsonl").slice(0, 5));
  assert.equal(validateAction(pre, { event: "vote", data: { meetingId: "mPre", selection: "p2" } }).ok, false);
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "mVil", content: "hello" } }).ok, true);
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "mVil", content: "x".repeat(241) } }).ok, false);
});

test("decide emits only legal actions", () => {
  const v = day();
  const acts = decide(v);
  assert.deepEqual(acts, [{ event: "vote", data: { meetingId: "mVil", selection: "p2" } }]);
  for (const a of acts) assert.equal(validateAction(v, a).ok, true);
  const voted = reduce(v, { event: "vote", data: { meetingId: "mVil", voterId: "p1", target: "p2" } });
  assert.deepEqual(decide(voted), []);
});

test("night: dead skipped, winners ends", () => {
  const night = reduceAll(load("game1-night.jsonl").slice(0, 3), day());
  assert.equal(night.phase.phase, "Night");
  assert.deepEqual(decide(night), [{ event: "vote", data: { meetingId: "mMaf", selection: "p3" } }]);
  const end = reduceAll(load("game1-night.jsonl"), day());
  assert.equal(end.finished, true);
  assert.deepEqual(decide(end), []);
});

test("decide falls back to '*' when no other living target", () => {
  let v = reduceAll([{ event: "self", data: "p1" }, { event: "players", data: { p1: { id: "p1" } } },
    { event: "state", data: { name: "Night 1" } },
    { event: "meeting", data: { id: "m", voting: true, canVote: true, amMember: true, targets: ["p1", "*"] } }]);
  assert.deepEqual(decide(v), [{ event: "vote", data: { meetingId: "m", selection: "*" } }]);
});
