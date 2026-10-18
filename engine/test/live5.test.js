// Live game L5-1018 (10/18, Village won), replayed with fake names. s1 Sheriff (outed at once, shot s7 at the
// last call unasked), s8 Cop (real; N1 inno on s1, then a free-chat "s5 is mafia, vote him now"), s4 Journalist
// (N1 visit on s8; N2 went elsewhere), s3/s5/s7 mafia (s3 fake-claimed Journalist on D2), s9 cleaned N1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, reduceAll, townReads, chatAudit, sheriffShotReady, sheriffAskLine, proposeNightAction, roleClaimLine, copGuiltyResult } from "../src/index.js";

const NAMES = ["AldaMercer17", "BrenTowle40", "CoraVane22", "DarioPell58", "EzraQuill31", "FinnHolt63", "GretaSloan87", "HugoRask60", "IvyMarsh51"];
const players = Object.fromEntries(NAMES.map((n, i) => [`s${i + 1}`, { id: `s${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t, meetingId = "vil") => ({ event: "message", t, data: { senderId, meetingId, content, t } });
const server = (content, t) => ({ event: "message", t, data: { senderId: "server", content, t } });
const village = (id = "vil", alive = ids) => ({ event: "meeting", data: { id, name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...alive, "*"], votes: {} } });

function seat(self, role, frames = [], d1 = true) {
  return reduceAll([{ event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role } },
    { event: "state", data: { id: 1, name: "Night 1" }, t: 0 }, { event: "state", data: { id: 2, name: "Day 1" }, t: 1_000 },
    { event: "timerInfo", t: 1_000, data: { name: "main", delay: 300_000 } }, { event: "death", data: "s9", t: 1_000 },
    village("vil", ids.filter((x) => x !== "s9")), ...(d1 ? [] : []), ...frames]);
}
const D1 = [say("s1", "im sheriff", 1_500), say("s8", "im cop. aldamercer17 inno", 8_000), say("s8", "results: aldamercer17 inno", 11_000),
  say("s5", "lol", 24_000), say("s2", "ivymarsh51 is gone, who is hunting", 28_000), say("s3", "hugo inno, vote her next", 28_100)];

test("L5 #1: a Cop claimer's free-chat accusation is not a guilty; a result line is", () => {
  assert.equal(copGuiltyResult("ezraquill31 is mafia", "ezraquill31 is mafia, vote him now"), false);
  assert.equal(copGuiltyResult("ezraquill31 guilty", "im cop. ezraquill31 guilty"), true);
  assert.equal(copGuiltyResult("ezraquill31 is guilty"), true);
  assert.equal(copGuiltyResult(" ezraquill31 mafia", "results: ezraquill31 mafia"), true);
  const v = seat("s6", "Villager", [...D1, say("s8", "ezraquill31 is mafia, vote him now", 40_000)]);
  const r = townReads(v);
  assert.deepEqual(r.record.guilty, []);
  assert.ok(!(r.reasons.s5 || []).some((w) => /guilty/.test(w)), JSON.stringify(r.reasons.s5));
  // The Cop's own reads never cite a guilty it did not get (its own public line, not its notes).
  const cop = seat("s8", "Cop", [...D1, say("s8", "im cop. ezraquill31 guilty", 40_000)]);
  assert.ok(!(townReads(cop).reasons.s5 || []).some((w) => /guilty/.test(w)), JSON.stringify(townReads(cop).reasons.s5));
});

test("L5 #2: once voting starts, the Sheriff asks a beat after his claim, before the discussion gate (no read yet)", () => {
  const v = seat("s1", "Sheriff", [{ event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, instant: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "s1"), votes: {} } }, ...D1.slice(0, 3),
    // Live, the village started voting at once (the day closes soon after all votes are in).
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((x) => x !== "s9"), "*"], votes: { s5: "s2" } } }]);
  const quiet = reduce(v, { event: "meeting", data: { ...v.meetings.vil, votes: {} } });
  assert.equal(sheriffShotReady(quiet, { now: 12_000 }).ask, undefined, "no votes yet: the discussion gate holds the ask too");
  const r = sheriffShotReady(v, { now: 12_000 });
  assert.equal(r.ok, false);
  assert.ok(r.ask?.target && r.ask.target !== "s8", JSON.stringify(r));
  assert.equal(sheriffAskLine(v, { now: 12_000 })?.line, r.ask.line);
  // A Villager reply opens the target; after the discussion gate he shoots it.
  const asked = reduce(reduce(v, say("s1", r.ask.line, 13_000)), say(r.ask.target, "im vt", 16_000));
  const more = ["s2", "s3", "s4", "s5", "s6", "s7"].reduce((x, p, i) => reduce(x, say(p, "hmm idk", 17_000 + i * 500)), asked);
  // L6: the answer settles it; he shoots the asked Villager claimer at once (no wait for reads).
  const shot = sheriffShotReady(asked, { now: 16_500 });
  assert.equal(shot.ok, true, shot.reason);
  assert.equal(shot.target, r.ask.target);
});

test("L5 #4: the real Journalist counterclaims a fake Journalist claim with a 'not me' suffix", () => {
  const v = seat("s4", "Journalist", [server(":journ: You learn that BrenTowle40 received no reports.", 50_000),
    { event: "state", data: { id: 4, name: "Day 2" }, t: 60_000 }, village("vil2"), say("s3", "im journalist, nothing useful yet. not me", 70_000, "vil2")]);
  assert.match(roleClaimLine(v) || "", /coravane22 is lying, im journalist/);
});

test("L5 #6: Journalist on Cop N2: the uncounterclaimed Cop claimer, even if already visited N1", () => {
  const n2 = [...D1, server(":journ: You received all reports that HugoRask60 received: After investigating, you learn that AldaMercer17 is Innocent!", 2_000),
    { event: "state", data: { id: 3, name: "Night 2" }, t: 100_000 },
    { event: "meeting", data: { id: "rr", name: "Receive Reports", voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "s9"), votes: {} } }];
  const v = seat("s4", "Journalist", n2);
  assert.equal(proposeNightAction(v, { lastTargetId: "s8", rng: () => 0 })?.data.selection, "s8");
  // Counterclaimed: the rule no longer forces him.
  const cc = seat("s4", "Journalist", [...D1, say("s6", "no im the real cop", 20_000), ...n2.slice(D1.length)]);
  assert.notEqual(proposeNightAction(cc, { lastTargetId: "s8", rng: () => 0 })?.data.selection, "s8");
});

test("L5 #5: blocked: doubting the revealed Sheriff, template placeholders, garbled Sheriff lines", () => {
  const v = seat("s6", "Villager", [...D1, server(":gun: AldaMercer17 pulls a gun and shoots at GretaSloan87!", 90_000), { event: "death", data: "s7", t: 90_000 },
    { event: "reveal", data: { playerId: "s7", role: "Janitor" } }]);
  const rules = (who, line) => chatAudit(who, line).map((f) => f.rule);
  assert.ok(rules(v, "is aldamercer17 really the sheriff or a fake?").includes("doubts-sheriff"));
  assert.ok(rules(v, "Target claim your role immediately.").includes("placeholder"));
  assert.ok(rules(v, "<name> is sus").includes("placeholder"));
  assert.ok(rules(v, "vote {target}").includes("placeholder"));
  const sh = { ...v, selfId: "s1", role: "Sheriff" };
  assert.ok(rules(sh, "hugorask60 vote hugo, she's mafia.").includes("garbled-vote"));
  assert.ok(rules(sh, "coravane22 shot hugorask60.").includes("wrong-shot"));
  for (const ok of ["aldamercer17 shot gretasloan87, good shot", "the target is cora", "ezra is mafia, vote ezra", "i trust aldamercer17"]) {
    assert.deepEqual(rules(v, ok).filter((r) => ["doubts-sheriff", "placeholder", "garbled-vote", "wrong-shot"].includes(r)), [], ok);
  }
});

test("L5 #6: once the Cop claimer is dead, the Journalist goes back to his normal pick (never the dead Cop)", () => {
  const n2 = [...D1, server(":journ: You received all reports that HugoRask60 received: After investigating, you learn that AldaMercer17 is Innocent!", 2_000),
    { event: "death", data: "s8", t: 99_000 },
    { event: "state", data: { id: 3, name: "Night 2" }, t: 100_000 },
    // A stale target list that still names the dead Cop must not pull the visit to him.
    { event: "meeting", data: { id: "rr", name: "Receive Reports", voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "s9"), votes: {} } }];
  const v = seat("s4", "Journalist", n2);
  const pick = proposeNightAction(v, { lastTargetId: "s8", rng: () => 0 })?.data.selection;
  assert.ok(pick && pick !== "s8" && pick !== "s4" && pick !== "s9", String(pick));
  // One other seat left alive: he still acts and visits it.
  const few = seat("s4", "Journalist", [...n2.slice(0, -1), ...["s2", "s3", "s5", "s6", "s7"].map((d) => ({ event: "death", data: d, t: 99_500 })),
    { event: "meeting", data: { id: "rr", name: "Receive Reports", voting: true, canVote: true, amMember: true, targets: ["s1", "s4"], votes: {} } }]);
  assert.equal(proposeNightAction(few, { rng: () => 0.9 })?.data.selection, "s1");
});

// Live game L6-1018 (10/18, Mafia won N2), fake names: s1 Sheriff (claimed, asked s2 at ~90s, never shot), s5 the
// real Cop (sole claimer, lynched D1 on one mafia "liar" call), s2 Lawyer (planned "im vt" reply never posted).
import { validateAction as va6, trustedClaimers, sheriffShotReady as ready6 } from "../src/index.js";
const L6 = [say("s1", "im sheriff", 500), say("s5", "im cop. ivymarsh51 inno", 3_500), say("s5", "results: ivymarsh51 inno", 9_500),
  say("s4", "ivy died clean, need a second kill", 37_000), say("s7", "ezraquill31 is lying about the body", 99_000)];

test("L6 B: a living, uncounterclaimed Cop claimer is off the table for town votes (soft 'liar' reads don't count)", () => {
  const v = seat("s3", "Villager", L6);
  assert.ok(trustedClaimers(v).has("s5"));
  assert.match(va6(v, { event: "vote", data: { meetingId: "vil", selection: "s5" } }).reason || "", /never lynch an uncounterclaimed Cop/);
  // Hard evidence opens it: a counterclaim.
  const cc = seat("s3", "Villager", [...L6, say("s6", "no im cop. ezraquill31 lies", 100_000)]);
  assert.equal(trustedClaimers(cc).has("s5"), false);
  assert.equal(va6(cc, { event: "vote", data: { meetingId: "vil", selection: "s5" } }).ok, true);
  // Mafia are not bound by it.
  assert.equal(va6(seat("s7", "Mafioso", L6), { event: "vote", data: { meetingId: "vil", selection: "s5" } }).ok, true);
});

test("L6 A2: the Sheriff shoots the asked seat 15s after an unanswered ask (no read, discussion gate or not)", () => {
  const gunM = { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, instant: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "s1"), votes: {} } };
  const v = seat("s1", "Sheriff", [gunM, ...L6.slice(0, 3), say("s1", "brentowle40 claim before i shoot", 90_000)]);
  assert.equal(ready6(v, { now: 100_000 }).ok, false, "inside the 15s reply window");
  const r = ready6(v, { now: 105_500 });
  assert.equal(r.ok, true, r.reason); assert.equal(r.target, "s2");
});

test("L6 C: blocked: town pushing the Sheriff's lynch; the Sheriff calling Sheriff and Cop claims a conflict", () => {
  const rules = (v, line) => chatAudit(v, line).map((f) => f.rule);
  const town = seat("s8", "Villager", L6);
  assert.ok(rules(town, "believe the cop, vote that sheriff out").includes("lynch-sheriff"));
  assert.ok(rules(town, "lynch aldamercer17").includes("lynch-sheriff"));
  for (const ok of ["the sheriff is solid", "vote ezra not the sheriff, he is town", "sheriff shoot gretasloan87"]) assert.equal(rules(town, ok).includes("lynch-sheriff"), false, ok);
  const sh = seat("s1", "Sheriff", L6);
  assert.ok(rules(sh, "both claiming law enforcement, someone is lying").includes("sheriff-cop-conflict"));
  assert.equal(rules(sh, "ezra cop claim checks out").includes("sheriff-cop-conflict"), false);
});
