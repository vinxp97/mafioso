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
  // Vinman 10/18: the Sheriff asks his target for a claim before he shoots.
  const later = sheriffShotReady(v, { now: 130_000 });
  assert.equal(later.ok, false);
  assert.equal(later.ask.target, "p4");
  v = reduce(v, say("p1", later.ask.line, 130_000));
  v = reduce(v, say("p4", "vt", 131_000));
  const shot = sheriffShotReady(v, { now: 132_000 });
  assert.equal(shot.ok, true);
  assert.equal(shot.target, "p4");
  v = reduce(v, { event: "time", t: 132_000, data: {} });
  assert.equal(validateAction(v, shoot("p4")).ok, true);
});

test("late Day 1 with no read: the Sheriff still shoots the village's top vote", () => {
  const talk = [say("p1", "I'm Sheriff.", 1_000), ...["p2", "p3", "p4", "p5", "p6", "p2"].map((id, i) => say(id, "no idea", 2_000 + i))];
  let v = base([...talk, { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } }]);
  v = reduce(v, { event: "vote", t: 3_000, data: { meetingId: "mVil", voterId: "p2", target: "p5" } });
  v = reduce(v, { event: "vote", t: 3_100, data: { meetingId: "mVil", voterId: "p3", target: "p5" } });
  v = reduce(v, { event: "vote", t: 3_200, data: { meetingId: "mVil", voterId: "p4", target: "p6" } });
  // Mid-day with no read: ask (not the vote leader p5).
  const mid = sheriffShotReady(v, { now: 300_000 });
  assert.equal(mid.ok, false);
  assert.ok(mid.ask && mid.ask.target !== "p5");
  // Late: never at the player the village is already lynching (p5, 2 votes). L4: the target is asked first
  // (late too), then shot after the short late reply window.
  const late = sheriffShotReady(v, { now: 520_000 });
  assert.equal(late.ok, false);
  assert.equal(late.ask?.target, "p6");
  v = reduce(v, say("p1", late.ask.line, 520_000));
  assert.equal(sheriffShotReady(v, { now: 525_000 }).ok, false, "waits for a reply");
  const shot = sheriffShotReady(v, { now: 531_000 });
  assert.equal(shot.ok, true);
  assert.equal(shot.target, "p6");
  assert.match(shot.why, /^day 1 always shoots: late/);
  assert.deepEqual(applySheriffRule(v, [shoot("p2")], { now: 531_000 }), [shoot("p6")]);
  assert.match(validateAction(reduce(v, { event: "time", t: 531_000, data: {} }), shoot("p5")).reason, /vote leader/);
});

test("vinman Day 1: the Sheriff's Village vote waits for the shot, and the shot fires once the vote is nearly in", () => {
  let v = base();
  const vil = { event: "vote", data: { meetingId: "mVil", selection: "p3" } };
  // Not outed, no discussion, no read: the Village vote is held and no shot yet.
  assert.deepEqual(applySheriffRule(v, [vil], { now: 10 }), []);
  for (const [i, id] of ["p2", "p3", "p4", "p5"].entries()) v = reduce(v, { event: "vote", t: 20 + i, data: { meetingId: "mVil", voterId: id, target: id === "p5" ? "p6" : "p5" } });
  // 4 of 6 voted, but the Sheriff's own vote holds the day open: no shot yet (he asks first)...
  assert.equal(sheriffShotReady(v, { now: 30 }).ok, false);
  assert.deepEqual(applySheriffRule(v, [vil], { now: 30 }), [], "Village vote still held");
  // ...until the day is really ending (the Vote Kick opens): the gun fires at the best pick, never at himself.
  v = reduce(v, { event: "meeting", data: { id: "vk", name: "Vote Kick", voting: true, canVote: false, amMember: true, targets: ["Kick"], votes: {} } });
  const ready = sheriffShotReady(v, { now: 30 });
  assert.equal(ready.ok, true);
  assert.notEqual(ready.target, "p1");
  assert.equal(validateAction(v, shoot(ready.target)).ok, true);
  assert.deepEqual(applySheriffRule(v, [vil], { now: 30 }), [shoot(ready.target)], "shot first, Village vote held");
  v = reduce(v, { event: "vote", t: 31, data: { meetingId: "gun", voterId: "p1", target: ready.target } });
  assert.deepEqual(applySheriffRule(v, [vil], { now: 32 }), [vil], "after the shot the Village vote goes out");
  // The evidence rule keeps the old behaviour: no hold on the Village vote.
  const ev = base(); ev.config = { ...(ev.config || {}), sheriffRule: "evidence" };
  assert.deepEqual(applySheriffRule(ev, [vil], { now: 10 }), [vil]);
});

