// Night 5 (Vinman 10/20, relayed by Nightshift): 1) the Sheriff holds on a Villager answer before he shoots. He waits for more claims and reads,
// then decides (the same target or another); the Day 1 shot still happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, sheriffShotReady, shotStatus, validateAction, SHERIFF_ASK } from "../src/index.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const shoot = (sel) => ({ event: "vote", data: { meetingId: "gun", selection: sel } });
const timer = { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } };
const at = (v, t) => reduce(v, { event: "time", t, data: { name: "main", time: 600_000 - t } });
const sheriffDay = (extra = []) => reduceAll([
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, timer,
  { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "p1"), votes: {} } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  say("p1", "im sheriff", 1_000), ...["p2", "p3", "p4", "p5", "p6", "p7"].map((p, i) => say(p, "hmm idk", 2_000 + i)), ...extra,
]);

// ---- 1) the Sheriff vs a Villager answer ----
test("1: a Villager/blue answer is held (no shot, no gun vote) until more claims and reads come in", () => {
  let v = at(sheriffDay([say("p2", "im cop. cat guilty", 3_000), say("p1", "cat claim?", 130_000)]), 131_000);
  for (const answer of ["im villager", "blue", "im vt", "just a townie, im blue"]) {
    const w = at(reduce(v, say("p4", answer, 131_000)), 132_000);
    assert.equal(shotStatus(w, "p4").status, "pending-vt", answer);
    const r = sheriffShotReady(w);
    assert.equal(r.ok, false, answer);
    assert.match(r.reason, /pending-vt/, answer);
    assert.equal(r.ask, undefined, "no new ask while holding");
    assert.match(validateAction(w, shoot("p4")).reason, /too early/, answer);
  }
  // Not enough: 12s but only 2 more lines; enough: 4 lines from others after 12s; or 30s whatever happens.
  v = reduce(v, say("p4", "im villager", 131_000));
  const two = [say("p5", "ok", 133_000), say("p6", "hm", 134_000)].reduce(reduce, v);
  assert.equal(shotStatus(two, "p4", { now: 131_000 + SHERIFF_ASK.vtHoldMinMs + 1 }).status, "pending-vt");
  const four = [say("p3", "cat is lying", 135_000), say("p7", "cat sus", 136_000)].reduce(reduce, two);
  assert.equal(shotStatus(four, "p4", { now: 131_000 + SHERIFF_ASK.vtHoldMinMs + 1 }).status, "open");
  assert.equal(shotStatus(v, "p4", { now: 131_000 + SHERIFF_ASK.vtHoldMaxMs }).status, "open");
  // After the hold, with no stronger case, he shoots the asked Villager claimer.
  const done = at(four, 131_000 + SHERIFF_ASK.vtHoldMinMs + 1);
  assert.deepEqual([sheriffShotReady(done).ok, sheriffShotReady(done).target], [true, "p4"]);
  assert.equal(validateAction(done, shoot("p4")).ok, true);
});

test("1: during the hold a stronger case can take the shot instead (he moves to another target)", () => {
  // Cat answers villager; then Dan and Eve both claim Journalist (one is lying): the contested claim is shot.
  let v = at(sheriffDay([say("p1", "cat claim?", 130_000), say("p4", "im villager", 131_000)]), 131_500);
  v.notes = { ...(v.notes || {}), suspects: ["p4", "p5"] };
  assert.match(sheriffShotReady(v).reason, /pending-vt/);
  v = [say("p5", "im journalist", 133_000), say("p6", "dan is lying, im the journalist", 134_000)].reduce(reduce, v);
  // 10/20 2:02pm: nobody asked either; Dan volunteered first and Eve called him a liar: Dan is shot.
  const r = sheriffShotReady(at(v, 135_000));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.target, "p5", JSON.stringify(r));
  assert.match(r.why, /contested/);
});

test("1: after the hold he re-ranks: a new evidence read is asked before the Villager claimer is shot", () => {
  let v = at(sheriffDay([say("p1", "cat claim?", 130_000), say("p4", "im villager", 131_000)]), 132_000);
  // A Cop claim with a guilty on Fay lands during the hold: after it, Fay is the stronger case; ask her first.
  v = [say("p2", "im cop. fay guilty", 133_000), say("p3", "hm", 134_000), say("p5", "fay?", 135_000), say("p6", "ok", 136_000)].reduce(reduce, v);
  const r = sheriffShotReady(at(v, 131_000 + SHERIFF_ASK.vtHoldMinMs + 1));
  assert.equal(r.ok, false);
  assert.equal(r.ask?.target, "p7", JSON.stringify(r));
});

test("1: the hold never costs the Day 1 shot: at the deadline a held Villager claimer is shot", () => {
  let v = sheriffDay([say("p1", "cat claim?", 540_000), say("p4", "blue", 541_000)]);
  v.notes = { ...(v.notes || {}), suspects: ["p4"] };
  v = at(v, 545_000); // 91% of the day: deadline, before the 30s hold ends
  assert.equal(shotStatus(v, "p4").status, "pending-vt");
  const r = sheriffShotReady(v);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.target, "p4");
  assert.match(r.why, /day 1 always shoots/);
  assert.equal(validateAction(v, shoot("p4")).ok, true);
});

test("1: existing rules stand: an uncounterclaimed power answer is not shot, a refusal or silence still is", () => {
  const base = at(sheriffDay([say("p1", "cat claim?", 130_000)]), 131_000);
  const cop = at(reduce(base, say("p4", "im cop", 131_000)), 131_000 + SHERIFF_ASK.ccMs + 1);
  assert.equal(shotStatus(cop, "p4").status, "protected");
  const refuse = at(reduce(base, say("p4", "not claiming", 131_000)), 132_000);
  assert.deepEqual([sheriffShotReady(refuse).ok, sheriffShotReady(refuse).target], [true, "p4"]);
  const silent = at(base, 130_000 + SHERIFF_ASK.replyMs + 1);
  assert.equal(sheriffShotReady(silent).target, "p4");
});

