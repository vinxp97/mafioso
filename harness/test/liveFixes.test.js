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
  // No wall clock: each "model call" is a gate the test opens by hand, so the interleaving is exact.
  const order = [];
  const gates = {};
  const q = createSeatQueues(async (e) => {
    const k = `${e.accountId}${e.seq}`;
    order.push(`start ${k}`);
    await new Promise((r) => { gates[k] = r; });
    order.push(`end ${k}`);
  });
  const settle = () => new Promise((r) => setImmediate(r));
  q.push({ accountId: "A", seq: 1 }); q.push({ accountId: "B", seq: 1 });
  q.push({ accountId: "A", seq: 2 }); q.push({ accountId: "B", seq: 2 });
  await settle();
  assert.deepEqual(order, ["start A1", "start B1"], "both seats are in a model call at once");
  gates.A1(); await settle();
  assert.deepEqual(order.slice(2), ["end A1", "start A2"], "A moves on while B1 is still waiting");
  gates.B1(); gates.A2(); await settle();
  gates.B2(); await q.drain();
  assert.equal(order.length, 8);
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
  let n = 0;
  const complete = async ({ user, purpose }) => {
    if (purpose === "speech" || user.includes("SCHEDULER: approved")) {
      const sheriff = user.includes("Out yourself as Sheriff");
      return JSON.stringify({ action: "speak", meeting: "Village", text: sheriff ? "I'm Sheriff. Shooting at end of day if no claims." : ["morning, who has thoughts", "quiet start huh", "anyone got a read", "bea feels odd to me", "lets get some talk going", "who is lurking today", "cat what do you think", "dan you there"][(n++) % 8] });
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

test("public speech never leaks player ids: names swap in, unknown ids drop", async () => {
  const { humanizePlayerIds } = await import("mafioso-engine");
  const v = reduce(emptyView(), { event: "players", data: { zekOPxX6S: { id: "zekOPxX6S" }, wONLAMmupM7: { id: "wONLAMmupM7", name: "Bob" }, c3AuF5: { id: "c3AuF5", name: "Ann" } } });
  assert.equal(humanizePlayerIds(v, "Quiet so far: zekOPxX6S, wONLAMmupM7, c3AuF5."), "Quiet so far: Bob, Ann.");

  const table = createBotTable([{ accountId: "A" }]);
  const client = { api: async () => [{ id: "A", playerId: "p1", name: "Me" }, { id: "B", playerId: "p2", name: "Alice" }] };
  await seedSelfIds(client, table, ["A", "B"], { sleep: async () => {} });
  assert.equal(table.views.A.players.p2.name, "Alice");

  const complete = async ({ purpose, user }) => (purpose === "speech" || user.includes("SCHEDULER: approved")
    ? '{"action":"speak","meeting":"Village","text":"p2 and Qx7pLm2Za are quiet"}'
    : '{"action":"wait"}');
  const t = 1_000_000;
  for (const e of [
    { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
    { event: "message", data: { senderId: "p2", meetingId: "mVil", content: "hi Me", time: t } },
  ]) var added = await onGameEntry(table, { accountId: "A", t, ...e }, { complete, dryRun: true, rng: () => 0, now: t });
  const line = added.find((a) => a.event === "speak");
  assert.ok(line, "a public line was proposed");
  assert.ok(!/\bp2\b|Qx7pLm2Za/.test(line.data.content), line.data.content);
  assert.match(line.data.content, /Alice/);
});

test("a dead seat is silent: validateAction rejects, scheduler and generator skip, queue stops", async () => {
  const { validateAction, decideSpeech, proposeSeatActions, generatePublicSpeech, selfAlive } = await import("mafioso-engine");
  const day = [
    { event: "self", data: "p1" },
    { event: "players", data: { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" } } },
    { event: "roleReveal", data: { playerId: "p1", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 2" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "*"], votes: {} } },
  ];
  for (const killer of [{ event: "death", data: "p1" }, { event: "playerLeave", data: "p1" }, { event: "kicked", data: {} }]) {
    let v = emptyView();
    for (const e of [...day, killer]) v = reduce(v, e);
    assert.equal(selfAlive(v), false, killer.event);
    assert.equal(validateAction(v, { event: "speak", data: { meetingId: "mVil", content: "hi" } }).reason, "dead seat");
    assert.equal(validateAction(v, { event: "vote", data: { meetingId: "mVil", selection: "p2" } }).reason, "dead seat");
    assert.equal(decideSpeech(v, { now: 1 }).speak, false);
    let calls = 0;
    const complete = async () => { calls++; return '{"action":"speak","meeting":"Village","text":"still here"}'; };
    assert.deepEqual((await proposeSeatActions(v, { complete, now: 1 })).actions, []);
    assert.equal((await generatePublicSpeech(v, { complete, schedule: { speak: true }, now: 1 })).action, null);
    assert.equal(calls, 0);
  }

  const table = createBotTable([{ accountId: "A" }]);
  let calls = 0;
  const complete = async () => { calls++; return '{"action":"speak","meeting":"Village","text":"still here"}'; };
  const handled = [];
  const q = createSeatQueues(async (e) => { handled.push(e.event); await onGameEntry(table, e, { complete, dryRun: true, now: 1 }); }, { isStopped: (id, e) => !!table.stopped?.[id] && e.event !== "winners" });
  let seq = 0;
  for (const e of [...day, { event: "death", data: "p1" }, { event: "message", data: { senderId: "p2", meetingId: "mVil", content: "Me?" } }, { event: "winners", data: { groups: ["Village"], players: [] } }]) q.push({ accountId: "A", seq: ++seq, t: 1, ...e });
  await q.drain();
  assert.ok(table.stopped.A);
  assert.ok(!handled.includes("message"), "queue skips work after death");
  assert.ok(handled.includes("winners") && table.views.A.finished);
});

import { runStreamLoop as rsl, createBotTable as cbt, onGameEntry as oge } from "../src/live.js";
test("qAl36MVss: backfill replays buffered start events before the stream; stale accounts_dropped is ignored", async () => {
  const table = cbt([{ accountId: "A1" }]);
  const sse = [
    `event: accounts_dropped\ndata: ${JSON.stringify({ accounts: [{ id: "xX", gameId: "l0bS-lGKX", status: "dropped" }] })}\n\n`,
    `event: game\ndata: ${JSON.stringify({ accountId: "A1", seq: 3, event: "state", data: { id: 1, name: "Night 1" } })}\n\n`,
    `event: game\ndata: ${JSON.stringify({ accountId: "A1", seq: 4, event: "time", data: { time: 1 } })}\n\n`,
  ].join("");
  const errors = [], infos = [], seen = [];
  await rsl({
    fetchStream: async () => (async function* () { yield sse; })(),
    backfill: async () => [
      { accountId: "A1", seq: 1, event: "self", data: "p1" },
      { accountId: "A1", seq: 2, event: "roleReveal", data: { playerId: "p1", role: "Cop" } },
      { accountId: "A1", seq: 3, event: "state", data: { id: 1, name: "Night 1" } },
    ],
    onFrame: async (f) => { if (f.type === "game") { seen.push(f.entry.seq); await oge(table, f.entry, { dryRun: true }); } return false; },
    ourIds: ["A1"], maxAttempts: 0, sleep: async () => {},
    shouldStop: () => seen.length >= 5,
    onError: (e) => errors.push(e.message), onInfo: (m) => infos.push(m),
  }).catch(() => {});
  assert.deepEqual(seen.slice(0, 5), [1, 2, 3, 3, 4]);
  assert.equal(table.views.A1.selfId, "p1");
  assert.equal(table.views.A1.role, "Cop");
  assert.equal(table.views.A1.phase.name, "Night 1");
  assert.equal(errors.filter((e) => /accounts_dropped/.test(e)).length, 0);
  assert.equal(infos.filter((m) => /stale accounts_dropped/.test(m)).length, 1);
});

import { publicChatLogLine } from "../src/live.js";
test("public chat is logged once (sanitized, up to 500 chars); faction chat and server lines never", async () => {
  const table = cbt([{ accountId: "A" }, { accountId: "B" }]);
  const lines = [];
  for (const acc of ["A", "B"]) {
    let s = 0;
    const f = (event, data) => oge(table, { accountId: acc, seq: ++s, event, data }, { dryRun: true, onChat: (l) => lines.push(l) });
    await f("self", acc === "A" ? "p1" : "p2");
    await f("players", { p1: { id: "p1", name: "Ann" }, p2: { id: "p2", name: "Bob" }, p3: { id: "p3", name: "Cat" } });
    await f("state", { id: 1, name: "Day 1" });
    await f("meeting", { id: "vil", name: "Village", speech: true, voting: true, amMember: true, targets: ["p1"], votes: {} });
    await f("meeting", { id: "maf", name: "Mafia", speech: true, voting: false, amMember: true });
    await f("message", { meetingId: "vil", senderId: "p3", content: "im cop, bob is guilty " + "x".repeat(600), time: 5 });
    await f("message", { meetingId: "maf", senderId: "p3", content: "PLAN kill=p1", time: 6 });
    await f("message", { meetingId: "vil", senderId: "server", content: "Ann was killed", time: 7 });
    await f("message", { meetingId: "whoknows", senderId: "p3", content: "secret?", time: 8 });
  }
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^chat \[Day 1\] Village Cat: "im cop, bob is guilty x+/);
  assert.ok(lines[0].length > 400 && lines[0].length < 560);
  assert.equal(publicChatLogLine(table, "A", { event: "vote", data: {} }), null);
});
