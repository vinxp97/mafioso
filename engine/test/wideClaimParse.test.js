// Night 6 part 5: config.wideClaimParse (off by default). Three scripted claim wordings the default parse misses,
// plus negatives (questions, hypotheticals, reports about others, dead claimers) that never count as claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, claimedRoleIn, claimOpts, publicRecord, claimOptions, parseClaimReply, shotStatus, SHERIFF_ASK } from "../src/index.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const WIDE = { wide: true };
const day = (self, role, extra, wide, mates = []) => {
  const v = reduceAll([
    { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role } },
    ...(mates.length ? [{ event: "teammates", data: mates }] : []),
    { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } },
    { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: role === "Sheriff", targets: ids.filter((x) => x !== self), votes: {} } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    ...extra,
  ]);
  v.config = { ...(v.config || {}), mafia: "adaptive", ...(wide ? { wideClaimParse: "on" } : {}) };
  return v;
};
const at = (v, t) => reduce(v, { event: "time", t, data: { name: "main", time: 600_000 - t } });

export const WIDE_POSITIVES = Object.freeze([
  ["cop bob guilty", "cop"], ["cop: bob inno", "cop"], ["cop dan innocent", "cop"],
  ["journalist lol, no reports to share", "journalist"], ["Journalist, nothing to report yet.", "journalist"], ["journalist, no reports yet", "journalist"],
]);
export const WIDE_NEGATIVES = Object.freeze([
  "are you cop?", "who is the cop", "who is the cop?", "cop?", "cop bob guilty?", "journalist, who did you check?", "journalist lol where are you",
  "if i were cop i would claim", "if im cop ill tell you", "even if im journalist it wont matter", "i could be cop for all you know",
  "cop said bob is guilty", "cop says bob guilty", "the cop said dan inno", "cop claimed bob", "cop is lying",
  "the cop is dead", "cop is dead lol", "rip cop", "cop flipped janitor", "dead cop said bob guilty", "our cop was lying",
  "cop who", "cop and journalist should claim", "cop, claim pls", "sheriff shoot bob", "bob is cop", "i think cop is lying",
]);

test("wide parse: the three missed wordings are claims with the flag, not without", () => {
  for (const [t, role] of WIDE_POSITIVES) {
    assert.equal(claimedRoleIn(t), null, `off: ${t}`);
    assert.equal(claimedRoleIn(t, WIDE), role, `on: ${t}`);
  }
  // Ordinary claims keep their role either way.
  for (const [t, role] of [["im cop, bob guilty", "cop"], ["Cop here: Bob guilty.", "cop"], ["journalist", "journalist"], ["blue", "villager"], ["sheriff here", "sheriff"], ["im cop, who should i check?", "cop"]]) {
    assert.equal(claimedRoleIn(t), role, t); assert.equal(claimedRoleIn(t, WIDE), role, t);
  }
});

test("wide parse: questions, hypotheticals, reports about others and dead claimers are never claims with the flag", () => {
  for (const t of WIDE_NEGATIVES) assert.equal(claimedRoleIn(t, WIDE), null, t);
  // The default parse reads this hypothetical as a claim; the flag doesn't.
  assert.equal(claimedRoleIn("if im cop ill tell you"), "cop");
  assert.equal(claimOpts({ config: { wideClaimParse: "on" } }).wide, true);
  assert.equal(claimOpts({ config: {} }), undefined);
});

test("wide parse: a terse 'cop bob guilty' enters the public record (Cop claim and guilty) only with the flag", () => {
  const extra = [say("p2", "cop bob guilty", 5_000)];
  const off = publicRecord(day("p4", "Villager", extra, false));
  const on = publicRecord(day("p4", "Villager", extra, true));
  assert.equal(off.claims.p2, undefined);
  assert.equal(on.claims.p2, "Cop");
  assert.ok(on.guilty.some((g) => g.by === "p2" && g.target === "p3"), JSON.stringify(on.guilty));
  assert.ok(!off.guilty.some((g) => g.by === "p2" && g.target === "p3" && off.claims.p2 === "Cop"));
});

test("wide parse: a real Journalist's 'journalist lol, ...' closes the fake Journalist claim for mafia only with the flag", () => {
  const mates = [{ id: "p6", name: "Eve", role: "Janitor" }, { id: "p7", name: "Fay", role: "Lawyer" }];
  const extra = [say("p2", "journalist lol, no reports to share", 5_000), say("p3", "im cop, dan inno", 6_000)];
  assert.equal(claimOptions(day("p4", "Mafioso", extra, false, mates)).journalist, true);
  assert.equal(claimOptions(day("p4", "Mafioso", extra, true, mates)).journalist, false);
});

test("wide parse: a hypothetical is not a claim on the public record with the flag", () => {
  const extra = [say("p2", "if im cop ill tell you", 5_000)];
  assert.equal(publicRecord(day("p4", "Villager", extra, false)).claims.p2, "Cop");
  assert.equal(publicRecord(day("p4", "Villager", extra, true)).claims.p2, undefined);
});

test("wide parse: the Sheriff's asked seat reporting the Cop ('cop said bob is guilty') is not a power answer with the flag", () => {
  assert.equal(parseClaimReply("cop said bob is guilty").kind, "power", "off: the bare role word reads as a Cop claim");
  assert.equal(parseClaimReply("cop said bob is guilty", WIDE), null);
  assert.equal(parseClaimReply("cop bob guilty", WIDE).kind, "power");
  assert.equal(parseClaimReply("cop?", WIDE), null);
  // In the gate: I am the Sheriff (p1), asked Cat (p4), who reports a Cop line instead of claiming.
  const base = [say("p1", "im sheriff", 1_000), ...["p2", "p3", "p5", "p6", "p7"].map((p, i) => say(p, "hmm idk", 2_000 + i)), say("p1", "cat claim?", 130_000), say("p4", "cop said bob is guilty", 135_000)];
  const off = at(day("p1", "Sheriff", base, false), 136_000);
  const on = at(day("p1", "Sheriff", base, true), 136_000);
  assert.notEqual(shotStatus(off, "p4").status, "open", "off: Cat counts as a fresh Cop claim");
  assert.equal(shotStatus(off, "p4").status, "pending-cc", "off: waits on a counterclaim to Cat's 'Cop claim'");
  assert.equal(shotStatus(on, "p4").status, "pending-reply", "on: not an answer yet, the reply window runs");
  assert.equal(shotStatus(at(on, 130_000 + SHERIFF_ASK.replyMs + 1), "p4").status, "open", "on: then silence counts");
});
