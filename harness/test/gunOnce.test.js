// Night 5 gun fix (config.gunOnce, off by default): once the Sheriff's shot has gone out, no second gun vote.
// L6 with the Vote Kick replayed: the gun net and the rules path both shot within 0.2s; the server refuses the
// second ("instant meeting already used"). The default keeps that behavior; the flag stops the second vote.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tableFacts, soloReplay, scoreSolo } from "../src/soloEval.js";
import { createBotTable } from "../src/live.js";

const E = fs.readFileSync(new URL("./fixtures/solo-timeline/l06.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const facts = tableFacts(E);
const sheriff = Object.keys(facts.pidOf).find((a) => facts.roles[facts.pidOf[a]] === "Sheriff");
const gunVotes = (run) => run.proposals.filter((p) => p.event === "vote" && /shoot gun/i.test(facts.meetings[p.data.meetingId] || ""));

test("gunOnce: off by default (no config key unless \"on\")", () => {
  assert.ok(!("gunOnce" in createBotTable([{ accountId: "a" }]).config));
  assert.ok(!("gunOnce" in createBotTable([{ accountId: "a" }], { gunOnce: "off" }).config));
  assert.equal(createBotTable([{ accountId: "a" }], { gunOnce: "on" }).config.gunOnce, "on");
});

test("gunOnce: L6 (Vote Kick kept), the Sheriff's gun votes once; the default still double-votes", async () => {
  const off = await soloReplay(E, sheriff, { seed: 7, facts, voteKick: "keep" });
  assert.equal(gunVotes(off).length, 2, "default: the gun votes again after it fired (kept as is)");
  assert.equal(scoreSolo(E, off, facts).illegal.length, 1);
  assert.equal(off.table.gunSends.length, 2);
  const on = await soloReplay(E, sheriff, { seed: 7, facts, voteKick: "keep", config: { gunOnce: "on" } });
  const shots = gunVotes(on);
  assert.equal(shots.length, 1, `gunOnce: one gun vote, got ${JSON.stringify(shots.map((p) => [p.source, p.data.selection]))}`);
  assert.equal(shots[0].data.selection, gunVotes(off)[0].data.selection, "the shot that goes out is the first one");
  assert.deepEqual(scoreSolo(E, on, facts).illegal, []);
});

test("gunOnce: without the Vote Kick nothing changes (one shot either way)", async () => {
  const a = await soloReplay(E, sheriff, { seed: 7, facts });
  const b = await soloReplay(E, sheriff, { seed: 7, facts, config: { gunOnce: "on" } });
  assert.equal(gunVotes(a).length, 1);
  assert.deepEqual(gunVotes(b).map((p) => [p.t, p.data.selection]), gunVotes(a).map((p) => [p.t, p.data.selection]));
});
