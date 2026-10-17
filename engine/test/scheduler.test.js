import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEECH_SYSTEM,
  reduceAll, reduce, validateAction, decideSpeech, scheduleSpeech, speechCap,
  generatePublicSpeech, proposeSeatActions, rulesSeatActions, SYSTEM_PROMPT,
} from "../src/index.js";

const players = {
  p1: { id: "p1", name: "Me" },
  p2: { id: "p2", name: "Alice" },
  p3: { id: "p3", name: "Bob" },
};

function day(extra = [], self = "p1") {
  return reduceAll([
    { event: "self", data: self },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role: "Cop" } },
    { event: "state", data: { id: 1, name: "Day 1" } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
    ...extra,
  ]);
}

const chat = (senderId, content, t, meetingId = "mVil") => ({
  event: "message", t, data: { senderId, content, meetingId, t },
});

test("urgency 4 after being named speaks, and the other seat does not", () => {
  const named = day([chat("p2", "vote Me, I think Me is mafia", 10)]);
  const sched = decideSpeech(named, { now: 10_000 });
  assert.equal(sched.urgency, 4);
  assert.equal(sched.speak, true);
  assert.equal(sched.path, "addressed");
  assert.equal(sched.meetingId, "mVil");

  const other = day([], "p2");
  const idle = decideSpeech(other, { now: 10_000 });
  assert.equal(idle.speak, false);
  assert.equal(idle.urgency, 0);
  reduce(named, chat("p3", "vote Alice too", 11));
  const again = decideSpeech(other, { now: 10_000 });
  assert.equal(again.speak, false);
  assert.equal(again.urgency, 0);
  assert.equal(other.messages.length, 0);
});

test("high own message rate takes the quiet path; a matched rate still speaks", () => {
  const own = [0, 1000, 2000, 3000].map((t, i) => chat("p1", `thought ${i}`, t));
  const loud = day([
    ...own,
    chat("p2", "ok", 500),
    { event: "vote", t: 4000, data: { meetingId: "mVil", voterId: "p2", target: "p3" } },
  ]);
  const quiet = decideSpeech(loud, { now: 120_000 });
  assert.equal(quiet.urgency, 2);
  assert.equal(quiet.amendment, "quiet");
  assert.equal(quiet.path, "quiet");
  assert.equal(quiet.speak, false);

  const even = day([
    chat("p1", "one thought", 1000),
    chat("p2", "hello", 2000),
    chat("p3", "same", 3000),
    { event: "vote", t: 4000, data: { meetingId: "mVil", voterId: "p2", target: "p3" } },
  ]);
  const balanced = decideSpeech(even, { now: 120_000 });
  assert.equal(balanced.amendment, "balanced");
  assert.equal(balanced.urgency, 2);
  assert.equal(balanced.speak, true);
});

test("rate cap rejects spam even when named", () => {
  const spam = day([
    chat("p1", "a", 10_000),
    chat("p1", "b", 20_000),
    chat("p1", "c", 40_000),
    chat("p1", "d", 45_000),
    chat("p1", "e", 47_000),
    chat("p1", "f", 49_000),
    chat("p2", "vote Me", 50_000),
  ]);
  const capped = decideSpeech(spam, { now: 59_000 });
  assert.equal(capped.urgency, 4);
  assert.equal(capped.capped, true);
  assert.equal(capped.speak, false);
  assert.equal(capped.path, "capped");
  assert.match(capped.reason, /rate limit|cooldown/);
  assert.equal(speechCap(spam, { now: 59_000 }).ok, false);

  const cooled = day([
    chat("p1", "a", 1_000),
    chat("p2", "vote Me", 2_000),
  ]);
  const held = decideSpeech(cooled, { now: 3_000 });
  assert.equal(held.urgency, 4);
  assert.equal(held.reason, "cooldown");
  assert.equal(held.speak, false);
});

