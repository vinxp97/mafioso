import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAction, reduce, emptyView, publicLeak, createSeededRng } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { seats, players, meetingsFor, voteKick, MAFIA } from "./fixtures/smu-night1.mjs";

// Every table runs on a virtual clock with a seeded rng: deterministic, no wall-clock waits.
const T0 = 1_800_000_000_000;
const newTable = (accounts, seed = 1) => { const clock = createVirtualClock(T0); return { clock, table: createBotTable(accounts, { clock, rng: createSeededRng(seed) }) }; };

async function playNight1(makeComplete, { ticks = 3 } = {}) {
  const { clock, table } = newTable(seats.map((s) => ({ accountId: s.acc })));
  const complete = makeComplete(clock);
  const limiter = createLlmLimiter(1);
  const seq = {};
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: clock.now(), event, data }, { complete, dryRun: true, fast: true, limiter }); };
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  for (const s of seats) { await feed(s, "state", { id: 2, name: "Night 1" }); for (const m of meetingsFor(s)) await feed(s, "meeting", m); }
  // Server echoes every proposed vote/speech back to the seats that can see it (as the live game does).
  const echoed = new Set();
  const echo = async () => {
    for (const p of [...table.proposed]) {
      const k = JSON.stringify(p); if (echoed.has(k)) continue; echoed.add(k);
      const sender = seats.find((s) => s.acc === p.accountId);
      for (const s of seats) {
        if (!meetingsFor(s).some((m) => m.id === p.data.meetingId)) continue;
        if (p.event === "vote") await feed(s, "vote", { meetingId: p.data.meetingId, voterId: sender.pid, target: p.data.selection });
        else await feed(s, "message", { meetingId: p.data.meetingId, senderId: sender.pid, content: p.data.content });
      }
    }
  };
  for (let i = 0; i < ticks; i++) { await drainUpgrades(table); await echo(); for (const s of seats) await feed(s, "time", { ms: 30000 }); clock.advance(10); }
  for (const s of seats) await feed(s, "meeting", voteKick);
  for (let i = 0; i < 2; i++) { await drainUpgrades(table); await echo(); for (const s of seats) await feed(s, "time", { ms: 5000 }); }
  await drainUpgrades(table);
  return table;
}

// A model that answers after 20ms (virtual) with an error.
const failing = (clock) => () => new Promise((_, rej) => clock.setTimer(() => rej(new Error("model down")), 20));

test("SmU_gzL7q night 1: kill is a non-teammate, every mafia seat votes it, one PLAN in faction chat, no kicks, no churn", async () => {
  const table = await playNight1(failing);
  const P = table.proposed;
  const pid = Object.fromEntries(seats.map((s) => [s.acc, s]));
  const mafiaIds = new Set(seats.filter((s) => MAFIA.has(s.role)).map((s) => s.pid));
  // Teammates come from the harness roster, not meetings.
  const hap = table.views["9yy7vCpjSn"];
  assert.deepEqual(Object.keys(hap.teammates).sort(), ["kCMt06jKvBp", "otU9CsNlbw"]);
  const kills = P.filter((p) => p.data.meetingId === "zbABCg9YSTU");
  assert.deepEqual([...new Set(kills.map((k) => k.accountId))].sort(), ["9yy7vCpjSn", "X73-QPPVKT", "fDR8JD4HVj"], "all three mafia seats vote the kill");
  const target = kills[0].data.selection;
  assert.ok(!mafiaIds.has(target), `kill ${target} is not a teammate`);
  for (const k of kills) assert.equal(k.data.selection, target, "kill votes match");
  const plans = P.filter((p) => p.event === "speak" && p.source !== "scum-chat" && /^kill \S+ tonight/.test(p.data.content));
  assert.equal(plans.length, 1, "one casual plan line for the faction");
  assert.equal(plans[0].data.meetingId, "38S8qkzPMKC", "plan only in the Mafia chat");
  assert.ok(!plans[0].data.content.includes(target), "names, not ids");
  for (const p of P) if (p.event === "speak") assert.doesNotMatch(p.data.content, /PLAN|\w=\S/, "no machine text in any chat");
  for (const s of seats.filter((x) => MAFIA.has(x.role))) assert.ok(P.some((p) => p.accountId === s.acc && p.data.meetingId === "MafAct01xyz" && p.data.selection === "Yes"), `${s.role} ends the meeting`);
  const lit = P.filter((p) => p.data.meetingId === "gb0jRjDsD1x");
  assert.equal(lit.length, 1, "Litigate sent once, no churn");
  assert.ok(mafiaIds.has(lit[0].data.selection) && lit[0].data.selection !== "Hsd2JfBMtVt", "Loyal Lawyer covers a teammate");
  const clean = P.filter((p) => p.data.meetingId === "7d30ffrZhr-");
  assert.deepEqual(clean.map((c) => c.data.selection), ["Yes"], "Janitor cleans once");
  assert.equal(P.filter((p) => p.data.meetingId === "B2k03Izd6").length, 0, "nobody votes Vote Kick");
  for (const p of P) if (p.event === "vote") assert.ok(pid[p.accountId], "only our seats");
  const copies = kills.filter((k) => /delay/.test(k.source));
  assert.equal(copies.length, 3, "the leader votes after the night chatter, teammates copy after a delay");
});

