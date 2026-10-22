// Night 5 eval (harness/src/night5Eval.js) on a small synthetic log in the live.mjs format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLog, parseLiveLog, reasonKey, summarize } from "../src/night5Eval.js";

const T = 1_800_000_000_000;
const LOG = [
  "game G1 accounts=A,B,C,D,E",
  'seatmap s1=pA:"Sher" s2=pB:"Copper" s3=pC:"Mafo" s4=pD:"Vee" s5=pE:"Jani"',
  'meeting A [Night 1] n1 name="Village" role=- vote=false canVote=true targets=5',
  'meeting C [Night 1] mk name="Mafia Kill" role=kill vote=true canVote=true targets=3',
  'meeting E [Night 1] mk name="Mafia Kill" role=kill vote=true canVote=true targets=3',
  'meeting E [Night 1] cd name="Clean Death" role=- vote=true canVote=true targets=3',
  `send C [Night 1] t=${T} vote mk pD source=rules prompt=seed`,
  'meeting A [Day 1] vil name="Village" role=- vote=true canVote=true targets=5',
  'meeting A [Day 1] gun name="Shoot Gun" role=- vote=true canVote=true targets=4',
  'alert B [Day 1] kind=cop target="Mafo" result="Mafia"',
  `sheriff-claim-delay A [Day 1] ms=4200 due=${T + 10_000 + 4200}`,
  `send A [Day 1] t=${T + 14_200} speak vil "im sheriff" source=claim-rule prompt=seed`,
  `chat [Day 1] Village Sher: "im sheriff" t=${T + 14_400}`,
  `send B [Day 1] t=${T + 16_000} speak vil "im cop. Mafo guilty" source=claim-rule prompt=seed`,
  `send A [Day 1] t=${T + 40_000} speak vil "Vee claim?" source=claim-rule prompt=seed`,
  `send D [Day 1] t=${T + 45_000} speak vil "Sher im villager" source=claim-rule prompt=seed`,
  `chat [Day 1] Village Human1: "vee is fine i think" t=${T + 47_000}`,
  `speech-reject B [Day 1] source=llm reasons=["chat-audit: CONTRADICTION dead-sus (calls x sus, who is dead)"] line="x is sus"`,
  `speech-reject B [Day 1] source=llm reasons=["held line invalid at send: chat-audit: CONTRADICTION dead-sus (calls y)"] line="y is sus"`,
  `speech-reject C [Day 1] source=llm reasons=["stale reply (41s after the line it answers)"] line="hmm"`,
  `send C [Day 1] t=${T + 52_000} speak vil "Vee seems town to me" source=llm prompt=seed`,
  `send B [Day 1] t=${T + 53_000} speak vil "results: Mafo guilty" source=llm prompt=seed`,
  `send A [Day 1] t=${T + 75_000} vote gun pC source=rules prompt=seed`,
  `send A [Day 1] t=${T + 76_000} speak vil "Copper claim?" source=claim-rule prompt=seed`,
  `send B [Day 1] t=${T + 78_000} speak vil "im the real cop" source=claim-rule prompt=seed`,
  `send E [Day 1] t=${T + 82_500} speak vil "Copper is lying, im the real cop" source=claim-rule+paced prompt=seed`,
  `send D [Day 1] t=${T + 90_000} speak vil "im vt btw" source=llm prompt=seed`,
  "game_end status=finished game=G1 winner=Village",
].join("\n");

test("parses the live log: seats, roles, sends, rejects, the logged Sheriff delay", () => {
  const L = parseLiveLog(LOG);
  assert.equal(L.game, "G1");
  assert.equal(L.seats.B.name, "Copper");
  assert.equal(L.sends.filter((s) => s.event === "speak").length, 10);
  assert.equal(L.delays[0].ms, 4200);
  assert.equal(reasonKey("held line invalid at send: chat-audit: CONTRADICTION dead-sus (calls y)"), "chat-audit: CONTRADICTION dead-sus");
});

test("computes speech success, reject reasons, timing and the five rule checks", () => {
  const r = evaluateLog(LOG);
  assert.equal(r.speech.llmSent, 3);
  assert.equal(r.speech.llmAttempts, 6);
  assert.equal(r.speech.llmSuccessPct, 50);
  assert.equal(r.speech.chatAuditByRule["CONTRADICTION dead-sus"], 2);
  assert.equal(r.timing.sheriffClaim.ms, 4200);
  assert.equal(r.timing.sheriffClaim.exact, true);
  assert.equal(r.rules.r4_sheriffDelay.ok, true);
  // Rule 1: Vee answered villager at +45s, the gun went to Mafo (another target).
  assert.deepEqual(r.rules.r1_sheriffVsVillager.cases.map((c) => [c.target, c.shot, c.ok]), [["Vee", "Mafo", true]]);
  // Rule 2: Copper's Cop answer got one mafia CC (Jani) 4.5s later.
  const cc = r.rules.r2_mafiaCounterclaim.cases[0];
  assert.equal(cc.mafiaCCs.length, 1);
  assert.equal(cc.mafiaCCs[0].delayMs, 4_500);
  assert.equal(r.rules.r2_mafiaCounterclaim.ok, true);
  // Rule 3: Copper said three Cop lines on Day 1 (claim, results:, the answer): a failure.
  assert.equal(r.rules.r3_copOneLine.ok, false);
  assert.equal(r.rules.r3_copOneLine.cases.find((c) => c.who === "Copper").lines.length, 3);
  // Rule 5: one vt line went out.
  assert.equal(r.rules.r5_noVt.sent.length, 1);
  assert.equal(r.humanLines, 1);
  assert.match(summarize(r), /LLM 3\/6 sent \(50%\)/);
});
