// Adaptive mafia (FJ, Vinman's strategy from the mafia side) and the town reads that answer it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduceAll, decide, townReads, TOWN_READS, mafiaModeOf, observerView, adaptiveKill, claimOptions, adaptiveDraft,
  formatAdaptivePlan, adaptiveClaimLine, adaptiveVote, parsePlanLine, publicReads, stateHash,
} from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const TEAM = { p1: "Mafioso", p2: "Janitor", p3: "Lawyer" };

/** A mafia seat (p1 by default) on Night/Day N, adaptive unless told otherwise. */
function scum(events = [], { phase = "Night 1", self = "p1", mafia = "adaptive", sid = 5 } = {}) {
  const day = /^day/i.test(phase);
  return reduceAll([
    { event: "self", data: self },
    { event: "players", data: players },
    ...(mafia ? [{ event: "botConfig", data: { mafia } }] : []),
    ...Object.entries(TEAM).map(([id, role]) => ({ event: "roleReveal", data: { playerId: id, role } })),
    ...events.filter((e) => e.pre),
    { event: "state", data: { id: sid, name: phase } },
    day
      ? { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== self), "*"], votes: {} } }
      : { event: "meeting", data: { id: "maf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, targets: ids.filter((i) => !TEAM[i]), votes: {}, members: Object.keys(TEAM).map((id) => ({ id })) } },
    ...events.filter((e) => !e.pre),
  ]);
}
const say = (from, content, pre = true) => ({ pre, event: "message", data: { meetingId: "vil", senderId: from, content } });
const dies = (id, role) => [{ pre: true, event: "death", data: id }, ...(role ? [{ pre: true, event: "reveal", data: { playerId: id, role } }] : [])];
const pool = (v) => ids.filter((i) => !TEAM[i] && !v.dead?.[i]);

test("mode: engine default is the old script, the harness flag selects adaptive", () => {
  assert.equal(mafiaModeOf(scum([], { mafia: null })), "script");
  assert.equal(mafiaModeOf(scum([], { mafia: "script" })), "script");
  assert.equal(mafiaModeOf(scum()), "adaptive");
});

test("kill priority from public claims: Cop > Sheriff > Journalist", () => {
  const all = scum([say("p4", "im journalist"), say("p5", "im sheriff"), say("p6", "im cop. cal inno")], { phase: "Night 2" });
  assert.equal(adaptiveKill(all, pool(all)), "p6");
  const noCop = scum([say("p4", "im journalist"), say("p5", "im sheriff")], { phase: "Night 2" });
  assert.equal(adaptiveKill(noCop, pool(noCop)), "p5");
  const jOnly = scum([say("p4", "im journalist")], { phase: "Night 2" });
  assert.equal(adaptiveKill(jOnly, pool(jOnly)), "p4");
});

test("no claims: kills spread over the players town trusts, varying by night", () => {
  const picks = new Set();
  for (let n = 1; n <= 8; n++) { const v = scum([], { phase: `Night ${n}` }); picks.add(adaptiveKill(v, pool(v))); }
  assert.ok(picks.size >= 2, `same kill every night: ${[...picks]}`);
});

test("no fake Cop once a real Cop has flipped, claimed, or is verified", () => {
  assert.equal(claimOptions(scum()).cop, true);
  assert.equal(claimOptions(scum([...dies("p6", "Cop")], { phase: "Night 2" })).cop, false, "Cop flipped");
  assert.equal(claimOptions(scum([say("p6", "im cop. cal inno")], { phase: "Night 2" })).cop, false, "a living outside Cop claim");
  // A plan drafted after a Cop flip names no Cop claimer.
  const v = scum([...dies("p6", "Cop")], { phase: "Night 2" });
  const plan = adaptiveDraft(v, { killTarget: "p4", lynchTarget: "p5", lawyerTarget: "p1" }, pool(v));
  assert.notEqual(plan.claimRole, "Cop");
});

