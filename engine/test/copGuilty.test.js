// Cop guilties and the Loyal Lawyer (FJ): a Litigate only works on a teammate and makes it read Innocent,
// so a Cop's Guilty is a fact and an Innocent is not a clear. Plus the copRule config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, townReads, townDayPick, townCounterLine, proposeNightAction, claimAllowed, roleClaimLine, journalistInfo, copRuleOf, TOWN_READS, validateAction } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
function seat(role, events = [], { phase = "Day 2", config } = {}) {
  const day = /^day/i.test(phase);
  return reduceAll([
    ...(config ? [{ event: "botConfig", data: config }] : []),
    { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } },
    ...events.filter((e) => e.pre),
    { event: "state", data: { id: 5, name: phase } },
    day ? { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.slice(1), "*"], votes: {} } }
      : { event: "meeting", data: { id: "act", name: role, voting: true, canVote: true, amMember: true, targets: ids.slice(1), votes: {} } },
    ...events.filter((e) => !e.pre),
  ]);
}
const say = (from, content, pre = false) => ({ pre, event: "message", data: { meetingId: "vil", senderId: from, content } });
const srv = (content, pre = true) => ({ pre, event: "message", data: { meetingId: null, senderId: "server", content } });
const dies = (id, role, phase) => [...(phase ? [{ pre: true, event: "state", data: { id: 2, name: phase } }] : []), { pre: true, event: "death", data: id }, { pre: true, event: "reveal", data: { playerId: id, role } }];

test("copRule: 'vinman' (default) claims once a living Sheriff is out; 'wait' does not; both claim on a guilty", () => {
  const inno = srv("Your investigation shows that Cal is Innocent");
  const sheriffOut = say("p4", "im sheriff");
  assert.equal(copRuleOf(seat("Cop")), "vinman");
  assert.equal(claimAllowed(seat("Cop", [inno, sheriffOut])), true);
  assert.equal(roleClaimLine(seat("Cop", [inno, sheriffOut])), "im cop. cal inno");
  const wait = seat("Cop", [inno, sheriffOut], { config: { copRule: "wait" } });
  assert.equal(copRuleOf(wait), "wait");
  assert.equal(claimAllowed(wait), false);
  for (const config of [undefined, { copRule: "wait" }]) {
    assert.equal(claimAllowed(seat("Cop", [srv("Your investigation shows that Bea is Guilty")], { config })), true, `guilty claims under ${config?.copRule || "vinman"}`);
    assert.equal(claimAllowed(seat("Cop", [inno, say("p3", "im cop, ash is guilty")], { config })), true, "counterclaimed");
  }
  const deadSheriff = seat("Cop", [inno, say("p4", "im sheriff", true), ...dies("p4", "Sheriff")]);
  assert.equal(claimAllowed(deadSheriff), false, "a dead Sheriff does not trigger it");
});

test("my own Cop Innocent is not a clear: it offsets a lynch-level read, no more, and is re-checked", () => {
  const plain = seat("Cop", [srv("Your investigation shows that Cal is Innocent")]);
  assert.equal(townReads(plain).score.p3, TOWN_READS.lawyerableInno);
  // Cal claims Cop against me (a Cop): still clearly mafia despite the Innocent.
  const sus = seat("Cop", [srv("Your investigation shows that Cal is Innocent"), say("p3", "im cop, eli is guilty", true)], { phase: "Night 3" });
  const r = townReads(sus);
  assert.ok(r.score.p3 > 0, JSON.stringify(r.reasons.p3));
  assert.equal(proposeNightAction(sus, { rng: () => 0 }).data.selection, "p3", "re-check the suspicious Innocent");
  const day = seat("Cop", [srv("Your investigation shows that Cal is Innocent"), say("p3", "im cop, eli is guilty")]);
  assert.match(townCounterLine(day) || "", /cal came back inno but a lawyer can fake that/);
});

