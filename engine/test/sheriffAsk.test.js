// Vinman 2026-10-18: the Sheriff asks before he shoots; town never lynches the revealed Sheriff; mafia never call
// him suspicious; kill priority Cop > Sheriff > Journalist; the Sheriff never shoots the village vote leader.
// Plus chatAudit gaps from game GAME02 (cleaned flips, misquotes, a Cop urging a lynch on his own clear) and
// the server's stale votes on a dead player (Meeting.generateTargets).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduceAll, reduce, validateAction, sheriffShotReady, applySheriffRule, parseClaimReply, sheriffAsks, sheriffAskedMe,
  askReplyLine, claimAllowed, legalActions, NEVER_LYNCH_SHERIFF, chatAudit, adaptiveKill, priorityKill, MAFIA_KILL_PRIORITY,
  legalVotes, villageLeader, shotStatus, SHERIFF_ASK, adaptiveClaimLine,
} from "../src/index.js";

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

// ---- parser for claims replying to the Sheriff's ask (live path) ----
test("parseClaimReply reads casual answers: power, plain, refusal, negation, nothing", () => {
  const cases = {
    "im cop": ["Cop", "power"], "I'm the Journalist": ["Journalist", "power"], "cop here": ["Cop", "power"], "journo": ["Journalist", "power"],
    "im the doc": ["Doctor", "power"], "i'm doctor lol": ["Doctor", "power"], "im the real cop, results: bob inno": ["Cop", "power"],
    "vt": ["Villager", "plain"], "me im vt": ["Villager", "plain"], "im just a villager": ["Villager", "plain"], "vanilla town": ["Villager", "plain"],
    "town": ["Villager", "plain"], "i'm town": ["Villager", "plain"], "blue": ["Villager", "plain"], "im blue": ["Villager", "plain"],
    "v/t": ["Villager", "plain"], "im v/t": ["Villager", "plain"], "not cop, v/t": ["Villager", "plain"],
    "not claiming": [null, "refuse"], "not telling you": [null, "refuse"], "im not cop": [null, "refuse"], "not cop, vt": ["Villager", "plain"],
  };
  for (const [text, [role, kind]] of Object.entries(cases)) assert.deepEqual(parseClaimReply(text), { role, kind }, text);
  for (const text of ["why me", "bob is sus", "lol", "", "vote cat"]) assert.equal(parseClaimReply(text), null, text);
});

test("the Sheriff's ask is read from his own line; a target's answer and a counterclaim are tracked", () => {
  let v = sheriffDay([say("p1", "cat claim?", 10_000), say("p4", "im cop", 11_000)]);
  const [a] = sheriffAsks(v);
  assert.equal(a.target, "p4");
  assert.deepEqual([a.reply.role, a.reply.kind], ["Cop", "power"]);
  assert.equal(a.counter, null);
  v = reduce(v, say("p3", "bob here, im the real cop", 12_000));
  assert.equal(sheriffAsks(v)[0].counter.by, "p3");
  // "im sheriff" from me is not an ask; a line naming two players is not an ask either.
  assert.equal(sheriffAsks(sheriffDay([say("p1", "cat or bob, claim?", 10_000)])).length, 0);
});

// ---- Rule 1: ask before shooting ----
test("rule 1: the Sheriff asks his target first; a non-power answer (or none) lets the shot go", () => {
  let v = at(sheriffDay([say("p2", "im cop. cat guilty", 3_000)]), 130_000);
  let r = sheriffShotReady(v);
  assert.equal(r.ok, false);
  assert.equal(r.ask.target, "p4", "ask the Cop's guilty first");
  assert.match(r.ask.line, /^cat\b/);
  assert.match(validateAction(v, shoot("p4")).reason, /too early/);
  v = at(reduce(v, say("p1", r.ask.line, 130_000)), 131_000);
  assert.match(sheriffShotReady(v).reason, /waiting on Cat \(pending-reply\)/);
  // A plain answer: shoot.
  const plain = at(reduce(v, say("p4", "alice why me, im vt", 131_000)), 132_000);
  assert.deepEqual([sheriffShotReady(plain).ok, sheriffShotReady(plain).target], [true, "p4"]);
  // No answer within the window: shoot.
  const silent = at(v, 130_000 + SHERIFF_ASK.replyMs + 1);
  assert.deepEqual([sheriffShotReady(silent).ok, sheriffShotReady(silent).target], [true, "p4"]);
  assert.match(sheriffShotReady(silent).why, /no claim when asked/);
  // A refusal: shoot.
  const refuse = at(reduce(v, say("p4", "not claiming", 131_000)), 132_000);
  assert.equal(sheriffShotReady(refuse).target, "p4");
});

