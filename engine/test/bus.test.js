import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, emptyView, busCheck, busPick, busNote, sideCounts, selectAction, rejectCandidate, decide, publicLeak, validateAction, machineLeak, BUS } from "../src/index.js";

// 9 players. Cal (self, Mafioso), Hap (Lawyer), Ivo (Janitor) are mafia; the rest town.
const P = ["cal", "hap", "ivo", "ash", "bea", "dot", "eli", "fin", "gil"].map((n) => [`${n}000001`, n[0].toUpperCase() + n.slice(1)]);
const id = (n) => `${n.toLowerCase()}000001`;
const players = Object.fromEntries(P.map(([i, name]) => [i, { id: i, name }]));
function view({ votes = {}, dead = [], phase = "Day 2" } = {}) {
  let v = reduce(emptyView(), { event: "self", data: id("cal") });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "roleReveal", data: { playerId: id("cal"), role: "Mafioso" } });
  v = reduce(v, { event: "reveal", data: { playerId: id("hap"), role: "Lawyer" } });
  v = reduce(v, { event: "reveal", data: { playerId: id("ivo"), role: "Janitor" } });
  v = reduce(v, { event: "state", data: { id: 3, name: phase } });
  const alive = P.map(([i]) => i).filter((i) => !dead.includes(i));
  v.dead = Object.fromEntries(dead.map((d) => [d, true]));
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: alive.filter((i) => i !== id("cal")), votes: Object.fromEntries(Object.entries(votes).map(([a, b]) => [id(a), id(b)])) } });
  v = reduce(v, { event: "meeting", data: { id: "maf", name: "Mafia", speech: true, voting: false, amMember: true } });
  return v;
}
const cand = (target, kind = "day-vote") => ({ kind, decisionId: "day:vil", meetingId: "vil", target: id(target), reason: "x" });

test("bus: refused when town is not on the teammate (teammates' own votes don't count)", () => {
  assert.equal(busCheck(view(), "vil", id("hap")).ok, false);
  assert.equal(busCheck(view({ votes: { ivo: "hap" } }), "vil", id("hap"), { deliberate: true }).ok, false, "a teammate's vote is not town pressure");
  assert.match(rejectCandidate(view(), cand("hap")), /known teammate/);
});

test("bus: allowed on a town wagon (2+ town votes) or when the teammate leads the vote", () => {
  const w = busCheck(view({ votes: { ash: "hap", bea: "hap" } }), "vil", id("hap"));
  assert.equal(w.ok, true); assert.equal(w.mode, "wagon");
  assert.equal(rejectCandidate(view({ votes: { ash: "hap", bea: "hap" } }), cand("hap")), "");
  const lead = busCheck(view({ votes: { ash: "hap" } }), "vil", id("hap"));
  assert.equal(lead.ok, true, "1 town vote but leading wagon");
  assert.equal(busCheck(view({ votes: { ash: "hap", bea: "dot", eli: "dot" } }), "vil", id("hap")).ok, false, "1 vote and not leading");
});

test("bus: a deliberate town-read play needs at least one town voter already on the teammate", () => {
  const v = view({ votes: { ash: "hap", bea: "dot", eli: "dot" } });
  const r = busCheck(v, "vil", id("hap"), { deliberate: true });
  assert.equal(r.ok, true); assert.equal(r.mode, "townread");
  assert.equal(rejectCandidate(v, cand("hap")), "", "model-proposed day-vote bus survives");
  assert.equal(busCheck(view({ votes: { bea: "dot" } }), "vil", id("hap"), { deliberate: true }).ok, false);
});

test("bus hard rules: never down to a lone scum, never when one lynch from parity, never at night", () => {
  const wagon = { ash: "hap", bea: "hap", dot: "hap" };
  const lone = view({ votes: wagon, dead: [id("ivo")] });
  assert.match(busCheck(lone, "vil", id("hap")).reason, /lone scum/);
  // 3 scum vs 4 town: lynching town would give parity. Bus is refused.
  const parity = view({ votes: { ash: "hap", bea: "hap" }, dead: [id("fin"), id("gil")] });
  assert.deepEqual(sideCounts(parity), { scum: 3, town: 4 });
  assert.match(busCheck(parity, "vil", id("hap")).reason, /parity/);
  assert.equal(busCheck(view({ votes: wagon, phase: "Night 2" }), "vil", id("hap")).ok, false);
  assert.equal(BUS.minScumAfter, 2);
});

test("bus scoring: near-certain lynch makes the bus the usual pick; a fresh wagon sometimes; never with no pressure", () => {
  const sure = view({ votes: { ash: "hap", bea: "hap", dot: "hap", eli: "hap" } });
  const pick = (v, seed) => selectAction(v, [cand("fin"), cand("gil")], { seed, decisions: [{ id: "day:vil", kind: "day-vote", meetingId: "vil", targets: [] }] }).actions[0]?.data.selection;
  let n = 0; for (let s = 1; s <= 200; s++) if (pick(sure, s) === id("hap")) n++;
  assert.ok(n > 60, `bus anchor chosen ${n}/200 when lynch is certain`);
  const calm = view({ votes: { ash: "fin" } });
  for (let s = 1; s <= 50; s++) assert.notEqual(pick(calm, s), id("hap"));
});

test("rules decide: busPick joins a certain lynch by chance, never otherwise", () => {
  const sure = view({ votes: { ash: "hap", bea: "hap", dot: "hap", eli: "hap" } });
  assert.equal(busPick(sure, "vil", () => 0), id("hap"));
  assert.equal(busPick(sure, "vil", () => 0.99), null);
  const vote = decide(sure, { rng: () => 0 }).find((a) => a.data.meetingId === "vil");
  assert.equal(vote?.data.selection, id("hap"));
  assert.equal(busPick(view(), "vil", () => 0), null);
});

test("bus speech: accusing a teammate is allowed; admitting the faction or pairing with a teammate is not", () => {
  const v = view({ votes: { ash: "hap", bea: "hap" } });
  for (const t of ["hap is scum", "lynch hap", "hap is mafia tbh", "hap feels off"]) assert.equal(publicLeak(v, t), null, t);
  for (const t of ["im mafia", "we are scum", "my team is hap", "hap is my partner", "me and hap", "hap and i are good"]) assert.ok(publicLeak(v, t), t);
  for (let r = 0; r < 3; r++) {
    const note = busNote(v, id("hap"), () => r / 3);
    assert.equal(machineLeak(v, note), null);
    assert.ok(validateAction(v, { event: "speak", data: { meetingId: "maf", content: note } }).ok, note);
    assert.ok(!/PLAN|=/.test(note));
  }
});