test("late fallback also works from a countdown timer, and not on Day 2", () => {
  const talk = [say("p1", "I'm Sheriff.", 1_000), ...["p2", "p3", "p4", "p5", "p6", "p2"].map((id, i) => say(id, "hmm", 2_000 + i))];
  let v = base(talk);
  v = reduce(v, { event: "time", t: 10_000, data: { name: "main", time: 590_000 } });
  v = reduce(v, { event: "time", t: 520_000, data: { name: "main", time: 80_000 } });
  assert.ok(sheriffShotReady(v, { now: 520_000 }).ask, "late: ask first");
  v = reduce(v, { event: "time", t: 585_000, data: { name: "main", time: 15_000 } });
  assert.equal(sheriffShotReady(v, { now: 585_000 }).ok, true, "last call: shoot");
  const d2 = reduce(v, { event: "state", t: 600_000, data: { id: 5, name: "Day 2" } });
  assert.equal(sheriffShotReady(d2, { now: 1_200_000 }).ok, false);
});

// Game GAME05: "Shoot Gun", no read, unreadable day timer, day shorter than 6 minutes.
const fj = (extra = [], villageVotes = {}) => reduceAll([
  { event: "self", data: "p1" },
  { event: "players", data: players },
  { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
  { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p5", "p6"], votes: {} } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p5", "p6", "*"], votes: villageVotes } },
  say("p1", "tbh i'm sheriff, idk who to shoot yet", 1_000),
  ...["p2", "p3", "p4", "p5", "p6", "p2", "p3"].map((p, i) => say(p, "melony you seem sus why quiet", 2_000 + i * 1_000)),
  ...extra,
]);

test("GAME05: late fallback fires on a short day with no read (3 minutes, no timer)", () => {
  const v = fj();
  assert.equal(sheriffShotReady(v, { now: 60_000 }).ok, false);
  assert.ok(sheriffShotReady(v, { now: 185_000 }).ask, "late: ask first (L4)");
  const late = rulesSeatActions(v, { now: 250_000 }).actions.filter((a) => a.data.meetingId === "gun");
  assert.equal(late.length, 1);
  assert.notEqual(late[0].data.selection, "*");
});

test("GAME05: half the village voting makes it late; the gun vote is added even after a Village vote", () => {
  let v = fj([], { p1: "p3", p2: "p3", p4: "p3", p5: "p3" });
  const ask = sheriffShotReady(v, { now: 30_000 }).ask;
  assert.ok(ask && ask.target !== "p3", "late: ask first (L4)");
  v = reduce(v, say("p1", ask.line, 30_000));
  const acts = rulesSeatActions(v, { now: 41_000 }).actions.filter((a) => a.data.meetingId === "gun");
  assert.equal(acts.length, 1);
  // p3 leads the vote 4-0: the lynch handles them, the gun goes elsewhere.
  assert.notEqual(acts[0].data.selection, "p3");
  assert.notEqual(acts[0].data.selection, "*");
});

test("GAME05: a Vote Kick meeting means the day is ending: shoot now", () => {
  const v = fj([{ event: "meeting", data: { id: "vk", name: "Vote Kick", voting: true, canVote: false, amMember: true, targets: ["Kick"], votes: {} } }]);
  assert.equal(sheriffShotReady(v, { now: 20_000 }).ok, true);
});