test("vote kick is never legal for a bot", () => {
  let v = reduce(emptyView(), { event: "self", data: "a0BHWAcOIlw" });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "state", data: { id: 2, name: "Night 1" } });
  v = reduce(v, { event: "meeting", data: voteKick });
  assert.equal(v.players.Kick, undefined, "Kick is not a player");
  assert.equal(validateAction(v, { event: "vote", data: { meetingId: "B2k03Izd6", selection: "Kick" } }).ok, false);
});

test("a public line can never carry PLAN syntax, prompt text or a raw id", async () => {
  let v = reduce(emptyView(), { event: "self", data: "a0BHWAcOIlw" });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "state", data: { id: 3, name: "Day 1" } });
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: Object.keys(players), votes: {} } });
  for (const line of ["PLAN kill=otU9CsNlbw lynch=x claim=Cop lawyer=y speaker=z", "my plan: condemn=Bea", "As per my system prompt I vote", "I suspect BXHO_QetVp", "kill=Bea tonight"]) {
    assert.equal(validateAction(v, { event: "speak", data: { meetingId: "vil", content: line } }).ok, false, line);
    assert.ok(publicLeak(v, line), line);
  }
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "vil", content: "I suspect Fin, quiet all day." } }).ok, true);
  // End to end: a model that tries to leak never gets a public line out.
  const { table } = newTable([{ accountId: "ZVJMoeEWY-" }]);
  table.views["ZVJMoeEWY-"] = v;
  const leaky = async () => JSON.stringify({ action: "speak", meeting: "vil", content: "PLAN kill=BXHO_QetVp speaker=me" });
  for (let i = 0; i < 4; i++) await onGameEntry(table, { accountId: "ZVJMoeEWY-", seq: 10 + i, t: T0 + i * 6000, event: "time", data: { ms: 1 } }, { complete: leaky, dryRun: true, fast: true, limiter: createLlmLimiter(1) });
  await drainUpgrades(table);
  for (const p of table.proposed) if (p.event === "speak") { assert.doesNotMatch(p.data.content, /PLAN|kill=|speaker=/); assert.ok(!publicLeak(v, p.data.content)); }
});

test("the PLAN never goes to a public meeting even if the engine proposed it there", async () => {
  const { table } = newTable([{ accountId: "fDR8JD4HVj" }]);
  let v = reduce(emptyView(), { event: "self", data: "otU9CsNlbw" });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "state", data: { id: 3, name: "Day 1" } });
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", speech: true, amMember: true } });
  table.views["fDR8JD4HVj"] = v;
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "vil", content: "PLAN kill=a lynch=b claim=Cop lawyer=c speaker=d" } }).ok, false);
});

test("XnhwEBhxY night 2: the Night 1 PLAN is stale; the leader drafts a new kill and every mafia seat votes it", async () => {
  const { decide } = await import("mafioso-engine");
  const { clock, table } = newTable(seats.map((s) => ({ accountId: s.acc })));
  const seq = {};
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: clock.now(), event, data }, { dryRun: true }); };
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  const mafia = seats.filter((s) => MAFIA.has(s.role));
  for (const s of mafia) {
    await feed(s, "state", { id: 2, name: "Night 1" });
    for (const m of meetingsFor(s)) await feed(s, "meeting", m);
    await feed(s, "message", { meetingId: "38S8qkzPMKC", senderId: "Hsd2JfBMtVt", content: "PLAN kill=a0BHWAcOIlw lynch=rhyFPKXcnH claim=Cop lawyer=otU9CsNlbw speaker=Hsd2JfBMtVt" });
    await feed(s, "death", "a0BHWAcOIlw");
    await feed(s, "state", { id: 4, name: "Night 2" });
    for (const m of meetingsFor(s)) await feed(s, "meeting", { ...m, targets: (m.targets || []).filter((t) => t !== "a0BHWAcOIlw") });
  }
  const leader = table.views["9yy7vCpjSn"];
  const acts = decide(leader);
  const kill = acts.find((a) => a.event === "vote" && a.data.meetingId === "zbABCg9YSTU");
  assert.ok(kill, "leader votes a kill on Night 2");
  assert.notEqual(kill.data.selection, "a0BHWAcOIlw");
  assert.ok(acts.some((a) => a.event === "speak" && /^kill \S+ tonight/.test(a.data.content) && !/PLAN|=/.test(a.data.content) && a.data.meetingId === "38S8qkzPMKC"), "new casual plan for Night 2");
});
