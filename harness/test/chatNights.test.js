import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, emptyView, validateAction, generatePublicSpeech, PUBLIC_MAX, claimAllowed } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, SCUM_CHAT, DAY_VOTE } from "../src/live.js";
import { seats, players, meetingsFor, MAFIA } from "./fixtures/smu-night1.mjs";

Object.assign(SCUM_CHAT, { minDelayMs: 10, maxDelayMs: 40, gapMs: 20 });
Object.assign(DAY_VOTE, { staggerMinMs: 5, staggerMaxMs: 20, scumExtraMs: 5 });
const failing = async () => { throw new Error("model down"); };
const mafiaSeats = seats.filter((s) => MAFIA.has(s.role));
// Night N meetings: fresh ids every night, as on the server.
const nightMeetings = (s, n, dead) => meetingsFor(s).map((m) => ({ ...m, id: `${m.id}-n${n}`, targets: (m.targets || []).filter((t) => !dead.has(t)), votes: {} }));

test("N1 -> D1 -> N2: PLAN, kill votes, Mafia Action Yes and faction chatter fire every night", { timeout: 60000 }, async () => {
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })));
  const seq = {};
  const feed = (s, event, data) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t: Date.now(), event, data }, { complete: failing, dryRun: true, fast: true, limiter: createLlmLimiter(1), rng: Math.random }); };
  const echoed = new Set();
  const visible = {};
  const echo = async () => {
    for (const p of [...table.proposed]) {
      const k = JSON.stringify(p); if (echoed.has(k)) continue; echoed.add(k);
      const from = seats.find((s) => s.acc === p.accountId);
      for (const s of seats) {
        if (!(visible[s.acc] || []).some((m) => m.id === p.data.meetingId)) continue;
        if (p.event === "vote") await feed(s, "vote", { meetingId: p.data.meetingId, voterId: from.pid, target: p.data.selection });
        else await feed(s, "message", { meetingId: p.data.meetingId, senderId: from.pid, content: p.data.content });
      }
    }
  };
  const settle = async () => { for (let i = 0; i < 4; i++) { await drainUpgrades(table); await echo(); for (const s of seats) await feed(s, "time", { time: 1000 }); await new Promise((r) => setTimeout(r, 60)); } };
  for (const s of seats) { await feed(s, "self", s.pid); await feed(s, "players", players); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role });
  const dead = new Set();
  const night = async (n, stateId) => {
    for (const s of seats) { if (dead.has(s.pid)) continue; await feed(s, "state", { id: stateId, name: `Night ${n}` }); visible[s.acc] = nightMeetings(s, n, dead); for (const m of visible[s.acc]) await feed(s, "meeting", m); }
    await settle();
    const P = table.proposed.filter((p) => p.phase === `Night ${n}`);
    const kills = P.filter((p) => p.data.meetingId === `zbABCg9YSTU-n${n}`);
    assert.equal(new Set(kills.map((k) => k.accountId)).size, mafiaSeats.length, `night ${n}: all mafia vote the kill`);
    assert.equal(new Set(kills.map((k) => k.data.selection)).size, 1, `night ${n}: one kill target`);
    for (const s of mafiaSeats) assert.ok(P.some((p) => p.accountId === s.acc && p.data.meetingId === `MafAct01xyz-n${n}` && p.data.selection === "Yes"), `night ${n}: ${s.role} sends Mafia Action Yes`);
    const plans = P.filter((p) => p.event === "speak" && p.source !== "scum-chat" && /^kill \S+ tonight/.test(p.data.content));
    assert.equal(plans.length, 1, `night ${n}: one casual plan line`);
    for (const p of P) if (p.event === "speak") assert.doesNotMatch(p.data.content, /PLAN|\w=\S/, "no machine text in any chat");
    const chatter = P.filter((p) => p.source === "scum-chat");
    for (const s of mafiaSeats) {
      const mine = chatter.filter((c) => c.accountId === s.acc);
      assert.ok(mine.length >= 1 && mine.length <= 2, `night ${n}: ${s.role} says 1-2 lines (${mine.length})`);
    }
    for (const c of chatter) { assert.equal(c.data.meetingId, `38S8qkzPMKC-n${n}`, "faction chat only"); assert.doesNotMatch(c.data.content, /PLAN|=|[A-Za-z0-9_-]{10,}/); }
    return kills[0].data.selection;
  };
  const k1 = await night(1, 2);
  dead.add(k1);
  for (const s of seats) await feed(s, "death", k1);
  for (const s of seats) { if (dead.has(s.pid)) continue; await feed(s, "state", { id: 3, name: "Day 1" }); visible[s.acc] = [{ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: Object.keys(players).filter((i) => i !== s.pid && !dead.has(i)), votes: {} }]; for (const m of visible[s.acc]) await feed(s, "meeting", m); }
  await settle();
  const k2 = await night(2, 4);
  assert.notEqual(k2, k1, "night 2 targets a living player");
});

