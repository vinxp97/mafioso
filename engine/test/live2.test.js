// Live game L2-1018 (2026-10-18, suspicion arm): planned fake claims that adapt to the board, flip talk about
// players who never flipped, seats naming themselves in the third person, and the suspicion arm abstaining on D2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, adaptiveClaimLine, agreedPlan, exposedTeam, planClaimDropReason, chatAudit, validateAction, townVote, nicknamesOf } from "../src/index.js";

// The L2-1018 table: s1 Janitor, s3 Lawyer, s4 Mafioso; s6 Journalist, s7 Sheriff, s9 Cop.
const NAMES = ["AldenMorrow74", "RinaDrake34", "RileyFrost72", "SagaBennett98", "GavinGill66", "PaxSandor4", "NoraKell60", "TobyYarrow45", "ReedKorbin18"];
const players = Object.fromEntries(NAMES.map((n, i) => [`s${i + 1}`, { id: `s${i + 1}`, name: n }]));
const ids = Object.keys(players);
const MATES = { s1: "Janitor", s3: "Lawyer", s4: "Mafioso" };
const say = (senderId, content, meetingId = "vil") => ({ event: "message", data: { senderId, meetingId, content } });
const PLAN = "kill norakell60 tonight, sagabennett98 fake cop tmrw and push rinadrake34, lawyer go on sagabennett98";
function seat(self, role, day = []) {
  const mates = MATES[self] ? Object.entries(MATES).filter(([id]) => id !== self).map(([id, r]) => ({ id, name: players[id].name, role: r })) : [];
  const v = reduceAll([{ event: "botConfig", data: { mafia: "adaptive" } }, { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role } },
    ...(mates.length ? [{ event: "teammates", data: mates }] : []),
    { event: "state", data: { id: 1, name: "Night 1" } },
    ...(mates.length ? [{ event: "meeting", data: { id: "maf", name: "Mafia Meeting", speech: true, voting: false, amMember: true } }, say("s3", PLAN, "maf")] : []),
    { event: "state", data: { id: 2, name: "Day 1" } }, { event: "death", data: "s7" },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    ...day]);
  v.config = { ...(v.config || {}), mafia: "adaptive" };
  return v;
}

test("item 1: the planned fake Cop claim is the plan's line on a quiet board", () => {
  const v = seat("s4", "Mafioso");
  assert.equal(agreedPlan(v).speakerId, "s4");
  const c = adaptiveClaimLine(v, agreedPlan(v));
  assert.deepEqual([c.role, c.target, c.line, c.adapt], ["Cop", "s2", "im cop. rinadrake34 guilty", undefined]);
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "vil", content: c.line } }).ok, true, "passes the claim gate and chatAudit");
});

test("item 1: a Journalist naming a teammate makes the fake Cop answer the accuser, with the reason", () => {
  const v = seat("s4", "Mafioso", [say("s6", "im journalist. aldenmorrow74 is janitor")]);
  assert.deepEqual(exposedTeam(v), { by: "s6", mate: "s1", role: "Journalist" });
  const c = adaptiveClaimLine(v, agreedPlan(v));
  assert.equal(c.target, "s6");
  assert.equal(c.line, "im cop. paxsandor4 guilty");
  assert.match(c.adapt, /journalist paxsandor4 named aldenmorrow74: guilty moves from rinadrake34 to the accuser/i);
  // A town seat's ordinary suspicion ("alden is janitor" without a claim) is not a report.
  assert.equal(exposedTeam(seat("s4", "Mafioso", [say("s5", "aldenmorrow74 is janitor")])), null);
});

test("item 1: a real Cop already out means the planned fake Cop claim is dropped, and why", () => {
  // Cop taken, Journalist open: the plan adapts to a Journalist counterclaim on the Cop, and says so.
  const j = seat("s4", "Mafioso", [say("s9", "im cop. gavingill66 inno")]);
  const c = adaptiveClaimLine(j, agreedPlan(j));
  assert.deepEqual([c.role, c.target], ["Journalist", "s9"]);
  assert.match(c.adapt, /cop already claimed by reedkorbin18: counterclaim as journalist/);
  // Both taken: nothing fits, the claim is dropped with the reason.
  const v = seat("s4", "Mafioso", [say("s9", "im cop. gavingill66 inno"), say("s6", "im journalist")]);
  assert.equal(adaptiveClaimLine(v, agreedPlan(v)), null);
  assert.equal(planClaimDropReason(v), "cop already claimed by reedkorbin18");
  // Not my plan to speak: no reason to log.
  assert.equal(planClaimDropReason(seat("s1", "Janitor", [say("s9", "im cop")])), null);
});

