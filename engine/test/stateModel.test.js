// The game-state model (src/stateModel.js): every phase transition, every death cause, the game's end, and the
// illegal actions it refuses. One Frontier Justice table throughout (made-up ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStateModel, stepModel, replayModel, modelLegalActions, modelCheck, modelWinner, modelPublicFacts, nextPhases } from "../src/index.js";

const ROLES = { p1: "Mafioso", p2: "Janitor", p3: "Lawyer", p4: "Cop", p5: "Journalist", p6: "Sheriff", p7: "Villager", p8: "Villager", p9: "Villager" };
const NAMES = Object.fromEntries(Object.keys(ROLES).map((id) => [id, `Player${id.slice(1)}`]));
const fresh = () => createStateModel({ players: NAMES, roles: ROLES });
/** Apply events that must all be legal; returns the model. */
function run(events, m = fresh()) {
  for (const ev of events) {
    const r = stepModel(m, ev);
    assert.ok(r.ok, `${JSON.stringify(ev)} refused: ${r.reason}`);
    m = r.model;
  }
  return m;
}
/** The reason an event is refused after a legal prefix. */
const refuse = (prefix, ev) => { const m = run(prefix); const r = stepModel(m, ev); assert.equal(r.ok, false, `${JSON.stringify(ev)} was accepted`); assert.equal(r.model, m, "a refused event leaves the model as it was"); return r.reason; };
const v = (voter, meeting, target) => ({ type: "vote", voter, meeting, target });
const N1 = [{ type: "phase", name: "Night 1" }];
const KILL7 = [v("p1", "Mafia Kill", "p7"), v("p2", "Mafia Kill", "p7"), v("p3", "Mafia Kill", "p7"), { type: "death", id: "p7", cause: "night" }];

test("phase order: Pregame -> Night 1 -> Day 1 -> Night 2; no skipping, no going back", () => {
  assert.deepEqual(nextPhases(fresh().phase), ["Night 1", "Day 1"]);
  const m = run([...N1, { type: "phase", name: "Day 1" }, { type: "phase", name: "Night 2" }, { type: "phase", name: "Day 2" }]);
  assert.equal(m.phase.name, "Day 2");
  assert.deepEqual(Object.keys(m.nights), ["Night 1", "Night 2"]);
  assert.deepEqual(Object.keys(m.days), ["Day 1", "Day 2"]);
  assert.equal(refuse([], { type: "phase", name: "Night 2" }), "Pregame cannot go to Night 2");
  assert.equal(refuse(N1, { type: "phase", name: "Night 2" }), "Night 1 cannot go to Night 2");
  assert.equal(refuse(N1, { type: "phase", name: "Night 1" }), "Night 1 cannot go to Night 1");
  assert.equal(refuse([...N1, { type: "phase", name: "Day 1" }], { type: "phase", name: "Day 2" }), "Day 1 cannot go to Day 2");
  assert.equal(refuse([], { type: "phase", name: "Dusk 1" }), "unknown phase Dusk 1");
});

test("night -> day: the mafia kill lands in the night, flips at the day, and the ballots' pick is recorded", () => {
  const m = run([...N1, ...KILL7, { type: "reveal", id: "p7", role: "Villager" }, { type: "phase", name: "Day 1" }]);
  assert.equal(m.alive.p7, false);
  assert.deepEqual(m.deaths, [{ id: "p7", cause: "night", phase: "Night 1", kind: "Night", n: 1 }]);
  assert.equal(m.flips.p7, "Villager");
  assert.deepEqual(m.nights["Night 1"], { killed: ["p7"], expected: "p7" });
  assert.equal(refuse(N1, { type: "death", id: "p1", cause: "night" }), "the mafia kill never lands on the mafia");
  assert.equal(refuse([...N1, { type: "phase", name: "Day 1" }], { type: "death", id: "p7", cause: "night" }), "night kill in Day 1");
});