test("rule 1: a power-role answer waits for a counterclaim; none in time means pick someone else", () => {
  let v = at(sheriffDay([say("p2", "cat is sus"), say("p1", "cat claim?", 130_000), say("p4", "im journalist", 131_000)]), 132_000);
  v.notes = { ...(v.notes || {}), suspects: ["p4", "p5"] };
  assert.equal(shotStatus(v, "p4").status, "pending-cc");
  assert.match(sheriffShotReady(v).reason, /pending-cc/);
  assert.match(validateAction(v, shoot("p4")).reason, /too early|pending-cc/);
  // Nobody counterclaimed: Cat is protected; the Sheriff asks the next suspect, never shoots Cat.
  const later = at(v, 131_000 + SHERIFF_ASK.ccMs + 1);
  assert.equal(shotStatus(later, "p4").status, "protected");
  const next = sheriffShotReady(later);
  assert.equal(next.ok, false);
  assert.ok(next.ask && next.ask.target !== "p4", `asks someone else, got ${JSON.stringify(next)}`);
  // Counterclaimed: the claim is contested and the shot goes ahead.
  const cc = at(reduce(v, say("p6", "cat is lying, im the journalist", 133_000)), 134_000);
  assert.equal(shotStatus(cc, "p4").status, "contested");
  const shot = sheriffShotReady(cc);
  assert.equal(shot.ok, true);
  assert.ok(["p4", "p6"].includes(shot.target));
});

test("rule 1 + D1 always: late in the day the shot fires, skipping a protected claim and the vote leader", () => {
  let v = sheriffDay([say("p1", "cat claim?", 130_000), say("p4", "im cop", 131_000), voteEv("p2", "p5"), voteEv("p3", "p5"), voteEv("p6", "p7")]);
  v.notes = { ...(v.notes || {}), suspects: ["p4", "p5", "p7"] };
  v = at(v, 560_000); // 93% of the day
  const r = sheriffShotReady(v);
  assert.equal(r.ok, true);
  assert.equal(r.target, "p7", "Cat is an uncontested Cop claim, Dan leads the vote 2-1: Fay");
  assert.match(r.why, /^day 1 always shoots: late/);
  assert.equal(villageLeader(v), "p5");
  assert.match(validateAction(v, shoot("p5")).reason, /vote leader/);
  assert.match(validateAction(v, shoot("p4")).reason, /protected \(Cop\)/);
  assert.deepEqual(applySheriffRule(v, [shoot("p4")]), [shoot("p7")]);
  // Late with only an asked-but-silent target left: an unanswered ask is not a claim, so he is shot.
  let w = sheriffDay([say("p1", "dan claim?", 520_000)]);
  w.notes = { ...(w.notes || {}), suspects: ["p5"] };
  w = at(w, 520_000 + SHERIFF_ASK.replyMs + 5_000);
  assert.equal(sheriffShotReady(w).target, "p5");
});

test("rule 1: the Sheriff's Village vote stays held on Day 1 while the ask runs (the day can't close first)", () => {
  let v = at(sheriffDay([say("p2", "im cop. cat guilty", 3_000), ...["p2", "p3", "p4", "p5", "p6"].map((p) => voteEv(p, "p6"))]), 130_000);
  const vil = { event: "vote", data: { meetingId: "mVil", selection: "p6" } };
  const out = applySheriffRule(v, [vil]);
  assert.equal(out.some((a) => a.data.meetingId === "mVil"), false, "Village vote held");
  assert.equal(out.some((a) => a.data.meetingId === "gun"), false, "no shot before Cat answers");
});