test("generator uses the seat briefing and validateAction still gates the line", async () => {
  const named = day([chat("p2", "vote Me", 5_000)]);
  assert.equal(decideSpeech(named, { now: 20_000 }).speak, true);
  const calls = [];
  const complete = async (prompt) => {
    calls.push(prompt);
    return JSON.stringify({ action: "speak", meeting: "mVil", text: "Not me. Alice is forcing a mislynch." });
  };
  const spoken = await generatePublicSpeech(named, { complete, now: 20_000 });
  assert.equal(calls.length, 1);
  // Short chat prompt: own voice, recent chat, who to answer; capped output.
  assert.equal(calls[0].system, SPEECH_SYSTEM);
  assert.equal(calls[0].maxTokens, 40);
  assert.match(calls[0].user, /voice:/);
  assert.match(calls[0].user, /chat:/);
  assert.ok(calls[0].user.length < 900, `prompt ${calls[0].user.length} chars`);
  assert.ok(spoken.action.data.content.length <= 80);
  assert.equal(validateAction(named, spoken.action).ok, true);
  assert.equal(spoken.action.event, "speak");

  const rejected = await generatePublicSpeech(named, {
    now: 20_000,
    maxRetries: 0,
    complete: async () => JSON.stringify({ action: "speak", meeting: "mVil", text: "PLAN kill=Bob speaker=me" }),
  });
  assert.equal(rejected.action, null);
  assert.match(rejected.rejections.join(" "), /machine text|public leak/);
  const long = await generatePublicSpeech(named, { now: 20_000, maxRetries: 0, complete: async () => "x ".repeat(200) });
  assert.ok(long.action.data.content.length <= 80, "long replies are cut to the chat cap");

  const idle = day();
  let used = 0;
  const skipped = await generatePublicSpeech(idle, { now: 20_000, complete: async () => { used += 1; return "{}"; } });
  assert.equal(decideSpeech(idle).speak, false);
  assert.equal(skipped.action, null);
  assert.equal(used, 0);
});

test("scheduler wait does not block a day vote or a night action", async () => {
  const idle = day();
  assert.equal(decideSpeech(idle).speak, false);
  const voted = await proposeSeatActions(idle, {
    now: 1_000,
    complete: async () => '{"action":"vote","meeting":"mVil","target":"p3"}',
  });
  assert.ok(voted.actions.some((action) => action.event === "vote" && action.data.selection === "p3"));
  assert.equal(voted.actions.some((action) => action.event === "speak"), false);

  const night = reduceAll([
    { event: "self", data: "p1" },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Cop" } },
    { event: "state", data: { id: 2, name: "Night 1" } },
    { event: "meeting", data: { id: "mN", name: "Investigate", voting: true, canVote: true, amMember: true, targets: ["p1", "p2", "p3", "*"], votes: {} } },
  ]);
  assert.equal(decideSpeech(night).speak, false);
  const acted = await proposeSeatActions(night, {
    complete: async () => '{"action":"vote","meeting":"mN","target":"p2"}',
  });
  assert.deepEqual(acted.actions, [{ event: "vote", data: { meetingId: "mN", selection: "p2" } }]);
});

test("approved speech still keeps the vote, and a capped seat does not speak", async () => {
  const named = day([chat("p2", "vote Me", 5_000)]);
  const plan = await proposeSeatActions(named, {
    now: 20_000,
    complete: async ({ purpose }) => purpose === "speech"
      ? '{"action":"speak","meeting":"Village","text":"I checked nobody. Do not lynch me."}'
      : '{"action":"vote","meeting":"mVil","target":"p3"}',
  });
  assert.equal(plan.schedule.urgency, 4);
  assert.ok(plan.actions.some((action) => action.event === "vote" && action.data.selection === "p3"));
  const line = plan.actions.find((action) => action.event === "speak");
  assert.equal(validateAction(named, line).ok, true);
  assert.match(line.data.content, /^alice .*checked nobody/i, "answers the player who pushed it");

  const spam = day([
    chat("p1", "a", 10_000),
    chat("p1", "b", 20_000),
    chat("p1", "c", 40_000),
    chat("p1", "d", 45_000),
    chat("p1", "e", 47_000),
    chat("p1", "f", 49_000),
    chat("p2", "vote Me", 50_000),
  ]);
  let calls = 0;
  const held = await proposeSeatActions(spam, {
    now: 59_000,
    complete: async () => { calls += 1; return '{"action":"speak","meeting":"mVil","text":"again"}'; },
  });
  assert.equal(held.schedule.speak, false);
  assert.equal(held.actions.some((action) => action.event === "speak"), false);
  assert.ok(held.actions.some((action) => action.event === "vote"));
  assert.ok(calls >= 1);
});

test("optional scheduler model can wait on a fuzzy line and cannot beat a cap", async () => {
  const thought = day([chat("p2", "hello", 1_000), chat("p3", "yeah", 2_000)]);
  const engine = decideSpeech(thought, { now: 30_000 });
  assert.equal(engine.urgency, 1);
  assert.equal(engine.amendment, "talkative");
  assert.equal(engine.speak, true);
  const veto = await scheduleSpeech(thought, {
    now: 30_000,
    complete: async () => '{"urgency":1,"speak":false,"reason":"hold"}',
  });
  assert.equal(veto.speak, false);

  const spam = day([
    chat("p1", "a", 10_000),
    chat("p1", "b", 20_000),
    chat("p1", "c", 40_000),
    chat("p1", "d", 45_000),
    chat("p1", "e", 47_000),
    chat("p1", "f", 49_000),
    chat("p2", "vote Me", 50_000),
  ]);
  let calls = 0;
  const blocked = await scheduleSpeech(spam, {
    now: 59_000,
    complete: async () => { calls += 1; return '{"urgency":4,"speak":true}'; },
  });
  assert.equal(calls, 0);
  assert.equal(blocked.speak, false);
  assert.equal(blocked.capped, true);
});

