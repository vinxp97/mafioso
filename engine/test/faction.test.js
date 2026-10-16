import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reduceAll, extractClaim, allies, enemies, myFaction, decide, validateAction } from "../src/index.js";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/claims.json", import.meta.url), "utf8"));
const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Ally" }, p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Cat" } };
const mtg = (id, name, targets, extra = {}) => ({ event: "meeting", data: { id, name, voting: true, canVote: true, amMember: true, targets, votes: {}, ...extra } });
const mafiaBase = (phase) => [{ event: "self", data: "p1" }, { event: "players", data: players },
  { event: "roleReveal", data: { playerId: "p1", role: "Mafioso" } },
  { event: "roleReveal", data: { playerId: "p2", role: "Godfather" } },
  { event: "state", data: { id: 1, name: phase } }];

test("claim extraction fixtures", () => {
  for (const c of cases) {
    const got = extractClaim(c.msg);
    if (c.expect === null) assert.equal(got, null, c.msg.content);
    else { assert.equal(got.role, c.expect.role, c.msg.content); assert.equal(got.kind, c.expect.kind); }
  }
});

test("reducer builds claim board; retract clears", () => {
  const v = reduceAll([{ event: "message", data: { senderId: "p2", content: "I'm cop" } },
    { event: "message", data: { senderId: "p3", content: "cc doc" } },
    { event: "message", data: { senderId: "p2", content: "retract cop" } }]);
  assert.equal(v.claims.p3.role, "Doctor");
  assert.equal(v.claims.p2.role, null);
  assert.equal(v.claims.p2.history.length, 2);
});

test("faction: mafia allies from reveals + meeting members; village has none", () => {
  const v = reduceAll([...mafiaBase("Night 1"), mtg("mMaf", "Mafia", ["p2", "p3", "p4"], { members: [{ id: "p1" }, { id: "p4" }] })]);
  assert.equal(myFaction(v), "Mafia");
  assert.deepEqual([...allies(v)].sort(), ["p2", "p4"]);
  const town = reduceAll([{ event: "self", data: "p1" }, { event: "roleReveal", data: { playerId: "p1", role: "Cop" } },
    { event: "message", data: { senderId: "p2", content: "I'm cop" } }, { event: "roleReveal", data: { playerId: "p3", role: "Mafioso" } }]);
  assert.equal(allies(town).size, 0, "claims never make allies");
  assert.deepEqual([...enemies(town)], ["p3"]);
});

test("mafia kill meeting skips ally", () => {
  const v = reduceAll([...mafiaBase("Night 1"), mtg("mMaf", "Mafia", ["p2", "p3", "*"])]);
  const acts = decide(v);
  assert.deepEqual(acts, [{ event: "vote", data: { meetingId: "mMaf", selection: "p3" } }]);
  assert.equal(validateAction(v, acts[0]).ok, true);
});

test("day vote skips ally, still votes non-ally", () => {
  const v = reduceAll([...mafiaBase("Day 1"), mtg("mVil", "Village", ["p1", "p2", "p3", "p4", "*"])]);
  assert.deepEqual(decide(v), [{ event: "vote", data: { meetingId: "mVil", selection: "p3" } }]);
});

test("only allies left -> '*' if legal, else nothing", () => {
  const withStar = reduceAll([...mafiaBase("Day 2"), { event: "death", data: "p3" }, { event: "death", data: "p4" },
    mtg("mVil", "Village", ["p1", "p2", "p3", "*"])]);
  assert.deepEqual(decide(withStar), [{ event: "vote", data: { meetingId: "mVil", selection: "*" } }]);
  const noStar = reduceAll([...mafiaBase("Night 2"), { event: "death", data: "p3" }, { event: "death", data: "p4" },
    mtg("mMaf", "Mafia", ["p2", "p3"])]);
  assert.deepEqual(decide(noStar), []);
});

test("night ability never targets ally (forced role on mafia side)", () => {
  // Hooker is alwaysAct n1 in policy and Mafia-aligned
  const v = reduceAll([{ event: "self", data: "p1" }, { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Hooker" } }, { event: "roleReveal", data: { playerId: "p2", role: "Mafioso" } },
    { event: "state", data: { id: 1, name: "Night 1" } }, mtg("mH", "Block", ["p2", "p3"])]);
  for (const a of decide(v)) assert.notEqual(a.data.selection, "p2");
});
