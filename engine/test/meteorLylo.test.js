// Vinman: "they can NL if a mafia killing would not result in autoloss (LYLO - lynch or lose). They can NL if it
// leads to a 5-way (with 6 people alive - meaning, assuming at least 1 mafia is dead). Mafia should also know that
// they do not need to kill at night if meteor is not on them." Meteor is Ultimafia's stalemate end: after phases
// with no death the server warns that a meteor ends the game (no winner) unless someone dies in that phase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, noLynchLoses, lyloToday, meteorOn, validateAction, buildBriefing, rejectCandidate } from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const srv = (content) => ({ event: "message", data: { senderId: "server", content } });
const DAY_WARN = "A giant meteor will land and end the game if nobody is condemned today!";
const NIGHT_WARN = "A giant meteor will land and end the game if nobody dies tonight!";
const dies = (dead) => Object.entries(dead).flatMap(([id, r]) => [{ event: "death", data: id }, { event: "reveal", data: { playerId: id, role: r } }]);
function day(dead, { role = "Villager", day = 4, after = [] } = {}) {
  return reduceAll([
    { event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role } },
    ...dies(dead), { event: "state", data: { id: day * 2 + 1, name: `Day ${day}` } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== "p9" && !(i in dead)), "*"], votes: {} } },
    ...after,
  ]);
}
/** Mafioso Ivo (p9, partner Hap p8) at night; `chat` lands before the night. */
function night({ warn = false, chat = [] } = {}) {
  return reduceAll([
    { event: "self", data: "p9" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p9", role: "Mafioso" } },
    { event: "teammates", data: { p8: "Janitor" } },
    { event: "state", data: { id: 5, name: "Day 2" } }, ...chat,
    { event: "state", data: { id: 6, name: "Night 2" } },
    ...(warn ? [srv(NIGHT_WARN)] : []),
    { event: "meeting", data: { id: "maf", name: "Mafia", voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== "p9" && i !== "p8"), "*"], votes: {} } },
  ]);
}
const noOne = (meetingId) => ({ event: "vote", data: { meetingId, selection: "*" } });

test("6 alive with a mafia flipped dead: NL into a 5-way is allowed; with no mafia dead it is not", () => {
  const sixOneScumDead = day({ p1: "Mafioso", p2: "Villager", p3: "Villager" });
  assert.equal(noLynchLoses(sixOneScumDead), false, "2 mafia: NL + kill = 5 alive, 2 vs 3");
  assert.equal(validateAction(sixOneScumDead, noOne("vil")).ok, true);
  assert.equal(lyloToday(sixOneScumDead), false);
  const sixNoScumDead = day({ p1: "Villager", p2: "Villager", p3: "Villager" });
  assert.equal(noLynchLoses(sixNoScumDead), true, "3 mafia: NL + kill = 3 vs 2");
  assert.equal(validateAction(sixNoScumDead, noOne("vil")).reason, "no lynch loses: must lynch today");
});

test("LYLO in the briefing: the 5-way with 2 mafia is lynch or lose", () => {
  const five = day({ p1: "Mafioso", p2: "Villager", p3: "Villager", p4: "Villager" });
  assert.equal(lyloToday(five), true);
  assert.match(buildBriefing(five), /LYLO: LYNCH OR LOSE TODAY/);
  const safe = day({ p1: "Mafioso", p2: "Villager", p3: "Villager" });
  assert.doesNotMatch(buildBriefing(safe), /LYLO/);
  assert.match(buildBriefing(safe), /NO LYNCH IS ALLOWED today/);
});

test("meteor on the day: nobody votes no-one (a no-winner end), and the briefing says so", () => {
  const v = day({ p1: "Villager" }, { day: 3, after: [srv(DAY_WARN)] });
  assert.equal(meteorOn(v), "Day");
  assert.match(validateAction(v, noOne("vil")).reason, /meteor/);
  assert.match(buildBriefing(v), /METEOR: SOMEONE MUST BE CONDEMNED TODAY/);
  const mafia = day({ p1: "Villager" }, { day: 3, role: "Mafioso", after: [srv(DAY_WARN)] });
  assert.match(validateAction(mafia, noOne("vil")).reason, /meteor/, "no one wins: mafia loses too");
  // The warning only stands in its own phase.
  assert.equal(meteorOn(day({ p1: "Villager" }, { day: 3, after: [srv(DAY_WARN), { event: "state", data: { id: 8, name: "Night 3" } }] })), null);
});

test("a Sheriff's shot does not lift a Day meteor: only a condemn does (effects/Meteor.js), so the town must still lynch", () => {
  const shot = day({ p1: "Mafioso" }, { day: 3, after: [srv(DAY_WARN), srv(":gun: Hap pulls a gun and shoots at Bea!"), ...dies({ p2: "Villager" })] });
  assert.equal(noLynchLoses(shot), false, "no-lynch would be allowed but for the meteor");
  assert.equal(meteorOn(shot), "Day");
  assert.match(validateAction(shot, noOne("vil")).reason, /meteor/);
});

test("mafia may skip the kill when the meteor is not on them, but not a living power-role claimer, and never under the meteor", () => {
  const free = night();
  assert.equal(meteorOn(free), null);
  assert.equal(rejectCandidate(free, { meetingId: "maf", target: "*", kind: "night-target" }), "");
  assert.match(buildBriefing(free), /NO METEOR ON YOU TONIGHT: the kill is optional/);
  const copOut = night({ chat: [{ event: "message", data: { meetingId: "vil", senderId: "p3", content: "im cop. ash inno" } }] });
  // The owed kill is one of Vinman's hard rules in legalActions, so validateAction refuses the skip itself.
  assert.match(rejectCandidate(copOut, { meetingId: "maf", target: "*", kind: "night-target" }), /^kill owed/);
  assert.match(validateAction(copOut, noOne("maf")).reason, /^kill owed/);
  const meteor = night({ warn: true });
  assert.equal(meteorOn(meteor), "Night");
  assert.match(validateAction(meteor, noOne("maf")).reason, /meteor: someone must die tonight/);
  assert.match(buildBriefing(meteor), /METEOR: SOMEONE MUST DIE TONIGHT OR NO ONE WINS: kill/);
});