test("faction night speech and the day claim still follow this seat only", async () => {
  const night = reduceAll([
    { event: "self", data: "p1" },
    { event: "players", data: { ...players, p4: { id: "p4", name: "Cat" } } },
    { event: "roleReveal", data: { playerId: "p1", role: "Mafioso" } },
    { event: "roleReveal", data: { playerId: "p2", role: "Godfather" } },
    { event: "state", data: { id: 2, name: "Night 1" } },
    { event: "meeting", data: { id: "mMaf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, targets: ["p3", "p4", "*"], votes: {}, members: [{ id: "p1" }, { id: "p2" }] } },
  ]);
  assert.equal(decideSpeech(night).path, "idle");
  const planned = rulesSeatActions(night);
  assert.ok(planned.actions.some((action) => action.event === "speak" && /^kill \S+ tonight/.test(action.data.content) && !/PLAN|=/.test(action.data.content)));
  assert.ok(planned.actions.some((action) => action.event === "vote" && action.data.meetingId === "mMaf"));

  let daySeat = reduce(night, { event: "message", data: { senderId: "p1", meetingId: "mMaf", content: "PLAN kill=p4 lynch=p3 claim=Cop lawyer=p4 speaker=p1" } });
  daySeat = reduce(daySeat, { event: "state", data: { id: 3, name: "Day 1" } });
  daySeat = reduce(daySeat, { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p4", "p3", "p2", "*"], votes: {} } });
  const claim = rulesSeatActions(daySeat);
  assert.equal(claim.schedule.urgency, 3);
  assert.equal(claim.schedule.speak, true);
  assert.ok(claim.actions.some((action) => action.data.content === "I'm Cop. Vote p3."));
  assert.ok(claim.actions.some((action) => action.event === "vote" && action.data.selection === "p3"));
  const generated = await proposeSeatActions(daySeat, {
    maxRetries: 0,
    complete: async ({ user, purpose }) => (purpose === "speech" ? '{"action":"vote"}' : '{"action":"vote","meeting":"mVil","target":"p3"}'),
  });
  assert.ok(generated.actions.some((action) => action.event === "vote" && action.data.selection === "p3"));
  assert.ok(generated.actions.some((action) => action.event === "speak" && /Bob/.test(action.data.content)), JSON.stringify(generated.actions));
});

import { varyOpener, personaOf } from "../src/chatStyle.js";
import { createSeededRng } from "../src/selector.js";
test("openers vary: a room full of 'tbh <name>' does not get another one", () => {
  const msgs = ["tbh gusena u seem sus", "tbh gusena you seem shady", "gusena what are you seeing tbh"].map((content, i) => ({ senderId: `s${i}`, meetingId: "v", content }));
  let tbh = 0;
  const rng = createSeededRng(5);
  for (let i = 0; i < 50; i++) {
    const out = varyOpener({ selfId: `me${i}`, messages: msgs }, "tbh gusena why so quiet", rng, "v");
    if (/\btbh\b/i.test(out)) tbh++;
    assert.match(out, /gusena why so quiet/);
  }
  assert.equal(tbh, 0);
  assert.equal(varyOpener({ selfId: "x", messages: msgs }, "gusena that threat is sus, tbh.", rng, "v"), "gusena that threat is sus");
  assert.equal(varyOpener({ selfId: "x", messages: [] }, "who do you trust?", rng, "v"), "who do you trust?");
  const keys = new Set(Array.from({ length: 40 }, (_, i) => personaOf({ selfId: `seat${i}` }).key));
  assert.ok(keys.size >= 4, "several personas across seats");
});

import { claimedRoleIn, humanizePlayerIds } from "../src/index.js";
test("PbOaZSJzx: 'Sheriff here.' is a claim (one claim per seat); 'sheriff, shoot bob' is not", () => {
  assert.equal(claimedRoleIn("Sheriff here."), "sheriff");
  assert.equal(claimedRoleIn("cop btw"), "cop");
  assert.equal(claimedRoleIn("sheriff, shoot bob"), null);
  assert.equal(claimedRoleIn("cop is dead"), null);
});
test("PbOaZSJzx: meeting members given as an object do not crash name humanizing", () => {
  const v = { players: { abcdefgh12: { name: "Ann" } }, meetings: { x: { targets: {}, members: { q: { id: "abcdefgh12" } } } } };
  assert.equal(humanizePlayerIds(v, "abcdefgh12 hi"), "Ann hi");
});
