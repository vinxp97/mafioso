// legalActions: per meeting, what the server accepts (server), what Vinman's hard rules leave (allowed, exactly
// what validateAction passes) and what a bot should pick (picks: minus advice), for the Frontier Justice core
// roles plus the Doctor. Targets come from the meeting frame; derivedTargets covers a frame with none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, legalActions, legalVotes, validateAction, serverAccepts, derivedTargets, meetingKind, KILL_OWED, METEOR_NIGHT, METEOR_DAY, NO_LYNCH_LOSES, DAY1_LYNCH_OWED, townVote, buildBriefing } from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const alive = (dead = []) => ids.filter((i) => !dead.includes(i));
const meet = (id, name, targets, extra = {}) => ({ event: "meeting", data: { id, name, voting: true, canVote: true, amMember: true, targets, votes: {}, ...extra } });
const seat = (role, phase, meetings, { dead = [], self = "p9", mates = {}, before = [], config } = {}) => {
  const v = reduceAll([
    { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role } },
    ...Object.entries(mates).map(([playerId, r]) => ({ event: "reveal", data: { playerId, role: r } })),
    ...dead.flatMap((id) => [{ event: "death", data: id }, { event: "reveal", data: { playerId: id, role: "Villager" } }]),
    ...before, { event: "state", data: { id: 9, name: phase } }, ...meetings,
  ]);
  if (config) v.config = { ...(v.config || {}), ...config };
  return v;
};
const entry = (v, id) => legalActions(v).meetings.find((e) => e.meetingId === id);
const vote = (meetingId, selection) => ({ event: "vote", data: { meetingId, selection } });

test("Cop, Doctor, Journalist: the offered targets, all allowed and picked; '*' is a legal skip", () => {
  for (const [role, name] of [["Cop", "Investigate"], ["Doctor", "Save"], ["Journalist", "Receive Reports"]]) {
    const targets = [...alive().filter((i) => i !== "p9"), "*"];
    const e = entry(seat(role, "Night 2", [meet("m", name, targets)]), "m");
    assert.equal(e.kind, { Cop: "investigate", Doctor: "save", Journalist: "reports" }[role]);
    assert.deepEqual(e.server, targets);
    assert.deepEqual(e.allowed, targets);
    assert.deepEqual(e.picks, targets);
    assert.equal(e.closed, null);
  }
});

test("Janitor: Yes/No while the clean is unused; the server stops offering the meeting after a clean", () => {
  const v = seat("Janitor", "Night 1", [meet("c", "Clean Death", ["Yes", "No"], { inputType: "boolean" })], { mates: { p8: "Mafioso" } });
  assert.deepEqual(entry(v, "c").allowed, ["Yes", "No"]);
  assert.equal(validateAction(v, vote("c", "p3")).ok, false, "a player is not a Clean Death option");
  assert.equal(legalActions(seat("Janitor", "Night 2", [], { mates: { p8: "Mafioso" } })).meetings.length, 0);
});

test("Loyal Lawyer: any living other player is server-legal, only teammates are picks; the plain variant picks any player", () => {
  const targets = [...alive().filter((i) => i !== "p9"), "*"];
  const loyal = entry(seat("Lawyer", "Night 1", [meet("l", "Litigate", targets)], { mates: { p8: "Mafioso", p7: "Janitor" } }), "l");
  assert.deepEqual(loyal.server, targets);
  assert.deepEqual(loyal.allowed, targets, "the server accepts it and no hard rule refuses it");
  assert.deepEqual(loyal.picks, ["p7", "p8"], "and never skips");
  assert.equal(loyal.notes.p3.tier, "advice");
  const plain = entry(seat("Lawyer", "Night 1", [meet("l", "Litigate", targets)], { mates: { p8: "Mafioso" }, config: { lawyer: "plain" } }), "l");
  assert.deepEqual(plain.picks, targets.filter((t) => t !== "*"));
});

