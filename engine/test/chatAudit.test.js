// chatAudit: leaks, contradictions and scum mistakes in public lines, and what must pass (bussing, fake claims,
// grounded results). Players: p1 Ash (the speaker), p2 Bea, p3 Cal, p4 Dot, p5 Eli, p6 Fin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, chatAudit, groundedLine, validateAction } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli", "Fin"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const seat = (role, events = [], { config = null, mates = [] } = {}) => reduceAll([
  ...(config ? [{ event: "botConfig", data: config }] : []),
  { event: "self", data: "p1" }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: "p1", role } },
  ...(mates.length ? [{ event: "teammates", data: mates }] : []),
  { event: "state", data: { id: 3, name: "Night 1" } },
  ...events.filter((e) => e.night),
  { event: "state", data: { id: 4, name: "Day 2" } },
  { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes: {} } },
  ...events.filter((e) => !e.night),
]);
const say = (from, content) => ({ event: "message", data: { meetingId: "vil", senderId: from, content } });
const srv = (content) => ({ night: true, event: "message", data: { senderId: "server", content } });
const vote = (voterId, target) => ({ event: "vote", data: { meetingId: "vil", voterId, target } });
const dies = (id, role) => [{ event: "death", data: id }, ...(role ? [{ event: "reveal", data: { playerId: id, role } }] : [])];
const MAFIA = [{ id: "p5", name: "Eli", role: "Janitor" }, { id: "p6", name: "Fin", role: "Lawyer" }];
const kinds = (view, line) => chatAudit(view, line).map((f) => `${f.kind} ${f.rule}`);

test("LEAK: town naming an unflipped role it has no source for; any seat citing a result it never got", () => {
  assert.deepEqual(kinds(seat("Villager"), "dot is the lawyer"), ["LEAK unknown-role"]);
  assert.deepEqual(kinds(seat("Villager"), "im cop. cal guilty"), ["LEAK result-not-received"]);
  const cop = seat("Cop", [srv("Your investigation shows that Cal is Innocent")]);
  assert.deepEqual(kinds(cop, "im cop. results: dot guilty"), ["LEAK result-not-received"]);
  assert.deepEqual(kinds(seat("Journalist"), "im journalist. bea got no report, fake cop"), ["LEAK result-not-received"]);
});

test("LEAK: scum admitting the faction, a teammate as team or by real role, PLAN lines and seat ids", () => {
  const maf = seat("Mafioso", [], { mates: MAFIA });
  assert.deepEqual(kinds(maf, "eli is my partner, trust him"), ["LEAK public-leak"]);
  assert.deepEqual(kinds(maf, "eli is the janitor"), ["LEAK teammate-role"]);
  assert.deepEqual(kinds(maf, "fine im janitor"), ["LEAK admits-mafia-role"]);
  assert.deepEqual(kinds(maf, "PLAN kill=cal"), ["LEAK public-leak"]);
  const v = seat("Villager");
  v.players.k9x2qa7 = { id: "k9x2qa7", name: "Gus" };
  assert.deepEqual(kinds(v, "vote k9x2qa7 now"), ["LEAK public-leak"]);
});

test("CONTRADICTION: flips, deaths, votes, vote counts, claims and replies that engine state disproves", () => {
  const v = seat("Villager", [...dies("p3", "Villager"), ...dies("p2", null), vote("p4", "p6")]);
  assert.deepEqual(kinds(v, "cal flipped cop"), ["CONTRADICTION flip"]);
  assert.deepEqual(kinds(v, "dot was the cop"), ["CONTRADICTION flip"], "dot is alive");
  assert.deepEqual(kinds(v, "bea flipped villager"), ["CONTRADICTION flip"], "bea was cleaned");
  assert.deepEqual(kinds(v, "eli died last night"), ["CONTRADICTION death"]);
  assert.deepEqual(kinds(v, "eli voted dot"), ["CONTRADICTION vote"]);
  assert.deepEqual(kinds(v, "fin has 3 votes"), ["CONTRADICTION vote-count"]);
  assert.deepEqual(kinds(v, "eli claimed cop"), ["CONTRADICTION claim"]);
  assert.deepEqual(kinds(v, "eli why me"), ["CONTRADICTION reply"]);
  assert.deepEqual(kinds(v, "two cops and one is lying"), ["CONTRADICTION claim-count"]);
  // Eli never said it either: the misquote rule (10/18) flags that too.
  assert.deepEqual(kinds(v, "eli says dot already flipped cop"), ["CONTRADICTION flip", "CONTRADICTION misquote"]);
  const cop = seat("Cop", [srv("Your investigation shows that Cal is Innocent")]);
  assert.deepEqual(kinds(cop, "im cop. cal guilty"), ["CONTRADICTION result"]);
});

test("SCUM_MISTAKE: a fake claim of a role that already flipped, a fake guilty on a revealed townie", () => {
  const maf = seat("Mafioso", [...dies("p3", "Cop"), ...dies("p2", "Villager")], { mates: MAFIA });
  assert.deepEqual(kinds(maf, "im cop. dot guilty"), ["SCUM_MISTAKE claims-flipped-role"]);
  const maf2 = seat("Mafioso", dies("p2", "Villager"), { mates: MAFIA });
  assert.deepEqual(kinds(maf2, "im cop. bea guilty"), ["SCUM_MISTAKE fake-result"]);
  assert.deepEqual(kinds(maf2, "bea is the janitor"), ["SCUM_MISTAKE role"]);
});

