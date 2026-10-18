// The fixture builder (src/replayBuild.js) on small synthetic logs: seat binding recovered from dead-seat lines,
// role meetings and the winners list; ballots from dead seats dropped; cleaned kills without a flip; alerts as
// the server's report messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, parseLog } from "../src/replayBuild.js";

// Five seats. True binding: a1 Cop = P3, a2 Mafioso = P5, a3 Villager = P1, a4 Janitor = P4, a5 Villager = P2.
// Players are first seen in the order P2, P5, P3, P1, P4, so the old guess (seat i = i-th player) is wrong for all.
const A = (i) => `AcSeat${i}xQz`; const P = (i) => `plPlay${i}xQz`;
const FRAMES = { "game:self": 5, "game:players": 5, "game:state": 20, "game:meeting": 20, "game:message": 20, "game:vote": 10, "game:death": 5, "game:reveal": 5, "game:roleReveal": 5, "game:winners": 5 };
const meet = (a, phase, id, name) => `meeting ${A(a)} [${phase}] ${id} name="${name}" role=${name === "Mafia Kill" ? "kill" : "-"} vote=true canVote=true targets=4`;
const vote = (a, phase, id, val) => `send ${A(a)} [${phase}] vote ${id} ${val} source=rules prompt=seed`;
const dead = (a) => `sched ${A(a)} skip u=0/0 path=dead reason=seat is dead; queue stopped`;
function log({ deadLines = true, winners = true, seatmap = false, staleVote = false, alerts = true } = {}) {
  return [
    `game GmSynth01x accounts=${[1, 2, 3, 4, 5].map(A).join(",")}`,
    `frames ${JSON.stringify(FRAMES)}`,
    ...(seatmap ? [`seatmap ${[[1, 3], [2, 5], [3, 1], [4, 4], [5, 2]].map(([s, p]) => `s${s}=${P(p)}:"Handle${p}x"`).join(" ")}`] : []),
    meet(2, "Night 1", "KillMtg01x", "Mafia Kill"), meet(4, "Night 1", "KillMtg01x", "Mafia Kill"),
    meet(4, "Night 1", "CleanMtg1x", "Clean Death"), meet(1, "Night 1", "InvMtg001x", "Investigate"),
    vote(2, "Night 1", "KillMtg01x", P(2)), vote(4, "Night 1", "KillMtg01x", P(2)),
    vote(4, "Night 1", "CleanMtg1x", "Yes"), vote(1, "Night 1", "InvMtg001x", P(5)),
    ...(deadLines ? [dead(5)] : []),
    ...(alerts ? ['alert AcSeat1xQz [Day 1] kind=cop target="Handle5x" result="Mafia"', 'alert AcSeat4xQz [Day 1] kind=janitor target="Handle2x" result="Villager"'] : []),
    meet(1, "Day 1", "VilMtg001x", "Village"),
    vote(1, "Day 1", "VilMtg001x", P(5)), vote(3, "Day 1", "VilMtg001x", P(5)), vote(2, "Day 1", "VilMtg001x", P(3)),
    ...(deadLines ? [dead(2)] : []),
    meet(4, "Night 2", "KillMtg02x", "Mafia Kill"),
    ...(staleVote ? [vote(2, "Night 2", "KillMtg02x", P(3))] : []),
    vote(4, "Night 2", "KillMtg02x", P(1)),
    ...(deadLines ? [dead(3)] : []),
    ...(winners ? [`winners {"groups":["Mafia"],"players":["${P(5)}","${P(4)}"],"messages":[],"playersByGroup":{"Mafia":["${P(5)}","${P(4)}"]}}`] : []),
    "",
  ].join("\n");
}
const run = (opts) => { const [g] = parseLog(log(opts)); return build(g, { source: "synthetic.log" }); };
const selfOf = (r) => Object.fromEntries(r.out.filter((e) => e.event === "self").map((e) => [e.accountId, e.data]));
const roleOf = (r) => Object.fromEntries(r.out.filter((e) => e.event === "roleReveal").map((e) => [e.data.playerId, e.data.role]));
// Fake ids follow first sight: P2 = p01, P5 = p02, P3 = p03, P1 = p04, P4 = p05.
const TRUE = { acc01: "p03", acc02: "p02", acc03: "p04", acc04: "p05", acc05: "p01" };

test("dead-seat lines, role meetings and winners recover the whole seat binding", () => {
  const r = run();
  assert.deepEqual(selfOf(r), TRUE);
  assert.equal(r.seatBinding, "recovered");
  assert.deepEqual(r.ambiguousSeats, []);
  assert.deepEqual(roleOf(r), { p03: "Cop", p02: "Mafioso", p04: "Villager", p05: "Janitor", p01: "Villager" });
  assert.equal(r.deathsConfirmedByDeadLines, 3);
});

test("without dead-seat lines, the winners list still puts the Mafia's seats on the Mafia's players", () => {
  const r = run({ deadLines: false });
  assert.equal(r.seatBinding, "partial");
  const self = selfOf(r);
  assert.deepEqual([self.acc02, self.acc04].sort(), ["p02", "p05"], "kill-meeting seats hold the winners' Mafia");
  assert.notEqual(self.acc01, "p02", "the Cop never investigates itself");
  assert.deepEqual(r.out.find((e) => e.event === "winners").data.playersByGroup.Mafia, ["p02", "p05"]);
});

