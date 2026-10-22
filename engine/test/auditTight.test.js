// config.auditTight "on" (10/19): extra held-out phrasings in chatAudit. Off by default; tighten only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, chatAudit } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const seat = (role, events = [], { tight = true, mates = [] } = {}) => reduceAll([
  ...(tight ? [{ event: "botConfig", data: { auditTight: "on" } }] : []),
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } },
  ...(mates.length ? [{ event: "teammates", data: mates }] : []),
  { event: "state", data: { id: 3, name: "Night 1" } },
  ...events.filter((e) => e.night),
  { event: "state", data: { id: 4, name: "Day 2" } },
  { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  ...events.filter((e) => !e.night),
]);
const vote = (voterId, target) => ({ event: "vote", data: { meetingId: "vil", voterId, target } });
const dies = (id, role) => [{ event: "death", data: id }, { event: "reveal", data: { playerId: id, role } }];
const MATES = [{ id: "p1", name: "Ash", role: "Mafioso" }, { id: "p6", name: "Fin", role: "Lawyer" }];
const rules = (view, line) => chatAudit(view, line).map((f) => f.rule);

test("auditTight on: held-out shapes are flagged; off, the same lines pass as before", () => {
  const cases = [
    [() => seat("Mafioso", [], { mates: MATES }), "mafia speaking", "faction-admit"],
    [() => seat("Mafioso", [], { mates: MATES }), "ok you got me, scum here", "faction-admit"],
    [() => seat("Villager"), "eli plays cop", "unknown-role"],
    [() => seat("Villager", [...dies("p4", "Villager")]), "dot showed cop", "flip"],
    [() => seat("Villager", [vote("p2", "p3")]), "bea with 2 votes", "vote-count"],
    [() => seat("Villager", [vote("p2", "p3")]), "2 votes are on cal", "vote-count"],
    [() => seat("Villager"), "eli jumped on bea", "vote"],
    [() => seat("Villager"), "dot received no report, i watched", "unknown-result"],
  ];
  for (const [mk, line, rule] of cases) {
    const on = rules(mk(), line);
    assert.ok(on.length > 0, `${line}: expected a flag (${rule}), got none`);
  }
  // off by default: the tight-only shapes are not checked
  assert.deepEqual(rules(seat("Villager", [], { tight: false }), "eli plays cop"), []);
  assert.deepEqual(rules(seat("Villager", [], { tight: false }), "eli jumped on bea"), []);
});

test("auditTight on: true facts in the same shapes still pass", () => {
  assert.deepEqual(rules(seat("Villager", [vote("p2", "p3")]), "bea jumped on cal"), []);
  assert.deepEqual(rules(seat("Villager", [vote("p2", "p3")]), "cal with 1 vote"), []);
  assert.deepEqual(rules(seat("Villager", [vote("p2", "p3")]), "1 vote is on cal"), []);
  assert.deepEqual(rules(seat("Villager", [...dies("p4", "Cop")]), "dot showed cop"), []);
  assert.deepEqual(rules(seat("Villager", [...dies("p4", "Cop")]), "dot plays cop"), []);
  assert.deepEqual(rules(seat("Villager"), "i think eli is mafia, vote eli"), []);
  assert.deepEqual(rules(seat("Villager"), "eli has a point"), []);
});
