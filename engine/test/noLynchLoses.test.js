// Vinman: town must compute whether its vote results in a loss. FJ 9p has 3 mafia; town can't see how many are left,
// so every mafia not confirmed dead counts as alive. If a no-lynch plus the next night kill reaches parity, town lynches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, noLynchLoses, assumedMafiaAlive, validateAction, townDayPick, ruleBotActions, buildBriefing } from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
/** Villager Ivo (p9) on Day N with these players dead (id -> revealed role, or null when cleaned). */
function town(dead = {}, { role = "Villager", day = 3, chat = [] } = {}) {
  return reduceAll([
    { event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role } },
    ...Object.entries(dead).flatMap(([id, r]) => [{ event: "death", data: id }, ...(r ? [{ event: "reveal", data: { playerId: id, role: r } }] : [])]),
    ...chat,
    { event: "state", data: { id: day * 2 + 1, name: `Day ${day}` } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== "p9" && !(i in dead)), "*"], votes: {} } },
  ]);
}
const noOne = { event: "vote", data: { meetingId: "vil", selection: "*" } };
// 7 alive, no scum dead: 3 assumed mafia vs 4 others; no lynch then a kill = 3 vs 3, parity.
const seven = { p1: "Villager", p2: null };

test("the count: setup mafia minus confirmed-dead scum; 7 alive with 3 assumed loses, 8 alive does not", () => {
  assert.equal(assumedMafiaAlive(town(seven)), 3);
  assert.equal(noLynchLoses(town(seven)), true);
  assert.equal(noLynchLoses(town({ p1: "Villager" }, { day: 2 })), false, "8 alive: 3 vs 4 after a kill");
  const scumGone = town({ p1: "Mafioso", p2: "Villager" });
  assert.equal(assumedMafiaAlive(scumGone), 2);
  assert.equal(noLynchLoses(scumGone), false, "7 alive, 2 mafia: 2 vs 4 after a kill");
});

test("town may not vote no-one when it loses; mafia and safe days still may", () => {
  assert.equal(validateAction(town(seven), noOne).reason, "no lynch loses: must lynch today");
  assert.equal(validateAction(town({ p1: "Villager" }, { day: 2 }), noOne).ok, true);
  assert.equal(validateAction(town(seven, { role: "Mafioso" }), noOne).ok, true, "only town is held to it");
});

test("townDayPick lynches the top read instead of a contested-Cop no-lynch; ruleBot never votes no-one", () => {
  const chat = [say("p3", "im cop. dot guilty"), say("p4", "im cop. cal guilty")];
  const safe = town({ p1: "Villager" }, { day: 2, chat });
  assert.equal(townDayPick(safe, safe.meetings.vil)?.target, "*", "8 alive: contested Cops still mean no lynch");
  const loses = town(seven, { chat });
  const pick = townDayPick(loses, loses.meetings.vil);
  assert.notEqual(pick.target, "*");
  assert.match(pick.why, /^no lynch loses: must lynch today/);
  for (let seed = 1; seed <= 10; seed++) {
    const vote = ruleBotActions(town(seven), { seed }).actions.find((a) => a.event === "vote" && a.data.meetingId === "vil");
    assert.ok(vote && vote.data.selection !== "*", `seed ${seed}: ${JSON.stringify(vote)}`);
  }
});

test("the model briefing says the day must end in a lynch", () => {
  assert.match(buildBriefing(town(seven)), /NO LYNCH LOSES: MUST LYNCH TODAY/);
  assert.doesNotMatch(buildBriefing(town({ p1: "Villager" }, { day: 2 })), /NO LYNCH LOSES/);
});
