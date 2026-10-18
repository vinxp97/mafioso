// GAME01 follow-up: FJ's Loyal Lawyer litigates a teammate so the Cop sees Village. While a Lawyer could be
// alive, a Cop Village/Innocent result is soft: it lowers suspicion but is no clear and no support for a claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, townReads, memoryOf, TOWN_READS } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
function seat(role, events) {
  return reduceAll([
    { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } },
    { event: "state", data: { id: 3, name: "Night 1" } },
    ...events.filter((e) => e.night),
    { event: "state", data: { id: 5, name: "Day 2" } },
    ...events.filter((e) => !e.night),
  ]);
}
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
const srv = (content) => ({ night: true, event: "message", data: { meetingId: null, senderId: "server", content } });
const lawyerFlips = [{ event: "death", data: "p7" }, { event: "reveal", data: { playerId: "p7", role: "Lawyer" } }];

test("my own Innocent: a soft clear while a Lawyer may live (not in cleared, backs no claim); a full clear once the Lawyer flips", () => {
  // Cal checked Innocent (maybe litigated) claims Journalist; Dot claims Journalist too.
  const ev = [srv("Your investigation shows that Cal is Innocent"), say("p3", "im journalist"), say("p4", "im journalist, cal is lying")];
  const v = seat("Cop", ev);
  const mem = memoryOf(v);
  assert.ok(!mem.cleared.has("p3") && mem.softCleared.has("p3"));
  const r = townReads(v);
  assert.ok(!r.verified.includes("p3"), "an Innocent alone does not verify Cal's claim");
  assert.ok(!(r.reasons.p4 || []).some((w) => /against a verified/.test(w)), JSON.stringify(r.reasons.p4));
  assert.ok(r.score.p3 < 0, "still a lean toward town");

  const gone = seat("Cop", [...ev, ...lawyerFlips]);
  assert.ok(memoryOf(gone).cleared.has("p3"));
  const g = townReads(gone);
  assert.ok(g.reasons.p3.includes(`${-TOWN_READS.ownCheck} my check: innocent, Lawyer gone`), JSON.stringify(g.reasons.p3));
  assert.ok(g.verified.includes("p3"));
  assert.ok((g.reasons.p4 || []).some((w) => /against a verified Journalist/.test(w)), JSON.stringify(g.reasons.p4));
});

test("a verified Cop's 'inno' on a claimer does not verify that claim while the Lawyer may live", () => {
  // Bea (Cop) is verified: her guilty on Cal flipped mafia. She calls Eli inno; Eli and Fin both claim Journalist.
  const ev = [
    say("p2", "im cop. cal guilty"), { event: "death", data: "p3" }, { event: "reveal", data: { playerId: "p3", role: "Mafioso" } },
    say("p2", "results: eli inno"), say("p5", "im journalist"), say("p6", "im journalist"),
  ];
  const r = townReads(seat("Villager", ev));
  assert.ok(r.verified.includes("p2"), "the Cop is verified by her flipped guilty");
  assert.ok(!r.verified.includes("p5"), JSON.stringify(r.reasons.p5));
  assert.ok(!(r.reasons.p6 || []).some((w) => /against a verified/.test(w)), JSON.stringify(r.reasons.p6));
  assert.ok((r.reasons.p5 || []).some((w) => /could be lawyered/.test(w)));

  const g = townReads(seat("Villager", [...ev, ...lawyerFlips]));
  assert.ok(g.verified.includes("p5"), JSON.stringify(g.reasons.p5));
});