test("day -> night with a lynch: the condemn is the ballots' plurality; no second lynch, no votes after it", () => {
  const day = [...N1, ...KILL7, { type: "phase", name: "Day 1" },
    v("p4", "Village", "p1"), v("p5", "Village", "p1"), v("p6", "Village", "p1"), v("p8", "Village", "p1"), v("p1", "Village", "p8"), v("p2", "Village", "p8"),
    { type: "death", id: "p1", cause: "condemn" }];
  assert.equal(refuse(day, v("p9", "Village", "p2")), "the day's lynch already happened");
  assert.equal(refuse(day, { type: "death", id: "p2", cause: "condemn" }), "two lynches in one day");
  const m = run([...day, { type: "reveal", id: "p1", role: "Mafioso" }, { type: "phase", name: "Night 2" }]);
  assert.equal(m.days["Day 1"].lynched, "p1");
  assert.equal(m.days["Day 1"].expected, "p1");
  assert.equal(m.days["Day 1"].noLynch, false);
  assert.equal(m.phase.name, "Night 2");
  assert.equal(refuse(N1, { type: "death", id: "p1", cause: "condemn" }), "condemn in Night 1");
});

test("day -> night with no lynch: a tie or a no-one plurality condemns nobody", () => {
  const tie = run([...N1, { type: "phase", name: "Day 1" }, v("p4", "Village", "p1"), v("p1", "Village", "p4"), { type: "phase", name: "Night 2" }]);
  assert.equal(tie.days["Day 1"].lynched, null);
  assert.equal(tie.days["Day 1"].noLynch, true);
  assert.equal(tie.days["Day 1"].expected, "*", "a tie is no one (Meeting.js)");
  const nl = run([...N1, { type: "phase", name: "Day 1" }, v("p4", "Village", "*"), v("p5", "Village", "*"), v("p1", "Village", "p4"), { type: "phase", name: "Night 2" }]);
  assert.equal(nl.days["Day 1"].expected, "*");
  assert.equal(nl.days["Day 1"].noLynch, true);
});

test("an unvote takes a ballot back; changing a vote keeps only the last one", () => {
  const m = run([...N1, { type: "phase", name: "Day 1" }, v("p4", "Village", "p1"), v("p4", "Village", "p2"), v("p5", "Village", "p1"), { type: "unvote", voter: "p5", meeting: "Village" }]);
  assert.deepEqual(m.votes["Day 1"].Village, { p4: "p2" });
  assert.equal(refuse([...N1, { type: "phase", name: "Day 1" }], { type: "unvote", voter: "p5", meeting: "Village" }), "no vote to take back");
});

test("the Sheriff's shot: Day only, once, reveals him; the victim dies by the gun and votes on him stop counting", () => {
  const d1 = [...N1, { type: "phase", name: "Day 1" }];
  const shot = [...d1, v("p2", "Village", "p8"), v("p7", "Village", "p1"), { type: "shot", by: "p6", target: "p1" }, { type: "death", id: "p1", cause: "gun" }];
  const m = run([...shot, { type: "reveal", id: "p1", role: "Mafioso" }, { type: "reveal", id: "p6", role: "Sheriff" }, v("p8", "Village", "p2"), { type: "phase", name: "Night 2" }]);
  assert.equal(m.sheriff, "p6");
  assert.equal(m.gunUsed.p6, true);
  assert.deepEqual(m.days["Day 1"].shots, [{ by: "p6", target: "p1" }]);
  assert.deepEqual(m.deaths.map((d) => [d.id, d.cause]), [["p1", "gun"]]);
  // p7's ballot on the dead p1 is cleared: p2 (p8's vote) and p8 (p2's vote) tie.
  assert.equal(m.days["Day 1"].expected, "*");
  assert.equal(refuse(shot, { type: "shot", by: "p6", target: "p2" }), "the gun is spent");
  assert.equal(refuse(shot, v("p6", "Shoot Gun", "p2")), "the gun is spent");
  assert.equal(refuse(N1, { type: "shot", by: "p6", target: "p1" }), "no gun in Night 1");
  assert.equal(refuse(d1, { type: "shot", by: "p7", target: "p1" }), "Villager has no gun");
  assert.equal(refuse(d1, { type: "shot", by: "p6", target: "p6" }), "cannot shoot self");
  assert.equal(refuse(d1, { type: "death", id: "p2", cause: "gun" }), "gun death without a shot at the victim");
  assert.equal(refuse(shot, { type: "reveal", id: "p4", role: "Cop" }), "a living player's role is not public");
});

