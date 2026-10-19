// 10/19 quiet-table variants: every flag is off by default; each one changes only the line it targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAll, publicFactLines, reviveKeepingIntent, reviveSpeech, isKeyLine, quietTableOpts, QUIET_TABLE_DEFAULTS, dayOpener } from "../src/index.js";

const players = Object.fromEntries(["Ash", "Bea", "Cal", "Dot", "Eli"].map((n, i) => [`p${i + 1}`, { id: `p${i + 1}`, name: n }]));
const ids = Object.keys(players);
const say = (from, content, t) => ({ event: "message", t, data: { meetingId: "vil", senderId: from, content, t } });
const day = (self, role, extra = [], votes = {}) => reduceAll([
  { event: "self", data: self }, { event: "players", data: players }, { event: "roleReveal", data: { playerId: self, role } },
  { event: "state", data: { id: 2, name: "Day 1" } },
  { event: "meeting", data: { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: [...ids, "*"], votes } },
  ...extra,
]);

test("quiet-table flags default off; unknown values fall back to the defaults", () => {
  assert.deepEqual(quietTableOpts({}), { ...QUIET_TABLE_DEFAULTS });
  assert.deepEqual(quietTableOpts(undefined), { ...QUIET_TABLE_DEFAULTS });
  assert.deepEqual(quietTableOpts({ quietTable: { filler: "loud", repair: "x", keyFirst: "yes" } }), { ...QUIET_TABLE_DEFAULTS });
  assert.deepEqual(quietTableOpts({ quietTable: { filler: "facts", repair: "intent", keyFirst: true } }), { filler: "facts", repair: "intent", keyFirst: true });
});

test("filler 'facts' restates the public record only: vote counts and living claims, never a read or the seat's role", () => {
  const v = day("p5", "Cop", [say("p1", "im sheriff", 1000), say("p2", "im journalist. cal got no report", 2000)], { p1: "p3", p2: "p3", p4: "p2" });
  const lines = publicFactLines(v);
  assert.deepEqual(lines, ["votes so far: cal 2, bea 1", "claims so far: ash sheriff, bea journalist"]);
  for (const l of lines) assert.doesNotMatch(l, /my read|watching|\bcop\b|\bim\b/i, l);
  // The default opener of the same seat names its read or watch target: that is what "facts" removes.
  assert.match(String(dayOpener(v)), /my read is|watching|\bim\b|cop/i);
  assert.deepEqual(publicFactLines(day("p5", "Villager")), ["no votes yet"]);
});

test("key lines: claims, Cop/Journalist results, counterclaims and Sheriff asks; not chatter or defences", () => {
  for (const t of ["im cop. bea guilty", "results: cal inno", "Eli is lying, im journalist", "dot got no report, fits villager", "sheriff here"]) assert.equal(isKeyLine(t), true, t);
  assert.equal(isKeyLine("ash claim before i shoot", "ask-rule"), true);
  for (const t of ["cal why me", "watching the votes", "my read is dot", "not sure yet"]) assert.equal(isKeyLine(t), false, t);
});

test("repair 'intent': a stale defence is dropped (a0e6d88) where the default re-sends it unchanged; a stale result is kept", () => {
  const v = day("p5", "Villager", [say("p2", "eli is sus", 1000)]);
  assert.equal(reviveSpeech(v, "Bea why me")?.data.content, "Bea why me"); // default: same line, minutes late
  assert.equal(reviveKeepingIntent(v, "Bea why me", { stale: true }), null);
  assert.equal(reviveKeepingIntent(v, "Bea is lying", { stale: true })?.data.content, "Bea is lying");
});

test("repair 'intent': a spent-gun threat is repaired only when the repair names the same players, never to a generic line", () => {
  const v = day("p1", "Sheriff", [{ event: "message", data: { meetingId: "vil", senderId: "server", content: ":gun: Ash pulls a gun and shoots at Eli!" } }]);
  assert.equal(reviveKeepingIntent(v, "my read is bea, claim or im shooting")?.data.content, "my read is bea");
  // Cutting the threat drops its addressee: that changes who the line is about, so it is dropped, not
  // replaced (the default falls back to the opener or a read line).
  assert.equal(reviveKeepingIntent(v, "bea claim or im shooting"), null);
  assert.ok(reviveSpeech(v, "bea claim or im shooting"));
});
