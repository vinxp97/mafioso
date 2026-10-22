// Live game L2-1018 fixes on the live path: the planned fake claim goes out from the rules path (after the
// Sheriff's out-window), adapts or drops with a logged reason, and delayed ballots send the seat's latest pick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeededRng, parseClaimReply } from "mafioso-engine";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry, PLAN_CLAIM_AFTER_MS } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { seats, players, meetingsFor } from "./fixtures/smu-night1.mjs";

const T0 = 1_800_000_000_000;
const seat = (name) => seats.find((s) => s.name === name);
const village = (s) => ({ id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(players).filter((i) => i !== s.pid), "*"], votes: {} });

/** Night 1 with Hap's plan in Mafia chat ("cal fake cop tmrw and push bea"), then the start of Day 1 at T0. */
async function planDay(seed = 1, { dayLines = [] } = {}) {
  const clock = createVirtualClock(T0 - 60_000);
  const table = createBotTable(seats.map((s) => ({ accountId: s.acc })), { clock, rng: createSeededRng(seed), mafia: "adaptive" });
  const seq = {};
  const opts = { dryRun: true, fast: true, limiter: createLlmLimiter(1) };
  const feed = (s, event, data, t) => { seq[s.acc] = (seq[s.acc] || 0) + 1; return onGameEntry(table, { accountId: s.acc, seq: seq[s.acc], t, event, data }, opts); };
  const all = async (event, data, t) => { for (const s of seats) await feed(s, event, data, t); };
  for (const s of seats) { await feed(s, "self", s.pid, T0 - 60_000); await feed(s, "players", players, T0 - 60_000); }
  for (const s of seats) await feed(s, "roleReveal", { playerId: s.pid, role: s.role }, T0 - 60_000);
  for (const s of seats) { await feed(s, "state", { id: 1, name: "Night 1" }, T0 - 60_000); for (const m of meetingsFor(s)) await feed(s, "meeting", m, T0 - 60_000); }
  const maf = meetingsFor(seat("Hap")).find((m) => m.name === "Mafia").id;
  for (const s of seats.filter((x) => ["Cal", "Hap", "Ivo"].includes(x.name))) {
    await feed(s, "message", { senderId: seat("Hap").pid, meetingId: maf, content: "kill dot tonight, cal fake cop tmrw and push bea, lawyer go on cal" }, T0 - 50_000);
  }
  await drainUpgrades(table);
  table.proposed.length = 0;
  for (const s of seats) { await feed(s, "state", { id: 2, name: "Day 1" }, T0); await feed(s, "meeting", village(s), T0); }
  await all("death", seat("Dot").pid, T0);
  for (const [who, line, at] of dayLines) await all("message", { senderId: seat(who).pid, meetingId: "vil", content: line, t: T0 + at }, T0 + at);
  return { table, feed, all, clock };
}
const said = (table, name) => table.proposed.filter((p) => p.event === "speak" && p.accountId === seat(name).acc && p.data.meetingId === "vil").map((p) => p.data.content);

test("item 1: the planned fake Cop claim goes out from the rules path, after the Sheriff's out-window", async () => {
  const { table, all } = await planDay(1, { dayLines: [["Gil", "im sheriff", 1_000]] });
  await all("time", { time: 290_000 }, T0 + 5_000);
  await drainUpgrades(table);
  assert.equal(said(table, "Cal").some((l) => /\bim cop\b/.test(l)), false, "not inside the out-window");
  await all("time", { time: 280_000 }, T0 + PLAN_CLAIM_AFTER_MS + 1_000);
  await drainUpgrades(table);
  const claim = said(table, "Cal").find((l) => /\bim cop\b/.test(l));
  assert.ok(claim, `Cal: ${said(table, "Cal").join(" | ")}`);
  assert.match(claim, /im cop\. Bea guilty/);
  assert.deepEqual(parseClaimReply(claim), { role: "Cop", kind: "power" });
  assert.equal(table.proposed.filter((p) => p.event === "speak" && p.accountId === seat("Cal").acc && /\bim cop\b/.test(p.data.content)).length, 1, "once");
});

test("item 1: a Journalist naming a teammate adapts the claim (guilty on the Journalist) and logs why", async () => {
  const notes = [];
  const { table, all } = await planDay(2, { dayLines: [["Gil", "im sheriff", 1_000], ["Fin", "im journalist. ivo is janitor", 3_000]] });
  table.onPlanClaim = (who, what) => notes.push([who, what]);
  await all("time", { time: 280_000 }, T0 + PLAN_CLAIM_AFTER_MS + 1_000);
  await drainUpgrades(table);
  const claim = said(table, "Cal").find((l) => /\bim cop\b/.test(l));
  assert.match(String(claim), /im cop\. Fin guilty/, said(table, "Cal").join(" | "));
  const mine = notes.filter(([who]) => who === seat("Cal").acc);
  assert.equal(mine.length, 1, "logged once");
  assert.match(mine[0][1], /^adapt: journalist fin named ivo: guilty moves from bea to the accuser/i);
});

test("item 1: a real Cop and Journalist already out: the planned claim is dropped with a logged reason", async () => {
  const notes = [];
  const { table, all } = await planDay(3, { dayLines: [["Gil", "im sheriff", 1_000], ["Ash", "im cop. eli inno", 2_000], ["Fin", "im journalist", 2_500]] });
  table.onPlanClaim = (who, what) => notes.push([who, what]);
  await all("time", { time: 280_000 }, T0 + PLAN_CLAIM_AFTER_MS + 1_000);
  await drainUpgrades(table);
  assert.equal(said(table, "Cal").some((l) => /\bim (cop|journalist)\b/.test(l)), false);
  assert.deepEqual(notes.filter(([who]) => who === seat("Cal").acc).map(([, w]) => w), ["drop: cop already claimed by ash"]);
});

test("item 2: a delayed ballot sends the seat's latest pick when it changed and is legal, else the queued one", async () => {
  const { table, all } = await planDay(4);
  for (let k = 1; k <= 30; k++) await all("time", { time: 300_000 - k * 5_000 }, T0 + k * 5_000);
  await drainUpgrades(table);
  const before = table.proposed.length;
  const updates = [];
  table.onBallotUpdate = (who, from, to) => updates.push([who, from, to]);
  // Two seats queue their first ballot; before it goes out, their pick moves (one legal, one illegal: self).
  await all("time", { time: 110_000 }, T0 + 190_000);
  const bea = seat("Bea"), eli = seat("Eli");
  const k = (s) => `${s.acc}|${table.views[s.acc].stateId}|vil`;
  assert.ok(table.pendingVotes?.[k(bea)] > 0 && table.pendingVotes?.[k(eli)] > 0, "both ballots are queued");
  table.latestPick[k(bea)] = seat("Hap").pid;
  table.latestPick[k(eli)] = eli.pid;
  await drainUpgrades(table);
  const ballot = (s) => table.proposed.slice(before).filter((p) => p.event === "vote" && p.data.meetingId === "vil" && p.accountId === s.acc).at(-1);
  assert.equal(ballot(bea).data.selection, seat("Hap").pid, "latest legal pick sent");
  assert.notEqual(ballot(eli).data.selection, eli.pid, "an illegal latest pick is not sent");
  assert.deepEqual(updates.filter(([who]) => who === bea.acc).map(([, , to]) => to), [seat("Hap").pid]);
});