test("the Janitor's clean: the kill's flip is hidden, the Janitor learns the role, and the clean is spent", () => {
  const n1 = [...N1, v("p2", "Clean Death", "Yes"), ...KILL7];
  const m = run([...n1, { type: "phase", name: "Day 1" }, { type: "result", kind: "janitor", to: "p2", target: "p7", result: "Villager" }]);
  assert.equal(m.deaths[0].cleaned, true);
  assert.deepEqual(m.results, [{ kind: "janitor", to: "p2", target: "p7", result: "Villager", night: "Night 1" }]);
  assert.equal(modelCheck(m, { type: "reveal", id: "p7", role: "Villager" }), "a cleaned death has no flip");
  const n2 = run([{ type: "phase", name: "Night 2" }], m);
  assert.equal(stepModel(n2, v("p2", "Clean Death", "Yes")).reason, "the clean is spent");
  assert.ok(!modelLegalActions(n2, "p2").meetings.some((x) => x.meeting === "Clean Death"));
  assert.equal(refuse([...n1, { type: "phase", name: "Day 1" }], { type: "result", kind: "janitor", to: "p2", target: "p7", result: "Sheriff" }), "janitor report says Sheriff, role is Villager");
  assert.equal(refuse([...n1, { type: "phase", name: "Day 1" }], { type: "result", kind: "janitor", to: "p2", target: "p8", result: "Villager" }), "janitor report on a player not killed tonight");
  assert.equal(refuse([...n1, { type: "phase", name: "Day 1" }], { type: "result", kind: "janitor", to: "p3", target: "p7", result: "Villager" }), "Lawyer gets no janitor report");
});

test("Cop and Journalist reports: their holder only, on a seated player; a holder killed tonight still reports", () => {
  const n1 = [...N1, v("p4", "Investigate", "p1"), v("p5", "Receive Reports", "p4"), v("p1", "Mafia Kill", "p4"), { type: "death", id: "p4", cause: "night" }, { type: "phase", name: "Day 1" }];
  const m = run([...n1, { type: "result", kind: "cop", to: "p4", target: "p1", result: "Guilty" }, { type: "result", kind: "journalist", to: "p5", target: "p4", result: "Guilty on p1" }]);
  assert.deepEqual(m.results.map((r) => [r.kind, r.to, r.target]), [["cop", "p4", "p1"], ["journalist", "p5", "p4"]]);
  assert.equal(refuse(n1, { type: "result", kind: "cop", to: "p7", target: "p1", result: "Guilty" }), "Villager gets no cop report");
  // The L9 Journalist line cut a username to its first 14 letters: a result must name a seated player.
  assert.equal(refuse(n1, { type: "result", kind: "journalist", to: "p5", target: "Player0", result: "Guilty" }), "report target is not seated");
  assert.equal(refuse(n1, { type: "result", kind: "cop", to: "p4", target: "p4", result: "Innocent" }), "a report on self");
  const n2 = [...n1, { type: "phase", name: "Night 2" }];
  assert.equal(refuse(n2, { type: "result", kind: "cop", to: "p4", target: "p1", result: "Guilty" }), "report holder was dead before the night");
  assert.equal(refuse([], { type: "result", kind: "cop", to: "p4", target: "p1", result: "Guilty" }), "no report in Pregame");
});

test("illegal votes: dead voter, dead target, wrong phase, a meeting the role does not hold, self, teammate, bad selection", () => {
  const n1 = [...N1, ...KILL7];
  const d1 = [...n1, { type: "phase", name: "Day 1" }];
  assert.equal(refuse(d1, v("p7", "Village", "p1")), "voter is dead");
  assert.equal(refuse(d1, v("p4", "Village", "p7")), "target is dead");
  assert.equal(refuse(d1, v("p4", "Village", "p42")), "target is not seated");
  assert.equal(refuse(d1, v("p42", "Village", "p1")), "voter is not seated");
  assert.equal(refuse(d1, v("p1", "Mafia Kill", "p4")), "Mafia Kill does not meet in Day 1");
  assert.equal(refuse(N1, v("p4", "Village", "p1")), "Village does not meet in Night 1");
  assert.equal(refuse(N1, v("p7", "Mafia Kill", "p4")), "Villager does not hold Mafia Kill");
  assert.equal(refuse(N1, v("p7", "Investigate", "p1")), "Villager does not hold Investigate");
  assert.equal(refuse(N1, v("p4", "Investigate", "p4")), "cannot target self");
  assert.equal(refuse(N1, v("p3", "Litigate", "p3")), "cannot target self");
  assert.equal(refuse(N1, v("p1", "Mafia Kill", "p2")), "the kill cannot target a teammate");
  assert.equal(refuse(N1, v("p2", "Clean Death", "p7")), "Clean Death takes Yes or No");
  assert.equal(refuse(N1, v("p1", "Vote Kick", "Kick")), "vote kick is not a game action");
  assert.equal(refuse(N1, v("p1", "Hex", "p4")), "unknown meeting Hex");
  // Legal ones the rules allow: a self-vote in the Village, no one anywhere it is offered.
  run([...d1, v("p4", "Village", "p4"), v("p5", "Village", "*")]);
  run([...N1, v("p4", "Investigate", "*"), v("p1", "Mafia Kill", "*")]);
});