test("item 3: flip claims about living or cleaned players, wrong flips, and 'loyal' are blocked", () => {
  const v = seat("s2", "Villager", [{ event: "death", data: "s3" }, { event: "reveal", data: { playerId: "s3", role: "Lawyer" } }]);
  const rules = (line) => chatAudit(v, line).map((f) => f.rule);
  assert.ok(rules("tobyyarrow45 flipped cop").includes("flip"), "alive");
  assert.ok(rules("toby flipped cop").includes("flip"), "alive, by nickname");
  assert.ok(rules("rileyfrost72 flipped loyal").includes("flip"), "flipped Lawyer, not 'loyal'");
  assert.ok(rules("riley flipped loyal").includes("flip"));
  assert.ok(rules("saga's right, gavin's flip is sus").includes("flip"), "flip talk about a living player");
  assert.ok(rules("that janitor flip is sus af lol").includes("flip"), "nobody flipped Janitor");
  assert.ok(rules("norakell60 flipped sheriff").includes("flip"), "the cleaned seat: no flip");
  for (const ok of ["rileyfrost72 flipped lawyer", "riley flipped mafia", "riley's flip proves it", "the lawyer flip helps", "toby is sus", "aldenmorrow74 is janitor"]) {
    assert.equal(rules(ok).includes("flip"), false, ok);
  }
  const loyal = seat("s2", "Villager", [{ event: "death", data: "s3" }, { event: "reveal", data: { playerId: "s3", role: "Loyal Lawyer" } }]);
  assert.equal(chatAudit(loyal, "riley flipped loyal").some((f) => f.rule === "flip"), false);
});

test("item 4: a seat naming itself by its handle (or short handle) is blocked; 'me'/'i' are fine", () => {
  const riley = seat("s3", "Lawyer");
  assert.ok(chatAudit(riley, "lol riley's lawyer not janitor, vote saga instead").some((f) => f.rule === "self-third-person"));
  const saga = seat("s4", "Mafioso");
  assert.ok(chatAudit(saga, "gotta trust toby's flip over sagabennett98's random cop claim").some((f) => f.rule === "self-third-person"));
  assert.match(validateAction(saga, { event: "speak", data: { meetingId: "vil", content: "vote saga lol" } }).reason, /self-third-person/);
  assert.equal(chatAudit(saga, "im not mafia, vote rina").some((f) => f.rule === "self-third-person"), false);
  assert.deepEqual(nicknamesOf("ReedKorbin18"), ["reedkorbin", "reed"]);
  assert.deepEqual(nicknamesOf("Ash"), []);
});

test("item 5: suspicion arm with follow: no read above zero follows the wagon, else the best read; no-lynch only in LYLO", () => {
  // Day 2, 7 alive, nobody flipped mafia; s5 (town) has no reads.
  const base = (votes) => {
    const v = reduceAll([{ event: "self", data: "s5" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "s5", role: "Villager" } },
      { event: "state", data: { id: 3, name: "Day 2" } }, { event: "death", data: "s7" }, { event: "death", data: "s1" }, { event: "reveal", data: { playerId: "s1", role: "Janitor" } },
      { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((x) => x !== "s7" && x !== "s1"), "*"], votes } }]);
    return v;
  };
  const quiet = base({});
  assert.equal(townVote(quiet, quiet.meetings.vil).target, "*", "default stays as before (rules arm, other callers)");
  const f = townVote(quiet, quiet.meetings.vil, { follow: true });
  assert.notEqual(f.target, "*");
  assert.match(f.why, /best read/);
  const wagon = base({ s4: "s2", s9: "s2", s8: "s6" });
  const w = townVote(wagon, wagon.meetings.vil, { follow: true });
  assert.equal(w.target, "s2");
  assert.match(w.why, /wagon/);
  // LYLO: 4 alive, 1 mafia flipped, 2 assumed alive -> a wrong lynch loses, a no-lynch doesn't: no lynch.
  const lylo = reduceAll([{ event: "self", data: "s5" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "s5", role: "Villager" } },
    { event: "state", data: { id: 7, name: "Day 4" } },
    ...["s1", "s6", "s7", "s8", "s9"].map((d) => ({ event: "death", data: d })), { event: "reveal", data: { playerId: "s1", role: "Janitor" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["s2", "s3", "s4", "s5", "*"], votes: {} } }]);
  const l = townVote(lylo, lylo.meetings.vil, { follow: true });
  assert.ok(l, "a pick");
  if (l.target === "*") assert.match(l.why, /LYLO/);
});
