// Night 5 solo flags (10/20, Nightshift): one bot among humans. Each flag is off by default and changes only
// what it names. Behavior tests on hand-built views (engine side); the harness side is in harness/test/soloFlags.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, validateAction, mafiaCounterclaim, mafiaCounterclaimer, counterclaimMates, MAFIA_CC, sheriffShotReady, lastCall, shotDeadline, isLate, kickAimedAtMe, voteHoldPick, voteHoldLate, groundedSpeechLines, soloFlagsOf, SOLO_FLAG_KEYS, chatAudit, revealedSheriff } from "../src/index.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const timer = { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } };
const cfg = (data) => ({ event: "botConfig", data });
const village = (votes = {}) => ({ event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes } });

test("solo flags: all off by default, each on only for the exact value \"on\"", () => {
  assert.deepEqual(SOLO_FLAG_KEYS, ["voteHold", "soloCounterclaim", "groundedSpeech", "voteKickGuard"]);
  assert.deepEqual(soloFlagsOf(undefined), { voteHold: false, soloCounterclaim: false, groundedSpeech: false, voteKickGuard: false });
  assert.deepEqual(soloFlagsOf({ voteHold: true, soloCounterclaim: "yes", groundedSpeech: "on" }), { voteHold: false, soloCounterclaim: false, groundedSpeech: true, voteKickGuard: false });
});

// ---- (b) soloCounterclaim ----
const MATES = [{ id: "p5", name: "Dan", role: "Mafioso" }, { id: "p6", name: "Eve", role: "Janitor" }, { id: "p7", name: "Fay", role: "Lawyer" }];
const mafiaSeat = (self, extra = [], config = null) => reduceAll([
  ...(config ? [cfg(config)] : []),
  { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role: MATES.find((m) => m.id === self).role } },
  { event: "teammates", data: MATES.filter((m) => m.id !== self) },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, village(),
  say("p1", "im sheriff", 1_000), say("p2", "hi", 2_000), ...extra,
]);
const ASK = [say("p1", "cat claim?", 30_000), say("p4", "im cop", 31_000)];

test("(b) soloCounterclaim: a lone bot whose human teammate holds the default pick counterclaims itself, once, 3-7s later", () => {
  const picker = mafiaCounterclaimer(mafiaSeat("p5", ASK), "p4");
  const lone = ["p5", "p6", "p7"].find((s) => s !== picker);
  // Off (default): the lone bot leaves it to the teammate, who is a human in a real lobby -> nobody counterclaims.
  assert.equal(mafiaCounterclaim(mafiaSeat(lone, ASK), { now: 31_500 }), null);
  const on = { soloCounterclaim: "on", botSeats: [lone] };
  const v = mafiaSeat(lone, ASK, on);
  assert.deepEqual(counterclaimMates(v), [], "no teammate is a bot");
  assert.equal(mafiaCounterclaimer(v, "p4"), lone);
  const cc = mafiaCounterclaim(v, { now: 31_500 });
  assert.ok(cc, "the lone bot counterclaims");
  assert.match(cc.line, /^Cat is lying, im the real cop$/);
  assert.doesNotMatch(cc.line, /sheriff|\bme\b/i, "never claims Sheriff, never names the Sheriff");
  assert.ok(cc.at - 31_000 >= MAFIA_CC.minMs && cc.at - 31_000 <= MAFIA_CC.maxMs, `beat ${cc.at - 31_000}ms`);
  const speak = { event: "speak", data: { meetingId: "mVil", content: cc.line } };
  assert.equal(validateAction(v, speak).ok, true, JSON.stringify(validateAction(v, speak)));
  assert.deepEqual(chatAudit(v, cc.line), []);
  // Once: after its counterclaim there is no second one.
  assert.equal(mafiaCounterclaim(mafiaSeat(lone, [...ASK, say(lone, cc.line, 35_000)], on), { now: 36_000 }), null);
  // Not on a villager answer, not when a human teammate already fake-claimed Cop, not late.
  assert.equal(mafiaCounterclaim(mafiaSeat(lone, [say("p1", "cat claim?", 30_000), say("p4", "im villager", 31_000)], on), { now: 31_500 }), null);
  assert.equal(mafiaCounterclaim(mafiaSeat(lone, [...ASK, say(picker, "im cop. bob inno", 32_000)], on), { now: 33_000 }), null);
  assert.equal(mafiaCounterclaim(mafiaSeat(lone, ASK, on), { now: 31_000 + 120_000 }), null);
  assert.deepEqual([...MAFIA_CC.roles], ["Cop", "Journalist"], "Sheriff is never a counterclaim role");
});

test("(b) soloCounterclaim: bot teammates still share one pick; without botSeats it is the default", () => {
  const picker = mafiaCounterclaimer(mafiaSeat("p5", ASK), "p4");
  // Every mate a bot: the same pick as the default.
  const all = { soloCounterclaim: "on", botSeats: ["p5", "p6", "p7"] };
  assert.equal(mafiaCounterclaimer(mafiaSeat("p5", ASK, all), "p4"), picker);
  // Two bots: exactly one of them counterclaims.
  const two = ["p5", "p6"];
  const speakers = two.map((s) => mafiaCounterclaim(mafiaSeat(s, ASK, { soloCounterclaim: "on", botSeats: two }), { now: 31_500 })).filter(Boolean);
  assert.equal(speakers.length, 1);
  // Flag on but no botSeats known: unchanged.
  for (const s of ["p5", "p6", "p7"]) assert.deepEqual(mafiaCounterclaim(mafiaSeat(s, ASK, { soloCounterclaim: "on" }), { now: 31_500 }), mafiaCounterclaim(mafiaSeat(s, ASK), { now: 31_500 }));
});

