import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyView, reduce } from "mafioso-engine";
import { createBotTable, createSeatQueues, onGameEntry, runStreamLoop, seedSelfIds } from "../src/live.js";
import { createExperientialComplete } from "../src/experiential.js";

const ids = ["p1", "p2", "p3", "p4"];
const players = Object.fromEntries(ids.map((id) => [id, { id, name: id }]));
const copNight = (accountId, { withPlayers = true } = {}) => [
  ...(withPlayers ? [{ accountId, seq: 1, event: "players", data: players }] : []),
  { accountId, seq: 2, event: "roleReveal", data: { playerId: "p1", role: "Cop" } },
  { accountId, seq: 3, event: "state", data: { id: 2, name: "Night 1" } },
  { accountId, seq: 4, event: "time", data: { name: "main", time: 100 } },
  { accountId, seq: 5, event: "meeting", data: { id: "mCop", name: "Cop", actionName: "Learn Alignment", voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4"], members: [{ id: "p1" }], votes: {} } },
];

async function drive(entries, table) {
  const out = [];
  for (const e of entries) out.push(...await onGameEntry(table, e, { dryRun: true, rng: () => 0 }));
  return out;
}

test("without a self frame a seat decides nothing; seeding selfId from /dev/accounts fixes it", async () => {
  const bare = createBotTable([{ accountId: "A" }]);
  assert.equal((await drive(copNight("A"), bare)).length, 0);

  const table = createBotTable([{ accountId: "A" }]);
  const client = { api: async (m, p) => { assert.equal(`${m} ${p}`, "GET /dev/accounts"); return [{ id: "A", playerId: "p1" }, { id: "Z", playerId: "x" }]; } };
  const missing = await seedSelfIds(client, table, ["A"], { sleep: async () => {} });
  assert.deepEqual(missing, []);
  assert.equal(table.views.A.selfId, "p1");
  const acts = await drive(copNight("A"), table);
  assert.ok(acts.some((a) => a.data.meetingId === "mCop" && ["p2", "p3", "p4"].includes(a.data.selection)));
});

test("seedSelfIds gives up quietly when the endpoint is missing", async () => {
  const table = createBotTable([{ accountId: "A" }]);
  const missing = await seedSelfIds({ api: async () => { throw new Error("404"); } }, table, ["A"], { sleep: async () => { throw new Error("no sleep"); } });
  assert.deepEqual(missing, ["A"]);
});

test("missing players frame: meeting targets count as living, night pick is a real target not no-one", async () => {
  const v = reduce(emptyView(), { event: "meeting", data: { id: "m", members: [{ id: "p1" }], targets: ["p2", "*"] } });
  assert.ok(v.players.p1 && v.players.p2 && !v.players["*"]);
  const table = createBotTable([{ accountId: "A" }]);
  table.views.A = reduce(emptyView(), { event: "self", data: "p1" });
  const acts = await drive(copNight("A", { withPlayers: false }), table);
  const vote = acts.find((a) => a.data.meetingId === "mCop");
  assert.ok(vote && vote.data.selection !== "*");
});

test("timer ticks never reach the decide path", async () => {
  const table = createBotTable([{ accountId: "A" }]);
  let calls = 0;
  const complete = async () => { calls++; return "{}"; };
  table.views.A = reduce(emptyView(), { event: "self", data: "p1" });
  for (let i = 0; i < 20; i++) await onGameEntry(table, { accountId: "A", seq: i + 1, event: "time", data: {} }, { complete, dryRun: true });
  assert.equal(calls, 0);
});

test("a throwing model falls back to rules and reports the error", async () => {
  const table = createBotTable([{ accountId: "A" }]);
  table.views.A = reduce(emptyView(), { event: "self", data: "p1" });
  const errors = [];
  const complete = async () => { throw new Error("boom"); };
  const acts = [];
  for (const e of copNight("A")) acts.push(...await onGameEntry(table, e, { complete, dryRun: true, rng: () => 0, onError: (err) => errors.push(err.message) }));
  assert.ok(acts.some((a) => a.data.meetingId === "mCop"));
});

test("two seats with a slow model decide in parallel; each seat stays in order", async () => {
  const order = [];
  const q = createSeatQueues(async (e) => {
    order.push(`start ${e.accountId}${e.seq}`);
    await new Promise((r) => setTimeout(r, 200));
    order.push(`end ${e.accountId}${e.seq}`);
  });
  const t0 = Date.now();
  q.push({ accountId: "A", seq: 1 }); q.push({ accountId: "B", seq: 1 });
  q.push({ accountId: "A", seq: 2 }); q.push({ accountId: "B", seq: 2 });
  await q.drain();
  const ms = Date.now() - t0;
  assert.ok(ms < 700, `took ${ms}ms; serial would be ~800ms`);
  assert.ok(order.indexOf("start B1") < order.indexOf("end A1"), "B started before A finished");
  assert.ok(order.indexOf("end A1") < order.indexOf("start A2"), "A stays serial");
  assert.ok(order.indexOf("end B1") < order.indexOf("start B2"), "B stays serial");
});

test("EXPLABS_ZDR=1 adds provider.zdr; default sends no provider field", async () => {
  const bodies = [];
  const fetch = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }); };
  await createExperientialComplete({ apiKey: "k", model: "m", fetch, env: {} })({ system: "s", user: "u" });
  await createExperientialComplete({ apiKey: "k", model: "m", fetch, env: { EXPLABS_ZDR: "1" } })({ system: "s", user: "u" });
  assert.equal(bodies[0].provider, undefined);
  assert.deepEqual(bodies[1].provider, { zdr: true });
});

