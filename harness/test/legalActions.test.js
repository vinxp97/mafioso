// legalActions over g01-g16, seat by seat. (1) Every vote the server accepted (a seat's own vote frame) is in
// the server-legal set of the seat's view just before it; the exceptions are pinned with their cause. (2) At every
// decision point (a seat with an open vote) every vote the bots pick is server-legal and passes Vinman's rules:
// rules decide, rulesSeatActions (scum plans and the kill fallback), the rule bot, the selector over every
// server option (rule-refused and advised ones included), and llmDecide with a model that asks for each option.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reduce, emptyView, serverAccepts, meetingActions } from "mafioso-engine";
import { picks } from "./legalPicks.helper.js";

const dir = new URL("./fixtures/replays/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
const load = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Accepted by the server, not in the fixture view's server-legal set: none since the builder offers every recorded
// option (g02 used to offer only "*" when its votes mixed "*" and players). fixture, phase, role, meeting, selection, cause.
const KNOWN = [];
// Votes legal in the fixture view that the real server would not have taken: g05 is an untagged log whose phases
// were guessed, so Village ballots were filed as Night 1's Mafia Kill, cast by Villager seats.
const GUESS = "fixture gap: untagged log, phase and meeting guessed (day votes filed as Night 1's kill)";
const MISFILED = [["g05.jsonl", "Night 1", "Villager", "Mafia Kill", GUESS]];

function accepted(entries) {
  const views = {}; let n = 0; const miss = []; const misfiled = [];
  for (const e of entries) {
    const before = views[e.accountId] || emptyView();
    if (e.event === "vote" && e.data?.voterId && e.data.voterId === before.selfId) {
      n += 1;
      if (!serverAccepts(before, { event: "vote", data: { meetingId: e.data.meetingId, selection: e.data.target } })) {
        miss.push([before.phase?.name, before.role, before.meetings?.[e.data.meetingId]?.name, e.data.target]);
      }
      const m = before.meetings?.[e.data.meetingId];
      if (m && meetingActions(before, m).kind === "kill" && !/mafioso|janitor|lawyer/i.test(String(before.role))) misfiled.push([before.phase?.name, before.role, m.name]);
    }
    views[e.accountId] = reduce(before, e);
  }
  return { n, miss, misfiled };
}

test("every vote the server accepted in g01-g16 is server-legal in the voter's view, except the pinned fixture gaps", () => {
  let n = 0; const got = []; const wrong = new Set();
  for (const f of manifest.fixtures) {
    const r = accepted(load(f.fixture));
    n += r.n;
    for (const m of r.miss) if (!got.some((g) => JSON.stringify(g) === JSON.stringify([f.fixture, ...m]))) got.push([f.fixture, ...m]);
    for (const m of r.misfiled) wrong.add(JSON.stringify([f.fixture, ...m]));
  }
  assert.deepEqual(got, KNOWN.map((k) => k.slice(0, 5)));
  assert.deepEqual([...wrong].map((w) => JSON.parse(w)), MISFILED.map((k) => k.slice(0, 4)), "kill votes by town seats only where the fixture guessed the phase");
  assert.ok(n >= 150, `${n} accepted votes checked`);
});

test("at every decision point in g01-g16, every bot pick is server-legal and passes the rules", async () => {
  let points = 0; let checked = 0; const bad = [];
  for (const f of manifest.fixtures) {
    const r = await picks(load(f.fixture));
    points += r.points; checked += r.checked;
    bad.push(...r.bad.map((b) => `${f.fixture} ${b}`));
  }
  assert.deepEqual(bad, []);
  assert.ok(points >= 1000 && checked >= 5000, `${points} decision points, ${checked} picks`);
});