test("Mafia kill: '*' is server-legal; Vinman's rules allow it only with no night meteor and no power-role claimer", () => {
  const kill = (before = []) => seat("Mafioso", "Night 2", [meet("k", "Mafia Kill", ["p1", "p2", "p3", "p8", "*"])], { mates: { p8: "Janitor" }, before });
  const free = entry(kill(), "k");
  assert.equal(free.kind, "kill");
  assert.deepEqual(free.server, ["p1", "p2", "p3", "p8", "*"]);
  assert.deepEqual(free.allowed, ["p1", "p2", "p3", "p8", "*"]);
  assert.deepEqual(free.picks, ["p1", "p2", "p3", "*"], "a teammate is server-legal (anonymous kill meeting) but never a pick");
  assert.deepEqual(free.flags, { meteor: false, killOptional: true });
  const claim = [{ event: "state", data: { id: 7, name: "Day 2" } }, { event: "message", data: { senderId: "p3", meetingId: "vil", content: "im cop. ash inno" } }];
  const owed = kill(claim);
  assert.deepEqual(entry(owed, "k").allowed, ["p1", "p2", "p3", "p8"]);
  assert.deepEqual(entry(owed, "k").notes["*"], { tier: "rule", reason: KILL_OWED });
  assert.equal(validateAction(owed, vote("k", "*")).reason, KILL_OWED);
  assert.equal(serverAccepts(owed, vote("k", "*")), true, "still server-legal");
  const meteor = kill([{ event: "state", data: { id: 8, name: "Night 2" } }, { event: "message", data: { senderId: "server", content: "A giant meteor will land and end the game if nobody dies tonight!" } }]);
  assert.equal(validateAction(meteor, vote("k", "*")).reason, METEOR_NIGHT);
});

test("Village: lynch anyone offered; no-lynch refused into an autoloss or under a day meteor; LYLO is a flag, not a block", () => {
  const vil = (dead, after = []) => seat("Villager", "Day 3", [meet("v", "Village", [...alive(dead), "*"]), ...after], { dead });
  const open = entry(vil([]), "v");
  assert.equal(open.allowed.includes("*"), true);
  assert.deepEqual(open.flags, { lylo: false, noLynchLoses: false, day1LynchOwed: false, meteor: false });
  const lylo = entry(vil(["p1", "p2"]), "v");
  assert.equal(lylo.flags.lylo, true);
  assert.equal(lylo.flags.noLynchLoses, true);
  assert.deepEqual(lylo.notes["*"], { tier: "rule", reason: NO_LYNCH_LOSES });
  assert.equal(lylo.allowed.includes("*"), false);
  assert.equal(lylo.server.includes("*"), true);
  const met = vil([], [{ event: "message", data: { senderId: "server", content: "A giant meteor will land and end the game if nobody is condemned today!" } }]);
  assert.equal(validateAction(met, vote("v", "*")).reason, METEOR_DAY);
});

test("Day 1: town may not no-lynch while the Sheriff lives; allowed once the Sheriff is dead, on Day 2, and for scum", () => {
  const vil = (role, phase, opts) => seat(role, phase, [meet("v", "Village", [...alive(opts?.dead), "*"])], opts);
  const d1 = vil("Villager", "Day 1");
  const e = entry(d1, "v");
  assert.equal(e.flags.day1LynchOwed, true);
  assert.deepEqual(e.notes["*"], { tier: "rule", reason: DAY1_LYNCH_OWED });
  assert.equal(e.allowed.includes("*"), false);
  assert.equal(e.server.includes("*"), true, "still server-legal");
  assert.equal(validateAction(d1, vote("v", "*")).reason, DAY1_LYNCH_OWED);
  assert.equal(validateAction(d1, vote("v", "p3")).ok, true);
  assert.notEqual(townVote(d1, d1.meetings.v).target, "*", "the suspicion vote lynches");
  assert.notEqual(townVote(d1, d1.meetings.v).target, "p9", "and never votes itself");
  assert.match(buildBriefing(d1), /DAY 1 WITH THE SHERIFF ALIVE: TOWN MUST LYNCH/);
  assert.equal(validateAction(vil("Sheriff", "Day 1"), vote("v", "*")).reason, DAY1_LYNCH_OWED, "the Sheriff too");
  // A revealed dead Sheriff lifts the rule.
  const dead = seat("Villager", "Day 1", [meet("v", "Village", [...alive(["p4"]), "*"])], { before: [{ event: "death", data: "p4" }, { event: "reveal", data: { playerId: "p4", role: "Sheriff" } }] });
  assert.equal(entry(dead, "v").flags.day1LynchOwed, false);
  assert.equal(validateAction(dead, vote("v", "*")).ok, true);
  assert.doesNotMatch(buildBriefing(dead), /TOWN MUST LYNCH/);
  assert.equal(validateAction(vil("Villager", "Day 2"), vote("v", "*")).ok, true);
  assert.equal(validateAction(vil("Mafioso", "Day 1", { mates: { p8: "Janitor" } }), vote("v", "*")).ok, true, "a town rule, not a scum one");
});