test("allowed: bussing a teammate, fake claims and fake reports that fit the public facts", () => {
  const maf = seat("Mafioso", [], { mates: MAFIA });
  assert.deepEqual(kinds(maf, "eli is mafia, vote eli"), []);
  assert.deepEqual(kinds(maf, "im cop. dot guilty"), []);
  assert.deepEqual(kinds(maf, "im journalist. bea got no report, fake cop"), []);
  assert.deepEqual(kinds(maf, "dot is the janitor"), [], "a fake Journalist janitor call on a townie is deception");
  assert.deepEqual(kinds(maf, "fin is lying, im the real cop"), []);
});

test("allowed: results this seat received, public facts stated right, answering a real vote, opinions", () => {
  const cop = seat("Cop", [srv("Your investigation shows that Cal is Innocent")]);
  assert.deepEqual(kinds(cop, "im cop. results: cal inno"), []);
  const jour = seat("Journalist", [srv(":journ: You received all reports that Bea received: Your investigation shows that Dot is Guilty.")]);
  assert.deepEqual(kinds(jour, "im journalist. bea got a cop report, real cop, it said dot guilty"), []);
  const v = seat("Villager", [...dies("p3", "Villager"), vote("p4", "p1"), say("p2", "eli claims cop"), say("p5", "im cop")]);
  assert.deepEqual(kinds(v, "cal flipped villager"), []);
  assert.deepEqual(kinds(v, "dot voted me"), []);
  assert.deepEqual(kinds(v, "i have 1 vote"), []);
  // L2-1018: a seat naming itself by its own handle reads as a bot (blocked since live2-fixes).
  assert.deepEqual(kinds(v, "ash has 1 vote"), ["CONTRADICTION self-third-person"]);
  assert.deepEqual(kinds(v, "dot why me"), []);
  assert.deepEqual(kinds(v, "eli claimed cop"), []);
  assert.deepEqual(kinds(v, "dot is sus, vote dot"), []);
  assert.deepEqual(kinds(v, "dot is dead to me"), [], "an idiom, not a death");
  assert.deepEqual(kinds(seat("Villager", [say("p2", "im cop"), say("p5", "im cop")]), "two cops and one is lying"), []);
});

test("wired into validateAction (dropped with a chat-audit reason); measure mode only reports", () => {
  const line = { event: "speak", data: { meetingId: "vil", content: "eli voted dot" } };
  const r = validateAction(seat("Villager"), line);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^chat-audit: CONTRADICTION vote/);
  assert.equal(validateAction(seat("Villager", [], { config: { chatAudit: "measure" } }), line).ok, true);
});

test("groundedLine: a town replacement from the reads that passes the audit; scum get none", () => {
  const v = seat("Villager", [say("p2", "im cop, cal is guilty"), say("p4", "im cop, eli is guilty")]);
  const line = groundedLine(v);
  assert.ok(line && chatAudit(v, line).length === 0, line);
  assert.equal(groundedLine(seat("Mafioso", [], { mates: MAFIA })), null);
});

test("positive-control paraphrases: seat-id fragments, faction admits, partners, role/result/flip/count/vote rewordings", () => {
  const v = seat("Villager", [...dies("p3", "Villager"), vote("p4", "p6")]);
  v.players.k9x2qa7 = { id: "k9x2qa7", name: "Gus" };
  for (const line of ["vote k9x2 tbh", "my top suspect is the one who voted me (k9x2q", "k9x2qa?"]) assert.deepEqual(kinds(v, line), ["LEAK id-fragment"], line);
  const maf = seat("Mafioso", [], { mates: MAFIA });
  for (const line of ["i'm on the mafia team", "us mafia gotta stick together", "as the mafia i say no lynch", "yes i'm one of the mafia", "fine, mafia here"]) assert.ok(kinds(maf, line).includes("LEAK faction-admit"), line);
  for (const line of ["eli is with me", "eli's my teammate", "my buddy eli knows", "dont lynch eli, we're on the same team", "eli is my fellow mafioso"]) assert.ok(kinds(maf, line).some((k) => /^LEAK (partner-name|public-leak)/.test(k)), line);
  for (const line of ["dot's the lawyer", "dot has to be the lawyer", "dot = lawyer", "dot is definitely the lawyer"]) assert.ok(kinds(v, line).includes("LEAK unknown-role"), line);
  for (const line of ["checked dot last night: mafia", "my check on dot came back guilty", "i investigated dot, guilty", "dot is guilty, i checked"]) assert.deepEqual(kinds(v, line), ["LEAK result-not-received"], line);
  for (const line of ["my report on dot: nothing", "journalist: no report on dot", "dot got nothing last night, i looked"]) assert.deepEqual(kinds(seat("Journalist"), line), ["LEAK result-not-received"], line);
  for (const line of ["cal turned up cop", "cal was revealed as cop", "cal's flip was cop", "cal's role was cop", "cal died as the cop"]) assert.deepEqual(kinds(v, line), ["CONTRADICTION flip"], line);
  for (const line of ["fin's at 2", "2 on fin", "fin is sitting at 3", "3 votes for fin", "fin has 2 on them"]) assert.deepEqual(kinds(v, line), ["CONTRADICTION vote-count"], line);
  for (const line of ["dot is on eli", "dot's vote is on eli", "dot went for eli", "dot put a vote on eli", "dot is voting for eli"]) assert.deepEqual(kinds(v, line), ["CONTRADICTION vote"], line);
  // The same shapes stated right, and scum flip talk that is not a self-claim, stay clean.
  for (const line of ["cal turned up villager", "fin's at 1", "1 on fin", "dot is on fin", "dot went for fin", "lol kayla again"]) assert.deepEqual(kinds(v, line), [], line);
  assert.deepEqual(kinds(maf, "cal died as the lawyer").filter((k) => k.startsWith("LEAK")), [], "a flip claim about someone else is not admitting a mafia role");
  assert.deepEqual(kinds(maf, "we need to find the mafia"), []);
});
