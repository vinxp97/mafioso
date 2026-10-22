// Night 5 (Vinman 10/20, relayed by Nightshift): 3) a Cop claim is ONE line with its report; 5) town claims say
// villager or blue, never vt. Every path: model text, rules lines, line breaks, the chat cap, the word cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, reduce, validateAction, chatShorten, capSpeechWords, humanizeSpeak, finalSpeak, rewriteVt, vtLeft, copSecondLine, joinCopLines, fitCopLine, isCopClaim, askReplyLine, roleClaimLine, VILLAGER_DEFENSES } from "../src/index.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const at = (v, t) => reduce(v, { event: "time", t, data: { name: "main", time: 600_000 - t } });

// ---- 3) the Cop claim is one line ----
const copSeat = (extra = [], night = []) => reduceAll([
  { event: "self", data: "p2" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p2", role: "Cop" } },
  { event: "state", data: { id: 2, name: "Night 1" }, t: 0 }, ...night,
  { event: "state", data: { id: 3, name: "Day 1" }, t: 1_000 },
  { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  say("p1", "im sheriff", 2_000), ...extra,
]);

test("3: line breaks, a results: second line, list markup: all become one Cop line with the report", () => {
  for (const [raw, want] of [
    ["im cop\nbob guilty", "im cop. bob guilty"],
    ["im cop.\nresults: bob guilty", "im cop. bob guilty"],
    ["im cop\n- bob guilty\n- cat inno", "im cop. bob guilty. cat inno"],
    ["\"im the real cop\nbob inno\"", "im the real cop. bob inno"],
  ]) {
    const out = chatShorten(raw);
    assert.equal(out, want, JSON.stringify(raw));
    assert.doesNotMatch(out, /\n/);
  }
  assert.equal(joinCopLines("im cop"), "im cop");
  // A non-Cop line keeps the first-line rule (unchanged default).
  assert.equal(chatShorten("bob is sus\nvote him"), "bob is sus");
});

test("3: over the chat cap the Cop line drops whole result items (inno first), never the report or a name", () => {
  const long = "im cop. " + ["AaaaaaaaaaaaaaaaaaaaaaA1 inno", "BbbbbbbbbbbbbbbbbbbbbbB2 guilty", "CccccccccccccccccccccccC3 inno"].join(", ");
  const out = chatShorten(long, 80);
  assert.ok(out.length <= 80, out);
  assert.match(out, /^im cop\. BbbbbbbbbbbbbbbbbbbbbbB2 guilty/, "the guilty stays");
  for (const n of ["AaaaaaaaaaaaaaaaaaaaaaA1", "CccccccccccccccccccccccC3"]) assert.ok(!out.includes(n.slice(0, 5)) || out.includes(n), `no half name: ${out}`);
  // The old first-sentence cut would have left "im cop." alone.
  assert.notEqual(out, "im cop.");
  assert.equal(fitCopLine("im cop. BobbyLongname99 guilty", 80), "im cop. BobbyLongname99 guilty");
  // The model's 12-word cap does not cut a Cop report either.
  const words = "im cop. aa inno, bb inno, cc inno, dd inno, ee guilty, ff inno";
  assert.equal(capSpeechWords(words), words);
  assert.equal(capSpeechWords("one two three four five six seven eight nine ten eleven twelve thirteen").split(" ").length, 12);
});

test("3: a second same-day Cop line is blocked; a guilty that landed after the claim is the one exception", () => {
  const v = copSeat([say("p2", "im cop. bob inno", 3_000)]);
  for (const line of ["im cop. bob inno", "results: bob inno", "bob inno", "im the real cop, bob inno"]) {
    assert.match(copSecondLine(v, line) || "", /one line/, line);
    assert.match(validateAction(v, { event: "speak", data: { meetingId: "mVil", content: line } }).reason || "", /one line|repeat|similar/, line);
  }
  assert.equal(copSecondLine(v, "im cop. cat guilty"), null, "a new guilty must still reach town");
  assert.equal(copSecondLine(v, "dan is lying"), null, "a call-out is not a Cop line");
  assert.equal(copSecondLine(v, "vote cat"), null);
  // Lines not echoed yet count too (live: our own send is still on its way).
  const fresh = copSeat();
  assert.match(copSecondLine(fresh, "results: bob inno", { sent: ["im cop. bob inno"] }) || "", /one line/);
  // Next day is a new line (a new night's report).
  const d2 = reduce(reduce(v, { event: "state", data: { id: 5, name: "Day 2" }, t: 400_000 }), say("p1", "ok", 401_000));
  assert.equal(copSecondLine(d2, "im cop. cat inno"), null);
});

test("3: the Cop's rules claim and its Sheriff-ask answer are one line with the report", () => {
  const night = [{ event: "message", t: 500, data: { senderId: "server", content: "Your investigation shows that Bob is Innocent" } }];
  const v = copSeat([], night);
  const line = roleClaimLine(v);
  assert.match(line, /^im cop\. bob inno$/i);
  assert.ok(!/\n/.test(line) && isCopClaim(line));
  const asked = copSeat([say("p1", "alice claim?", 30_000)], night);
  assert.match(askReplyLine(asked), /^im cop\. bob inno/i);
});

// ---- 5) town claims never say vt ----
test("5: every vt / v/t token becomes villager on the way out; names are untouched", () => {
  const vtName = { ...players, p8: { id: "p8", name: "Vt-Rex" } };
  const v = reduceAll([{ event: "self", data: "p3" }, { event: "players", data: vtName }, { event: "roleReveal", data: { playerId: "p3", role: "Villager" } },
    { event: "state", data: { id: 3, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...Object.keys(vtName), "*"], votes: {} } }]);
  const out = (t) => finalSpeak(v, { event: "speak", data: { meetingId: "mVil", content: t } }).data.content;
  for (const [raw, want] of [
    ["im vt", "im villager"], ["me im vt", "me im villager"], ["vt", "villager"], ["VT here", "villager here"], ["im v/t", "im villager"],
    ["just vt, not cop", "just villager, not cop"], ["im vt. dan is sus", "im villager. dan is sus"], ["all the vts should vote dan", "all the villagers should vote dan"],
    ["im town", "im villager"], ["i'm just a townie lol", "i'm just a villager lol"], ["im vanilla", "im villager"],
  ]) {
    assert.equal(out(raw).toLowerCase(), want.toLowerCase(), raw);
    assert.equal(vtLeft(v, out(raw)), null, raw);
  }
  // Untouched: blue, villager, town reads, and a player literally named vt.
  for (const t of ["im blue", "im villager", "bob is a town read", "Vt-Rex is sus", "vote Vt-Rex"]) assert.equal(out(t).toLowerCase(), t.toLowerCase(), t);
  assert.equal(rewriteVt(v, "vt-rex claim?"), "vt-rex claim?");
});

test("5: every rules claim source says villager or blue: ask replies, defenses, mafia villager claims", () => {
  const asked = (role, mates = []) => {
    const v = reduceAll([{ event: "self", data: "p4" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p4", role } },
      ...(mates.length ? [{ event: "teammates", data: mates }] : []), { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
      { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
      say("p1", "im sheriff", 1_000), say("p1", "cat claim?", 30_000)]);
    v.config = { ...(v.config || {}), mafia: "adaptive" };
    return v;
  };
  const lines = [askReplyLine(asked("Villager")), askReplyLine(asked("Mafioso", [{ id: "p6", name: "Eve", role: "Janitor" }])), ...VILLAGER_DEFENSES];
  for (const l of lines) {
    assert.ok(l, "a line");
    assert.doesNotMatch(l, /\bv\/?t\b/i, l);
  }
  for (const l of VILLAGER_DEFENSES) assert.match(l, /\b(villager|blue)\b/i, l);
  // A model line saying vt is rewritten before validation, and a raw vt line is refused at validation.
  const v = asked("Villager");
  const fixed = humanizeSpeak(v, { event: "speak", data: { meetingId: "mVil", content: "me im vt" } });
  assert.match(fixed.data.content, /^me im villager$/i);
  assert.equal(validateAction(v, fixed).ok, true);
  assert.match(validateAction(v, { event: "speak", data: { meetingId: "mVil", content: "me im vt" } }).reason, /villager or blue|vt/);
});
