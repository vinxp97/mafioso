// Vinman: the Janitor never saves the clean on Night 1; it always cleans the N1 kill. Later nights unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, decide, llmDecide, selectAction, planViolation, agreedPlan } from "../src/index.js";

const names = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo"];
const players = Object.fromEntries(names.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const TEAM = { p1: "Mafioso", p2: "Janitor", p3: "Lawyer" };

/** The Janitor (p2) on a night, with the live Yes/No Clean Death meeting. */
function janitor({ phase = "Night 1", mafia = "adaptive", sid = 5, chat = [] } = {}) {
  return reduceAll([
    { event: "self", data: "p2" },
    { event: "players", data: players },
    { event: "botConfig", data: { mafia } },
    ...Object.entries(TEAM).map(([id, role]) => ({ event: "roleReveal", data: { playerId: id, role } })),
    { event: "state", data: { id: sid, name: phase } },
    { event: "meeting", data: { id: "maf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, targets: ids.filter((i) => !TEAM[i]), votes: {}, members: Object.keys(TEAM).map((id) => ({ id })) } },
    { event: "meeting", data: { id: "jan", name: "Clean Death", voting: true, canVote: true, amMember: true, targets: ["Yes", "No"], votes: {} } },
    ...chat.map((content) => ({ event: "message", data: { meetingId: "maf", senderId: "p1", content } })),
  ]);
}
const clean = (v) => decide(v).find((a) => a.event === "vote" && a.data.meetingId === "jan")?.data.selection;
const SAVE = "kill dot tonight, no fake claims tmrw, lay low, save the clean";

test("adaptive Janitor cleans on Night 1 whatever the draft, but may still save it on Night 2", () => {
  const n2 = new Set();
  for (let sid = 1; sid <= 20; sid++) {
    assert.equal(clean(janitor({ sid })), "Yes", `N1 sid ${sid}`);
    n2.add(clean(janitor({ sid, phase: "Night 2" })));
  }
  assert.ok(n2.has("No"), "Night 2 save logic unchanged");
});

test("a teammate's 'save the clean' on Night 1 is overridden in both modes; on Night 2 adaptive still saves", () => {
  for (const mafia of ["adaptive", "script"]) {
    const v = janitor({ mafia, chat: [SAVE] });
    assert.equal(agreedPlan(v).janitorTarget, "p4", mafia);
    assert.equal(clean(v), "Yes", mafia);
  }
  assert.equal(clean(janitor({ phase: "Night 2", chat: [SAVE] })), "No");
});

test("live paths: LLM and candidate selector cannot skip the Night 1 clean, plan or no plan", async () => {
  const no = { event: "vote", data: { meetingId: "jan", selection: "No" } };
  for (const chat of [[], [SAVE]]) {
    const v = janitor({ chat });
    assert.equal(planViolation(v, no), "janitor always cleans on night 1");
    const out = await llmDecide(v, { complete: async () => '{"action":"vote","meeting":"jan","target":"No"}', maxRetries: 0 });
    assert.equal(out.actions.find((a) => a.data?.meetingId === "jan")?.data.selection, "Yes");
    assert.equal(out.actions.some((a) => a.data?.selection === "No"), false);
  }
  const picked = selectAction(janitor({ chat: [SAVE] }), [
    { kind: "night-target", decisionId: "night:jan", meetingId: "jan", target: "No", reason: "save" },
    { kind: "night-target", decisionId: "night:jan", meetingId: "jan", target: "Yes", reason: "clean" },
  ], { seed: 1 });
  assert.equal(picked.actions[0].data.selection, "Yes");
  assert.equal(planViolation(janitor({ phase: "Night 2", chat: [SAVE] }), no), null);
});