test("Sheriff: the gun is server-legal at any living other player but waits for the shot rule; it is gone once fired", () => {
  const v = seat("Sheriff", "Day 1", [meet("v", "Village", [...alive(), "*"]), meet("g", "Shoot Gun", [...alive().filter((i) => i !== "p9"), "*"], { instant: true, actionName: "Shoot" })]);
  const gun = entry(v, "g");
  assert.equal(gun.kind, "gun");
  assert.equal(gun.server.length, 9);
  assert.deepEqual(gun.allowed, [], "no discussion yet: the Sheriff rule holds the shot");
  assert.match(gun.notes.p3.reason, /sheriff shot too early|sheriff does not skip/);
  assert.equal(legalActions(seat("Sheriff", "Day 2", [meet("v", "Village", [...alive(), "*"])])).meetings.some((e) => e.kind === "gun"), false);
});

test("Vote Kick is never allowed; a dead seat, a non-voting member and a locked vote are closed", () => {
  const kick = seat("Villager", "Day 1", [meet("k", "Vote Kick", ["Kick"])]);
  assert.deepEqual(entry(kick, "k").allowed, []);
  assert.equal(validateAction(kick, vote("k", "Kick")).reason, "never vote kick");
  assert.equal(entry(seat("Villager", "Day 2", [meet("v", "Village", ["p1", "*"])], { dead: ["p9"] }), "v").closed, "dead seat");
  assert.equal(entry(seat("Villager", "Day 2", [meet("v", "Village", ["p1", "*"], { canVote: false })]), "v").closed, "cannot vote in meeting");
  const locked = seat("Villager", "Day 2", [meet("v", "Village", ["p1", "p2", "*"], { canUpdateVote: false, votes: { p9: "p1" } })]);
  assert.equal(entry(locked, "v").closed, "vote locked");
  assert.deepEqual(legalVotes(locked), []);
});

test("legalVotes and validateAction agree with legalActions on every option", () => {
  const v = seat("Mafioso", "Night 2", [meet("k", "Mafia Kill", ["p1", "p2", "p8", "*"]), meet("c", "Lawyer", ["p1", "p8"])], { mates: { p8: "Janitor" } });
  for (const e of legalActions(v).meetings) {
    for (const sel of [...e.server, "p5", "zzz"]) assert.equal(validateAction(v, vote(e.meetingId, sel)).ok, e.allowed.includes(sel), `${e.name} ${sel}`);
    assert.deepEqual(legalVotes(v).find((x) => x.meetingId === e.meetingId).targets, e.allowed);
  }
  assert.equal(meetingKind({ name: "Lawyer" }), "litigate");
});

test("derivedTargets: a frame with no targets gets the server definition's (self, members, '*')", () => {
  const v = seat("Cop", "Night 2", [], { dead: ["p1"] });
  assert.deepEqual(derivedTargets(v, { name: "Investigate", members: [{ id: "p9" }] }), [...alive(["p1", "p9"]), "*"]);
  assert.deepEqual(derivedTargets(v, { name: "Village" }), [...alive(["p1"]), "*"]);
  assert.deepEqual(derivedTargets(v, { name: "Mafia Kill", factionRole: "kill", members: [{ id: "p9" }, { id: "p8" }] }), [...alive(["p1", "p8", "p9"]), "*"]);
  assert.deepEqual(derivedTargets(v, { name: "Mafia Kill", factionRole: "kill", anonymous: true, members: [{ id: "p9" }] }), [...alive(["p1"]), "*"]);
  assert.deepEqual(derivedTargets(v, { name: "Clean Death" }), ["Yes", "No"]);
  assert.deepEqual(derivedTargets(v, { name: "Receive Reports" }), [...alive(["p1", "p9"]), "*"]);
  const offered = seat("Cop", "Night 2", [{ event: "meeting", data: { id: "m", name: "Investigate", voting: true, canVote: true, amMember: true, votes: {}, members: [{ id: "p9" }] } }]);
  assert.deepEqual(entry(offered, "m").server, alive().filter((i) => i !== "p9").concat("*"));
});

test("the Lawyer votes the Mafia Kill like any teammate: only its Litigate is limited to teammates", async () => {
  const { rejectCandidate } = await import("../src/index.js");
  const v = seat("Lawyer", "Night 2", [meet("k", "Mafia Kill", ["p1", "p2", "p3", "*"]), meet("l", "Litigate", [...alive().filter((i) => i !== "p9"), "*"])], { mates: { p8: "Mafioso", p7: "Janitor" } });
  // Before legalActions the selector's "lawyer only litigates teammates" check hit every personal meeting,
  // so a Lawyer's kill vote on any town player was dropped.
  assert.equal(rejectCandidate(v, { kind: "night-target", meetingId: "k", target: "p3" }), "");
  assert.equal(rejectCandidate(v, { kind: "night-target", meetingId: "l", target: "p3" }), "lawyer only litigates teammates");
  assert.equal(rejectCandidate(v, { kind: "night-target", meetingId: "l", target: "p8" }), "");
});
