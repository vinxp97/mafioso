// Live game L4-1018 (10/18, Mafia won at parity after the Sheriff was vote-kicked), replayed with fake names.
// s3 Sheriff (outed, shot s1 for "s3 shut up, you are mafia"), s2 Cop claimer, s4/s5/s7 mafia, s6 cleaned N1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, reduceAll, chatAudit, legalVotes, rulesSeatActions, sheriffShotReady, sheriffThreat, revealedSheriff } from "../src/index.js";

const NAMES = ["AldaMercer17", "BrenTowle40", "CoraVane22", "DarioPell58", "EzraQuill31", "FinnHolt63", "GretaSloan87", "HugoRask60", "IvyMarsh51"];
const players = Object.fromEntries(NAMES.map((n, i) => [`s${i + 1}`, { id: `s${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t, meetingId = "vil") => ({ event: "message", t, data: { senderId, meetingId, content, t } });
const server = (content, t) => ({ event: "message", t, data: { senderId: "server", content, t } });
const gunMeeting = (extra = {}) => ({ event: "meeting", data: { id: "gun", name: "Shoot Gun", actionName: "Shoot", voting: true, instant: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "s3"), votes: {}, ...extra } });

function sheriff(frames = []) {
  return reduceAll([{ event: "self", data: "s3" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "s3", role: "Sheriff" } },
    { event: "state", data: { id: 1, name: "Night 1" }, t: 0 }, { event: "state", data: { id: 2, name: "Day 1" }, t: 1_000 },
    { event: "timerInfo", t: 1_000, data: { name: "main", delay: 600_000 } }, { event: "death", data: "s6", t: 1_000 },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((x) => x !== "s6"), "*"], votes: {} } },
    gunMeeting(), say("s3", "im sheriff", 2_000), say("s2", "im cop. gretasloan87 inno", 3_000), ...frames]);
}
const SHOT = [{ event: "vote", t: 60_000, data: { meetingId: "gun", voterId: "s3", target: "s1" } }, server(":gun: CoraVane22 pulls a gun and shoots at AldaMercer17!", 60_000),
  { event: "death", data: "s1", t: 60_000 }, { event: "reveal", data: { playerId: "s1", role: "Villager" } }, { event: "reveal", data: { playerId: "s3", role: "Sheriff" } }];

test("L4 #1: the fired gun is spent; its vote on the dead target is not a stale vote to redo", () => {
  let v = sheriff(SHOT);
  // The server re-sends the finished gun meeting after the vote (Player.js sendMeeting), his vote on s1 in it.
  v = reduce(v, { ...gunMeeting({ votes: { s3: "s1" } }), t: 60_001 });
  assert.equal(v.meetings.gun.used, true);
  assert.equal(v.meetings.gun.votes.s3, "s1", "pruneDeadVotes leaves an instant meeting's vote alone");
  assert.deepEqual(legalVotes(v).map((l) => l.name), ["Village"]);
  const acts = rulesSeatActions(v, { now: 300_000 }).actions.filter((a) => a.event === "vote");
  assert.equal(acts.some((a) => a.data.meetingId === "gun"), false);
  assert.ok(acts.some((a) => a.data.meetingId === "vil"), JSON.stringify(acts));
  // Re-sent without his vote (or as a non-member after leftMeeting), it stays spent / gone.
  const v2 = reduce(v, { ...gunMeeting({ votes: {} }), t: 61_000 });
  assert.equal(v2.meetings.gun.used, true);
  const v3 = reduce(reduce(sheriff(SHOT), { event: "leftMeeting", data: "gun" }), gunMeeting({ amMember: false, canVote: undefined }));
  assert.equal(v3.meetings.gun, undefined);
});

test("L4 #2: an accusation of the Sheriff is not a shot reason; any shot target is asked to claim first", () => {
  const talk = [say("s1", "coravane22 shut up, you are mafia", 10_000), ...["s4", "s5", "s7", "s8", "s9", "s2"].map((p, i) => say(p, "idk who yet", 11_000 + i))];
  const v = sheriff(talk);
  assert.equal(sheriffThreat(v), null);
  const early = sheriffShotReady(v, { now: 20_000 });
  assert.equal(early.ok, false);
  // Late in the day, still an ask before the shot, whoever the target is.
  const late = sheriffShotReady(v, { now: 530_000 });
  assert.equal(late.ok, false, late.why);
  assert.ok(late.ask?.target, late.reason);
  const asked = reduce(v, say("s3", late.ask.line, 530_000));
  assert.equal(sheriffShotReady(asked, { now: 535_000 }).ok, false, "a reply window, late too");
  const shot = sheriffShotReady(asked, { now: 541_000 });
  assert.equal(shot.ok, true);
  assert.equal(shot.target, late.ask.target);
  // A Sheriff counterclaim is still shot at once (a claim, not an accusation).
  assert.equal(sheriffThreat(sheriff([say("s8", "no im the sheriff", 10_000)]))?.target, "s8");
});

test("L4 #3: after the gun reveals the Sheriff, town lines doubting or attacking him are blocked", () => {
  const v = reduceAll([{ event: "self", data: "s8" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "s8", role: "Villager" } },
    { event: "state", data: { id: 2, name: "Day 1" } }, { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ids, votes: {} } },
    server(":gun: CoraVane22 pulls a gun and shoots at AldaMercer17!"), { event: "death", data: "s1" }, { event: "reveal", data: { playerId: "s1", role: "Villager" } }]);
  assert.equal(revealedSheriff(v), "s3");
  const rules = (line) => chatAudit(v, line).map((f) => f.rule);
  for (const line of ["cora shot a villager, why would you trust him", "coravane22 lol shoot a villager then tell me what to do?",
    "cora shot a villager, you're a blind wolf lol", "coravane22 shut up, you're the wolf.", "cora seems off, he is sus", "cora, why did you shoot a villager?"]) {
    assert.ok(rules(line).some((r) => r === "attacks-sheriff" || r === "doubts-sheriff"), line);
  }
  for (const line of ["cora is confirmed town, trust him", "i trust cora", "cora who do you think is mafia?", "vote gretasloan87, cora agrees", "unlucky shot cora, aldamercer17 flipped villager"]) {
    assert.deepEqual(rules(line).filter((r) => r === "attacks-sheriff" || r === "doubts-sheriff"), [], line);
  }
});

test("L4 #5: cheap garble checks: two roles on one player, a flip that says nothing about a claim", () => {
  const v = sheriff([...SHOT, say("s2", "gretasloan87 inno, trust me", 70_000)]);
  const town = { ...v, selfId: "s8", role: "Villager" };
  const rules = (line) => chatAudit(town, line).map((f) => f.rule);
  assert.ok(rules("cora u the cop and the sheriff").includes("role-stack"));
  assert.deepEqual(rules("cora u the sheriff, bren the cop").filter((r) => r === "role-stack"), []);
  assert.ok(rules("cora, aldamercer17 flip kills brentowle40 claim. vote him.").includes("flip-claim"));
  // The Cop claimer gave a result on the flipped player: the flip does bear on his claim.
  const v2 = { ...sheriff([...SHOT, say("s2", "aldamercer17 inno", 70_000)]), selfId: "s8", role: "Villager" };
  assert.deepEqual(chatAudit(v2, "aldamercer17 flip kills brentowle40 claim").map((f) => f.rule).filter((r) => r === "flip-claim"), []);
  // "X flip" about a living X is already flagged (L2).
  assert.ok(rules("gretasloan87 flip proves it").includes("flip"));
});

test("L4 #2: while the late ask waits for its reply, the gun is still owed (the Village vote stays held)", async () => {
  const { sheriffGunOwed } = await import("../src/index.js");
  const talk = ["s4", "s5", "s7", "s8", "s9", "s2"].map((p, i) => say(p, "idk who yet", 11_000 + i));
  const v = sheriff(talk);
  const late = sheriffShotReady(v, { now: 530_000 });
  const asked = reduce(reduce(v, say("s3", late.ask.line, 530_000)), { event: "time", t: 535_000, data: {} });
  assert.equal(sheriffShotReady(asked, { now: 535_000 }).ok, false);
  assert.equal(sheriffGunOwed(asked), true);
});