test("a Cop claimer whose innocent flips mafia is not a proven liar (the Lawyer fakes innocents)", () => {
  const v = seat("Villager", [say("p2", "im cop, cal inno", true), ...dies("p3", "Mafioso")]);
  assert.ok((townReads(v).score.p2 || 0) < TOWN_READS.provenLiar);
  assert.ok((townReads(v).score.p2 || 0) <= TOWN_READS.innoFlippedMafia);
});

test("claiming a unique role that a dead player flipped is a lie, and town says so", () => {
  const v = seat("Villager", [say("p2", "im cop, eli guilty", true), ...dies("p2", "Cop", "Night 2"), { pre: true, event: "state", data: { id: 4, name: "Day 2" } }, say("p4", "im cop, cal is guilty")]);
  const r = townReads(v);
  assert.ok(r.score.p4 >= TOWN_READS.roleFlipped, JSON.stringify(r.reasons.p4));
  assert.ok(r.score.p5 >= TOWN_READS.credibleGuilty, "the dead real Cop's guilty still counts");
  assert.ok(["p4", "p5"].includes(townDayPick(v, v.meetings.vil).target));
  assert.match(townCounterLine(v) || "", /dot claims cop but bea already flipped cop, dot is lying/);
});

test("a rival flipping mafia credits only the claimer who stood against him while he lived", () => {
  const v = seat("Villager", [
    { pre: true, event: "state", data: { id: 2, name: "Day 1" } },
    say("p2", "im cop, cal is guilty", true), say("p3", "im cop, bea is guilty", true),
    { pre: true, event: "death", data: "p3" }, { pre: true, event: "reveal", data: { playerId: "p3", role: "Lawyer" } },
    { pre: true, event: "state", data: { id: 4, name: "Day 2" } }, say("p4", "im cop, eli is guilty"),
  ]);
  const r = townReads(v);
  assert.ok(r.verified.includes("p2"), JSON.stringify(r.reasons.p2));
  assert.ok(!r.verified.includes("p4"));
  assert.ok(r.score.p4 >= TOWN_READS.strong, JSON.stringify(r.reasons.p4));
});

test("a verified Cop settles the contest: town lynches today instead of no-lynch, and says why", () => {
  const v = seat("Villager", [
    { pre: true, event: "state", data: { id: 2, name: "Day 1" } }, say("p2", "im cop", true), say("p2", "cal is lying", true), ...dies("p3", "Mafioso"),
    { pre: true, event: "state", data: { id: 4, name: "Day 2" } }, say("p4", "im cop, bea is guilty"), say("p2", "results: eli guilty"),
  ]);
  const pick = townDayPick(v, v.meetings.vil);
  assert.ok(pick && pick.target !== "*", JSON.stringify(pick?.why));
  assert.ok(["p4", "p5"].includes(pick.target), "the fake Cop or the verified Cop's guilty: both scum on the evidence");
  assert.match(townCounterLine(v) || "", /lawyer cant fake a guilty, only an inno, so eli is mafia/);
});

test("repeating a result is one call, not new evidence", () => {
  const once = seat("Villager", [say("p2", "im cop, cal is guilty")]);
  const thrice = seat("Villager", [say("p2", "im cop, cal is guilty"), say("p2", "results: cal guilty"), say("p2", "results: cal guilty, eli inno")]);
  assert.equal(townReads(thrice).score.p3, townReads(once).score.p3);
});

test("Journalist who saw the Cop's Guilty report relays it, and town counts it", () => {
  const j = seat("Journalist", [say("p2", "im cop", true), srv("You received all reports that Bea received: Your investigation shows that Cal is Guilty.")]);
  const info = journalistInfo(j);
  assert.deepEqual(info, { kind: "copguilty", target: "p2", guilty: "p3" });
  const line = roleClaimLine(j);
  assert.match(line, /bea got a cop report, real cop, it said cal guilty/);
  const v = seat("Villager", [say("p2", "im cop", true), ...dies("p2", "Cop", "Night 2"), { pre: true, event: "state", data: { id: 4, name: "Day 2" } }, say("p6", line)]);
  assert.ok(townReads(v).score.p3 >= TOWN_READS.credibleGuilty, JSON.stringify(townReads(v).reasons.p3));
});

