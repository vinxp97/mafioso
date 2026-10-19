// audit-fp 10/19: false positives found replaying the rejected/held lines of live games L2-L8 (10/18) offline.
// Examples are the logged lines with handles scrubbed (PlayerNN / pNN), states rebuilt to the moment of reject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, chatAudit, earlyClaimBlock, claimAllowed, underPressure, adaptivePressureLine } from "../src/index.js";

const ids = Array.from({ length: 9 }, (_, i) => `p0${i + 1}`);
const players = Object.fromEntries(ids.map((id, i) => [id, { id, name: `Player0${i + 1}` }]));
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
function seat(self, role, pre = [], { votes = {}, team = null, config = null, day = 2 } = {}) {
  return reduceAll([
    { event: "self", data: self }, { event: "players", data: players },
    ...(config ? [{ event: "botConfig", data: config }] : []),
    ...(team ? Object.entries(team).map(([id, r]) => ({ event: "roleReveal", data: { playerId: id, role: r } })) : []),
    { event: "roleReveal", data: { playerId: self, role } },
    ...pre,
    { event: "state", data: { id: 2 * day, name: `Day ${day}` } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids.filter((i) => i !== self), "*"], votes } },
  ]);
}
const rules = (view, line) => chatAudit(view, line).map((f) => f.rule);

test("misquote: unquoted reported speech is checked on its first clause (L8 D1 x4, L3 D2)", () => {
  const v = seat("p03", "Villager", [say("p06", "im cop. Player04 inno"), say("p06", "results: Player04 inno")], { day: 1 });
  for (const line of ["player06 said player04 is inno, so lynch player07", "player06 said player04 inno, but do we trust him",
    "player06 said player04 is inno right", "player06 said inno, that's my top read"]) assert.ok(!rules(v, line).includes("misquote"), line);
  // Still caught: the first clause itself is wrong, or a quoted span is wrong.
  assert.ok(rules(v, "player06 said player07 guilty, so lynch").includes("misquote"));
  assert.ok(rules(v, 'player06 said "player03 guilty"').includes("misquote"));
  const w = seat("p08", "Villager", [say("p07", "im cop. player03 guilty"), say("p07", "results: player03 guilty")]);
  assert.ok(!rules(w, "player07 said player03, trusting that blind").includes("misquote"));
  assert.ok(rules(w, "player07 said player05 guilty, trusting that").includes("misquote"));
});

test("flip: a reveal string with a trailing ':' compares on the role (L2 D3)", () => {
  const v = seat("p08", "Sheriff", [{ event: "death", data: "p09" }, { event: "reveal", data: { playerId: "p09", role: "Cop:" } }], { day: 3 });
  assert.ok(!rules(v, "player09 flipped cop").includes("flip"));
  assert.ok(!rules(v, "player09 was cop, so player06 is lying").includes("flip"));
  assert.ok(rules(v, "player09 flipped mafia").includes("flip"));
});

test("early claim: 3 alive, one vote on me (L-1): the pressure line is not generated into the block (L8 D3 x7)", () => {
  const team = { p01: "Mafioso" };
  const dead = ["p02", "p03", "p04", "p05", "p07", "p08"].map((id) => ({ event: "death", data: id }));
  const opts = { votes: { p06: "p01" }, team, config: { mafia: "adaptive" }, day: 3 };
  const v = seat("p01", "Mafioso", dead, opts);
  assert.equal(underPressure(v), true, "hammer 2: one vote is L-1");
  assert.equal(claimAllowed(v), false);
  assert.match(String(earlyClaimBlock(v, "im just vt, nothing to show. this wagon is wrong")), /early claim/);
  assert.equal(adaptivePressureLine(v), null, "no line the validator refuses");
  // claimPressure "l1" (off by default) allows the L-1 claim.
  const l1 = seat("p01", "Mafioso", dead, { ...opts, config: { mafia: "adaptive", claimPressure: "l1" } });
  assert.equal(claimAllowed(l1), true);
  assert.equal(earlyClaimBlock(l1, "im just vt, nothing to show. this wagon is wrong"), null);
  assert.ok(adaptivePressureLine(l1)?.line);
  // Town too, and never without the vote.
  assert.equal(claimAllowed(seat("p06", "Villager", dead, { votes: { p01: "p06" }, day: 3, config: { claimPressure: "l1" } })), true);
  assert.equal(claimAllowed(seat("p06", "Villager", dead, { day: 3, config: { claimPressure: "l1" } })), false);
  // 9 alive: unchanged (one vote is not pressure under either rule).
  assert.equal(claimAllowed(seat("p01", "Villager", [], { votes: { p06: "p01" }, config: { claimPressure: "l1" } })), false);
});
