// Live game L3-1018 (10/18, Mafia won), replayed with fake names. Roles: s1 Mafioso, s3 Janitor, s5 Lawyer;
// s2 Villager (cleaned N1), s4 Villager (lynched D1 on a mafia-started wagon), s6 Villager, s7 Cop (killed N2,
// flipped Cop), s8 Sheriff (shot the Janitor D1), s9 Journalist (counterclaimed the Janitor's fake Journalist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, townReads, townVote, validateAction, chatAudit, askReplyChoice, askReplyLine, revealedSheriff, wrongLynchCostly, TOWN_READS, NEVER_LYNCH_SHERIFF } from "../src/index.js";

const NAMES = ["AldaMercer17", "BrenTowle40", "CoraVane22", "DarioPell58", "EzraQuill31", "FinnHolt63", "GretaSloan87", "HugoRask60", "IvyMarsh51"];
const players = Object.fromEntries(NAMES.map((n, i) => [`s${i + 1}`, { id: `s${i + 1}`, name: n }]));
const ids = Object.keys(players);
const MATES = { s1: "Mafioso", s3: "Janitor", s5: "Lawyer" };
const PLAN = "kill brentowle40 tonight, no fake claims tmrw, lay low and lean dariopell58, lawyer go on me";
const say = (senderId, content, meetingId = "vil") => ({ event: "message", data: { senderId, meetingId, content } });
const server = (content) => ({ event: "message", data: { senderId: "server", content } });
const vote = (voterId, target, meetingId = "vil") => ({ event: "vote", data: { meetingId, voterId, target } });
const village = (id = "vil", alive = ids) => ({ event: "meeting", data: { id, name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...alive, "*"], votes: {} } });

function seat(self, role, frames = []) {
  const mates = MATES[self] ? Object.entries(MATES).filter(([id]) => id !== self).map(([id, r]) => ({ id, name: players[id].name, role: r })) : [];
  const v = reduceAll([{ event: "botConfig", data: { mafia: "adaptive" } }, { event: "self", data: self }, { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role } }, ...(mates.length ? [{ event: "teammates", data: mates }] : []),
    { event: "state", data: { id: 1, name: "Night 1" } },
    ...(mates.length ? [{ event: "meeting", data: { id: "maf", name: "Mafia Meeting", speech: true, voting: false, amMember: true } }, say("s1", PLAN, "maf")] : []),
    { event: "state", data: { id: 2, name: "Day 1" } }, { event: "death", data: "s2" }, village(), ...frames]);
  v.config = { ...(v.config || {}), mafia: "adaptive" };
  return v;
}

// Day 1 as it went: the Sheriff asks the Janitor, who fake-claims Journalist; the real Journalist counterclaims;
// the Sheriff shoots the Janitor (the live server sent no reveal frame for the shooter, only the gun line).
const ASK = [say("s8", "coravane22 claim?"), say("s3", "im journalist, nothing useful yet"), say("s9", "im journalist. coravane22 is lying")];
const SHOT = [server(":gun: HugoRask60 pulls a gun and shoots at CoraVane22!"), { event: "death", data: "s3" }];
const FLIP = [{ event: "reveal", data: { playerId: "s3", role: "Janitor:Hidden" } }];

