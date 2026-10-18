// The agreed plan's kill can be unusable (target dead, not offered, not a player, no kill). The faction must still
// kill when it has to: re-pick by the adaptive priority, and skip only when Vinman's rules allow it (no night
// meteor on the mafia, no Cop/Journalist/Sheriff claimer alive). Leader and teammates land on the same target.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, withLegalKill, factionKillMeeting, decide } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const say = (from, content, meetingId = "vil") => ({ event: "message", data: { meetingId, senderId: from, content } });
/** Mafioso `self` with teammate (p1 Mafioso / p6 Janitor), Night 2; `day` lines land on Day 1. */
function night({ self = "p6", day = [], nightEvents = [], targets = ["p2", "p3", "p4", "p5", "*"] } = {}) {
  const mate = self === "p6" ? "p1" : "p6";
  return reduceAll([
    { event: "self", data: self }, { event: "players", data: players },
    { event: "roleReveal", data: { playerId: self, role: self === "p6" ? "Janitor" : "Mafioso" } },
    { event: "reveal", data: { playerId: mate, role: mate === "p6" ? "Janitor" : "Mafioso" } },
    { event: "state", data: { id: 3, name: "Day 1" } }, ...day,
    { event: "state", data: { id: 4, name: "Night 2" } },
    { event: "meeting", data: { id: "chat", name: "Mafia", speech: true, voting: false, amMember: true, targets: [] } },
    { event: "meeting", data: { id: "k", name: "Mafia Kill", factionRole: "kill", voting: true, canVote: true, amMember: true, targets, votes: {} } },
    ...nightEvents,
  ]);
}
const plan = (killTarget) => ({ killTarget, janitorTarget: killTarget, source: "chat" });
const pick = (v, p) => withLegalKill(v, factionKillMeeting(v), p).killTarget;
const copClaim = [say("p4", "im cop. ash inno")];

test("dead target: re-picked by priority (the Cop claimer)", () => {
  const v = night({ day: [...copClaim, { event: "death", data: "p2" }] });
  assert.equal(pick(v, plan("p2")), "p4");
});

test("target alive but not in the meeting's options, or not a player at all: re-picked", () => {
  const v = night({ day: copClaim, targets: ["p3", "p4", "p5", "*"] });
  assert.equal(pick(v, plan("p2")), "p4", "not offered");
  assert.equal(pick(v, plan("p99")), "p4", "not a player");
  assert.equal(pick(v, plan("p1")), "p4", "a teammate");
  const r = withLegalKill(v, factionKillMeeting(v), plan("p2"));
  assert.equal(r.janitorTarget, "p4", "the Janitor cleans the new kill");
});

test("no-kill plan: kept when skipping is allowed, overridden by a night meteor or a living power-role claimer", () => {
  assert.equal(pick(night(), plan("*")), "*", "no meteor, no claimer: the skip stands");
  const meteor = night({ nightEvents: [say("server", "A giant meteor will land and end the game if nobody dies tonight!", null)] });
  const m = pick(meteor, plan("*"));
  assert.ok(["p2", "p3", "p4", "p5"].includes(m), `meteor: a kill is mandatory (${m})`);
  assert.equal(pick(night({ day: copClaim }), plan("*")), "p4", "a Cop claimer is alive: kill him");
  assert.equal(pick(night({ day: copClaim }), plan(null)), "p4", "no target at all");
});

test("leader and teammate vote the same fallback; a teammate's legal vote is followed", () => {
  // The agreed chat plan names Bea, who is not in tonight's kill options.
  const day = copClaim;
  const chat = say("p1", "kill bea tonight", "chat");
  const opts = { day, targets: ["p3", "p4", "p5", "*"], nightEvents: [chat] };
  const killVote = (v) => (decide(v) || []).find((a) => a.event === "vote" && a.data.meetingId === "k")?.data.selection;
  assert.equal(killVote(night({ ...opts, self: "p1" })), "p4", "leader (p1)");
  assert.equal(killVote(night({ ...opts, self: "p6" })), "p4", "teammate (p6) agrees");
  const followed = night({ ...opts, self: "p6", nightEvents: [chat, { event: "vote", data: { meetingId: "k", voterId: "p1", target: "p5" } }] });
  assert.equal(killVote(followed), "p5", "the teammate follows the leader's actual vote");
});
