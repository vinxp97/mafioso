// Replays of the 10/18 live games L2-L8 (fixtures/live-1018, rebuilt from the suspicion-arm logs by
// scripts/build-replays.mjs; every id and name is a placeholder). Each fix from live games 3, 4 and 5 and the
// game-8 issues is checked on the game state it came from, through the current engine and live harness.
// The historical sends came from older code: they are the timeline, not the thing under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  reduce, emptyView, selfAlive, legalActions, serverAccepts, meetingActions, validateAction, decide, rulesSeatActions,
  createSeededRng, chatAudit, townReads, hammerVote, humanizeSpeak, sheriffGunOwed, sheriffGunSpent, sheriffShotReady,
  revealedSheriff, SPENT_GUN_THREAT,
} from "mafioso-engine";
import { createBotTable, drainUpgrades, onGameEntry, DAY_SPEECH, SPEECH_PACE } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";

const dir = new URL("./fixtures/live-1018/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
const load = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const game = (n) => load(manifest.fixtures.find((f) => f.liveGame === n).fixture);
const accOf = (E, pid) => E.find((e) => e.event === "self" && e.data === pid).accountId;
const roleOf = (E, role) => E.find((e) => e.event === "roleReveal" && e.data.role === role)?.data.playerId;
/** One seat's view, folded up to (not including) the first entry where stop(entry, index) holds. */
function viewAt(E, acc, stop = () => false) {
  let v = emptyView();
  for (const [i, e] of E.entries()) { if (stop(e, i)) break; if (e.accountId === acc) v = reduce(v, e); }
  return v;
}
const SCUM = /^(mafioso|janitor|lawyer|godfather)/i;
const isGunLine = (e) => e.event === "message" && /pulls a gun and shoots/.test(e.data?.content || "");
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** The live harness over a fixture, the virtual clock following the fixture's timestamps (no timer jumps). */
async function timedReplay(E, { until = () => false } = {}) {
  const clock = createVirtualClock(E[0].t);
  const table = createBotTable([...new Set(E.map((e) => e.accountId))].map((accountId) => ({ accountId })), { clock, rng: createSeededRng(42) });
  const errors = [];
  let i = 0;
  for (; i < E.length; i++) {
    const e = E[i];
    if (until(e, i)) break;
    if (e.t > clock.now()) clock.advance(e.t - clock.now());
    await onGameEntry(table, e, { dryRun: true, fast: true, onError: (err, who) => errors.push(`${who}: ${err?.message || err}`) });
    await settle();
  }
  return { table, errors, clock, next: i };
}

test("the live-1018 fixtures are L2-L8, carry no raw ids, and every frame type the logs saw", () => {
  assert.deepEqual(manifest.fixtures.map((f) => f.liveGame), ["L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  for (const f of manifest.fixtures) {
    const text = fs.readFileSync(new URL(f.fixture, dir), "utf8");
    assert.equal(f.seatBinding, "seatmap", f.fixture);
    // Placeholders only: accNN accounts, pNN players, mNN meetings, PlayerNN / GuestNN names.
    for (const e of text.trim().split("\n").map((l) => JSON.parse(l))) assert.match(e.accountId, /^acc\d\d$/);
    const names = new Set(text.match(/\b[A-Z][a-z]+[A-Z][A-Za-z]*\d*\b/g) || []);
    for (const n of names) assert.ok(/^(Player|Guest)\d+$/.test(n) || /^(accountId|meetingId)$/.test(n) || !/\d/.test(n), `${f.fixture}: ${n}`);
    const types = new Set(text.trim().split("\n").map((l) => JSON.parse(l).event));
    for (const ty of Object.keys(f.observedFrameCounts)) assert.ok(types.has(ty), `${f.fixture} lacks ${ty}`);
  }
});

test("L2-L8: every vote the server accepted is server-legal in the voter's view", () => {
  let n = 0; const miss = [];
  for (const f of manifest.fixtures) {
    const views = {};
    for (const e of load(f.fixture)) {
      const before = views[e.accountId] || emptyView();
      if (e.event === "vote" && e.data?.voterId && e.data.voterId === before.selfId) {
        n += 1;
        if (!serverAccepts(before, { event: "vote", data: { meetingId: e.data.meetingId, selection: e.data.target } })) miss.push(`${f.fixture} ${before.phase?.name} ${before.role} ${e.data.target}`);
      }
      views[e.accountId] = reduce(before, e);
    }
  }
  assert.deepEqual(miss, []);
  assert.ok(n >= 150, `${n} votes`);
});

test("L2-L8: at every decision point every bot pick is server-legal and keeps Vinman's town rules", () => {
  let points = 0; const bad = [];
  for (const f of manifest.fixtures) {
    const E = load(f.fixture); const views = {}; const seen = new Set();
    for (const e of E) {
      const v = (views[e.accountId] = reduce(views[e.accountId] || emptyView(), e));
      if (!v.selfId || !selfAlive(v) || v.finished || !/^(Day|Night)$/.test(v.phase?.phase || "")) continue;
      const open = legalActions(v).meetings.filter((m) => !m.closed && m.myVote == null && m.server.length);
      if (!open.length) continue;
      const key = `${e.accountId}|${v.stateId}|${(v.messages || []).length}|${Object.keys(v.dead || {}).length}|${JSON.stringify(Object.values(v.meetings).map((x) => x.votes))}`;
      if (seen.has(key)) continue;
      seen.add(key); points += 1;
      const town = !!v.role && !SCUM.test(String(v.role));
      const sheriff = revealedSheriff(v);
      const sheriffAlive = Object.keys(v.players || {}).some((id) => /sheriff/i.test(String(v.reveals?.[id] || (id === v.selfId ? v.role : ""))) && !v.dead?.[id]);
      const where = `${f.fixture} ${e.accountId} ${v.phase.name} ${v.role}`;
      for (const [who, actions] of [["decide", decide(v, { rng: createSeededRng(7) })], ["rules", rulesSeatActions(v, { rng: createSeededRng(7), now: e.t }).actions]]) {
        for (const a of actions || []) {
          if (a?.event !== "vote") continue;
          const m = v.meetings[a.data.meetingId];
          if (!serverAccepts(v, a) || !(m ? meetingActions(v, m).allowed : []).includes(String(a.data.selection)) || !validateAction(v, a).ok) bad.push(`${where}: ${who} illegal ${m?.name} ${a.data.selection}`);
          if (m?.name !== "Village" || !town) continue;
          if (sheriff && sheriff !== v.selfId && a.data.selection === sheriff) bad.push(`${where}: ${who} votes the revealed Sheriff`);
          if (v.phase.name === "Day 1" && sheriffAlive && /^(\*|no one)$/i.test(String(a.data.selection))) bad.push(`${where}: ${who} no-lynch on Day 1 with the Sheriff alive`);
        }
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(points >= 300, `${points} decision points`);
});

test("L2-L8 replay through the live harness: no seat errors, legal proposals only, the same result twice", async () => {
  const run = async (E) => {
    const table = createBotTable([...new Set(E.map((e) => e.accountId))].map((accountId) => ({ accountId })), { clock: createVirtualClock(1_800_000_000_000), rng: createSeededRng(42) });
    const errors = [];
    for (const e of E) await onGameEntry(table, e, { dryRun: true, fast: true, onError: (err, who) => errors.push(`${who}: ${err?.message || err}`) });
    await drainUpgrades(table);
    return { table, errors };
  };
  for (const f of manifest.fixtures) {
    const E = load(f.fixture);
    const a = await run(E);
    assert.deepEqual(a.errors, [], f.fixture);
    for (const p of a.table.proposed) {
      assert.ok(p.event === "vote" || p.event === "speak", `${f.fixture}: ${p.event}`);
      assert.ok(typeof p.data?.meetingId === "string", `${f.fixture}: meeting`);
    }
    const b = await run(E);
    const key = (t) => t.proposed.map((p) => [p.accountId, p.event, p.data.meetingId, p.data.selection ?? p.data.content]);
    assert.deepEqual(key(b.table), key(a.table), `${f.fixture} is deterministic`);
  }
});

// ---- Live game 3 (branch 15) ----

test("L3: the gun line reveals the Sheriff to every living town seat (the decision-point test keeps their votes off him)", () => {
  const E = game("L3");
  const sh = roleOf(E, "Sheriff");
  const shot = E.findIndex(isGunLine);
  assert.ok(shot > 0, "L3 has the Sheriff's shot");
  for (const pid of ["p02", "p04", "p06", "p07", "p09"].filter((p) => p !== sh)) {
    const v = viewAt(E, accOf(E, pid), (e, i) => i > shot + 40);
    if (!selfAlive(v)) continue;
    assert.equal(revealedSheriff(v), sh, `${pid} sees the revealed Sheriff`);
  }
});

test("L3: Day 2's doubts about the revealed Sheriff, and 'whoever shot' a night kill, are blocked now", () => {
  const E = game("L3");
  const flagged = linesFlagged(E);
  for (const [text, rule] of [
    ["that sheriff claim is weak.", /sheriff/], // mafia (Lawyer)
    ["player08 claim feels weak, vote player09", /sheriff/], // mafia (Mafioso), his nickname
    ["sheriff claim too weak, vote her", /sheriff/], // town, after the gun revealed him
    ["s sheriff claim is pure bs, vote her.", /sheriff/],
    ["Whoever shot player02 is a monster, vote them down.", /^shot$/], // Night 1's kill, not a shot
  ]) assert.ok(flagged.get(text)?.some((r) => rule.test(r)), `${text}: ${flagged.get(text)}`);
});

/** Recorded Village lines -> the chatAudit rules each now trips, from its sender's view just before it. */
function linesFlagged(E) {
  const views = {}; const out = new Map(); const acc = {};
  for (const e of E) if (e.event === "self") acc[e.data] = e.accountId;
  for (const e of E) {
    const before = views[e.accountId] || emptyView();
    if (e.event === "message" && e.data?.senderId && acc[e.data.senderId] === e.accountId && before.meetings?.[e.data.meetingId]?.name === "Village") {
      out.set(e.data.content, chatAudit(before, e.data.content).map((x) => x.rule));
    }
    views[e.accountId] = reduce(before, e);
  }
  return out;
}

// ---- Live game 4 (branch 16) ----

test("L4: after the shot the gun is spent, his vote is free, and the harness never re-aims it", async () => {
  const E = game("L4");
  const sh = roleOf(E, "Sheriff"); const acc = accOf(E, sh);
  const shot = E.findIndex((e) => isGunLine(e) && e.accountId === acc);
  assert.ok(shot > 0);
  const v = viewAt(E, acc, (e, i) => i > shot + 30 && e.event === "message");
  assert.equal(sheriffGunOwed(v), false, "the fired gun is not owed again");
  assert.equal(sheriffGunSpent(v), true);
  const gun = Object.values(v.meetings).find((m) => /gun/i.test(m.name));
  if (gun) assert.ok(legalActions(v).meetings.find((m) => m.meetingId === gun.id)?.closed !== false, "the used gun meeting is closed");
  const { table, errors } = await timedReplay(E, { until: (e) => e.event === "state" && e.data?.name === "Night 2" });
  assert.deepEqual(errors, []);
  const shotSeq = E[shot].seq;
  const mine = table.proposed.filter((p) => p.accountId === acc && p.phase === "Day 1");
  const gunId = E.find((e) => e.accountId === acc && e.event === "meeting" && /gun/i.test(e.data?.name || ""))?.data.id;
  assert.deepEqual(mine.filter((p) => p.data.meetingId === gunId && p.afterSeq >= shotSeq).map((p) => p.data.selection), [], "no gun vote after the shot");
  assert.ok(mine.some((p) => p.event === "vote" && p.data.meetingId !== gunId), "he casts a Village vote");
});

test("L4: attacks on the revealed Sheriff and the 'cop and sheriff' garble are blocked now", () => {
  const flagged = linesFlagged(game("L4"));
  for (const [text, rule] of [
    ["player03 shot a villager, why would you trust him", "attacks-sheriff"],
    ["player03 shot a villager, you're a blind wolf lol", "attacks-sheriff"],
    ["player08 stop defending player03, he's a wolf", "attacks-sheriff"],
    ["player03 u the cop and the sheriff", "role-stack"],
  ]) assert.ok(flagged.get(text)?.includes(rule), `${text}: ${flagged.get(text)}`);
  // Asking him for a read stays legal.
  const E = game("L4"); const acc = accOf(E, "p02");
  const v = viewAt(E, acc, (e) => isGunLine(e) && e.accountId === acc);
  assert.ok(!chatAudit(v, "player03 who do you think is mafia").some((f) => f.rule === "attacks-sheriff"));
});

// ---- Live game 5 (branch 17) ----

test("L5: a Cop claimer's free-chat 'X is mafia' is not a checked guilty in anyone's reads", () => {
  const E = game("L5");
  const shot = E.findIndex(isGunLine);
  for (const pid of ["p02", "p04", "p06", "p08", "p01"]) {
    const reads = townReads(viewAt(E, accOf(E, pid), (e, i) => i >= shot));
    assert.ok(!(reads.reasons.p05 || []).some((r) => /guilty/i.test(r)), `${pid}: ${reads.reasons.p05}`);
  }
});

test("L5: the Sheriff asks before he shoots (the live game shot unasked); 'X claiming cop' is not a claim", () => {
  const E = game("L5");
  const sh = roleOf(E, "Sheriff"); const acc = accOf(E, sh);
  let v = emptyView(); let first = null;
  for (const e of E) {
    if (e.accountId !== acc) continue;
    v = reduce(v, e);
    if (v.phase?.name !== "Day 1") continue;
    const r = sheriffShotReady(v, { now: e.t });
    if (r.ok || r.ask) { first = r; break; }
  }
  assert.ok(first?.ask, `first gun decision: ${JSON.stringify(first)}`);
  // The Janitor's "player08 claiming cop feels suspicious" had tagged him as a rival Cop claimer.
  const end = viewAt(E, acc, (e) => isGunLine(e));
  assert.equal(end.claims?.p07, undefined, JSON.stringify(end.claims?.p07));
  assert.equal(end.claims?.p08?.role, "Cop");
});

test("L5: template leaks, the garbled self-vote order, sheriff doubts and a night kill called a shot are blocked", () => {
  const flagged = linesFlagged(game("L5"));
  for (const [text, rule] of [
    ["Target claim your role immediately.", "placeholder"],
    ["player08 vote player08, she's mafia.", "garbled-vote"],
    ["is player01 really the sheriff or a fake?", "doubts-sheriff"],
    ["player03 shot player08.", "wrong-shot"],
  ]) assert.ok(flagged.get(text)?.includes(rule), `${text}: ${flagged.get(text)}`);
});

test("L5: on Night 2 the Journalist goes to the living, uncounterclaimed Cop claimer (live: another seat)", () => {
  const E = game("L5");
  const j = roleOf(E, "Journalist"); const acc = accOf(E, j);
  const n2 = E.findIndex((e) => e.accountId === acc && e.event === "state" && e.data?.name === "Night 2");
  const vote = E.findIndex((e, i) => i > n2 && e.event === "vote" && e.data?.voterId === j);
  const v = viewAt(E, acc, (e, i) => i >= vote);
  const cop = roleOf(E, "Cop");
  assert.equal(selfAlive(v) && !v.dead?.[cop], true);
  assert.notEqual(E[vote].data.target, cop, "the live Journalist went elsewhere");
  for (const actions of [decide(v, { rng: createSeededRng(7) }), rulesSeatActions(v, { rng: createSeededRng(7) }).actions]) {
    assert.equal(actions.find((a) => a.event === "vote")?.data.selection, cop);
  }
});

// ---- Live game 8 (PR #15) ----

test("L8: the 5-alive hammer picks by read, then evidence, then a stable id, and says which; self-vote order never decides", () => {
  const E = game("L8");
  const sh = roleOf(E, "Sheriff"); const acc = accOf(E, sh);
  const at = E.findIndex((e) => e.accountId === acc && e.event === "vote" && e.data?.voterId === sh && E.find((x) => x.event === "meeting" && x.data?.id === e.data.meetingId)?.data.name === "Village" && e.t > E.find((x) => x.event === "state" && x.data?.name === "Day 2").t);
  const v = viewAt(E, acc, (e, i) => i >= at);
  assert.equal(v.phase.name, "Day 2");
  const living = Object.keys(v.players).filter((id) => !v.dead?.[id]);
  assert.equal(living.length, 5);
  const hv = hammerVote(v, { now: v.clock });
  assert.ok(hv?.target && hv.target !== sh && living.includes(hv.target), JSON.stringify(hv));
  assert.match(hv.why, /^hammer: deciding vote, (read -?\d+(\.\d+)?(: .+)?|read 0, evidence: .+|read 0, no scored read; stable id)$/);
  assert.equal(validateAction(v, { event: "vote", data: { meetingId: Object.values(v.meetings).find((m) => m.name === "Village").id, selection: hv.target } }).ok, true);
  // The same four self-votes in the reverse order: same pick (live, the pick fell on the last self-voter).
  const day2 = E.findIndex((e) => e.event === "state" && e.data?.name === "Day 2");
  const selfVotes = E.slice(day2, at).filter((e) => e.accountId === acc && e.event === "vote" && e.data?.voterId === e.data?.target);
  assert.equal(selfVotes.length, 4);
  let w = viewAt(E, acc, (e, i) => i >= day2);
  for (const e of E.slice(day2, at)) if (e.accountId === acc && !selfVotes.includes(e)) w = reduce(w, e);
  for (const e of [...selfVotes].reverse()) w = reduce(w, e);
  assert.equal(hammerVote(w, { now: v.clock })?.target, hv.target);
});

test("L8: once the gun is spent the Sheriff's 'claim or im shooting' is blocked, and repaired to a whole line", async () => {
  const E = game("L8");
  const sh = roleOf(E, "Sheriff"); const acc = accOf(E, sh);
  const line = E.find((e) => e.accountId === acc && e.data?.senderId === sh && /claim or im shooting/.test(e.data?.content || ""));
  assert.ok(line, "the live line is in the fixture");
  const shot = E.findIndex((e) => isGunLine(e) && e.accountId === acc);
  assert.ok(shot < E.indexOf(line), "and it came after his shot");
  const gunId = E.find((e) => e.accountId === acc && e.event === "meeting" && /gun/i.test(e.data?.name || ""))?.data.id;
  const fired = E.findIndex((e) => e.accountId === acc && e.event === "vote" && e.data?.voterId === sh && e.data.meetingId === gunId);
  const before = viewAt(E, acc, (e, i) => i >= fired);
  assert.equal(sheriffGunSpent(before), false);
  assert.ok(!chatAudit(before, "player05 claim before i shoot").some((f) => f.rule === "spent-gun-threat"), "the ask is fine while loaded");
  const after = viewAt(E, acc, (e) => e === line);
  assert.ok(chatAudit(after, line.data.content).some((f) => f.rule === "spent-gun-threat"));
  const meetingId = line.data.meetingId;
  const fixed = humanizeSpeak(after, { event: "speak", data: { meetingId, content: line.data.content } }).data.content;
  assert.equal(SPENT_GUN_THREAT.test(fixed), false, fixed);
  assert.doesNotMatch(fixed, /\b(ing|claim)\b/, `no stub left: ${fixed}`);
  assert.equal(validateAction(after, { event: "speak", data: { meetingId, content: fixed } }).ok, true, fixed);
  // Through the harness, no line of his after the shot threatens another one.
  const { table } = await timedReplay(E, { until: (e) => e.event === "state" && e.data?.name === "Night 2" });
  const late = table.proposed.filter((p) => p.accountId === acc && p.event === "speak" && p.afterSeq >= E[shot].seq);
  for (const p of late) assert.equal(SPENT_GUN_THREAT.test(p.data.content), false, p.data.content);
});

test("L8: a quiet Day 2 gets an opener from every living seat within 20s, 2.5s apart, then a filler after 45s of silence", async () => {
  const E = game("L8");
  const day2 = E.findIndex((e) => e.event === "state" && e.data?.name === "Day 2");
  // Day 2 up to its first player line: the live day said three lines in five minutes.
  const firstLine = E.findIndex((e, i) => i > day2 && e.event === "message" && e.data?.senderId !== "server");
  const { table, errors, clock } = await timedReplay(E, { until: (e, i) => i >= firstLine });
  const start = E[day2].t;
  const living = [...new Set(E.slice(day2, firstLine).filter((e) => e.event === "meeting" && e.data?.name === "Village").map((e) => e.accountId))];
  assert.equal(living.length, 5);
  const seq = {}; for (const e of E.slice(0, firstLine)) seq[e.accountId] = Math.max(seq[e.accountId] || 0, e.seq);
  const n0 = table.proposed.length;
  for (let at = 2_500; at <= 90_000; at += 2_500) {
    const t = start + at;
    if (t > clock.now()) clock.advance(t - clock.now());
    for (const a of living) { seq[a] += 1; await onGameEntry(table, { accountId: a, seq: seq[a], t, event: "time", data: { name: "main", time: 1 } }, { dryRun: true, fast: true, onError: (err, who) => errors.push(`${who}: ${err?.message || err}`) }); }
    await settle();
  }
  assert.deepEqual(errors, []);
  const lines = table.proposed.slice(n0).filter((p) => p.event === "speak" && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  for (const a of living) {
    const first = lines.find((p) => p.accountId === a);
    assert.ok(first && first.t - start <= DAY_SPEECH.openWithinMs + SPEECH_PACE.tableGapMs, `${a} opens by 22.5s: ${first && first.t - start}`);
  }
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].t - lines[i - 1].t >= SPEECH_PACE.tableGapMs - 1, `${lines[i].t - lines[i - 1].t}ms between lines`);
  const opened = Math.max(...living.map((a) => lines.find((p) => p.accountId === a).t));
  const filler = lines.find((p) => p.t >= opened + DAY_SPEECH.silenceMs && /day-speech/.test(p.source || ""));
  assert.ok(filler, "the day speaks again after the silence window");
  for (const p of lines) {
    const v = table.views[p.accountId];
    assert.ok(!chatAudit(v, p.data.content).length, `${p.accountId}: ${p.data.content}`);
    assert.equal(SPENT_GUN_THREAT.test(p.data.content), false);
  }
});