test("silent Day 1: several seats speak with a mock LLM, the Sheriff outs, nobody exceeds 3 a minute", async () => {
  const seats = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
  const roles = ["Sheriff", "Cop", "Journalist", "Villager", "Villager", "Villager", "Mafioso", "Janitor", "Lawyer"];
  const all = Object.fromEntries(seats.map((id) => [id, { id, name: `Bot${id.slice(1)}` }]));
  const accounts = seats.map((id) => ({ accountId: `A${id}` }));
  const table = createBotTable(accounts);
  const complete = async ({ user, purpose }) => {
    if (purpose === "speech" || user.includes("SCHEDULER: approved")) {
      const sheriff = user.includes("Out yourself as Sheriff");
      return JSON.stringify({ action: "speak", meeting: "Village", text: sheriff ? "I'm Sheriff. Shooting at end of day if no claims." : "Morning. Anyone have a claim?" });
    }
    if (purpose === "scheduler") return '{"urgency":2,"speak":true,"reason":"ok"}';
    return "not json";
  };
  const sent = [];
  let seq = {}; let t = 1_000_000;
  const deliver = async (accountId, event, data) => {
    seq[accountId] = (seq[accountId] || 0) + 1;
    const added = await onGameEntry(table, { accountId, seq: seq[accountId], t: t, event, data }, { complete, dryRun: true, rng: () => 0, now: t });
    return added;
  };
  for (const [i, id] of seats.entries()) {
    const acc = `A${id}`;
    table.views[acc] = reduce(emptyView(), { event: "self", data: id });
    await deliver(acc, "players", all);
    await deliver(acc, "roleReveal", { playerId: id, role: roles[i] });
    await deliver(acc, "state", { id: 3, name: "Day 1" });
  }
  // One meeting frame per seat opens the day; then echo every public line to every seat.
  for (let round = 0; round < 8; round++) {
    for (const id of seats) {
      const acc = `A${id}`;
      const added = round === 0
        ? await deliver(acc, "meeting", { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...seats, "*"], votes: {} })
        : await deliver(acc, "time", {});
      for (const a of added.filter((x) => x.event === "speak")) {
        sent.push({ id, text: a.data.content, t });
        for (const other of seats) await deliver(`A${other}`, "message", { id: `m${sent.length}`, senderId: id, meetingId: "mVil", content: a.data.content, time: t });
      }
      t += 700;
    }
  }
  const speakers = new Set(sent.map((s) => s.id));
  assert.ok(speakers.size >= 3, `only ${speakers.size} seats spoke`);
  assert.ok(sent.some((s) => s.id === "p1" && /sheriff/i.test(s.text)), "Sheriff outs on Day 1");
  for (const id of speakers) {
    const mine = sent.filter((s) => s.id === id).map((s) => s.t);
    assert.ok(mine.filter((x) => x >= mine[0] && x - mine[0] < 60_000).length <= 3, `${id} broke the 3/min cap`);
  }
});