// ---- (d) voteKickGuard ----
const sheriffDay = (extra = [], config = null) => reduceAll([
  ...(config ? [cfg(config)] : []),
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, timer,
  { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "p1"), votes: {} } },
  village(),
  say("p1", "im sheriff", 1_000), say("p2", "hmm", 2_000), ...extra,
]);
const kick = (canVote) => ({ event: "meeting", data: { id: "mKick", name: "Vote Kick", voting: true, canVote, amMember: true, targets: ["Kick"], votes: {} } });

test("(d) voteKickGuard: a Vote Kick on someone else no longer fires the gun; one aimed at the Sheriff still does", () => {
  const now = 10_000;
  const open = sheriffDay([kick(true)]);
  assert.equal(lastCall(open, now), true, "default: any open Vote Kick is the last call");
  assert.equal(sheriffShotReady({ ...open, clock: now }, { now }).ok, true, "default: shoots at once");
  const guarded = sheriffDay([kick(true)], { voteKickGuard: "on" });
  assert.equal(kickAimedAtMe(guarded), false);
  for (const f of [lastCall, shotDeadline, isLate]) assert.equal(f(guarded, now), false, f.name);
  assert.equal(sheriffShotReady({ ...guarded, clock: now }, { now }).ok, false, "guard: the kick on someone else is not a deadline");
  // Aimed at me: the server's warning, or a Vote Kick I may not vote in.
  for (const v of [sheriffDay([kick(true), { event: "youAreBeingVoteKicked", data: { status: true } }], { voteKickGuard: "on" }), sheriffDay([kick(false)], { voteKickGuard: "on" })]) {
    assert.equal(kickAimedAtMe(v), true);
    assert.equal(lastCall(v, now), true);
    assert.equal(sheriffShotReady({ ...v, clock: now }, { now }).ok, true, "guard: a kick on me still fires the gun");
  }
  // No kick at all: the guard changes nothing.
  assert.deepEqual(sheriffShotReady({ ...sheriffDay([], { voteKickGuard: "on" }), clock: now }, { now }), sheriffShotReady({ ...sheriffDay(), clock: now }, { now }));
});

// ---- (a) voteHold ----
const townSeat = (role, extra = [], votes = {}) => reduceAll([
  { event: "self", data: "p2" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p2", role } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, timer, village(votes), ...extra,
]);

test("(a) voteHold: holds with no confident read until 60% of the day, then the top suspect (or the usual pick)", () => {
  const meeting = (v) => v.meetings.mVil;
  const quiet = townSeat("Villager", [say("p3", "hi all", 5_000)]);
  assert.equal(voteHoldPick(quiet, meeting(quiet), { now: 30_000 }), null, "early, no read: hold");
  assert.equal(voteHoldLate(quiet, 359_000), null);
  assert.match(String(voteHoldLate(quiet, 361_000)), /^fraction 0\.6/);
  const late = voteHoldPick(quiet, meeting(quiet), { now: 361_000 });
  assert.equal(late.target, null, "late, no read above zero: the usual rules pick");
  assert.equal(late.confident, false);
  // A read above zero but not confident: held early, voted at 60%.
  const liar = townSeat("Villager", [say("p3", "dan is lying", 5_000)]);
  assert.equal(voteHoldPick(liar, meeting(liar), { now: 30_000 }), null);
  assert.equal(voteHoldPick(liar, meeting(liar), { now: 361_000 })?.target, "p5");
});

test("(a) voteHold: a confident read votes at once; never the revealed Sheriff, never a verified claimer", () => {
  // I'm the Cop and Dan claims Cop: a lynch-level read (claimsMyRole), confident right away.
  const cop = townSeat("Cop", [say("p5", "im cop. bob inno", 5_000)]);
  const pick = voteHoldPick(cop, cop.meetings.mVil, { now: 10_000 });
  assert.equal(pick?.target, "p5");
  assert.equal(pick.confident, true);
  // The revealed Sheriff is never the hold's pick.
  const sheriff = reduceAll([{ event: "reveal", data: { playerId: "p5", role: "Sheriff" } }], cop);
  assert.equal(revealedSheriff(sheriff), "p5");
  for (const now of [10_000, 361_000]) assert.notEqual(voteHoldPick(sheriff, sheriff.meetings.mVil, { now })?.target, "p5", `t=${now}`);
});

// ---- (c) groundedSpeech ----
test("(c) groundedSpeech: only lines grounded in public facts or this seat's read; nothing when there is none", () => {
  const floor = /^(watching|not sure yet|need more here|still looking)/;
  const fresh = townSeat("Villager", [say("p3", "hi", 5_000)]);
  assert.deepEqual(groundedSpeechLines({ ...fresh, clock: 10_000 }), [], "a fresh day with nothing on record: silence");
  // One vote is not news yet; a wagon of two is.
  assert.deepEqual(groundedSpeechLines(townSeat("Villager", [], { p3: "p4" })), []);
  const wagon = groundedSpeechLines(townSeat("Villager", [], { p3: "p4", p6: "p4" }));
  assert.deepEqual(wagon, ["votes so far: cat 2"]);
  // Claims on record and this seat's confident read.
  const lines = groundedSpeechLines(townSeat("Cop", [say("p5", "im cop. bob inno", 5_000), say("p1", "im sheriff", 6_000)]));
  assert.ok(lines.some((l) => /^my read is dan/.test(l)), JSON.stringify(lines));
  assert.ok(lines.some((l) => /^claims so far: /.test(l)), JSON.stringify(lines));
  for (const l of [...wagon, ...lines]) assert.doesNotMatch(l, floor);
});
