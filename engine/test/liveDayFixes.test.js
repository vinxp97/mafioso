// Designer fixes after live games: confirmed claimers, dangerous ties, the 5-way hammer,
// ballot switches, names that must survive outgoing chat, and tighter chatAudit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, soleClaimers, meetingActions, COP_SKIPS_SOLE_CLAIMER, ballotBoard, ballotSwitch, formatBallot, switchesFor, confirmedLead, townVote, townReads, hammerAskLine, HAMMER, humanizeSpeak, finalSpeak, resolveSpeechRefs, chatAudit, noCondemnDanger, buildBriefing, sheriffGunOwed } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gus"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
const vote = (voterId, target) => ({ event: "vote", data: { meetingId: "vil", voterId, target } });
const vil = () => ({ event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } });

function day(self, role, events, { mates = [], config = null, night = false } = {}) {
  return reduceAll([
    ...(config ? [{ event: "botConfig", data: config }] : []),
    { event: "self", data: self },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role } },
    ...(mates.length ? [{ event: "teammates", data: mates }] : []),
    { event: "state", data: { id: 4, name: night ? "Night 2" : "Day 2" } },
    ...(night ? [] : [vil()]),
    ...events,
  ]);
}

test("a Journalist whose counterclaim was lynched is never a Cop check; a night kill or a real flip is", () => {
  const lynched = day("p1", "Cop", [
    say("p2", "im journalist"),
    say("p3", "im journalist too"),
    vote("p4", "p3"), vote("p5", "p3"),
    { event: "death", data: "p3" },
    { event: "state", data: { id: 5, name: "Night 2" } },
    { event: "meeting", data: { id: "inv", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ids.filter((id) => id !== "p1" && id !== "p3"), votes: {} } },
  ]);
  assert.ok(soleClaimers(lynched).has("p2"));
  const e = meetingActions(lynched, lynched.meetings.inv);
  assert.equal(e.notes.p2.reason, COP_SKIPS_SOLE_CLAIMER);
  assert.equal(e.allowed.includes("p2"), false);

  const nightKill = day("p1", "Cop", [
    { event: "state", data: { id: 3, name: "Day 1" } },
    vil(),
    say("p2", "im journalist"),
    say("p3", "im journalist too"),
    { event: "state", data: { id: 4, name: "Night 1" } },
    { event: "death", data: "p3" },
    { event: "state", data: { id: 5, name: "Night 2" } },
    { event: "meeting", data: { id: "inv", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ids.filter((id) => id !== "p1"), votes: {} } },
  ]);
  assert.equal(soleClaimers(nightKill).has("p2"), false, "a cleaned counterclaim does not confirm");

  const flipped = day("p1", "Cop", [
    say("p2", "im journalist"),
    say("p3", "im journalist too"),
    vote("p4", "p3"),
    { event: "death", data: "p3" },
    { event: "reveal", data: { playerId: "p3", role: "Journalist" } },
    { event: "state", data: { id: 5, name: "Night 2" } },
    { event: "meeting", data: { id: "inv", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ids.filter((id) => id !== "p1" && id !== "p3"), votes: {} } },
  ]);
  assert.equal(soleClaimers(flipped).has("p2"), false, "the lynched player was the real Journalist");
});

test("before a deadline, town consolidates a tie that would be an autoloss after the night kill", () => {
  const v = day("p1", "Villager", [
    vote("p2", "p6"), vote("p3", "p6"), vote("p4", "p7"), vote("p5", "p7"),
  ], { config: { mafiaCount: 3 } });
  v.voteKickWarning = true;
  assert.equal(noCondemnDanger(v), "autoloss");
  const sw = ballotSwitch(v, { now: 1 });
  assert.equal(sw.target, "p6", sw?.why);
  const other = day("p4", "Villager", [
    vote("p2", "p6"), vote("p3", "p6"), vote("p4", "p7"), vote("p5", "p7"),
  ], { config: { mafiaCount: 3 } });
  other.voteKickWarning = true;
  assert.equal(ballotSwitch(other, { now: 1 }).target, "p6");
});

