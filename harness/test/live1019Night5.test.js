// Legal actions on the sanitized live games L9 and L10 (test/fixtures/live-1019), judged by the Night 5 claim
// rules (Vinman 10/20): every bot pick at every decision point is server-legal and passes the rules; the Sheriff
// holds on a villager/blue answer; a Cop claim is one line; the Sheriff's day-start claim waits 1-10s; a town
// claim says villager or blue, never vt. L9 has no living Sheriff (killed and cleaned Night 1); its fixture hands
// the Sheriff role to p08, the pinned --alert-roles builder gap (stateReplay.test.js), so the Sheriff rules are
// checked on L10.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reduce, emptyView, createSeededRng, shotStatus, sheriffShotReady, validateAction, SHERIFF_ASK, isCopClaim, copSecondLine, vtLeft, rewriteVt, claimedRoleIn, askReplyLine } from "mafioso-engine";
import { createBotTable, onGameEntry, drainUpgrades, createLlmLimiter, sendGuardBlock, claimLineFor, SHERIFF_CLAIM_DELAY } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";
import { picks } from "./legalPicks.helper.js";

const dir = new URL("./fixtures/live-1019/", import.meta.url);
const load = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const L9 = load("l09.jsonl"); const L10 = load("l10.jsonl");
const rolesOf = (entries) => Object.fromEntries(entries.filter((e) => e.event === "roleReveal").map((e) => [e.data.playerId, e.data.role]));
const accOf = (entries, pid) => entries.find((e) => e.event === "self" && e.data === pid).accountId;
const TOWN = new Set(["Villager", "Cop", "Journalist", "Sheriff"]);

/** Each public line once, in the speaker's own view just before it arrived: [view, frame]. */
function ownLines(entries) {
  const views = {}; const out = [];
  for (const e of entries) {
    const v = views[e.accountId] || emptyView();
    if (e.event === "message" && e.data.senderId === v.selfId && v.meetings?.[e.data.meetingId]?.name === "Village") out.push([v, e]);
    views[e.accountId] = reduce(v, e);
  }
  return out;
}

test("L9, L10: at every decision point every bot pick is server-legal and passes the rules", async () => {
  for (const [name, entries, min] of [["l09", L9, 400], ["l10", L10, 230]]) {
    const r = await picks(entries);
    assert.deepEqual(r.bad, [], name);
    assert.ok(r.points >= min && r.checked >= 5 * min, `${name}: ${r.points} decision points, ${r.checked} picks`);
  }
});

// ---- 1) the Sheriff vs a villager/blue answer ----
const sheriffAcc = accOf(L10, Object.entries(rolesOf(L10)).find(([, r]) => r === "Sheriff")[0]);
const SHOT = new Set(["gunshot", "death", "deathSounds", "obituaries", "reveal", "isSpectator"]);

test("L10 as played: the Sheriff shot a counterclaimed power claim (contested), not a villager answer", () => {
  let v = emptyView();
  for (const e of L10.filter((x) => x.accountId === sheriffAcc)) {
    if (e.event === "vote" && e.data.meetingId === "m08") {
      assert.equal(e.data.target, "p07");
      assert.deepEqual([shotStatus(v, "p07").status, shotStatus(v, "p07").role], ["contested", "Journalist"]);
      return;
    }
    v = reduce(v, e);
  }
  assert.fail("no shot in L10");
});

test("L10 with a villager/blue answer: the Sheriff holds; no shot on the claimer for the rest of the day, then it opens", () => {
  // The asked p07 answers like town instead of a fake Journalist claim, and p08's counterclaim and the shot are cut.
  for (const answer of ["im villager", "blue", "just a townie, im blue", "im vt"]) {
    let v = emptyView(); let at = null; let points = 0;
    for (const e0 of L10.filter((x) => x.accountId === sheriffAcc)) {
      let e = e0;
      if (e.event === "state" && e.data.name === "Night 2") break;
      if (e.event === "message" && e.data.senderId === "p07" && /^im journalist/.test(e.data.content)) { e = { ...e, data: { ...e.data, content: answer } }; at = e.t; }
      if (at != null && ((e.event === "message" && (e.data.senderId === "p08" && /lying/.test(e.data.content) || /:gun:/.test(e.data.content))) || (e.event === "vote" && e.data.meetingId === "m08") || (SHOT.has(e.event) && JSON.stringify(e.data ?? "").includes("p07")))) continue;
      v = reduce(v, e);
      if (at == null || e.event !== "message") continue;
      points += 1;
      assert.equal(shotStatus(v, "p07").status, "pending-vt", `${answer} @${e.t - at}ms`);
      const r = sheriffShotReady(v);
      assert.ok(!(r.ok && r.target === "p07"), `${answer}: shot the held claimer: ${r.why}`);
      assert.equal(validateAction(v, { event: "vote", data: { meetingId: "m08", selection: "p07" } }).ok, false, answer);
    }
    assert.ok(points >= 3, `${answer}: ${points} lines checked during the hold`);
    assert.equal(shotStatus(v, "p07", { now: at + SHERIFF_ASK.vtHoldMaxMs }).status, "open", `${answer}: open once the hold is over`);
  }
});