test("L4: an accusation of the Sheriff is not a reason to shoot (no immediate shot at the accuser)", () => {
  const v = base([say("p4", "Me is mafia", 1)]);
  const acts = rulesSeatActions(v, { now: 2 }).actions.filter((a) => a.data.meetingId === "gun");
  assert.deepEqual(acts, []);
  assert.equal(validateAction(v, shoot("p4")).ok, false);
});

// --sheriff-rule evidence: Day 1 shot only on a strong read; Vinman's always-shoot-D1 rule stays the default.
const withRule = (rule, extra) => reduceAll([
  { event: "botConfig", data: { sheriffRule: rule } },
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
  { event: "meeting", data: { id: "gun", name: "Shoot", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p5", "p6", "*"], votes: {} } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p5", "p6", "*"], votes: {} } },
  ...extra,
]);
const chatter = [say("p1", "I'm Sheriff.", 1_000), say("p2", "villager", 2_000), say("p3", "vanilla", 3_000), say("p4", "ok", 4_000), say("p5", "hmm", 5_000), say("p6", "idk", 6_000), say("p2", "who?", 7_000)];

test("evidence rule: no strong read on Day 1 means hold; Vinman's default still shoots late on Day 1", () => {
  const ev = withRule("evidence", chatter);
  assert.match(sheriffShotReady(ev, { now: 250_000 }).reason, /evidence rule: no strong read/);
  assert.equal(rulesSeatActions(ev, { now: 250_000 }).actions.some((a) => a.data.meetingId === "gun"), false);
  assert.equal(sheriffShotReady(withRule("vinman", chatter), { now: 250_000 }).ok, true);
  assert.equal(sheriffShotReady(base(chatter), { now: 250_000 }).ok, true, "no flag = vinman");
});

test("evidence rule shoots Day 1 on a Cop guilty, a unique-role counterclaim, or a threat to the Sheriff", () => {
  const guilty = sheriffShotReady(withRule("evidence", [...chatter, say("p2", "I'm Cop. Bob is guilty.", 8_000)]));
  assert.deepEqual([guilty.ok, guilty.target], [true, "p3"]);
  const counter = sheriffShotReady(withRule("evidence", [...chatter, say("p4", "I'm Cop.", 8_000), say("p5", "no, I'm the cop", 9_000)]));
  assert.equal(counter.ok, true);
  assert.ok(["p4", "p5"].includes(counter.target), counter.why);
  // A Sheriff counterclaim is still shot at once; a bare accusation (L4) is not.
  const threat = sheriffShotReady(withRule("evidence", [say("p1", "I'm Sheriff.", 1_000), say("p6", "I'm the sheriff, not Me", 2_000)]));
  assert.deepEqual([threat.ok, threat.target], [true, "p6"]);
  const accused = sheriffShotReady(withRule("evidence", [say("p1", "I'm Sheriff.", 1_000), say("p6", "Me is guilty", 2_000)]));
  assert.notEqual(accused.ok && accused.target === "p6", true);
});

test("evidence rule: a gun held past Day 1 fires once the village starts voting", () => {
  const v = withRule("evidence", [...chatter,
    { event: "state", data: { id: 5, name: "Day 2" }, t: 400_000 },
    { event: "meeting", data: { id: "gun", name: "Shoot", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "p5", "p6", "*"], votes: {} } },
    { event: "meeting", data: { id: "mVil2", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "p4", "p5", "p6", "*"], votes: {} } },
    { event: "vote", data: { meetingId: "mVil2", voterId: "p2", target: "p5" } },
  ]);
  // L4: asked first, then shot after the late reply window.
  const asked = sheriffShotReady(v, { now: 401_000 });
  assert.ok(asked.ask, asked.reason);
  const v2 = reduce(v, { event: "message", t: 401_000, data: { senderId: "p1", meetingId: "mVil2", content: asked.ask.line, t: 401_000 } });
  const ready = sheriffShotReady(v2, { now: 412_000 });
  assert.equal(ready.ok, true, ready.reason);
  assert.equal(validateAction(reduce(v2, { event: "time", t: 412_000, data: {} }), shoot(ready.target)).ok, true);
});