test("a 5-alive Sheriff asks for the hammer with no read; a larger day still waits for one", () => {
  const T = 1_800_000_000_000;
  const shot = (extraDead) => {
    const v = reduceAll([
      { event: "self", data: "p1" },
      { event: "players", data: players },
      { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
      { event: "state", data: { id: 4, name: "Day 2" } },
      { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
      { event: "message", data: { meetingId: "vil", senderId: "server", content: ":gun: Ash pulls a gun and shoots at Gus!", t: T } },
      { event: "death", data: "p7" },
      ...extraDead,
    ]);
    v.phaseStartedAt = T;
    return v;
  };
  const five = shot([{ event: "death", data: "p6" }]);
  assert.equal(Object.keys(five.players).filter((id) => !five.dead[id]).length, 5);
  assert.match(hammerAskLine(five, { now: T + HAMMER.askAfterMs }), /self-vote/);
  const six = shot([]);
  assert.equal(Object.keys(six.players).filter((id) => !six.dead[id]).length, 6);
  assert.equal(hammerAskLine(six, { now: T + HAMMER.askAfterMs }), null);
});

test("on a split, an unsure villager follows an uncontested Cop or a cleared Journalist", () => {
  const cop = day("p1", "Villager", [
    say("p2", "im cop"),
    vote("p2", "p6"), vote("p3", "p6"), vote("p4", "p7"), vote("p5", "p7"),
    say("p3", "gus is lying"), say("p4", "gus is a liar"),
  ]);
  assert.equal(confirmedLead(cop, cop.meetings.vil).by, "p2");
  const tv = townVote(cop, cop.meetings.vil, { follow: true });
  assert.equal(tv.target, "p6", tv.why);
  const jour = day("p1", "Villager", [
    say("p2", "im journalist"),
    say("p3", "im journalist too"),
    vote("p4", "p3"), vote("p5", "p3"),
    { event: "death", data: "p3" },
    vote("p2", "p6"), vote("p7", "p6"), vote("p4", "p7"), vote("p5", "p7"),
  ]);
  assert.equal(confirmedLead(jour, jour.meetings.vil).by, "p2");
  assert.equal(townVote(jour, jour.meetings.vil, { follow: true }).target, "p6");
});

test("ballot analysis tells every seat which switch lynches, and mafia will not bus off-plan", () => {
  const counts = { p4: 2, p5: 2, p6: 1 };
  const one = switchesFor(counts, "p6", "p6");
  assert.ok(one.some((s) => s.vote === "p4" && s.lynches === "p4"));
  assert.ok(one.some((s) => s.vote === "p5" && s.lynches === "p5"));
  const onTwo = switchesFor(counts, "p4voter", "p4");
  assert.ok(onTwo.some((s) => s.vote === "p5" && s.lynches === "p5"));
  const v = day("p1", "Villager", [vote("p2", "p4"), vote("p3", "p4"), vote("p4", "p5"), vote("p5", "p5"), vote("p1", "p6")]);
  const text = formatBallot(v);
  assert.match(text, /BALLOT:/);
  assert.match(text, /Switching your vote:/);
  assert.match(text, /lynches/);
  assert.match(buildBriefing(v), /BALLOT:/);
  const board = ballotBoard(v);
  assert.ok(board.perPlayer.p1.switches.some((s) => s.lynches === "p4" || s.lynches === "p5"));
  const maf = day("p1", "Mafioso", [vote("p1", "p2")], { mates: [{ id: "p2", name: "Bea", role: "Janitor" }, { id: "p3", name: "Cal", role: "Lawyer" }] });
  const sw = ballotSwitch(maf, { now: 1 });
  assert.ok(sw, "off a teammate");
  assert.notEqual(sw.target, "p2");
  assert.notEqual(sw.target, "p3");
});

test("the Sheriff does not switch his village vote while the Day 1 gun is still owed", () => {
  const gun = { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: [...ids.filter((id) => id !== "p1"), "*"], votes: {} } };
  const split = [
    { event: "state", data: { id: 3, name: "Day 1" } },
    vil(),
    gun,
    say("p2", "im cop"),
    vote("p2", "p6"), vote("p3", "p6"), vote("p4", "p7"), vote("p5", "p7"),
  ];
  const owed = day("p1", "Sheriff", split);
  assert.equal(sheriffGunOwed(owed), true);
  assert.equal(ballotSwitch(owed, { now: 1 }), null);
  assert.match(formatBallot(owed), /BALLOT:/);
  const fired = day("p1", "Sheriff", [
    ...split,
    { event: "vote", data: { meetingId: "gun", voterId: "p1", target: "p6" } },
  ]);
  assert.equal(sheriffGunOwed(fired), false);
  assert.equal(ballotSwitch(fired, { now: 1 })?.target, "p6");
});

test("outgoing lines keep usernames; only a whole-word full name is recapitalized", () => {
  const view = {
    selfId: "a",
    players: {
      a: { id: "a", name: "Ash_Quill42" },
      b: { id: "b", name: "BeaStone7" },
      c: { id: "c", name: "Vinman" },
    },
    meetings: { vil: { name: "Village", voting: true, votes: { a: "b" } } },
    dead: {},
  };
  const speak = (content) => humanizeSpeak(view, { event: "speak", data: { meetingId: "vil", content } }).data.content;
  assert.equal(speak("im cop. Ash_Quill42 inno"), "im cop. Ash_Quill42 inno");
  assert.equal(speak("results: BeaStone7 inno"), "results: BeaStone7 inno");
  assert.equal(speak("BeaStone7 is lying, im journalist"), "BeaStone7 is lying, im journalist");
  assert.equal(speak("i'm reading BeaStone7 as mafia, vote them"), "i'm reading BeaStone7 as mafia, vote them");
  assert.equal(speak("ash is quiet"), "ash is quiet");
  assert.equal(speak("vote vinman"), "vote Vinman");
  assert.equal(speak("s2 claim?"), "BeaStone7 claim?");
  assert.equal(speak("seat 3 is quiet"), "Vinman is quiet");
  assert.equal(resolveSpeechRefs(view, "vote {target}"), "vote BeaStone7");
  assert.equal(finalSpeak(view, { event: "speak", data: { meetingId: "vil", content: "<name> inno" } }).data.content, "BeaStone7 inno");
  assert.equal(speak("<role> maybe"), "<role> maybe");
});

test("chatAudit: mentioning the Sheriff is not an accusation; a dead name is sus only as the subject", () => {
  const maf = day("p5", "Mafioso", [
    { event: "reveal", data: { playerId: "p1", role: "Sheriff" } },
    say("p1", "im sheriff"),
    { event: "message", data: { meetingId: "vil", senderId: "server", content: ":gun: Ash pulls a gun and shoots at Bea!" } },
  ], { mates: [{ id: "p6", name: "Fin", role: "Janitor" }, { id: "p7", name: "Gus", role: "Lawyer" }] });
  const rules = (line) => chatAudit(maf, line).map((f) => f.rule);
  assert.equal(rules("sheriff thinks cal is mafia").includes("accuses-sheriff"), false);
  assert.equal(rules("sheriff shot bea, bad luck").includes("accuses-sheriff"), false);
  assert.ok(rules("sheriff is lying").includes("accuses-sheriff"));
  assert.ok(rules("ash is sus").includes("accuses-sheriff"));
  assert.equal(rules("push the sheriff's read").includes("lynch-sheriff"), false);
  assert.equal(rules("don't lynch the sheriff").includes("lynch-sheriff"), false);
  const town = day("p4", "Villager", [
    { event: "reveal", data: { playerId: "p1", role: "Sheriff" } },
    { event: "message", data: { meetingId: "vil", senderId: "server", content: ":gun: Ash pulls a gun and shoots at Bea!" } },
    { event: "death", data: "p3" },
  ]);
  const townRules = (line) => chatAudit(town, line).map((f) => f.rule);
  assert.equal(townRules("push the sheriff's read").includes("lynch-sheriff"), false);
  assert.ok(townRules("vote that sheriff out").includes("lynch-sheriff"));
  assert.equal(townRules("dot is sus, cal was town").includes("dead-sus"), false);
  assert.ok(townRules("cal is sus").includes("dead-sus"));
  assert.equal(townRules("there were two cops").includes("claim-count"), false);
  assert.equal(townRules("not two cops").includes("claim-count"), false);
  assert.ok(townRules("two cops and one is lying").includes("claim-count"));
});

test("mafia may call an uncontested Cop claim nonsense; town reads do not treat that as evidence", () => {
  const maf = day("p5", "Mafioso", [say("p2", "im cop")], { mates: [{ id: "p6", name: "Fin", role: "Janitor" }, { id: "p7", name: "Gus", role: "Lawyer" }] });
  assert.deepEqual(chatAudit(maf, "bea's cop claim is pure bs, vote him now").map((f) => f.rule), []);
  const before = townReads(day("p1", "Villager", [say("p2", "im cop")]));
  const after = townReads(day("p1", "Villager", [say("p2", "im cop"), say("p5", "bea is a liar and fake")]));
  assert.equal(after.score.p2, before.score.p2);
  const villager = townReads(day("p1", "Villager", [say("p5", "dot is a liar")]));
  assert.ok((villager.score.p4 || 0) > 0, "a liar call on a non-claimer still counts");
});