test("L3 item 3: the gun line reveals the shooter as Sheriff, so no town ballot or pick can go on him", () => {
  const v = seat("s6", "Villager", [...ASK, ...SHOT, ...FLIP, vote("s8", "s6")]);
  assert.equal(revealedSheriff(v), "s8");
  const r = validateAction(v, { event: "vote", data: { meetingId: "vil", selection: "s8" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NEVER_LYNCH_SHERIFF);
  // The Sheriff voting me used to read as "voted X, revealed town" (+2) and put him on top.
  const tv = townVote(v, v.meetings.vil, { follow: true });
  assert.notEqual(tv.target, "s8");
  assert.ok(townReads(v).score.s8 <= TOWN_READS.credible, JSON.stringify(townReads(v).reasons.s8));
  // A real reveal frame still wins over the gun line.
  const w = seat("s6", "Villager", [{ event: "reveal", data: { playerId: "s8", role: "Sheriff:Revealing" } }, server(":gun: HugoRask60 pulls a gun and shoots at CoraVane22!")]);
  assert.equal(w.reveals.s8, "Sheriff:Revealing");
});

test("L3 item 1: a rival claimer shot by day is not 'killed at night'; his scum flip clears the other claimer", () => {
  // Shot, flip not in yet: no "+6 claimed it and was killed at night" on the real Journalist.
  const before = townReads(seat("s6", "Villager", [...ASK, ...SHOT]));
  assert.ok(!(before.reasons.s9 || []).some((r) => /killed at night/.test(r)), JSON.stringify(before.reasons.s9));
  const after = townReads(seat("s6", "Villager", [...ASK, ...SHOT, ...FLIP]));
  assert.ok(!(after.reasons.s9 || []).some((r) => /killed at night/.test(r)));
  assert.ok((after.reasons.s9 || []).some((r) => /rival Journalist claimer flipped mafia/.test(r)), JSON.stringify(after.reasons.s9));
  assert.ok(after.verified.includes("s9"), "the real Journalist is cleared");
  // A lynched rival who flips mafia clears the other claimer too.
  const lynch = townReads(seat("s6", "Villager", [say("s3", "im journalist"), say("s9", "im journalist, cora lying"), vote("s1", "s3"), vote("s6", "s3"), vote("s9", "s3"),
    { event: "death", data: "s3" }, ...FLIP]));
  assert.ok(!(lynch.reasons.s9 || []).some((r) => /killed at night/.test(r)));
  assert.ok(lynch.verified.includes("s9"));
  // A night-killed, cleaned claimer still proves the other claimer a liar.
  const night = townReads(seat("s6", "Villager", [say("s3", "im journalist"), say("s9", "im journalist"),
    { event: "state", data: { id: 3, name: "Night 2" } }, { event: "state", data: { id: 4, name: "Day 2" } }, { event: "death", data: "s9" }]));
  assert.ok((night.reasons.s3 || []).some((r) => /killed at night/.test(r)), JSON.stringify(night.reasons.s3));
});

test("L3 item 2: starting or joining a wagon on a town flip is suspicious, the starter most", () => {
  // D1: the Mafioso starts the wagon on s4, the Lawyer joins, then town. s4 flips Villager.
  const lynched = seat("s6", "Villager", [vote("s1", "s4"), vote("s5", "s4"), vote("s9", "s4"), { event: "death", data: "s4" }, { event: "reveal", data: { playerId: "s4", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Night 2" } }, { event: "state", data: { id: 4, name: "Day 2" } }]);
  const r = townReads(lynched);
  assert.ok(r.score.s1 > r.score.s5 && r.score.s5 > r.score.s9 && r.score.s9 > 0, JSON.stringify(r.score));
  // A wagon that did not land, on a player later killed at night who flipped Cop.
  const later = seat("s6", "Villager", [vote("s1", "s7"), vote("s5", "s7"), vote("s1", "s4"),
    { event: "state", data: { id: 3, name: "Night 2" } }, { event: "state", data: { id: 4, name: "Day 2" } }, { event: "death", data: "s7" }, { event: "reveal", data: { playerId: "s7", role: "Cop" } }]);
  const q = townReads(later);
  assert.ok((q.reasons.s1 || []).some((x) => /started a wagon on GretaSloan87/.test(x)), JSON.stringify(q.reasons.s1));
  assert.ok((q.reasons.s5 || []).some((x) => /joined a wagon/.test(x)));
  assert.ok(q.score.s1 > q.score.s5);
  assert.equal(q.score.s4 || 0, 0, "voted nobody");
});

test("L3 item 4: with a costly wrong lynch, a wagon alone does not move town onto an unread player", () => {
  // D2 of L3: 6 alive (s1, s5 mafia; s6, s7 dead later...), here: s1 s5 s6 s8 s9 + s4; mafia start a wagon on s6.
  const frames = [vote("s1", "s4"), vote("s5", "s4"), { event: "death", data: "s4" }, { event: "reveal", data: { playerId: "s4", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Night 2" } }, { event: "state", data: { id: 4, name: "Day 2" } }, { event: "death", data: "s7" }, { event: "reveal", data: { playerId: "s7", role: "Cop" } },
    village("vil2", ["s1", "s3", "s5", "s6", "s8", "s9"]), vote("s1", "s6", "vil2"), vote("s5", "s6", "vil2")];
  const v = seat("s9", "Journalist", [...ASK, ...SHOT, ...FLIP, ...frames]);
  assert.equal(wrongLynchCostly(v), true);
  const tv = townVote(v, v.meetings.vil2, { follow: true });
  assert.notEqual(tv.target, "s6", tv.why);
  assert.notEqual(tv.target, "s8");
  assert.match(tv.why, /costly/);
  // D1 with the Sheriff alive: must lynch, by reads, not the mafia-started wagon on an unread player.
  const d1 = seat("s6", "Villager", [say("s1", "dario sus"), vote("s1", "s4"), vote("s5", "s4"), say("s7", "im cop. ezraquill31 guilty")]);
  const t1 = townVote(d1, d1.meetings.vil, { follow: true });
  assert.notEqual(t1.target, "*");
  assert.notEqual(t1.target, "s4", t1.why);
});

test("L3 item 5: Sheriff-claim doubt, 'whoever shot' a night kill and votes on the dead are blocked; a real cop flip is not", () => {
  const scum = seat("s1", "Mafioso", [...ASK, ...SHOT, ...FLIP, { event: "state", data: { id: 3, name: "Night 2" } }, { event: "state", data: { id: 4, name: "Day 2" } },
    { event: "death", data: "s7" }, { event: "reveal", data: { playerId: "s7", role: "Cop:Hidden" } }, village("vil2", ["s1", "s4", "s5", "s6", "s8", "s9"])]);
  const rules = (v, line) => chatAudit(v, line).map((f) => f.rule);
  for (const line of ["that sheriff claim is weak.", "hugorask60 claim feels weak, vote ivymarsh51", "sheriff claim too weak, vote her", "s8 sheriff claim is pure bs"]) {
    assert.ok(rules(scum, line).includes("accuses-sheriff"), line);
  }
  for (const ok of ["the cop flip proves greta was real", "gretasloan87 flipped cop", "hugorask60 sheriff claim looks solid"]) assert.deepEqual(rules(scum, ok), [], ok);
  assert.ok(rules(scum, "vote coravane22").includes("vote-dead"));
  const town = seat("s4", "Villager", [...SHOT]);
  assert.ok(rules(town, "whoever shot brentowle40 is a monster, vote them down").includes("shot"), "s2 died at night");
  assert.deepEqual(rules(town, "whoever shot coravane22 did us a favor").filter((r) => r === "shot"), []);
  assert.ok(rules(town, "s sheriff claim is pure bs, vote her").includes("doubts-sheriff"), "revealed by the gun");
  assert.deepEqual(rules(town, "hugorask60 sheriff claim looks solid"), []);
});

test("L3 item 6: with a no-fake-claim plan, the asked Janitor answers villager (and says why); a guilty on him earns a counterclaim", () => {
  const v = seat("s3", "Janitor", [say("s8", "im sheriff"), say("s8", "coravane22 claim?")]);
  const c = askReplyChoice(v);
  assert.match(c.line, /\bvillager\b/);
  assert.doesNotMatch(c.line, /\bvt\b|v\/t/i);
  assert.match(c.why, /no fake claim/);
  assert.equal(askReplyLine(v), c.line);
  const g = seat("s3", "Janitor", [say("s7", "im cop. coravane22 guilty"), say("s8", "im sheriff"), say("s8", "coravane22 claim?")]);
  const cg = askReplyChoice(g);
  assert.doesNotMatch(cg.line, /\bvt\b|v\/t/i, cg.why);
  assert.match(cg.why, /counterclaim/);
});

// ---- Vinman's 11:05 AM ET rules (items 7-12) ----
import { meetingActions, proposeNightAction, soleClaimers, COP_SKIPS_SOLE_CLAIMER, villagerDefense, VILLAGER_DEFENSES, repeatedDefense, confirmedLead, hammerState, hammerAskLine, hammerVote, hammerRead, HAMMER } from "../src/index.js";

const invest = (targets) => ({ event: "meeting", data: { id: "inv", name: "Investigate", voting: true, canVote: true, amMember: true, targets: [...targets, "*"], votes: {} } });
function copNight(frames) {
  return reduceAll([{ event: "self", data: "s7" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "s7", role: "Cop" } },
    { event: "state", data: { id: 2, name: "Day 1" } }, village(), ...frames, { event: "state", data: { id: 3, name: "Night 2" } }, invest(ids.filter((i) => i !== "s7"))]);
}

test("item 7: the Cop never checks the sole uncontested Journalist claimer; contested claimers stay checkable", () => {
  const v = copNight([say("s9", "im journalist, nothing useful yet")]);
  assert.deepEqual([...soleClaimers(v)], ["s9"]);
  const e = meetingActions(v, v.meetings.inv);
  assert.ok(!e.allowed.includes("s9"));
  assert.equal(e.notes.s9.reason, COP_SKIPS_SOLE_CLAIMER);
  for (let i = 0; i < 20; i++) assert.notEqual(proposeNightAction(v, { rng: () => i / 20 })?.data.selection, "s9");
  const two = copNight([say("s9", "im journalist"), say("s3", "im journalist, ivy is lying")]);
  assert.ok(meetingActions(two, two.meetings.inv).allowed.includes("s9"), "contested");
  assert.ok(meetingActions(two, two.meetings.inv).allowed.includes("s3"));
});

test("item 9: Villager defenses vary and never repeat a phrasing in the game", () => {
  const v = seat("s6", "Villager");
  const first = villagerDefense(v);
  assert.ok(VILLAGER_DEFENSES.includes(first));
  const used = seat("s6", "Villager", VILLAGER_DEFENSES.slice(0, 11).map((l, i) => say(`s${(i % 5) + 1}`, l)));
  assert.equal(villagerDefense(used), VILLAGER_DEFENSES[11], "the one left");
  const repeat = seat("s6", "Villager", [say("s4", "im just a villager, no power role. not me")]);
  assert.ok(repeatedDefense(repeat, "im just a villager, no power role. not me"));
  assert.equal(validateAction(repeat, { event: "speak", data: { meetingId: "vil", content: "im just a villager, no power role. not me" } }).ok, false);
  assert.equal(repeatedDefense(repeat, "blue here, nothing to hide. wrong guy"), null);
});

test("item 10: dead or shot players are never called sus, urged as a vote, or kept in the reads", () => {
  const v = seat("s6", "Villager", [...ASK, ...SHOT, ...FLIP, vote("s3", "s6")]);
  const rules = (line) => chatAudit(v, line).map((f) => f.rule);
  assert.ok(rules("coravane22 is sus").includes("dead-sus"));
  assert.ok(rules("cora so sketchy").includes("dead-sus"), "nickname");
  assert.ok(rules("lynch coravane22").includes("vote-dead"));
  assert.deepEqual(rules("coravane22 flipped janitor, she was scum"), []);
  const r = townReads(v);
  assert.equal(r.score.s3, undefined);
  assert.equal(r.score.s2, undefined, "the cleaned body too");
});

test("item 11: a villager with a weak read follows the revealed Sheriff's vote", () => {
  const v = seat("s6", "Villager", [...ASK, ...SHOT, ...FLIP, vote("s8", "s5")]);
  assert.deepEqual(confirmedLead(v, v.meetings.vil), { by: "s8", target: "s5" });
  const tv = townVote(v, v.meetings.vil, { follow: true });
  assert.equal(tv.target, "s5", tv.why);
  assert.match(tv.why, /follow confirmed town/);
});

test("item 12: hammer ask: everyone self-votes, the Sheriff hammers a non-claimer last; a refuser is bandwagoned", () => {
  const T = 1_800_000_000_000;
  const at = (f, t) => ({ ...f, t });
  const base = (self, role, extra = []) => {
    const v = seat(self, role, [at(say("s8", "im sheriff"), T), ...SHOT.map((f) => at(f, T + 1000)), ...FLIP, at(say("s7", "im cop. ezraquill31 guilty"), T + 2000), ...extra]);
    v.phaseStartedAt = T - 5000;
    return v;
  };
  // The Sheriff asks after HAMMER.askAfterMs, once.
  const sh = base("s8", "Sheriff");
  assert.equal(hammerAskLine(sh, { now: T }), null, "too early");
  const ask = hammerAskLine(sh, { now: T + HAMMER.askAfterMs });
  assert.match(ask, /self-vote/);
  const asked = [at(say("s8", ask), T + HAMMER.askAfterMs)];
  // Town and mafia comply with a self-vote; self-votes are legal.
  const town = base("s6", "Villager", asked);
  assert.equal(hammerVote(town, { now: T + 30_000 }).target, "s6");
  assert.equal(validateAction(town, { event: "vote", data: { meetingId: "vil", selection: "s6" } }).ok, true);
  assert.equal(hammerVote(base("s1", "Mafioso", asked), { now: T + 30_000 }).target, "s1");
  // The Sheriff waits until all have self-voted, then votes his best read that is not a Cop/Journalist claimer.
  const living = ["s1", "s4", "s5", "s6", "s7", "s9"];
  const some = [...asked, ...living.slice(0, 4).map((id) => vote(id, id))];
  assert.equal(hammerVote(base("s8", "Sheriff", some), { now: T + 30_000 }).hold, true);
  const reask = hammerAskLine(base("s8", "Sheriff", some), { now: T + HAMMER.askAfterMs + HAMMER.reaskAfterMs });
  assert.match(reask, /gretasloan87, ivymarsh51 self-vote/);
  assert.deepEqual(hammerRead(base("s8", "Sheriff")).target, "s5");
  const all = [...asked, say("s9", "im journalist"), ...living.map((id) => vote(id, id))];
  const decide = hammerVote(base("s8", "Sheriff", all), { now: T + 40_000 });
  assert.equal(decide.target, "s5", `the deciding vote goes to the read (the Cop's guilty): ${decide.why}`);
  assert.equal(hammerState(base("s8", "Sheriff", all), { now: T + 40_000 }).ready, true);
  // A refuser (no self-vote HAMMER.refuseAfterMs after the re-ask) is the Sheriff's vote, and town follows it.
  const refuse = [...asked, ...living.filter((id) => id !== "s5").map((id) => vote(id, id)), vote("s5", "s4"), at(say("s8", "ezraquill31 self-vote pls, i hammer last"), T + 45_000)];
  const late = T + 45_000 + HAMMER.refuseAfterMs;
  assert.equal(hammerVote(base("s8", "Sheriff", refuse), { now: late }).target, "s5");
  assert.equal(hammerVote(base("s6", "Villager", [...refuse, vote("s8", "s5")]), { now: late }).target, "s5");
  assert.equal(hammerVote(base("s1", "Mafioso", [...refuse, vote("s8", "s5")]), { now: late }).target, "s1", "mafia keep their self-vote on a teammate refuser");
  // Off by config.
  const off = base("s6", "Villager", asked); off.config.hammer = "off";
  assert.equal(hammerVote(off, { now: T + 30_000 }), null);
});

test("Vinman 11:47: no hammer ask without a real read; a Cop guilty is one", () => {
  const T = 1_800_000_000_000;
  const mk = (extra) => { const v = seat("s8", "Sheriff", [{ ...say("s8", "im sheriff"), t: T }, ...SHOT.map((f) => ({ ...f, t: T + 1000 })), ...FLIP, ...extra]); v.phaseStartedAt = T - 5000; return v; };
  const quiet = mk([]);
  assert.equal(hammerRead(quiet), null);
  assert.equal(hammerAskLine(quiet, { now: T + HAMMER.askAfterMs + 1 }), null, "no read: no ask, town votes normally");
  assert.equal(hammerState(quiet), null);
  const guilty = mk([{ ...say("s7", "im cop. ezraquill31 guilty"), t: T + 2000 }]);
  assert.equal(hammerRead(guilty).target, "s5");
  assert.match(hammerAskLine(guilty, { now: T + HAMMER.askAfterMs + 1 }), /self-vote/);
  // A guilty on a Journalist claimer is not eligible; the override still turns it all off.
  const off = mk([{ ...say("s7", "im cop. ezraquill31 guilty"), t: T + 2000 }]); off.config.hammer = "off";
  assert.equal(hammerAskLine(off, { now: T + HAMMER.askAfterMs + 1 }), null);
});
