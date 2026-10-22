// Night 6 part 4: config.teamClaimGuard (off by default). A teammate's own public Cop/Journalist claim closes this
// seat's fake power claims, so the "no plan claim (cop)" fallback can't double-claim a role a teammate already claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, askReplyChoice, askReplyLine, claimOptions, parseClaimReply, validateAction } from "../src/index.js";

const NAMES = ["Me", "Alice", "Bob", "Cat", "Dan", "Eve", "Fay"];
const players = Object.fromEntries(NAMES.map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (senderId, content, t) => ({ event: "message", t, data: { senderId, meetingId: "mVil", content, t } });
const MATES = [{ id: "p6", name: "Eve", role: "Janitor" }, { id: "p7", name: "Fay", role: "Lawyer" }];
// I am Cat (p4), Mafioso, asked by the claimed Sheriff (p1) at 130s.
const asked = (extra, guard) => {
  const v = reduceAll([
    { event: "self", data: "p4" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p4", role: "Mafioso" } },
    { event: "teammates", data: MATES },
    { event: "state", data: { id: 3, name: "Day 1" }, t: 0 },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
    say("p1", "im sheriff", 1_000), ...extra, say("p1", "cat claim?", 130_000),
  ]);
  v.config = { ...(v.config || {}), mafia: "adaptive", ...(guard ? { teamClaimGuard: "on" } : {}) };
  return v;
};
const TEAM_COP = say("p6", "im cop, bob guilty", 5_000);
const REAL_J = say("p2", "im journalist", 60_000);

test("team claim guard off: a teammate's Cop claim leaves Cop open, so the asked seat double-claims Cop (the bug)", () => {
  const v = asked([TEAM_COP, REAL_J], false);
  assert.equal(claimOptions(v).cop, true, "holders() skips the team");
  const r = askReplyChoice(v);
  assert.equal(r.line, "im cop, no guilty yet");
  assert.match(r.why, /no plan claim \(cop\)/);
});

test("team claim guard on: the asked seat says villager after a teammate's Cop claim", () => {
  const v = asked([TEAM_COP, REAL_J], true);
  const o = claimOptions(v);
  assert.deepEqual([o.cop, o.journalist, o.teamPower], [false, false, true]);
  const r = askReplyChoice(v);
  assert.deepEqual(parseClaimReply(r.line), { role: "Villager", kind: "plain" });
  assert.match(r.why, /teammate already made the power claim/);
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "mVil", content: r.line } }).ok, true);
});

test("team claim guard on: no second fake power role either (teammate Cop, Journalist open)", () => {
  const off = askReplyLine(asked([TEAM_COP], false));
  assert.match(off, /^im (cop|journalist)/, "off: a second fake power claim");
  const on = askReplyLine(asked([TEAM_COP], true));
  assert.deepEqual(parseClaimReply(on), { role: "Villager", kind: "plain" });
});

test("team claim guard on: changes nothing without a teammate power claim (outsider Cop claim, or none)", () => {
  for (const extra of [[], [say("p2", "im cop, dan guilty", 5_000)], [say("p6", "im villager", 5_000)]]) {
    assert.equal(askReplyLine(asked(extra, true)), askReplyLine(asked(extra, false)), JSON.stringify(extra.map((e) => e.data.content)));
    const a = claimOptions(asked(extra, true)); const b = claimOptions(asked(extra, false));
    assert.deepEqual([a.cop, a.journalist, a.liveCop], [b.cop, b.journalist, b.liveCop]);
  }
});
