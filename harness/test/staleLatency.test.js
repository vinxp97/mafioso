// stale-latency 10/19: latency breakdown of the live stale rejects, the --sim-latency self-play mode, and the
// off-by-default staleFix variants (recheck, cancel, fallback). Fake names; no model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll } from "mafioso-engine";
import { paceSpeech, createLlmLimiter, staleFixOf } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { loadLatency, createSimLatencyComplete } from "../src/simLatency.js";
import { parseLog, breakdown } from "../scripts/stale-latency.mjs";
import { runSelfplay } from "../src/selfplay.js";

const players = { me: { id: "me", name: "Fin" }, x: { id: "x", name: "Cora" }, y: { id: "y", name: "Bea" } };
const dayView = () => reduceAll([
  { event: "self", data: "me" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "me", role: "Villager" } },
  { event: "state", data: { id: 2, name: "Day 1" } },
  { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["x", "y", "*"], votes: {} } },
  { event: "message", data: { meetingId: "vil", senderId: "x", t: 1_000, content: "who is sus" } },
]);
const line = { event: "speak", data: { meetingId: "vil", content: "bea why that read" } };

test("staleFix is off by default; recheck sends a late reply that is still valid, and still drops an invalid one", () => {
  assert.deepEqual(staleFixOf({}), { recheck: false, cancel: false, fallbackMs: 0 });
  const view = dayView();
  const off = { config: {}, spokeAt: {}, proposed: [] };
  assert.match(paceSpeech(off, "A", view, line, 40_000, { entry: { t: 1_200 }, source: "llm" }).drop || "", /stale reply/);
  let rechecked = 0;
  const on = { config: { staleFix: { recheck: true } }, spokeAt: {}, proposed: [], onStaleRecheck: () => rechecked++ };
  const p = paceSpeech(on, "A", view, line, 40_000, { entry: { t: 1_200 }, source: "llm" });
  assert.equal(p.drop, undefined); assert.equal(p.wait, 0); assert.equal(rechecked, 1);
  const bad = { event: "speak", data: { meetingId: "vil", content: "cora flipped mafia" } };
  assert.match(paceSpeech(on, "A", view, bad, 40_000, { entry: { t: 1_200 }, source: "llm" }).drop || "", /stale reply/);
});

test("the limiter rejects with the isStale reason (cancelled / fallback), plain true stays 'stale'", async () => {
  const lim = createLlmLimiter(1);
  let release; const first = lim.run(() => new Promise((r) => { release = r; }));
  const a = lim.run(async () => "a", { isStale: () => "cancelled" }).catch((e) => e.message);
  const b = lim.run(async () => "b", { isStale: () => true }).catch((e) => e.message);
  const c = lim.run(async () => "c", { isStale: () => false });
  await new Promise((r) => setImmediate(r));
  release("x");
  assert.deepEqual(await Promise.all([first, a, b, c]), ["x", "cancelled", "stale", "c"]);
});

test("--sim-latency: logged service times on the virtual clock, the logged games' rejection rates", async () => {
  const dist = loadLatency("live1018");
  assert.ok(dist.serviceMs.length > 100 && dist.serviceMs.every((x) => x >= 300));
  assert.equal(dist.games.length, 7);
  const clock = createVirtualClock(0);
  let i = 0; const rng = () => [0.5, 0.1, 0.9, 0.3][i++ % 4];
  const view = dayView();
  const { complete, sim } = createSimLatencyComplete(async () => { throw new Error("offline: no model"); }, { clock, rng, dist, viewByName: () => view });
  let out = null; complete({ purpose: "speech", user: "you are Fin. role (secret) Villager" }).then((x) => { out = x; });
  await new Promise((r) => setImmediate(r));
  assert.equal(out, null, "no answer before virtual time passes");
  clock.advance(60_000); await new Promise((r) => setImmediate(r));
  assert.equal(typeof out, "string"); assert.equal(sim.calls, 1);
});

test("stale-latency breakdown: interpolated times, serial service time, a stale reply split into queue and call", () => {
  const log = [
    "chat [Day 1] Village Cora: \"who is sus\" t=1000",
    "send A [Day 1] t=1000000000000 speak m \"x\" source=llm prompt=seed",
    "speech-reject B [Day 1] source=llm reasons=[\"chat-audit: CONTRADICTION flip (bea flip? bea is alive)\"]",
    "send C [Day 1] t=1000000010000 speak m \"y\" source=llm prompt=seed",
    "speech-reject D [Day 1] source=llm reasons=[\"stale reply (31s after the line it answers)\"] line=\"z\"",
    "send E [Day 1] t=1000000040000 vote m p source=rules prompt=seed",
  ].join("\n");
  const { lines } = parseLog(log);
  assert.equal(lines[2].t, 1000000005000);
  const r = breakdown(log).rejects;
  assert.equal(r.length, 1); assert.equal(r[0].kind, "stale reply"); assert.equal(r[0].ageMs, 31_000);
  assert.ok(r[0].callMs > 0 && r[0].queueMs >= 0);
});

test("--sim-latency self-play: deterministic, legal, and the default path is untouched", async () => {
  const a = await runSelfplay({ games: 1, seed: 3, simLatency: "live1018" });
  const b = await runSelfplay({ games: 1, seed: 3, simLatency: "live1018" });
  assert.deepEqual(a.results[0].log, b.results[0].log);
  assert.equal(a.scorecard.illegalActions.total, 0);
  assert.ok(a.results[0].stats.sim.lines.length > 0 && a.results[0].stats.sim.model.calls > 0);
  const plain = await runSelfplay({ games: 1, seed: 3 });
  assert.equal(plain.results[0].stats.sim, undefined);
});

test("--sim-latency: 'model error: …' rejects are counted by kind, and a fallback speaks a template line", async () => {
  const r = await runSelfplay({ games: 3, seed: 4, simLatency: "live1018", staleFix: { fallbackMs: 15000 } });
  assert.equal(r.scorecard.illegalActions.total, 0);
  const rej = {}; let fbLines = 0;
  for (const g of r.results) {
    for (const [k, n] of Object.entries(g.stats.sim.rejects)) rej[k] = (rej[k] || 0) + n;
    fbLines += g.log.filter((l) => /fallback/.test(String(l))).length;
  }
  assert.ok(rej.fallback > 0, "fallback rejects are counted");
  assert.equal(rej.other || 0, 0, `nothing unclassified: ${JSON.stringify(rej)}`);
  assert.ok(rej["model stale"] > 0);
  const c = await runSelfplay({ games: 2, seed: 4, simLatency: "live1018", staleFix: { cancel: true } });
  assert.ok(c.results.some((g) => g.stats.sim.rejects.cancelled > 0));
  assert.equal(c.scorecard.illegalActions.total, 0);
});