test("two unverified Cop claims: the counter-story is to test before lynching either", () => {
  const v = seat("Villager", [say("p2", "im cop, cal is guilty"), say("p4", "im cop, eli is guilty")]);
  assert.match(townCounterLine(v) || "", /two cops and one is lying/);
  assert.equal(townCounterLine(seat("Mafioso", [say("p2", "im cop, cal is guilty"), say("p4", "im cop, eli is guilty")])), null, "town seats only");
});

test("Journalist relays the guilty of a Cop killed (even cleaned) that night, who never got to claim", () => {
  const night = [{ pre: true, event: "death", data: "p2" }, srv("You received all reports that Bea received: Your investigation shows that Cal is Guilty.")];
  assert.deepEqual(journalistInfo(seat("Journalist", night)), { kind: "copguilty", target: "p2", guilty: "p3" });
  assert.match(roleClaimLine(seat("Journalist", night)), /bea got a cop report, real cop, it said cal guilty/);
  const living = [srv("You received all reports that Bea received: Your investigation shows that Cal is Guilty.")];
  assert.equal(journalistInfo(seat("Journalist", living)), null, "a living unclaimed Cop claims its own guilty; the Journalist does not out it");
  const v = seat("Villager", [{ pre: true, event: "death", data: "p2" }, say("p6", "im journalist. bea got a cop report, real cop, it said cal guilty")]);
  assert.ok(townReads(v).score.p3 >= TOWN_READS.strong, JSON.stringify(townReads(v).reasons.p3));
});

test("--lawyer plain (not FJ) can frame town: guilties count half and the 'lawyer cant fake a guilty' line is not said", () => {
  const flip = [say("p2", "im cop, cal is guilty", true), ...dies("p3", "Villager", "Day 1")];
  const loyal = townReads(seat("Villager", flip)).score.p2;
  const plain = townReads(seat("Villager", flip, { config: { lawyer: "plain" } })).score.p2;
  assert.equal(loyal - plain, TOWN_READS.provenLiar * (1 - TOWN_READS.plainFrame));
  const own = [srv("Your investigation shows that Cal is Guilty")];
  assert.equal(townReads(seat("Cop", own, { config: { lawyer: "plain" } })).score.p3, TOWN_READS.ownCheck * TOWN_READS.plainFrame);
  const verifiedGuilty = [say("p2", "im cop. dot guilty", true), ...dies("p4", "Mafioso", "Day 1"), { pre: true, event: "state", data: { id: 4, name: "Day 2" } }, say("p2", "im cop. eli guilty")];
  assert.match(townCounterLine(seat("Villager", verifiedGuilty)) || "", /lawyer cant fake a guilty/);
  assert.doesNotMatch(townCounterLine(seat("Villager", verifiedGuilty, { config: { lawyer: "plain" } })) || "", /lawyer cant fake/);
});

test("a Cop result stays on the claim line", () => {
  const inno = srv("Your investigation shows that Cal is Innocent");
  const sheriffOut = say("p4", "im sheriff");
  const first = roleClaimLine(seat("Cop", [inno, sheriffOut]));
  assert.equal(first, "im cop. cal inno");
  assert.doesNotMatch(first, /results?\s*[:\-]/);
  assert.equal(roleClaimLine(seat("Cop", [inno, sheriffOut, say("p1", "im cop. cal inno")])), null);
  assert.equal(roleClaimLine(seat("Cop", [inno, sheriffOut, say("p1", "im cop, no results yet")])), "im cop. cal inno");
});

test("a role claim is never dropped as a repeat: the real Cop answers a fake Cop's near-identical line", () => {
  const cop = seat("Cop", [srv("Your investigation shows that Cal is Guilty"), say("p2", "im cop. dot guilty")]);
  const speak = (content) => validateAction(cop, { event: "speak", data: { meetingId: "vil", content } });
  assert.equal(speak("im cop. cal guilty").ok, true);
  const v = seat("Villager", [say("p2", "dot is so sus today")]);
  assert.match(validateAction(v, { event: "speak", data: { meetingId: "vil", content: "dot is so sus today" } }).reason, /too similar/);
});