test("illegal speech: the dead, public chat at night, a town seat in the mafia chat; claims are read from public lines", () => {
  const d1 = [...N1, ...KILL7, { type: "phase", name: "Day 1" }];
  assert.equal(refuse(d1, { type: "speak", by: "p7", meeting: "Village", text: "i was town" }), "speaker is dead");
  assert.equal(refuse(N1, { type: "speak", by: "p4", meeting: "Village", text: "hi" }), "no public chat in Night 1");
  assert.equal(refuse(N1, { type: "speak", by: "p4", meeting: "Mafia", text: "hi" }), "Cop is not in the Mafia chat");
  assert.equal(refuse(d1, { type: "speak", by: "p4", meeting: "Village", text: "  " }), "empty speech");
  const m = run([...d1, { type: "speak", by: "p4", meeting: "Village", text: "im cop. player1 guilty" }, { type: "speak", by: "p2", meeting: "Village", text: "i'm the cop actually" },
    { type: "speak", by: "p8", meeting: "Village", text: "might be cop lol" }]);
  assert.deepEqual(m.claims, { p4: [{ role: "Cop", kind: "claim", phase: "Day 1" }], p2: [{ role: "Cop", kind: "claim", phase: "Day 1" }] }, "soft claims are not claims");
  run([...N1, { type: "speak", by: "p1", meeting: "Mafia", text: "kill player7" }]);
});

test("game end: the win check after each death; nothing but the end after a win; no win the table does not show", () => {
  // The Village wins: the Sheriff shoots p1, town lynches p2, the night kills nobody, town lynches p3.
  const village = [...N1, { type: "phase", name: "Day 1" }, { type: "shot", by: "p6", target: "p1" }, { type: "death", id: "p1", cause: "gun" },
    v("p4", "Village", "p2"), { type: "death", id: "p2", cause: "condemn" }, { type: "phase", name: "Night 2" }, { type: "phase", name: "Day 2" },
    v("p4", "Village", "p3"), { type: "death", id: "p3", cause: "condemn" }];
  const won = run(village);
  assert.equal(modelWinner(won), "Village");
  assert.equal(won.decided, "Village");
  assert.equal(stepModel(won, { type: "phase", name: "Night 3" }).reason, "game decided (Village): no phase after a win");
  assert.equal(stepModel(won, v("p4", "Village", "p5")).reason, "game over");
  assert.equal(stepModel(won, { type: "end", winner: "Mafia" }).reason, "winner Mafia but the table says Village");
  const over = run([{ type: "end", winner: "Village" }], won);
  assert.equal(over.ended, true);
  assert.equal(over.winner, "Village");
  assert.equal(stepModel(over, { type: "end", winner: "Village" }).reason, "game already ended");
  assert.equal(stepModel(over, { type: "death", id: "p4", cause: "night" }).reason, "game over");
  run([{ type: "speak", by: "p7", meeting: "Village", text: "gg" }], over); // postgame chat
  // Mafia parity: 3 mafia, 3 town left after the night.
  const mafia = run([...N1, ...KILL7, { type: "phase", name: "Day 1" }, v("p1", "Village", "p8"), { type: "death", id: "p8", cause: "condemn" }, { type: "phase", name: "Night 2" },
    v("p1", "Mafia Kill", "p9"), { type: "death", id: "p9", cause: "night" }]);
  assert.equal(modelWinner(mafia), "Mafia", "3 mafia, 3 town after Night 2's kill");
  assert.equal(stepModel(mafia, { type: "phase", name: "Day 2" }).reason, "game decided (Mafia): no phase after a win");
  run([{ type: "end", winner: "Mafia" }], mafia);
  assert.equal(stepModel(run(N1), { type: "end", winner: "Village" }).reason, "winner Village but the table says no winner yet");
});

