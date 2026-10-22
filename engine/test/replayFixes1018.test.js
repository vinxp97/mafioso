// Three bugs the L2-L8 replay fixtures (harness/test/live1018.test.js) turned up, as unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, extractClaim, meetingActions, humanizeSpeak, SPENT_GUN_THREAT, validateAction, reduce, SHERIFF_ASK } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (from, content, t) => ({ event: "message", t, data: { meetingId: "vil", senderId: from, content, t } });

test("'X claiming cop' is about X, not a claim by the speaker; first-person and line-opening claims still count", () => {
  const claim = (content) => extractClaim({ senderId: "p1", content })?.role || null;
  assert.equal(claim("bea claiming cop feels suspicious to me"), null);
  assert.equal(claim("she is claiming cop lol"), null);
  for (const t of ["claiming cop", "im claiming cop", "i claim cop", "ok. claiming sheriff", "Claiming journalist. cal clean", "im cop. bea inno"]) assert.ok(claim(t), t);
});

test("the gun's legal options are judged per target: an asked Villager is shootable though another seat is unasked", () => {
  const v = reduceAll([
    { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    { event: "meeting", data: { id: "gun", name: "Shoot Gun", actionName: "Shoot Gun", voting: true, canVote: true, amMember: true, instant: true, targets: ids.filter((x) => x !== "p1"), votes: {} } },
    say("p1", "im sheriff", 1000), say("p2", "hi", 2000), say("p3", "hm", 3000), say("p4", "who", 4000), say("p5", "idk", 5000), say("p2", "vote someone", 6000),
    say("p1", "cal what are you", 7000), say("p3", "ash im vt", 8000),
    // Vinman 10/20: the asked Villager claimer is shot only while he is still clearly the most suspicious.
    say("p4", "cal is sus", 8500), say("p5", "vote cal", 9000),
  ]);
  // Night 5: the Villager answer is held first (more claims and reads), then shootable.
  assert.ok(!meetingActions(v, v.meetings.gun).allowed.includes("p3"), "held right after the answer");
  const after = reduce(v, { event: "time", t: 8000 + SHERIFF_ASK.vtHoldMaxMs, data: {} });
  const gun = meetingActions(after, after.meetings.gun);
  assert.ok(gun.allowed.includes("p3"), JSON.stringify(gun.notes));
  assert.ok(!gun.allowed.includes("p2"), "an unasked seat waits");
});

test("a spent-gun threat is cut whole, its addressee with it, and never leaves a stub", () => {
  const v = reduceAll([
    { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    { event: "message", data: { meetingId: "vil", senderId: "server", content: ":gun: Ash pulls a gun and shoots at Eli!" } },
  ]);
  const speak = (content) => humanizeSpeak(v, { event: "speak", data: { meetingId: "vil", content } }).data.content;
  assert.equal(speak("ok sheriff here, bea claim or im shooting"), "ok sheriff here"); // L8: was "ok sheriff here, Bea ing"
  assert.equal(speak("my read is bea, claim or im shooting"), "my read is Bea");
  assert.equal(speak("bea claim or im shooting"), "guns spent");
  for (const t of ["ok sheriff here, bea claim or im shooting", "cal claim now or im shooting, last chance", "ash, claim or i shoot. who voted early?"]) {
    const out = speak(t);
    assert.equal(SPENT_GUN_THREAT.test(out), false, out);
    assert.doesNotMatch(out, /\bing\b/, out);
    assert.equal(validateAction(v, { event: "speak", data: { meetingId: "vil", content: out } }).ok, true, out);
  }
});
