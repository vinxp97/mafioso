// Protocol replay: sanitized fixtures rebuilt from the dev-game logs (see scripts/build-replays.mjs and
// fixtures/replays/manifest.json) go through the real SSE parser, the engine reducer and the live harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyEvent, HANDLED_EVENTS, IGNORED_EVENTS, createSeededRng, reduce, emptyView } from "mafioso-engine";
import { parseSse, replayStream } from "../src/stream.js";
import { createBotTable, drainUpgrades, onGameEntry } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";

const dir = new URL("./fixtures/replays/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
const load = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const toSse = (entries) => [": keepalive", ...entries.map((e) => `event: game\ndata: ${JSON.stringify(e)}`)].join("\n\n") + "\n\n";

test("replay fixtures exist and cover every frame type the dev logs saw", () => {
  assert.ok(manifest.fixtures.length >= 10, `${manifest.fixtures.length} fixtures`);
  const observed = new Set(manifest.fixtures.flatMap((f) => Object.keys(f.observedFrameCounts)));
  for (const f of manifest.fixtures) {
    const types = new Set(load(f.fixture).map((e) => e.event));
    for (const ty of Object.keys(f.observedFrameCounts)) assert.ok(types.has(ty), `${f.fixture} lacks ${ty}`);
  }
  assert.ok(observed.size >= 40, `${observed.size} types observed`);
});

test("every frame parses through the SSE parser and has a known type (handled or ignored with a reason)", () => {
  const unknown = new Map();
  for (const f of manifest.fixtures) {
    const entries = load(f.fixture);
    const frames = parseSse(toSse(entries));
    assert.equal(frames.length, entries.length, f.fixture);
    frames.forEach((fr, i) => { assert.equal(fr.type, "game"); assert.deepEqual(fr.entry, entries[i]); });
    for (const { entry } of frames) {
      const c = classifyEvent(entry.event);
      if (c.kind === "unknown") unknown.set(entry.event, f.fixture);
      if (c.kind === "ignored") assert.ok(c.reason && c.reason.length > 10, `${entry.event} needs a reason`);
    }
  }
  assert.deepEqual([...unknown.keys()], [], `unknown message types: ${[...unknown].map(([k, f]) => `${k} (${f})`).join(", ")}`);
});

test("the reducer folds every fixture: seats know themselves, the players, the phase, and the obituaries' dead", () => {
  for (const f of manifest.fixtures) {
    const entries = load(f.fixture);
    const views = replayStream(entries);
    const accounts = [...new Set(entries.map((e) => e.accountId))];
    assert.equal(Object.keys(views).length, accounts.length, f.fixture);
    const obitDead = new Set(entries.filter((e) => e.event === "obituaries").flatMap((e) => e.data.obituaries.map((o) => o.id)));
    for (const a of accounts) {
      const v = views[a];
      const got = (ev) => entries.some((e) => e.accountId === a && e.event === ev);
      // Some runs attached after the join burst (no self/players frames): exactly what the logs saw.
      if (got("self")) assert.ok(v.selfId, `${f.fixture} ${a} selfId`);
      if (got("players")) assert.ok(Object.keys(v.players).length >= f.seats, `${f.fixture} ${a} players`);
      if (got("state")) assert.ok(v.phase?.name, `${f.fixture} ${a} phase`);
      if (got("winners")) assert.equal(v.finished, true, `${f.fixture} ${a} finished`);
      if (entries.some((e) => e.accountId === a && e.event === "start")) assert.equal(v.started, true, `${f.fixture} ${a} started`);
      for (const id of obitDead) if (entries.some((e) => e.accountId === a && e.event === "obituaries" && e.data.obituaries.some((o) => o.id === id))) assert.equal(v.dead[id], true, `${f.fixture} ${a} knows ${id} died`);
    }
  }
});

test("the live harness replays every fixture with no seat errors, legal proposals only, and the same result twice", async () => {
  const run = async (f) => {
    const entries = load(f.fixture);
    const accounts = [...new Set(entries.map((e) => e.accountId))].map((accountId) => ({ accountId }));
    const table = createBotTable(accounts, { clock: createVirtualClock(1_800_000_000_000), rng: createSeededRng(42) });
    const errors = [];
    for (const e of entries) await onGameEntry(table, e, { dryRun: true, fast: true, onError: (err, who) => errors.push(`${who}: ${err?.message || err}`) });
    await drainUpgrades(table);
    return { table, errors };
  };
  for (const f of manifest.fixtures) {
    const a = await run(f);
    assert.deepEqual(a.errors, [], f.fixture);
    for (const p of a.table.proposed) {
      assert.ok(p.event === "vote" || p.event === "speak", `${f.fixture}: ${p.event}`);
      assert.ok(typeof p.data?.meetingId === "string", `${f.fixture}: meeting`);
    }
    const b = await run(f);
    const key = (t) => t.proposed.map((p) => [p.accountId, p.event, p.data.meetingId, p.data.selection ?? p.data.content]);
    assert.deepEqual(key(b.table), key(a.table), `${f.fixture} is deterministic`);
  }
});

test("HANDLED_EVENTS lists exactly the reducer's switch cases; nothing is both handled and ignored", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../../engine/src/reducer.js", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("switch (event) {"), src.indexOf("default: break;"));
  const cases = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(cases)].sort(), [...HANDLED_EVENTS].sort());
  for (const k of Object.keys(IGNORED_EVENTS)) assert.ok(!HANDLED_EVENTS.includes(k), k);
  assert.equal(classifyEvent("somethingNew").kind, "unknown");
});

test("newly handled frames: members, obituaries, youAreBeingVoteKicked, start/isStarted, isSpectator", () => {
  let v = reduce(emptyView(), { event: "self", data: "p1" });
  v = reduce(v, { event: "state", data: { id: 1, name: "Day 1" } });
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", voting: true, targets: ["p1", "p2"], members: [{ id: "p1" }] } });
  v = reduce(v, { event: "members", data: { meetingId: "vil", members: [{ id: "p1", canVote: true }, { id: "p9", canVote: true }] } });
  assert.deepEqual(v.meetings.vil.members.map((m) => m.id), ["p1", "p9"]);
  assert.ok(v.players.p9, "a member is a seated player");
  v = reduce(v, { event: "obituaries", data: { id: "1:Night", obituaries: [{ id: "p2", playerInfo: { id: "p2" } }], source: "Night" } });
  assert.equal(v.dead.p2, true);
  v = reduce(v, { event: "youAreBeingVoteKicked", data: { status: true } });
  assert.equal(v.voteKickWarning, true);
  v = reduce(v, { event: "youAreBeingVoteKicked", data: { status: false } });
  assert.equal(v.voteKickWarning, false);
  assert.equal(reduce(emptyView(), { event: "isStarted", data: false }).started, false);
  assert.equal(reduce(emptyView(), { event: "start" }).started, true);
  assert.equal(reduce(emptyView(), { event: "isSpectator" }).spectator, true);
  // A roleReveal no longer falls through into the meeting case.
  const r = reduce(v, { event: "roleReveal", data: { playerId: "p1", role: "Cop", id: "x", targets: ["zz"] } });
  assert.equal(r.meetings.x, undefined);
  assert.equal(r.players.zz, undefined);
});