// ---- the answer: who says what when the Sheriff asks ----
const asked = (role, extra = [], mates = []) => {
  const v = reduceAll([
    { event: "self", data: "p4" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p4", role } },
    ...(mates.length ? [{ event: "teammates", data: mates }] : []),
    { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    say("p1", "im sheriff", 1_000), ...extra, say("p1", "cat claim?", 130_000),
  ]);
  if (role !== "Villager" && !mates.length) v.config = { ...(v.config || {}), mafia: "adaptive" };
  else v.config = { ...(v.config || {}), mafia: "adaptive" };
  return v;
};

test("asked seats answer: Villager says villager, Cop claims with results, mafia fake-claims an open power role", () => {
  const vt = asked("Villager");
  assert.ok(sheriffAskedMe(vt));
  assert.equal(askReplyLine(vt), "me im villager");
  assert.doesNotMatch(askReplyLine(vt), /\bvt\b|v\/t/i);
  assert.deepEqual(parseClaimReply(askReplyLine(vt)), { role: "Villager", kind: "plain" });
  const cop = asked("Cop", [{ event: "message", data: { senderId: "server", content: "Your investigation shows that Bob is Innocent" } }]);
  assert.equal(claimAllowed(cop), true, "the ask unlocks the Cop claim");
  assert.match(askReplyLine(cop), /^im cop\. Bob inno/);
  const maf = asked("Mafioso", [], [{ id: "p6", name: "Eve", role: "Janitor" }, { id: "p7", name: "Fay", role: "Lawyer" }]);
  const line = askReplyLine(maf);
  assert.match(line, /^im (cop|journalist)/, line);
  assert.equal(validateAction(maf, { event: "speak", data: { meetingId: "mVil", content: line } }).ok, true, "passes the claim gate and chatAudit");
  // Not asked: no reply line; already claimed: no second claim.
  assert.equal(askReplyLine(reduceAll([{ event: "self", data: "p4" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p4", role: "Villager" } }, { event: "state", data: { id: 3, name: "Day 1" } }])), null);
  assert.equal(askReplyLine(asked("Villager", [say("p4", "im vt btw", 5_000)])), null);
});

// ---- Rule 2: town never lynches the revealed Sheriff; Rule 3 mafia never vote or accuse him ----
const afterShot = (selfId, role, mates = []) => reduceAll([
  { event: "self", data: selfId }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: selfId, role } },
  ...(mates.length ? [{ event: "teammates", data: mates }] : []),
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  say("p1", "im sheriff", 1_000), { event: "message", data: { senderId: "server", content: ":gun: Me pulls a gun and shoots at Bob!" } },
  { event: "reveal", data: { playerId: "p1", role: "Sheriff" } }, { event: "death", data: "p3" }, { event: "reveal", data: { playerId: "p3", role: "Villager" } },
]);
const MAFIA = [{ id: "p6", name: "Eve", role: "Janitor" }, { id: "p7", name: "Fay", role: "Lawyer" }];

test("rule 2: the revealed Sheriff is not an allowed Village vote, for town and mafia alike", () => {
  for (const [self, role, mates] of [["p2", "Villager", []], ["p4", "Cop", []], ["p5", "Mafioso", MAFIA]]) {
    const v = afterShot(self, role, mates);
    const e = legalActions(v).meetings.find((m) => m.name === "Village");
    assert.ok(e.server.includes("p1"), "the server would take it");
    assert.equal(e.allowed.includes("p1"), false, `${role}: not allowed`);
    assert.equal(e.notes.p1.reason, NEVER_LYNCH_SHERIFF);
    assert.equal(validateAction(v, { event: "vote", data: { meetingId: "mVil", selection: "p1" } }).reason, NEVER_LYNCH_SHERIFF);
    assert.equal(legalVotes(v).find((m) => m.name === "Village").targets.includes("p1"), false);
  }
  // Before the gun reveals him, a Sheriff claimer is not protected by this rule (a claim can be fake).
  const pre = reduceAll([{ event: "self", data: "p2" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p2", role: "Villager" } }, { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } }, say("p1", "im sheriff", 1_000)]);
  assert.equal(validateAction(pre, { event: "vote", data: { meetingId: "mVil", selection: "p1" } }).ok, true);
});

test("rule 3: chatAudit blocks mafia lines calling the Sheriff suspicious; town and defending lines pass", () => {
  const maf = afterShot("p5", "Mafioso", MAFIA);
  for (const line of ["me is sus", "sheriff is lying", "me is scummy for shooting bob", "vote me", "the sheriff is fake"]) {
    assert.ok(chatAudit(maf, line).some((f) => f.rule === "accuses-sheriff" && f.kind === "SCUM_MISTAKE"), line);
    assert.match(validateAction(maf, { event: "speak", data: { meetingId: "mVil", content: line } }).reason, /accuses-sheriff/, line);
  }
  for (const line of ["me is confirmed town", "me is not sus", "sheriff shot bob, bad luck", "alice is sus", "vote alice"]) {
    assert.equal(chatAudit(maf, line).some((f) => f.rule === "accuses-sheriff"), false, line);
  }
  // Before the shot: an outed Sheriff claimer counts too (a fake guilty on him also gets the liar shot).
  const pre = reduceAll([{ event: "self", data: "p5" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p5", role: "Mafioso" } },
    { event: "teammates", data: MAFIA }, { event: "state", data: { id: 3, name: "Day 1" } }, say("p1", "im sheriff", 1_000)]);
  assert.ok(chatAudit(pre, "me is lying about sheriff").some((f) => f.rule === "accuses-sheriff"));
  // Town may still question a Sheriff claim: this rule is for mafia only.
  assert.equal(chatAudit(afterShot("p2", "Villager"), "me is sus").some((f) => f.rule === "accuses-sheriff"), false);
});

// ---- Rule 4: kill priority Cop > Sheriff > Journalist ----
test("rule 4: mafia kill priority is Cop > Sheriff > Journalist (Journalist last), adaptive and script", () => {
  assert.deepEqual([...MAFIA_KILL_PRIORITY], ["Cop", "Sheriff", "Journalist"]);
  // Claims are made in public chat on Day 1; the kill happens on Night 1.
  const base = (claims, reveals = {}) => reduceAll([{ event: "self", data: "p5" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p5", role: "Mafioso" } },
    { event: "teammates", data: MAFIA }, { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    ...Object.entries(claims).map(([id, role], i) => say(id, `im ${role.toLowerCase()}`, 1_000 + i)),
    ...Object.entries(reveals).map(([playerId, role]) => ({ event: "reveal", data: { playerId, role } })),
    { event: "state", data: { id: 4, name: "Night 1" } }]);
  const pool = ["p2", "p3", "p4"];
  const all = base({ p2: "Journalist", p3: "Sheriff", p4: "Cop" });
  assert.equal(adaptiveKill(all, pool), "p4");
  assert.equal(priorityKill(all, pool), "p4");
  const noCop = base({ p2: "Journalist", p3: "Sheriff" });
  assert.equal(adaptiveKill(noCop, pool), "p3", "Sheriff before Journalist");
  assert.equal(priorityKill(noCop, pool), "p3");
  const revealed = base({ p2: "Journalist" }, { p3: "Sheriff" });
  assert.equal(adaptiveKill(revealed, pool), "p3", "a revealed Sheriff beats a Journalist claim");
  assert.equal(priorityKill(revealed, pool), "p3");
  assert.equal(priorityKill(base({ p2: "Journalist" }), pool), "p2");
});

// ---- chatAudit gaps (GAME02) ----
const town = (role, events = []) => reduceAll([
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } },
  { event: "state", data: { id: 3, name: "Night 1" } }, ...events.filter((e) => e.night),
  { event: "state", data: { id: 4, name: "Day 2" } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  ...events.filter((e) => !e.night),
]);
const rules = (v, line) => chatAudit(v, line).map((f) => f.rule);

test("chatAudit: flip talk about a cleaned body is a contradiction; 'no flip' talk is fine", () => {
  const v = town("Villager", [{ event: "death", data: "p3" }, { event: "reveal", data: { playerId: "p3", role: "Villager" } }, { event: "death", data: "p2" }]);
  for (const line of ["alice flipped", "alice's flip says a lot", "clean flip so town", "alice flipped clean"]) assert.ok(rules(v, line).includes("cleaned-flip") || rules(v, line).includes("flip"), line);
  for (const line of ["alice got cleaned, no flip", "alice didnt flip, janitor", "bob flipped villager", "bob flipped town"]) assert.deepEqual(rules(v, line), [], line);
});

test("chatAudit: quoting a player for something they never said is a contradiction", () => {
  const v = town("Villager", [say("p2", "i think cat is scum, vote cat", 1), say("p3", "idk yet", 2)]);
  for (const line of ["bob said cat is scum", "alice said bob is mafia lol", "dan said vote alice", 'alice said "bob is the cop"']) assert.ok(rules(v, line).includes("misquote"), line);
  for (const line of ["alice said cat is scum", "alice said vote cat", "bob said idk yet", "dan said nothing all day", "alice says cat scum"]) assert.equal(rules(v, line).includes("misquote"), false, line);
});

test("chatAudit: a Cop urging a shot or lynch on a player he cleared is a contradiction", () => {
  const cop = town("Cop", [{ night: true, event: "message", data: { senderId: "server", content: "Your investigation shows that Cat is Innocent" } }]);
  for (const line of ["sheriff shoot cat", "lynch cat", "vote cat now", "cat needs to be lynched"]) assert.ok(rules(cop, line).includes("cop-urges-cleared"), line);
  for (const line of ["dont lynch cat, inno", "vote dan", "cat came back inno but a lawyer can fake that, still sus"]) assert.equal(rules(cop, line).includes("cop-urges-cleared"), false, line);
  // Any seat that publicly cleared someone ("im cop. cat inno") is held to it, scum included.
  const fake = town("Mafioso", [say("p1", "im cop. cat inno", 1)]);
  fake.teammates = { p6: { id: "p6", role: "Janitor" } };
  assert.ok(chatAudit(fake, "lynch cat").some((f) => f.rule === "cop-urges-cleared"));
});

// ---- stale votes on the dead (server Meeting.generateTargets early return) ----
test("a vote left on a dead player is kept apart (staleVotes) so the seat re-votes", () => {
  let v = reduceAll([{ event: "self", data: "p2" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p2", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: { p3: "p5", p2: "p4", p6: "p4" } } }]);
  v = reduce(v, { event: "death", data: "p4" });
  assert.deepEqual(v.meetings.mVil.votes, { p3: "p5" });
  assert.deepEqual(v.meetings.mVil.staleVotes, { p2: "p4", p6: "p4" });
  assert.equal(legalVotes(v).find((m) => m.name === "Village").myVote, null, "my vote no longer stands");
  // The server re-sends the meeting with the stale vote still in it: still kept apart.
  v = reduce(v, { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "p4"), votes: { p3: "p5", p2: "p4" } } });
  assert.deepEqual(v.meetings.mVil.votes, { p3: "p5" });
  // And a dead player is never counted as the vote leader.
  assert.equal(villageLeader(v), null);
});

test("rule 3: a planned fake-cop guilty never lands on the outed Sheriff; it moves to another player", () => {
  const v = reduceAll([{ event: "self", data: "p5" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p5", role: "Mafioso" } },
    { event: "teammates", data: MAFIA }, { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    say("p1", "im sheriff", 1_000)]);
  const plan = { killTarget: "p2", lynchTarget: "p1", claimRole: "Cop", speakerId: "p5" };
  const c = adaptiveClaimLine(v, plan);
  assert.ok(c, "still claims");
  assert.notEqual(c.target, "p1");
  assert.doesNotMatch(c.line, /\bme guilty/);
  assert.equal(chatAudit(v, c.line).some((f) => f.rule === "accuses-sheriff"), false);
});
