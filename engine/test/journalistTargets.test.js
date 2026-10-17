// Journalist targeting and public reports (FJ). What a Journalist sees is the target's own night alerts
// (restartq ReceiveReports -> ReportsInfo -> Information.getReportsFromAlerts): the real Cop's result, the
// Janitor's clean result, a real Journalist's own report; nothing for anyone else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, proposeNightAction, journalistTarget, journalistExtras, roleClaimLine, claimAllowed, townReads, publicRecord, parseServerInfo, cleanedRoles, TOWN_READS } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);

function seat(role, events = [], { phase = "Day 2", self = "p1", votes = {} } = {}) {
  const day = /^day/i.test(phase);
  return reduceAll([
    { event: "self", data: self },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role } },
    ...events.filter((e) => e.pre),
    { event: "state", data: { id: 3, name: phase } },
    day
      ? { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== self), "*"], votes } }
      : { event: "meeting", data: { id: "act", name: role, voting: true, canVote: true, amMember: true, targets: ids.filter((i) => i !== self), votes: {} } },
    ...events.filter((e) => !e.pre),
  ]);
}
const say = (from, content, pre = true) => ({ pre, event: "message", data: { meetingId: "vil", senderId: from, content } });
const srv = (content) => ({ pre: true, event: "message", data: { senderId: "server", content } });
const night = (events) => proposeNightAction(seat("Journalist", events, { phase: "Night 2" }), { rng: () => 0 })?.data.selection;

test("live alert wording parses: emoji tags, the FJ Cop card, Journalist reports, the Janitor's clean", () => {
  const v = seat("Journalist");
  assert.equal(parseServerInfo(v, { senderId: "server", content: ":invest: After investigating, you learn that Bea is Mafia!" }).align, "Mafia");
  assert.equal(parseServerInfo(v, { senderId: "server", content: ":journ: You learn that Bea received no reports." }).detail, "no reports");
  const jan = parseServerInfo(v, { senderId: "server", content: ":journ: You received all reports that Bea received: :mop: You discover Cal's role is Cop.." });
  assert.equal(jan.role, "Janitor");
  assert.equal(parseServerInfo(v, { senderId: "p2", content: ":journ: You learn that Cal received no reports." }), null, "a player typing it is not a report");
  const j = seat("Janitor", [srv(":mop: You discover Cal's role is Cop.")], { self: "p2" });
  assert.deepEqual(cleanedRoles(j), { p3: "Cop" });
});

test("Night 2+: an unchecked Cop claimer stays first, even with a louder pusher around", () => {
  assert.equal(night([say("p4", "im cop, eli is guilty"), say("p2", "cal is lying"), say("p5", "cal is lying")]), "p4");
});

test("no unchecked Cop claimer: a rival Journalist claimer, else the hardest pusher, else a pressure claimer", () => {
  assert.equal(night([say("p4", "im journalist"), say("p2", "cal is lying"), say("p5", "cal is lying")]), "p4", "a rival claim is checkable");
  assert.equal(night([say("p2", "cal is lying"), say("p5", "cal is lying")]), "p3", "hardest pusher by the public reads");
  assert.equal(night([say("p6", "im just a villager, no power role. not me")]), "p6", "pressure claimer when nobody reads scummy");
  // The Cop claimer was already checked: move on to the pusher.
  const checked = [say("p4", "im cop, eli is guilty"), srv(":journ: You received all reports that Dot received: Your investigation shows that Eli is Guilty."), say("p2", "cal is lying"), say("p5", "cal is lying")];
  assert.equal(night(checked), "p3");
});

test("journalistTarget returns null with nobody worth a visit (default pick takes over)", () => {
  const v = seat("Journalist", [], { phase: "Night 2" });
  assert.equal(journalistTarget(v, ["p2", "p3"]), null);
});

test("Janitor found on a hardest pusher: claims (Vinman trigger) and names the Janitor", () => {
  const v = seat("Journalist", [srv(":journ: You received all reports that Cal received: :mop: You discover Fin's role is Cop..")]);
  assert.ok(claimAllowed(v));
  assert.match(roleClaimLine(v), /^im journalist\. cal is janitor/);
});

test("extras are only legitimate info; the rival claim (not the extra) is what triggers the counterclaim", () => {
  // Rival Journalist claimer with no report: a real Journalist always has one, so it's fake. The rival claim
  // itself is the trigger (unique role), and the counterclaim carries the finding.
  const rival = [say("p4", "im journalist"), srv(":journ: You learn that Dot received no reports.")];
  const countered = seat("Journalist", rival);
  assert.equal(claimAllowed(countered), true);
  assert.equal(roleClaimLine(countered), "dot is lying, im journalist. dot got no report, fake journalist");
  assert.deepEqual(journalistExtras(countered), [{ kind: "fakejournalist", target: "p4" }]);
  // Once outed, it calls the rival out and shares the finding (no repeat claim).
  const outed = seat("Journalist", [say("p1", "im journalist, nothing useful yet. not me"), ...rival]);
  assert.equal(roleClaimLine(outed), "dot is lying, dot got no report, fake journalist");
  // Under pressure it claims with the finding instead of "nothing useful yet".
  const l1 = seat("Journalist", rival, { votes: { p2: "p1", p3: "p1", p5: "p1" } });
  assert.match(roleClaimLine(l1), /im journalist\. dot got no report, fake journalist\. not me$/);
  // Villager claimer with no report: only "fits".
  const vil = seat("Journalist", [say("p1", "im journalist"), say("p6", "im just a villager, no power role. not me"), srv(":journ: You learn that Fin received no reports.")]);
  assert.equal(roleClaimLine(vil), "fin got no report, fits villager");
  // An unclaimed player with no report, or an unclaimed real Cop seen in a report: nothing to say.
  const silent = seat("Journalist", [say("p1", "im journalist"), srv(":journ: You learn that Eli received no reports."), srv(":journ: You received all reports that Cal received: Your investigation shows that Eli is Innocent.")]);
  assert.deepEqual(journalistExtras(silent), []);
  assert.equal(roleClaimLine(silent), null, "never outs an unclaimed Cop");
});

test("town reads: fake journalist and fake cop are heavy, 'no report' on a villager is a weak fit", () => {
  const v = seat("Villager", [
    say("p2", "im journalist. dot got no report, fake journalist"),
    say("p4", "im journalist"),
    say("p3", "im cop"),
    say("p2", "cal got no report, fake cop"),
    say("p6", "im just a villager, no power role. not me"),
    say("p2", "fin got no report, fits villager"),
  ], { self: "p5" });
  const kinds = Object.fromEntries(publicRecord(v).reports.map((r) => [r.target, r.kind]));
  assert.deepEqual(kinds, { p4: "fakejournalist", p3: "fakecop", p6: "noreport" });
  const r = townReads(v);
  assert.ok(r.reasons.p4.some((x) => /rival Journalist claim got no report/.test(x)));
  assert.ok(r.score.p4 > 0 && r.score.p3 > 0);
  assert.ok(r.score.p6 < 0 && r.score.p6 > -1, `weak fit: ${r.score.p6}`);
  assert.equal(TOWN_READS.noReport, -0.5);
});