test("legal actions per phase and role: what a seat may do now matches what the model accepts", () => {
  const n1 = run(N1);
  const names = (seat) => modelLegalActions(n1, seat).meetings.map((x) => x.meeting).sort();
  assert.deepEqual(names("p1"), ["Mafia Kill"]);
  assert.deepEqual(names("p2"), ["Clean Death", "Mafia Kill"]);
  assert.deepEqual(names("p3"), ["Litigate", "Mafia Kill"]);
  assert.deepEqual(names("p4"), ["Investigate"]);
  assert.deepEqual(names("p5"), ["Receive Reports"]);
  assert.deepEqual(names("p6"), []);
  assert.deepEqual(names("p7"), []);
  assert.deepEqual(modelLegalActions(n1, "p1").speak, ["Mafia"]);
  assert.deepEqual(modelLegalActions(n1, "p1").meetings[0].targets, ["p4", "p5", "p6", "p7", "p8", "p9", "*"]);
  const d1 = run([...KILL7, { type: "phase", name: "Day 1" }], n1);
  assert.deepEqual(modelLegalActions(d1, "p6").meetings.map((x) => x.meeting), ["Village", "Shoot Gun"]);
  assert.deepEqual(modelLegalActions(d1, "p6").meetings[1].targets, ["p1", "p2", "p3", "p4", "p5", "p8", "p9", "*"], "the gun: the living but self, or no one (hold it; items/Gun.js)");
  assert.deepEqual(modelLegalActions(d1, "p7"), { seat: "p7", phase: "Day 1", alive: false, meetings: [], speak: [] });
  // Every listed option is accepted, every seated unlisted one refused.
  for (const m of [n1, d1]) for (const seat of Object.keys(ROLES)) for (const { meeting, targets } of modelLegalActions(m, seat).meetings) {
    for (const t of [...Object.keys(ROLES), "*", "Yes", "No"]) assert.equal(!modelCheck(m, v(seat, meeting, t)), targets.includes(t), `${m.phase.name} ${seat} ${meeting} ${t}`);
  }
});

test("without roles only the table is checked; an unknown seat's role checks are skipped", () => {
  const blind = createStateModel({ players: ["a", "b", "c"] });
  const r = replayModel(blind, [{ type: "phase", name: "Night 1" }, v("a", "Mafia Kill", "b"), { type: "death", id: "b", cause: "night" }, { type: "phase", name: "Day 1" }, v("b", "Village", "a"), { type: "end", winner: "Mafia" }]);
  assert.deepEqual(r.refused.map((x) => x.reason), ["voter is dead"]);
  assert.equal(r.model.winner, "Mafia");
  const part = createStateModel({ players: NAMES, roles: { ...ROLES, p7: null } });
  assert.equal(modelCheck(run(N1, part), v("p7", "Investigate", "p1")), null, "p7's role is unknown");
  assert.equal(modelWinner(part), null, "no win check while a living seat's role is unknown");
});

test("a refused event never changes the model, and replays are deterministic", () => {
  const evs = [...N1, ...KILL7, v("p7", "Mafia Kill", "p4"), { type: "phase", name: "Day 1" }, v("p4", "Village", "p1"), { type: "phase", name: "Day 2" }, { type: "phase", name: "Night 2" }];
  const a = replayModel(fresh(), evs); const b = replayModel(fresh(), evs);
  assert.deepEqual(a, b);
  assert.deepEqual(a.refused.map((x) => [x.i, x.reason]), [[5, "voter is dead"], [8, "Day 1 cannot go to Day 2"]]);
  assert.equal(a.model.phase.name, "Night 2");
  const facts = modelPublicFacts(a.model);
  assert.deepEqual(facts.dead, ["Player7 (no flip, killed Night 1)"]);
  assert.equal(facts.alive.length, 8);
});