test("a role meeting's target is never its own seat: the old guess is overruled", () => {
  const r = run({ deadLines: false, winners: false });
  const self = selfOf(r);
  assert.notEqual(self.acc01, "p02");
  assert.notEqual(self.acc02, "p01", "a Mafia Kill voter is not its own target");
  assert.notEqual(self.acc04, "p01");
});

test("a kill vote from a seat that is already dead is dropped: the living Mafia's vote decides", () => {
  const r = run({ seatmap: true, staleVote: true });
  assert.equal(r.seatBinding, "seatmap");
  // With a seatmap, fake ids follow the seatmap: P3 = p01, P5 = p02, P1 = p03, P4 = p04, P2 = p05.
  const n2 = r.out.findIndex((e) => e.accountId === "acc04" && e.event === "state" && e.data.name === "Night 2");
  const stale = r.out.slice(n2).filter((e) => e.event === "vote" && e.data.voterId === "p02");
  assert.equal(stale.length, 0, "the dead Mafioso's Night 2 ballot is not replayed");
  const deaths = [...new Set(r.out.filter((e) => e.event === "death").map((e) => e.data))];
  assert.deepEqual(deaths, ["p05", "p02", "p03"], "Night 2 kills P1; a 1-1 tie with the stale ballot would kill nobody");
});

test("a cleaned kill dies without a flip; a condemned seat flips", () => {
  const r = run();
  const reveals = r.out.filter((e) => e.event === "reveal" && e.accountId === "acc01").map((e) => e.data.playerId);
  assert.ok(r.out.some((e) => e.event === "death" && e.data === "p01"));
  assert.ok(!reveals.includes("p01"), "the Janitor cleaned Night 1's kill");
  assert.ok(reveals.includes("p02") && reveals.includes("p04"));
  assert.equal(r.cleaned, 1);
});

test("alert lines become the server's report messages to that seat at the start of the next day", () => {
  const r = run();
  const msgs = (acc) => r.out.filter((e) => e.accountId === acc && e.event === "message" && /^:(invest|mop|journ):/.test(e.data.content)).map((e) => e.data.content);
  assert.deepEqual(msgs("acc01"), [":invest: After investigating, you learn that Player02 is Guilty!"]);
  assert.deepEqual(msgs("acc04"), [":mop: You discover Player01's role is Villager."]);
  assert.equal(r.alerts, 2);
  const day1 = r.out.findIndex((e) => e.accountId === "acc01" && e.event === "state" && e.data.name === "Day 1");
  assert.ok(r.out.findIndex((e) => e.accountId === "acc01" && /^:invest:/.test(e.data?.content || "")) > day1);
  assert.equal(run({ alerts: false }).alerts, 0);
  assert.ok(!JSON.stringify(r.out).includes("Handle"), "alert handles are replaced");
});

test("a dev name split in chat ('first last12') is replaced whole, surname included", () => {
  const text = log({ seatmap: true }).split("\n");
  text.splice(text.findIndex((l) => l.includes("VilMtg001x")), 0, 'chat [Day 1] Village Handle1x: "kestrel barlow91 you there"', `send ${A(3)} [Day 1] speak VilMtg001x "kestrel barlow91 you there" source=rules prompt=seed`);
  const [g] = parseLog(text.join("\n"));
  const blob = JSON.stringify(build(g, { realNames: ["KestrelBarlow91"] }).out).toLowerCase();
  assert.ok(blob.includes("you there"));
  assert.ok(!/kestrel|barlow/.test(blob));
});

test("a meeting whose recorded votes mix 'no one' and players offers the living players and '*' (g02's bug)", () => {
  const text = log().replace(vote(2, "Night 1", "KillMtg01x", P(2)), vote(2, "Night 1", "KillMtg01x", "*"));
  const [g] = parseLog(text);
  const r = build(g, { source: "synthetic.log" });
  const kill = r.out.find((e) => e.accountId === "acc02" && e.event === "meeting" && e.data.name === "Mafia Kill");
  assert.ok(kill.data.targets.includes("*"));
  assert.ok(kill.data.targets.includes("p01"), "the recorded player target is offered");
  assert.ok(kill.data.targets.filter((t) => /^p\d+$/.test(t)).length >= 3, "and the living non-mafia pool");
});

test("ids shortened into nicknames or cut at the chat limit never reach a fixture", () => {
  const say = `send ${A(1)} [Day 1] speak VilMtg001x ${JSON.stringify(`two claims (${P(5).slice(0, 6)}, ${P(3).slice(0, 5)}) and a vote from ${P(2).slice(0, 7)}`)} source=rules prompt=seed`;
  const text = log().replace(vote(1, "Day 1", "VilMtg001x", P(5)), `${vote(1, "Day 1", "VilMtg001x", P(5))}\n${say}`);
  const r = build(parseLog(text)[0], { source: "synthetic.log" });
  const dump = JSON.stringify(r.out);
  for (const i of [2, 3, 5]) for (let k = 4; k <= P(i).length; k++) assert.ok(!dump.includes(P(i).slice(0, k)), `${P(i).slice(0, k)} leaked`);
  assert.ok(r.out.some((e) => e.event === "message" && /two claims \(p\d\d, p\d\d\)/.test(e.data.content)), "stubs map to the fake ids");
});
