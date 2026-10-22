// The --plant-audit control's own labels (audit-fp 10/19): a planted "leak" must have no public source, and a
// planted clean fake claim must not be a real scum mistake. Seed-4 cases, names as in self-play.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll } from "mafioso-engine";
import { plantLines } from "../src/auditPlant.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const ids = names.map((_, i) => `p${i + 1}`);
function setup(roles, self, lines) {
  const S = { ids, names: Object.fromEntries(ids.map((id, i) => [id, names[i]])), roles: Object.fromEntries(ids.map((id, i) => [id, roles[i]])), alive: new Set(ids), meetings: new Map() };
  const view = reduceAll([
    { event: "self", data: self }, { event: "players", data: Object.fromEntries(ids.map((id, i) => [id, { id, name: names[i] }])) },
    { event: "roleReveal", data: { playerId: self, role: S.roles[self] } },
    { event: "state", data: { id: 2, name: "Day 1" } },
    { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ids, votes: {} } },
    ...lines.map(([from, content]) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } })),
  ]);
  return { S, view };
}
const seq = (n) => { let i = 0; return () => ((i++ * 0.37) % 1); };

test("town-unflipped-role: a seat that claimed vt is not a planted leak target", () => {
  // Bea (Journalist) speaking; only Dot (Villager) is a candidate, and Dot said "im vt".
  const roles = ["Cop", "Journalist", "Sheriff", "Villager", "Villager", "Lawyer", "Mafioso", "Janitor", "Villager"];
  const { S, view } = setup(roles, "p2", [["p4", "im vt. check my votes, theyre clean"], ["p5", "im a villager"], ["p9", "just a townie, im vt"],
    ["p1", "im cop"], ["p3", "im sheriff"], ["p6", "im lawyer"], ["p7", "im mafioso"], ["p8", "im janitor"]]);
  for (let k = 0; k < 20; k++) assert.equal(plantLines(S, "p2", view, seq(k)).find((p) => p.cat === "town-unflipped-role"), undefined);
  const open = setup(roles, "p2", []);
  for (const held of [false, "held", "held2"]) assert.ok(plantLines(open.S, "p2", open.view, seq(1), { held }).some((p) => p.cat === "town-unflipped-role"));
});

test("fake-claim: the clean scum fake claim never targets the Sheriff claimer", () => {
  const roles = ["Sheriff", "Cop", "Villager", "Journalist", "Mafioso", "Janitor", "Villager", "Lawyer", "Villager"];
  const { S, view } = setup(roles, "p6", [["p1", "im sheriff"]]);
  for (const held of [false, "held", "held2"]) for (let k = 0; k < 30; k++) {
    const rng = (() => { let i = k; return () => ((i++ * 0.618) % 1); })();
    const fc = plantLines(S, "p6", view, rng, { held }).find((p) => p.cat === "fake-claim");
    assert.ok(fc && !/\bash\b/.test(fc.text), fc?.text);
  }
});
