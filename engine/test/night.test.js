import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reduce, reduceAll, decide, validateAction, proposeNightAction, specForRole,
  mustActTonight } from "../src/index.js";

const load = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const night = () => reduceAll(load("reconnect-night.jsonl"));
const meetingFrame = (id, name, targets) => ({ event: "meeting", data: { id, name, voting: true,
  canVote: true, amMember: true, targets, votes: {} } });

test("history seeds meetings for current state, reveals, and dead", () => {
  const v = night();
  assert.equal(v.stateId, 2);
  assert.deepEqual(Object.keys(v.meetings).sort(), ["mCop", "mMaf"]);
  assert.equal(v.dead.p4, true);
  assert.equal(v.role, "Cop", "role from history roles map, modifiers stripped");
});

test("roleReveal sets own role; reveal of others doesn't", () => {
  let v = reduceAll([{ event: "self", data: "p1" }, { event: "roleReveal", data: { playerId: "p2", role: "Mafioso" } }]);
  assert.equal(v.role, null); assert.equal(v.reveals.p2, "Mafioso");
  v = reduce(v, { event: "roleReveal", data: { playerId: "p1", role: "Doctor:Loud" } });
  assert.equal(v.role, "Doctor");
});

test("policy spec: Cop forced on N1 only; unknown role not forced", () => {
  const cop = specForRole("Cop:Humble");
  assert.equal(mustActTonight(cop, 1), true);
  assert.equal(mustActTonight(cop, 2), false);
  assert.equal(specForRole("Villager").alwaysAct, "no");
  assert.equal(mustActTonight(specForRole("Oracle"), 3), true);
});

test("nightAct picks a forced living non-self target, never '*', dead, or kill meeting", () => {
  const v = night();
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const a = proposeNightAction(v, { rng: () => r });
    assert.equal(a.forced, true);
    assert.equal(a.data.meetingId, "mCop");
    assert.ok(["p2", "p3"].includes(a.data.selection), a.data.selection);
    assert.equal(validateAction(v, a).ok, true);
  }
});

test("read mode picks player called scum (Oracle N2)", () => {
  let v = reduceAll([{ event: "self", data: "p1" },
    { event: "players", data: { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" } } },
    { event: "roleReveal", data: { playerId: "p1", role: "Oracle" } },
    { event: "message", data: { senderId: "p2", content: "Bob is scum" } },
    { event: "state", data: { id: 4, name: "Night 2" } },
    meetingFrame("mO", "Prophesy", ["p1", "p2", "p3"])]);
  assert.equal(proposeNightAction(v, { rng: () => 0 }).data.selection, "p3");
});

test("illegal targets never emitted", () => {
  // only targets are self, dead, '*', yes/no -> forced role yields nothing illegal
  let v = night();
  v = reduce(v, { event: "death", data: "p2" }); v = reduce(v, { event: "death", data: "p3" });
  assert.equal(proposeNightAction(v), null);
  for (const a of decide(v)) assert.equal(validateAction(v, a).ok, true);
  // can't vote -> nothing
  const locked = reduce(night(), { event: "meeting", data: { ...night().meetings.mCop, canVote: false } });
  assert.deepEqual(decide(locked), []);
});

test("decide prefers nightAct at night and stops after own vote", () => {
  const v = night();
  const [a] = decide(v);
  assert.deepEqual(a, { event: "vote", data: { meetingId: "mCop", selection: "p2" } });
  const after = reduce(v, { event: "vote", data: { meetingId: "mCop", voterId: "p1", target: "p2" } });
  assert.deepEqual(decide(after), []);
});

test("day still uses stub path", () => {
  const v = reduceAll([...load("reconnect-night.jsonl"), { event: "state", data: { id: 3, name: "Day 2" } },
    meetingFrame("mVil", "Village", ["p1", "p2", "p3", "*"])]);
  assert.equal(v.role, "Cop");
  assert.deepEqual(decide(v), [{ event: "vote", data: { meetingId: "mVil", selection: "p2" } }]);
});