function daySeat(role, extra = []) {
  let v = reduce(emptyView(), { event: "self", data: "a0BHWAcOIlw" });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "roleReveal", data: { playerId: "a0BHWAcOIlw", role } });
  v = reduce(v, { event: "state", data: { id: 3, name: "Day 1" } });
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: Object.keys(players).filter((i) => i !== "a0BHWAcOIlw"), votes: {} } });
  for (const e of extra) v = reduce(v, e);
  return v;
}
const say = (v, content) => validateAction(v, { event: "speak", data: { meetingId: "vil", content } });

test("no early role claims on Day 1: only the Sheriff, a Cop with a guilty, or a seat under pressure", () => {
  const vill = daySeat("Villager");
  assert.equal(claimAllowed(vill), false);
  for (const line of ["im villager", "I'm just a plain Villager", "i am the cop", "im journalist btw"]) assert.equal(say(vill, line).ok, false, line);
  assert.equal(say(vill, "why claim cop tho?").ok, true, "asking about a claim is fine");
  assert.equal(say(vill, "bea feels off").ok, true);
  assert.equal(say(daySeat("Sheriff"), "im sheriff, holding my shot").ok, true, "Sheriff outs D1");
  assert.equal(say(daySeat("Cop"), "im cop, no guilty yet").ok, false, "Cop without a guilty waits");
  const pressured = daySeat("Villager", [
    { event: "vote", data: { meetingId: "vil", voterId: "rhyFPKXcnH", target: "a0BHWAcOIlw" } },
    { event: "vote", data: { meetingId: "vil", voterId: "jVE7zbEozZZ", target: "a0BHWAcOIlw" } },
  ]);
  assert.equal(say(pressured, "im villager dont lynch me").ok, true, "under real pressure a claim is allowed");
});

test("a mention gets a fast, short reply addressed to that person", async () => {
  const v = daySeat("Villager", [{ event: "message", data: { meetingId: "vil", senderId: "rhyFPKXcnH", content: "ash why so quiet? who u voting", t: 1000 } }]);
  let prompt;
  const r = await generatePublicSpeech(v, { now: 5000, maxRetries: 0, complete: async (p) => { prompt = p; return "idk yet, dot feels off to me honestly, lets see how votes go then decide tho"; } });
  assert.ok(r.action, r.rejections.join(","));
  assert.equal(r.schedule.urgency, 4, "named is top urgency");
  assert.match(prompt.user, /Bea said to you/);
  assert.match(r.action.data.content, /^bea\b/i, "reply is addressed to Bea");
  assert.ok(r.action.data.content.length <= PUBLIC_MAX, r.action.data.content);
  assert.equal(prompt.maxTokens, 40);
});

test("public lines always fit the chat cap, even from long or listy model output", async () => {
  const v = daySeat("Villager", [{ event: "message", data: { meetingId: "vil", senderId: "rhyFPKXcnH", content: "ash?", t: 1000 } }]);
  for (const out of ["- point one is long\n- point two", "As a villager I think that we should all carefully consider every single claim made so far today before voting anyone", '{"action":"speak","meeting":"vil","text":"' + "word ".repeat(60) + '"}']) {
    const r = await generatePublicSpeech(v, { now: 5000, maxRetries: 0, complete: async () => out });
    if (r.action) { assert.ok(r.action.data.content.length <= PUBLIC_MAX, r.action.data.content); assert.doesNotMatch(r.action.data.content, /^\s*-/); }
  }
});

test("the mafia PLAN speaker may only make the PLAN's fake claim", () => {
  let v = reduce(emptyView(), { event: "self", data: "Hsd2JfBMtVt" });
  v = reduce(v, { event: "players", data: players });
  v = reduce(v, { event: "roleReveal", data: { playerId: "Hsd2JfBMtVt", role: "Lawyer" } });
  v = reduce(v, { event: "state", data: { id: 2, name: "Night 1" } });
  v = reduce(v, { event: "meeting", data: { id: "chat", name: "Mafia", speech: true, amMember: true } });
  v = reduce(v, { event: "message", data: { meetingId: "chat", senderId: "Hsd2JfBMtVt", content: "PLAN kill=a0BHWAcOIlw lynch=rhyFPKXcnH claim=Cop lawyer=otU9CsNlbw speaker=Hsd2JfBMtVt" } });
  v = reduce(v, { event: "state", data: { id: 3, name: "Day 1" } });
  v = reduce(v, { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: Object.keys(players), votes: {} } });
  assert.equal(say(v, "im cop, bea is guilty").ok, true);
  assert.equal(say(v, "im villager btw").ok, false);
  assert.equal(say(v, "As a villager I think").ok, false);
});