test("the Janitor claims the role it cleaned (Cop/Journalist), never the Sheriff; and not one the dead player claimed", () => {
  const clean = { pre: true, event: "message", data: { senderId: "server", content: "You learn that Fin's role is Cop." } };
  const plan = { claimRole: "Cop", speakerId: "p2", lynchTarget: "p5", killTarget: "p4" };
  const j = scum([...dies("p6"), clean], { phase: "Day 2", self: "p2" });
  assert.equal(claimOptions(j).cleanedRole, "Cop");
  assert.equal(adaptiveClaimLine(j, plan).role, "Cop");
  const claimedBefore = scum([say("p6", "im cop. eli inno"), ...dies("p6"), clean], { phase: "Day 2", self: "p2" });
  assert.equal(claimOptions(claimedBefore).cleanedRole, null, "the cleaned player had claimed Cop in public");
  const sheriffClean = scum([...dies("p6"), { ...clean, data: { ...clean.data, content: "You learn that Fin's role is Sheriff." } }], { phase: "Day 2", self: "p2" });
  assert.equal(claimOptions(sheriffClean).cleanedRole, null);
  for (let n = 1; n <= 6; n++) {
    const v = scum([], { phase: `Night ${n}` });
    const p = adaptiveDraft(v, { killTarget: "p4", lynchTarget: "p5", lawyerTarget: "p1" }, pool(v));
    assert.notEqual(p.claimRole, "Sheriff");
  }
});

test("who fake-claims, and whether anyone does, varies", () => {
  const speakers = new Set(); let none = 0;
  for (let n = 1; n <= 24; n++) {
    const v = scum([], { phase: `Night ${n % 4 + 1}`, sid: 100 + n });
    const p = adaptiveDraft(v, { killTarget: "p4", lynchTarget: "p5", lawyerTarget: "p1" }, pool(v));
    if (p.claimRole) speakers.add(p.speakerId); else none += 1;
  }
  assert.ok(none > 0 && none < 24, `claims ${24 - none}/24`);
  assert.ok(speakers.size >= 2, `speakers ${[...speakers]}`);
});

test("plan lines are natural language and parse back: no claims, a teammate as claimer, save the clean", () => {
  const v = scum();
  const quiet = { killTarget: "p4", lynchTarget: "p5", claimRole: null, speakerId: null, lawyerTarget: "p2", janitorTarget: null };
  const line = formatAdaptivePlan(quiet, v);
  assert.equal(line, "kill dot tonight, no fake claims tmrw, lay low and lean eli, lawyer go on bea, save the clean");
  assert.doesNotMatch(line, /PLAN|\w+=\w+/);
  const p = parsePlanLine(line, v, "p1");
  assert.equal(p.killTarget, "p4"); assert.equal(p.claimRole, null); assert.equal(p.janitorTarget, null);
  const mate = formatAdaptivePlan({ ...quiet, claimRole: "Cop", speakerId: "p2", janitorTarget: "p4" }, v);
  assert.match(mate, /bea fake cop tmrw and push eli/);
  const q = parsePlanLine(mate, v, "p1");
  assert.equal(q.claimRole, "Cop"); assert.equal(q.speakerId, "p2");
});

test("day votes: never all three on one target short of the endgame, and no vote on a revealed townie", () => {
  const plan = { killTarget: "p4", lynchTarget: "p5", claimRole: null, speakerId: null, adaptive: true };
  const v = scum([], { phase: "Day 1" });
  v.meetings.vil.votes = { p2: "p5", p3: "p5", p6: "p5", p7: "p5" };
  const pick = adaptiveVote(v, v.meetings.vil, plan);
  assert.ok(pick && pick !== "p5", `third scum vote joined the bloc: ${pick}`);
  const sheriff = scum([{ pre: true, event: "reveal", data: { playerId: "p5", role: "Sheriff" } }], { phase: "Day 1" });
  assert.notEqual(adaptiveVote(sheriff, sheriff.meetings.vil, plan), "p5");
});

test("the observer view never reveals a living player's hidden role", () => {
  const v = scum([{ pre: true, event: "reveal", data: { playerId: "p5", role: "Sheriff" } }, ...dies("p6", "Cop")], { phase: "Day 2" });
  const o = observerView(v);
  assert.equal(o.selfId, "__observer__");
  assert.deepEqual(o.teammates, {});
  assert.equal(o.reveals.p1, undefined); assert.equal(o.reveals.p2, undefined); assert.equal(o.reveals.p3, undefined);
  assert.equal(o.reveals.p5, "Sheriff"); assert.equal(o.reveals.p6, "Cop");
  assert.ok(Object.keys(publicReads(v).score).every((id) => players[id]));
});

test("adaptive chat: the night line and the day claim carry no PLAN or key=value syntax", () => {
  for (let n = 1; n <= 6; n++) {
    const v = scum([], { phase: `Night ${n}` });
    for (const a of decide(v)) if (a.event === "speak") assert.doesNotMatch(a.data.content, /\bPLAN\b|\b\w+=\w+/);
  }
  const plan = { claimRole: "Cop", speakerId: "p1", lynchTarget: "p5", killTarget: "p4" };
  const line = adaptiveClaimLine(scum([], { phase: "Day 1" }), plan).line;
  assert.equal(line, "im cop. eli guilty");
});

