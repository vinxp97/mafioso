import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, decide, validateAction, parsePlanLine, formatPlanSpeech, machineLeak } from "../src/index.js";

// Mafia coordinate in plain words only. No PLAN line, no key=value, no ids, in ANY chat.
const players = {
  p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "DeltonHarrow21" },
  p3: { id: "p3", name: "RowanSkeel91" }, p4: { id: "p4", name: "LyHollie69" },
};
const view = { selfId: "p1", players };

test("parses several casual phrasings into ids", () => {
  const cases = [
    ["kill rowan tonight, ill fake cop tmrw, lawyer go on delton", { killTarget: "p3", claimRole: "Cop", lawyerTarget: "p2" }],
    ["lets kill LyHollie69", { killTarget: "p4" }],
    ["rowan tonight? i fakeclaim journ, push ly", { killTarget: "p3", claimRole: "Journalist", lynchTarget: "p4" }],
    ["nk @rowanskeel91 and wagon ly tmrw", { killTarget: "p3", lynchTarget: "p4" }],
    ["ok lyhollie it is", { killTarget: "p4" }],
    ["kill ly, lawyer me", { killTarget: "p4", lawyerTarget: "p2" }],
  ];
  for (const [text, want] of cases) {
    const got = parsePlanLine(text, view, "p2");
    assert.ok(got, text);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${text}: ${k}`);
  }
  for (const text of ["ok", "sounds good", "who do we think cop is", "kill someone idk"]) assert.equal(parsePlanLine(text, view, "p2"), null, text);
});

test("the old PLAN form is still read (old logs) but never written", () => {
  assert.equal(parsePlanLine("PLAN kill=p4 lynch=p3 claim=Cop lawyer=p2 speaker=p1").killTarget, "p4");
  const line = formatPlanSpeech({ killTarget: "p3", lynchTarget: "p4", claimRole: "Cop", lawyerTarget: "p2", speakerId: "p1" }, view);
  assert.equal(line, "kill rowanskeel91 tonight, ill fake cop tmrw and push lyhollie69, lawyer go on deltonharrow21");
  assert.equal(machineLeak(view, line), null);
  assert.equal(formatPlanSpeech({ killTarget: "zzUnknownId" }, view), null, "no name, no line (never an id)");
});

function seat(self, extra = []) {
  return reduceAll([
    { event: "self", data: self },
    { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "p1", role: "Mafioso" } },
    { event: "roleReveal", data: { playerId: "p2", role: "Lawyer" } },
    { event: "state", data: { id: 2, name: "Night 1" } },
    { event: "meeting", data: { id: "mMaf", name: "Mafia", speech: true, voting: true, canVote: true, amMember: true, targets: ["p3", "p4", "*"], votes: {}, members: [{ id: "p1" }, { id: "p2" }] } },
    { event: "meeting", data: { id: "mLaw", name: "Lawyer", speech: false, voting: true, canVote: true, amMember: self === "p2", targets: ["p1", "p2"], votes: {} } },
    { event: "meeting", data: { id: "mVil", name: "Village", speech: true, voting: false, amMember: true, targets: [], votes: {} } },
    ...extra,
  ]);
}

test("a teammate reads the casual plan from faction chat and votes it", () => {
  const msg = { event: "message", data: { senderId: "p1", meetingId: "mMaf", content: "kill ly tonight, ill fake cop tmrw, lawyer go on me" } };
  const lawyer = seat("p2", [msg]);
  const acts = decide(lawyer);
  assert.equal(acts.find((a) => a.event === "vote" && a.data.meetingId === "mMaf")?.data.selection, "p4");
  assert.equal(acts.find((a) => a.event === "vote" && a.data.meetingId === "mLaw")?.data.selection, "p1");
  for (const a of acts) if (a.event === "speak") assert.equal(machineLeak(lawyer, a.data.content), null);
});

test("unparseable chat falls back to rules plus copying the first teammate kill vote", () => {
  const v = seat("p2", [{ event: "message", data: { senderId: "p1", meetingId: "mMaf", content: "hmm idk" } }, { event: "vote", data: { meetingId: "mMaf", voterId: "p1", target: "p3" } }]);
  assert.equal(v.notes.plan, null);
  assert.equal(decide(v).find((a) => a.event === "vote" && a.data.meetingId === "mMaf")?.data.selection, "p3");
});

test("PLAN / key=value / raw ids are hard-banned on every meeting, including Mafia chat", () => {
  const v = seat("p1");
  const bad = ["PLAN kill=ET3zxwFN4Y condemn=09lUYMo6Qw claim=Cop Lawyer=fGDlOzRC1th speaker=K_MMHFmcWR", "plan PLAN later", "kill=p3"];
  assert.match(machineLeak({ players: { ET3zxwFN4Y: { id: "ET3zxwFN4Y", name: "Rowan" } } }, "kill ET3zxwFN4Y tonight"), /player id/);
  for (const meetingId of ["mMaf", "mVil"]) for (const content of bad) assert.equal(validateAction(v, { event: "speak", data: { meetingId, content } }).ok, false, `${meetingId}: ${content}`);
  assert.equal(validateAction(v, { event: "speak", data: { meetingId: "mMaf", content: "kill rowan tonight, ill fake cop" } }).ok, true);
  const leader = decide(v).filter((a) => a.event === "speak");
  assert.equal(leader.length, 1);
  assert.match(leader[0].data.content, /^kill \S+ tonight/);
  assert.equal(machineLeak(v, leader[0].data.content), null);
});
