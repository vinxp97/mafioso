import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, validateAction, rulesSeatActions, sheriffShotReady, applySheriffRule } from "../src/index.js";

const players = Object.fromEntries(["p1", "p2", "p3", "p4", "p5", "p6"].map((id, i) => [id, { id, name: ["Me", "Alice", "Bob", "Cat", "Dan", "Eve"][i] }]));
const base = (extra = []) => reduceAll([
  { event: "self", data: "p1" },
  { event: "players", data: players },
  { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
  { event: "meeting", data: { id: "gun", name: "Shoot", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p5", "p6", "*"], votes: {} } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p5", "p6", "*"], votes: {} } },
  ...extra,
]);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const shoot = (sel) => ({ event: "vote", data: { meetingId: "gun", selection: sel } });

test("no shot before the Sheriff outs", () => {
  const v = base([say("p2", "hi", 1), say("p3", "hi", 2), say("p4", "hi", 3), say("p5", "hi", 4), say("p6", "hi", 5), say("p2", "hi", 6)]);
  assert.match(validateAction(v, shoot("p3")).reason, /not outed/);
  assert.equal(rulesSeatActions(v, { now: 10 }).actions.some((a) => a.data.meetingId === "gun"), false);
});

test("outed but no discussion yet: still no shot", () => {
  const v = base([say("p1", "I'm Sheriff. Claims please.", 1), say("p2", "I'm Cop, Bob is guilty", 2)]);
  assert.match(validateAction(v, shoot("p3")).reason, /discussion first/);
});

test("after discussion the Sheriff shoots the Cop's guilty, not a quiet player", () => {
  const v = base([
    say("p1", "I'm Sheriff. Claims please.", 1),
    say("p2", "I'm Cop. Bob is guilty.", 2), say("p3", "I'm villager, Alice is lying", 3),
    say("p4", "vanilla", 4), say("p5", "villager", 5), say("p6", "villager here", 6), say("p4", "shoot Bob", 7),
  ]);
  const ready = sheriffShotReady(v);
  assert.equal(ready.ok, true);
  assert.equal(ready.target, "p3");
  assert.equal(validateAction(v, shoot("p3")).ok, true);
  assert.deepEqual(applySheriffRule(v, [shoot("p6")]), [shoot("p3")]);
  assert.match(validateAction(v, shoot("*")).reason, /does not skip/);
});

test("the Cop's guilty on a power-role claimer is not the test; no read means no shot", () => {
  const v = base([
    say("p1", "I'm Sheriff.", 1),
    say("p2", "I'm Cop. Bob is guilty.", 2), say("p3", "I'm Journalist and Alice is lying", 3),
    say("p4", "ok", 4), say("p5", "ok", 5), say("p6", "ok", 6), say("p4", "hmm", 7),
  ]);
  const ready = sheriffShotReady(v);
  assert.notEqual(ready.target, "p3");
});

test("time can stand in for discussion once the Sheriff has outed and has a read", () => {
  let v = base([say("p1", "I'm Sheriff.", 1_000), say("p2", "I'm Cop. Cat is guilty.", 2_000)]);
  assert.equal(sheriffShotReady(v, { now: 30_000 }).ok, false);
  const later = sheriffShotReady(v, { now: 130_000 });
  assert.equal(later.ok, true);
  assert.equal(later.target, "p4");
  v = reduce(v, { event: "time", t: 130_000, data: {} });
  assert.equal(validateAction(v, shoot("p4")).ok, true);
});

test("late Day 1 with no read: the Sheriff still shoots the village's top vote", () => {
  const talk = [say("p1", "I'm Sheriff.", 1_000), ...["p2", "p3", "p4", "p5", "p6", "p2"].map((id, i) => say(id, "no idea", 2_000 + i))];
  let v = base([...talk, { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } }]);
  v = reduce(v, { event: "vote", t: 3_000, data: { meetingId: "mVil", voterId: "p2", target: "p5" } });
  v = reduce(v, { event: "vote", t: 3_100, data: { meetingId: "mVil", voterId: "p3", target: "p5" } });
  v = reduce(v, { event: "vote", t: 3_200, data: { meetingId: "mVil", voterId: "p4", target: "p6" } });
  const mid = sheriffShotReady(v, { now: 300_000 });
  assert.equal(mid.ok, false);
  assert.match(mid.reason, /no read/);
  const late = sheriffShotReady(v, { now: 520_000 });
  assert.equal(late.ok, true);
  assert.equal(late.target, "p5");
  assert.equal(late.why, "late day 1, no read");
  assert.deepEqual(applySheriffRule(v, [shoot("p2")], { now: 520_000 }), [shoot("p5")]);
});

test("late fallback also works from a countdown timer, and not on Day 2", () => {
  const talk = [say("p1", "I'm Sheriff.", 1_000), ...["p2", "p3", "p4", "p5", "p6", "p2"].map((id, i) => say(id, "hmm", 2_000 + i))];
  let v = base(talk);
  v = reduce(v, { event: "time", t: 10_000, data: { name: "main", time: 590_000 } });
  v = reduce(v, { event: "time", t: 520_000, data: { name: "main", time: 80_000 } });
  assert.equal(sheriffShotReady(v, { now: 520_000 }).ok, true);
  const d2 = reduce(v, { event: "state", t: 600_000, data: { id: 5, name: "Day 2" } });
  assert.equal(sheriffShotReady(d2, { now: 1_200_000 }).ok, false);
});