test("stateHash is deterministic and in [0,1)", () => {
  assert.equal(stateHash("a", 1), stateHash("a", 1));
  const x = stateHash("x", "y"); assert.ok(x >= 0 && x < 1);
});

// Town answers from public play.
function town(events, phase = "Day 3") {
  return reduceAll([
    { event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role: "Villager" } },
    ...events,
    { event: "state", data: { id: 9, name: phase } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== "p9"), "*"], votes: {} } },
  ]);
}
const vote = (voterId, target) => ({ event: "vote", data: { meetingId: "v", voterId, target } });

test("town: voting with a player who flipped mafia, and voting the mafia lynch, move suspicion", () => {
  const v = town([
    { event: "state", data: { id: 2, name: "Day 1" } }, vote("p1", "p5"), vote("p4", "p5"), vote("p6", "p7"),
    { event: "state", data: { id: 4, name: "Day 2" } }, vote("p6", "p1"), vote("p7", "p1"),
    { event: "death", data: "p1" }, { event: "reveal", data: { playerId: "p1", role: "Mafioso" } },
  ]);
  const r = townReads(v);
  assert.equal(r.score.p4, TOWN_READS.votedWithScum, JSON.stringify(r.reasons.p4));
  assert.equal(r.score.p5, TOWN_READS.votedByScum);
  assert.equal(r.score.p6, TOWN_READS.votedOnScum);
});

test("town: a verified Cop's innocent clears, fully once the Lawyer has flipped", () => {
  const base = [
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "message", data: { meetingId: "vil", senderId: "p4", content: "im cop. ash guilty" } },
    { event: "death", data: "p1" }, { event: "reveal", data: { playerId: "p1", role: "Mafioso" } },
    { event: "message", data: { meetingId: "vil", senderId: "p4", content: "results: eli inno" } },
  ];
  assert.ok(townReads(town(base)).score.p5 <= TOWN_READS.credibleInno);
  const lawyerGone = townReads(town([...base, { event: "death", data: "p3" }, { event: "reveal", data: { playerId: "p3", role: "Lawyer" } }]));
  assert.ok(lawyerGone.score.p5 <= TOWN_READS.clearedInno, JSON.stringify(lawyerGone.reasons.p5));
});

test("town: a night-killed, cleaned Cop claimer was town, so the other Cop claimer is lying", () => {
  const v = town([
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "message", data: { meetingId: "vil", senderId: "p4", content: "im cop. ash guilty" } },
    { event: "message", data: { meetingId: "vil", senderId: "p6", content: "im cop. eli inno" } },
    { event: "state", data: { id: 4, name: "Day 2" } },
    { event: "death", data: "p6" },
  ]);
  assert.ok(townReads(v).score.p4 >= TOWN_READS.cleanedClaimer, JSON.stringify(townReads(v).reasons.p4));
});

test("town: a standing vote on a revealed townie (the Sheriff after a shot) is suspicious", () => {
  const v = town([
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "reveal", data: { playerId: "p5", role: "Sheriff" } }, vote("p2", "p5"),
  ], "Day 2");
  assert.equal(townReads(v).score.p2, TOWN_READS.votedRevealedTown);
});

test("scum vote timing: the hold is sampled from town's measured first-vote delays (config can override)", async () => {
  const { scumVoteHoldMs, sampleQuantiles, TOWN_VOTE_DELAY_MS } = await import("../src/index.js");
  assert.equal(TOWN_VOTE_DELAY_MS.length, 11);
  assert.equal(sampleQuantiles([0, 10, 20], 0.5), 10);
  assert.equal(sampleQuantiles([0, 10, 20], 0.25), 5);
  const v = scum([], { phase: "Day 1", sid: 7 });
  const h = scumVoteHoldMs(v);
  assert.ok(h >= TOWN_VOTE_DELAY_MS[0] && h <= TOWN_VOTE_DELAY_MS[10]);
  const table = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  const holds = new Set();
  for (const self of ["p1", "p2", "p3"]) for (let sid = 1; sid <= 6; sid++) {
    const x = scumVoteHoldMs(scum([], { phase: "Day 1", self, sid }), table);
    assert.ok(x >= 0 && x <= 10000); holds.add(x);
  }
  assert.ok(holds.size >= 5, "holds vary by seat and day");
  v.config = { ...v.config, townVoteDelayMs: [4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000] };
  assert.equal(scumVoteHoldMs(v), 4000);
});
