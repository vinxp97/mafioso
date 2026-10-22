// Night 6 part 4: the Sheriff's late-answer grace (config.sheriffLateGrace, off by default).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduceAll, reduce, validateAction, sheriffShotReady, applySheriffRule, parseClaimReply, sheriffAsks, sheriffAskedMe,
  askReplyLine, claimAllowed, legalActions, NEVER_LYNCH_SHERIFF, chatAudit, adaptiveKill, priorityKill, MAFIA_KILL_PRIORITY,
  legalVotes, villageLeader, shotStatus, SHERIFF_ASK, adaptiveClaimLine,
} from "../src/index.js";
import { askReplyWindowMs } from "../src/sheriffAsk.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const shoot = (sel) => ({ event: "vote", data: { meetingId: "gun", selection: sel } });
const voteEv = (voterId, target, t = 0) => ({ event: "vote", t, data: { meetingId: "mVil", voterId, target } });
const timer = { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } };
// Day 1, I am the Sheriff (p1), already outed; six lines of discussion so the gate is open.
const sheriffDay = (extra = [], { outed = true, talk = true } = {}) => reduceAll([
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, timer,
  { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "p1"), votes: {} } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  ...(outed ? [say("p1", "im sheriff", 1_000)] : []),
  ...(talk ? ["p2", "p3", "p4", "p5", "p6", "p7"].map((p, i) => say(p, "hmm idk", 2_000 + i)) : []),
  ...extra,
]);
const at = (v, t) => reduce(v, { event: "time", t, data: { name: "main", time: 600_000 - t } });
const grace = (v) => ({ ...v, config: { ...(v.config || {}), sheriffLateGrace: "on" } });

// Night 6 part 4: config.sheriffLateGrace "on" (off by default) waits lateGraceMs past replyMs for a late answer
// before the ask's silence counts as "no claim when asked". The deadline paths ignore it.
// Ask on Cat (p4) at 130s, via the Cop guilty; reply window 15s off, 45s on.
const asked = () => {
  const v = at(sheriffDay([say("p2", "im cop. cat guilty", 3_000)]), 130_000);
  const r = sheriffShotReady(v);
  assert.equal(r.ask.target, "p4");
  return reduce(v, say("p1", r.ask.line, 130_000));
};

test("late grace: the window is replyMs off, replyMs + lateGraceMs on (30s, from the mixed-table answer delays)", () => {
  assert.equal(SHERIFF_ASK.lateGraceMs, 30_000);
  assert.equal(askReplyWindowMs({ config: {} }), SHERIFF_ASK.replyMs);
  assert.equal(askReplyWindowMs({ config: { sheriffLateGrace: "on" } }), SHERIFF_ASK.replyMs + SHERIFF_ASK.lateGraceMs);
  assert.equal(askReplyWindowMs({ config: { sheriffLateGrace: "off" } }), SHERIFF_ASK.replyMs);
});

test("late grace: silence past replyMs is still pending with the flag; open (shot) without it", () => {
  const v = asked();
  const t = 130_000 + SHERIFF_ASK.replyMs + 5_000;
  const off = at(v, t);
  assert.equal(shotStatus(off, "p4").status, "open");
  assert.deepEqual([sheriffShotReady(off).ok, sheriffShotReady(off).target], [true, "p4"]);
  const on = at(grace(v), t);
  const st = shotStatus(on, "p4");
  assert.equal(st.status, "pending-reply");
  assert.equal(st.until, 130_000 + SHERIFF_ASK.replyMs + SHERIFF_ASK.lateGraceMs);
  assert.equal(sheriffShotReady(on).ok, false);
  assert.match(sheriffShotReady(on).reason, /pending-reply/);
  // Bounded: once the grace runs out, silence is evidence again.
  const after = at(grace(v), 130_000 + SHERIFF_ASK.replyMs + SHERIFF_ASK.lateGraceMs + 1);
  assert.deepEqual([sheriffShotReady(after).ok, sheriffShotReady(after).target], [true, "p4"]);
  assert.match(sheriffShotReady(after).why, /no claim when asked/);
});

test("late grace: a power answer 25s after the ask protects the seat with the flag; without it the seat was already shot", () => {
  const v = asked();
  // Off: the gun is ready at 146s, before the answer lands.
  assert.equal(sheriffShotReady(at(v, 146_000)).target, "p4");
  // On: still waiting at 146s; the Journalist answer at 155s makes Cat a fresh power claim, not a target.
  const on = grace(v);
  assert.equal(sheriffShotReady(at(on, 146_000)).ok, false);
  const answered = at(reduce(on, say("p4", "im journalist", 155_000)), 156_000);
  assert.notEqual(shotStatus(answered, "p4").status, "open");
  const r = sheriffShotReady(answered);
  assert.ok(!(r.ok && r.target === "p4"), `Cat answered with a power claim inside the grace window: ${JSON.stringify(r)}`);
});

test("late grace: a Villager answer inside the grace window goes to the Villager hold, as an in-time answer does", () => {
  const v = grace(asked());
  const vt = at(reduce(v, say("p4", "im villager", 160_000)), 161_000);
  assert.equal(shotStatus(vt, "p4").status, "pending-vt");
});

test("late grace: the deadline ignores it; Day 1 still always shoots", () => {
  // Ask at 500s (past nothing yet); the deadline is 85% of the 600s day = 510s. Late reply window 10s.
  let v = at(sheriffDay([say("p2", "im cop. cat guilty", 3_000)]), 500_000);
  v = grace(reduce(v, say("p1", sheriffShotReady(v).ask.line, 500_000)));
  assert.equal(sheriffShotReady(at(v, 505_000)).ok, false, "before the deadline the grace holds");
  // Past the deadline (510s) and the 10s late reply window: shot, though the 45s grace would still be running.
  const late = at(v, 500_000 + SHERIFF_ASK.lateReplyMs + 1_000);
  assert.equal(shotStatus(late, "p4").status, "pending-reply");
  const r = sheriffShotReady(late);
  assert.deepEqual([r.ok, r.target], [true, "p4"]);
  assert.match(r.why, /day 1 always shoots: late/);
  // The last call shoots even inside the late reply window.
  const last = sheriffShotReady(at(v, 590_000));
  assert.equal(last.ok, true);
});
