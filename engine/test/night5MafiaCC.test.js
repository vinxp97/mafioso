// Night 5 (Vinman 10/20, relayed by Nightshift): 2) one mafia member counterclaims the Sheriff's asked Cop/Journalist claimer, once, a few seconds later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, sheriffShotReady, shotStatus, validateAction, SHERIFF_ASK, mafiaCounterclaim, mafiaCounterclaimer, MAFIA_CC, chatAudit } from "../src/index.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const timer = { event: "timerInfo", t: 0, data: { name: "main", delay: 600_000 } };
const at = (v, t) => reduce(v, { event: "time", t, data: { name: "main", time: 600_000 - t } });
const sheriffDay = (extra = []) => reduceAll([
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role: "Sheriff" } },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 }, timer,
  { event: "meeting", data: { id: "gun", name: "Shoot Gun", voting: true, canVote: true, amMember: true, targets: ids.filter((x) => x !== "p1"), votes: {} } },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  say("p1", "im sheriff", 1_000), ...["p2", "p3", "p4", "p5", "p6", "p7"].map((p, i) => say(p, "hmm idk", 2_000 + i)), ...extra,
]);

// ---- 2) mafia counterclaim on an asked power-role claimer ----
const MATES = [{ id: "p6", name: "Eve", role: "Janitor" }, { id: "p7", name: "Fay", role: "Lawyer" }];
const mafiaSeat = (self, role, extra = [], mates = MATES.filter((m) => m.id !== self).concat(self === "p5" ? [] : [{ id: "p5", name: "Dan", role: "Mafioso" }])) => reduceAll([
  { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role } },
  { event: "teammates", data: mates.filter((m) => m.id !== self) },
  { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  say("p1", "im sheriff", 1_000), say("p2", "hi", 2_000), ...extra,
]);
const SEATS = [["p5", "Mafioso"], ["p6", "Janitor"], ["p7", "Lawyer"]];

test("2: one mafia member (the same pick on every mafia seat, not the Janitor) counterclaims, 3-7s after the answer", () => {
  for (const role of ["cop", "journalist"]) {
    const ask = [say("p1", "cat claim?", 30_000), say("p4", `im ${role}`, 31_000)];
    const out = SEATS.map(([self, r]) => mafiaCounterclaim(mafiaSeat(self, r, ask), { now: 31_500 }));
    const speakers = out.filter(Boolean);
    assert.equal(speakers.length, 1, `${role}: exactly one counterclaimer, got ${JSON.stringify(out)}`);
    const picks = SEATS.map(([self, r]) => mafiaCounterclaimer(mafiaSeat(self, r, ask), "p4"));
    assert.equal(new Set(picks).size, 1, "every mafia seat agrees on who");
    assert.notEqual(picks[0], "p6", "the Janitor is not the counterclaimer when another mate can");
    const cc = speakers[0];
    assert.equal(cc.role.toLowerCase(), role);
    assert.match(cc.line, new RegExp(`^Cat is lying, im the real ${role}$`));
    assert.doesNotMatch(cc.line, /\bme\b|sheriff/i, "never names or accuses the Sheriff");
    assert.ok(cc.at - 31_000 >= MAFIA_CC.minMs && cc.at - 31_000 <= MAFIA_CC.maxMs, `beat ${cc.at - 31_000}ms`);
    // It passes the claim gate and chatAudit for the chosen seat.
    const who = SEATS.find(([self]) => self === picks[0]);
    const view = mafiaSeat(who[0], who[1], ask);
    assert.equal(validateAction(view, { event: "speak", data: { meetingId: "mVil", content: cc.line } }).ok, true, JSON.stringify(validateAction(view, { event: "speak", data: { meetingId: "mVil", content: cc.line } })));
  }
});

test("2: only once, never on a teammate's claim, never when already contested, never for Sheriff, never late", () => {
  const ask = [say("p1", "cat claim?", 30_000), say("p4", "im cop", 31_000)];
  const pick = mafiaCounterclaimer(mafiaSeat("p5", "Mafioso", ask), "p4");
  const seatOf = (extra) => { const [self, r] = SEATS.find(([s]) => s === pick); return mafiaSeat(self, r, extra); };
  assert.ok(mafiaCounterclaim(seatOf(ask), { now: 32_000 }));
  // Sent: nobody counterclaims again (the faction's one CC).
  const name = players[pick].name;
  assert.equal(SEATS.map(([s, r]) => mafiaCounterclaim(mafiaSeat(s, r, [...ask, say(pick, "Cat is lying, im the real cop", 35_000)]), { now: 36_000 })).filter(Boolean).length, 0, name);
  // A teammate was asked and fake-claimed Cop: no CC on our own claim.
  const mate = [say("p1", "fay claim?", 30_000), say("p7", "im cop", 31_000)];
  assert.equal(SEATS.map(([s, r]) => mafiaCounterclaim(mafiaSeat(s, r, mate), { now: 32_000 })).filter(Boolean).length, 0);
  // Already counterclaimed by town: no CC.
  const contested = [...ask, say("p3", "cat is lying, im cop", 32_000)];
  assert.equal(SEATS.map(([s, r]) => mafiaCounterclaim(mafiaSeat(s, r, contested), { now: 33_000 })).filter(Boolean).length, 0);
  // A Sheriff answer is never counterclaimed (and Villager answers need none).
  for (const ans of ["im sheriff", "im villager"]) {
    const x = [say("p1", "cat claim?", 30_000), say("p4", ans, 31_000)];
    assert.equal(SEATS.map(([s, r]) => mafiaCounterclaim(mafiaSeat(s, r, x), { now: 32_000 })).filter(Boolean).length, 0, ans);
  }
  // Past the Sheriff's counterclaim window: too late.
  assert.equal(mafiaCounterclaim(seatOf(ask), { now: 31_000 + SHERIFF_ASK.ccMs }), null);
  // Town seats never counterclaim through this rule.
  const town = reduceAll([{ event: "self", data: "p3" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p3", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 1" } }, say("p1", "im sheriff", 1_000), ...ask]);
  assert.equal(mafiaCounterclaim(town, { now: 32_000 }), null);
});

test("2: the counterclaim makes the claim contested for the Sheriff (so the gun can test it)", () => {
  let v = at(sheriffDay([say("p1", "cat claim?", 130_000), say("p4", "im journalist", 131_000)]), 132_000);
  assert.equal(shotStatus(v, "p4").status, "pending-cc");
  v = at(reduce(v, say("p6", "Cat is lying, im the real journalist", 135_000)), 136_000);
  assert.equal(shotStatus(v, "p4").status, "contested");
  // 10/20 2:02pm: an asked answer and an unprompted counter is a weak pair: he waits for reads and the vote,
  // and with no vote on either shoots one of the two at the deadline.
  assert.match(sheriffShotReady(v).reason, /waiting on the Journalist claims/);
  const late = sheriffShotReady(at(v, 520_000));
  assert.equal(late.ok, true, late.reason);
  assert.ok(["p4", "p6"].includes(late.target));
});