// ---- 3) one Cop line ----
test("L9, L10: every Cop claim said is one line with its report; a split or a second same-day Cop line is blocked", () => {
  let n = 0;
  for (const entries of [L9, L10]) {
    for (const [v, e] of ownLines(entries).filter(([, x]) => isCopClaim(x.data.content))) {
      n += 1;
      const text = e.data.content;
      const table = { proposed: [] };
      const p = (content) => ({ accountId: e.accountId, event: "speak", data: { meetingId: e.data.meetingId, content } });
      assert.doesNotMatch(text, /[\r\n]/);
      assert.match(text, /\b(guilty|inno|innocent)\b/i, `the claim carries the report: ${text}`);
      assert.equal(sendGuardBlock(table, e.accountId, v, p(text), "replay"), false, text);
      const [claim, ...rest] = text.split(/\.\s+/);
      assert.equal(sendGuardBlock(table, e.accountId, v, p(`${claim}\n${rest.join(". ")}`), "replay"), true, "split over two lines");
      const after = reduce(v, e);
      assert.ok(copSecondLine(after, `results: ${rest.join(". ")}`), "the report again on its own line");
    }
  }
  assert.equal(n, 3, "L9: the fake Cop and the real Cop's counterclaim; L10: the Cop");
  // The bots' own Cop line in L10 (Day 1, report in hand) is one line with the guilty.
  const copAcc = accOf(L10, "p06"); let v = emptyView(); const lines = new Set();
  for (const e of L10.filter((x) => x.accountId === copAcc)) { v = reduce(v, e); if (v.phase?.name === "Day 1" && isCopClaim(claimLineFor(v) || "")) lines.add(claimLineFor(v)); }
  // Case-insensitive: PR #17 writes exact-cased names.
  assert.deepEqual([...lines].map((l) => l.toLowerCase()), ["im cop. player07 guilty"]);
});

// ---- 4) the Sheriff's day-start claim delay ----
test("L10: the Sheriff's day-start claim waits 1-10s after Day 1 starts, seeded, re-rolled per game", async () => {
  const mine = L10.filter((e) => e.accountId === sheriffAcc);
  const day = mine.findIndex((e) => e.event === "state" && e.data.name === "Day 1");
  const firstOwn = mine.findIndex((e, i) => i > day && e.event === "message" && e.data.senderId === "p03");
  const delays = [];
  for (const seed of [1, 2, 3, 4]) {
    const clock = createVirtualClock(mine[0].t);
    const table = createBotTable([{ accountId: sheriffAcc }], { clock, rng: createSeededRng(3), sheriffDelayRng: createSeededRng(seed) });
    for (const e of mine.slice(0, firstOwn)) {
      if (e.t > clock.now()) clock.advance(e.t - clock.now());
      await onGameEntry(table, e, { complete: async () => "hmm", dryRun: true, fast: true, limiter: createLlmLimiter(1), now: e.t });
    }
    await drainUpgrades(table);
    const claim = table.proposed.find((p) => p.event === "speak" && claimedRoleIn(p.data.content) === "sheriff");
    assert.ok(claim, `seed ${seed}`);
    const ms = claim.t - mine[day].t;
    assert.equal(ms, table.sheriffClaimDelayMs);
    assert.ok(ms >= SHERIFF_CLAIM_DELAY.minMs && ms <= SHERIFF_CLAIM_DELAY.maxMs, `seed ${seed}: ${ms}ms`);
    delays.push(ms);
  }
  assert.ok(new Set(delays).size > 1, `re-rolled: ${delays}`);
  // As played (old code), the claim was the Sheriff's first line, about 2.5s of fixture time in: the builder
  // spaces frames 37ms apart, so the live 0.3s (Night 5 eval) does not survive the rebuild. Not a timing source.
});

// ---- 5) villager or blue, never vt ----
test("L9, L10: every town claim said is villager or blue, never vt; a vt version is rewritten to villager", () => {
  const said = [];
  for (const entries of [L9, L10]) for (const [v, e] of ownLines(entries)) {
    const text = e.data.content;
    assert.equal(vtLeft(v, text), null, text);
    if (claimedRoleIn(text) !== "villager") continue;
    said.push(text);
    assert.match(text, /\b(villager|blue)\b/i, text);
    assert.equal(rewriteVt(v, text), text, "already clean");
    const vt = text.replace(/\bvillager\b/i, "vt");
    if (vt !== text) assert.equal(rewriteVt(v, vt), text.replace(/\bvillager\b/i, "villager"), vt);
  }
  assert.deepEqual(said, ["im just a villager, no power role. not me", "im a plain villager, youre on the wrong person", "im villager, Player04 looks railroaded and deserves a recheck",
    "Player08 i'm villager, could you explain what the report actually said?", "just a townie, im blue. find a better target"]);
});

test("L10: every town seat the Sheriff asks instead answers villager or blue (never vt)", () => {
  // Re-aim the Sheriff's Day 1 ask ("Player07 what are you") at each living town seat and read that seat's reply.
  const roles = rolesOf(L10);
  const asked = [];
  for (const [pid, role] of Object.entries(roles).filter(([p, r]) => TOWN.has(r) && r !== "Sheriff" && p !== "p09")) {
    const acc = accOf(L10, pid); let v = emptyView();
    for (const e0 of L10.filter((x) => x.accountId === acc)) {
      const ask = e0.event === "message" && e0.data.senderId === "p03" && /what are you/.test(e0.data.content);
      const e = ask ? { ...e0, data: { ...e0.data, content: `Player${pid.slice(1)} what are you` } } : e0;
      v = reduce(v, e);
      if (!ask) continue;
      const line = askReplyLine(v);
      asked.push([role, line]);
      assert.equal(vtLeft(v, line), null, line);
      if (role === "Villager") assert.match(line, /\b(villager|blue)\b/i, line);
      break;
    }
  }
  assert.deepEqual(asked.map(([r]) => r).sort(), ["Cop", "Journalist", "Villager", "Villager"]);
});
