// Night 5 rebuild of g05, g14 and g16 (docs/night5-fixture-diff.md): what changed is pinned here as behaviour, so a
// later rebuild that undoes it fails. g14's server bug (the stale votes on the shot player) stays in the fixture
// and is pinned, not fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tally } from "mafioso-engine";
import { replayFixture } from "../src/stateReplay.js";

const dir = new URL("./fixtures/replays/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));
const meta = (f) => manifest.fixtures.find((x) => x.fixture === f);
const load = (f) => fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const REBUILT = ["g05.jsonl", "g14.jsonl", "g16.jsonl"];
/** One seat's stream (the first account that saw the whole day) as [event, data] in order. */
const seatStream = (entries, acc) => entries.filter((e) => e.accountId === acc).map((e) => [e.event, e.data]);
const FAKE = /^(p\d\d|acc\d\d|m\d\d|x\d\d|u\d\d|Player\d\d|Guest\d\d|setup01|unseen\d+)$/i;
const ID_SHAPED = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:\d|_|[a-z][A-Z]))[A-Za-z0-9_-]{4,12}(?![A-Za-z0-9_-])/g;

test("the rebuilt fixtures record their builder options; the other 13 are default builds", () => {
  for (const f of manifest.fixtures) {
    assert.deepEqual(f.buildOptions, REBUILT.includes(f.fixture) ? ["--alert-roles", "--vote-order=log", "--nick-variants"] : undefined, f.fixture);
  }
});

test("the Sheriff's shot sits where the log has it: gun line, then the death, 'was shot', and no exorcise (Gun.js)", () => {
  // [fixture, a seat that lives through the shot, shooter, victim, phase, ballots that seat sees before the shot].
  const SHOTS = [["g05.jsonl", "acc01", "p09", "p06", "Day 4", 6], ["g14.jsonl", "acc02", "p08", "p03", "Day 1", 5], ["g16.jsonl", "acc01", "p02", "p01", "Day 1", 5]];
  for (const [f, acc, by, victim, phase, early] of SHOTS) {
    const s = seatStream(load(f), acc);
    const day = s.findIndex(([e, d]) => e === "state" && d.name === phase);
    const end = s.findIndex(([e, d], i) => i > day && e === "state");
    const today = s.slice(day, end < 0 ? undefined : end);
    const gun = today.findIndex(([e, d]) => e === "message" && d.content === `:gun: Player${by.slice(1)} pulls a gun and shoots at Player${victim.slice(1)}!`);
    const death = today.findIndex(([e, d]) => e === "death" && d === victim);
    assert.ok(gun > 0 && death > gun, `${f}: gun line before the death`);
    assert.deepEqual(today.filter(([e, d]) => e === "obituaries" && d.obituaries.some((o) => o.id === victim)).map(([, d]) => d.obituaries[0].snippets), [["was shot"]], f);
    assert.equal(today.filter(([e, d]) => e === "exorcised" && d === victim).length, 0, `${f}: a gun death is not an exorcise`);
    assert.equal(today.slice(0, gun).filter(([e]) => e === "vote").length, early, `${f}: ballots sent before the shot go out before it (--vote-order=log)`);
    // No frame from the victim after his death: no ballot, no line.
    const after = today.slice(death);
    assert.equal(after.filter(([e, d]) => e === "vote" && d.voterId === victim).length, 0, `${f}: no ballot from the dead`);
    if (f !== "g05.jsonl") assert.equal(after.filter(([e, d]) => e === "message" && d.senderId === victim).length, 0, `${f}: no line from the dead`);
  }
});

test("g05 is a guessed binding: its one post-shot line from the shot seat is a fixture gap, pinned", () => {
  // The untagged live-pr9 log can't bind seats (seatBinding guessed). The line is the dead Journalist's (dead since
  // early on), not the shot victim's: the guessed binding put that account on p06. Pinned so a change shows.
  assert.equal(meta("g05.jsonl").seatBinding, "guessed");
  const s = seatStream(load("g05.jsonl"), "acc01");
  const death = s.findIndex(([e, d]) => e === "death" && d === "p06");
  const late = s.slice(death).filter(([e, d]) => e === "message" && d.senderId === "p06").map(([, d]) => d.content.slice(0, 22));
  assert.deepEqual(late, ["Dead Journalist here —"]);
});

test("g14: the server's stale-vote tie is kept and pinned, not fixed", () => {
  // Day 1 Village ballots in send order, the shot on p03 (the Mafioso) after the first five. Meeting.js
  // generateTargets left the two ballots on p03 standing after he died, so the server's tally was a 2-2 tie (p03,
  // p06) and nobody was condemned: its Night 2 meetings count 7 living (Mafia Kill targets=6, Investigate 7). The
  // builder, like the engine, clears ballots on the shot player, so the fixture condemns p06 and the mafia's
  // Night 2 kill votes land on a "dead" p06.
  const s = seatStream(load("g14.jsonl"), "acc02");
  const day1 = s.slice(s.findIndex(([e, d]) => e === "state" && d.name === "Day 1"), s.findIndex(([e, d]) => e === "state" && d.name === "Night 2"));
  const ballots = day1.filter(([e, d]) => e === "vote" && d.meetingId === "m07").map(([, d]) => [d.voterId, d.target]);
  assert.deepEqual(ballots, [["p05", "p04"], ["p06", "p03"], ["p08", "p05"], ["p07", "p01"], ["p09", "p03"], ["p01", "p06"], ["p04", "p06"]]);
  const kept = Object.fromEntries(ballots);
  const cleared = Object.fromEntries(ballots.filter(([, t]) => t !== "p03"));
  assert.equal(tally(kept), "*", "server: the stale votes on p03 tie p06, nobody is condemned");
  assert.equal(tally(cleared), "p06", "builder/engine: ballots on the shot player cleared, p06 is condemned");
  assert.deepEqual(day1.filter(([e]) => e === "death").map(([, d]) => d), ["p03", "p06"], "the fixture keeps the builder's condemn");
  const r = replayFixture(load("g14.jsonl"), meta("g14.jsonl"));
  assert.deepEqual(r.refused.map((x) => [x.phase, x.type, x.voter, x.target, x.reason]), [
    ["Night 2", "vote", "p01", "p06", "target is dead"], ["Night 2", "vote", "p04", "p06", "target is dead"]]);
});

test("g16: the shot victim's ballot and the ballots on him go out before the shot; the replay refuses nothing", () => {
  const r = replayFixture(load("g16.jsonl"), meta("g16.jsonl"));
  assert.deepEqual(r.refused, []);
  assert.equal(r.model.winner, "Mafia");
});

test("no real ids or handles: every id-shaped token in g01-g16 chat is a placeholder, and g05 keeps plain hyphenated words", () => {
  // g05 once carried real seat-id prefixes (574b889). The builder maps any 4+ char prefix of a seen id to its fake.
  for (const f of manifest.fixtures) {
    const odd = new Set();
    for (const e of load(f.fixture)) if (e.event === "message") for (const t of String(e.data.content).match(ID_SHAPED) || []) if (!FAKE.test(t)) odd.add(t);
    assert.deepEqual([...odd], [], f.fixture);
  }
  const text = fs.readFileSync(new URL("g05.jsonl", dir), "utf8");
  // The old fixture turned these words into x03-x05 (an older builder took any hyphenated word for an id).
  for (const w of ["scum-driven", "non-player", "flip-flopped"]) assert.ok(text.includes(w), w);
  assert.ok(!/\bx0[345]\b/.test(text));
});

test("g14 carries no first-name variant of a dev handle (--nick-variants): each such line names the placeholder", () => {
  // Seven distinct lines (49 deliveries) addressed a dev by a plural or "ck" spelling of a 3-letter first name.
  // The test names only what is around that word: in every copy, the word is now the placeholder.
  const TAILS = [["player07 ", ", shut up, i'm voting player04."], ["player07 you're stalling ", ", stop it"], ["shut up, ", ", i don't need your help."],
    ["", ", are you actually listening to anyone?"], ["", ", stop dodging questions and actually speak up"], ["", ", stop dodging and pick a name right now"], ["", ", pick a real suspect or i'm voting you"]];
  const lines = load("g14.jsonl").filter((e) => e.event === "message" && e.data.senderId !== "server").map((e) => e.data.content);
  let n = 0;
  for (const [pre, post] of TAILS) {
    const hits = lines.filter((l) => l.startsWith(pre) && l.endsWith(post) && !/\bplayer0[1-9]\b.*\bplayer0[1-9]\b.*\bplayer0[1-9]\b/.test(l.slice(pre.length, -post.length)));
    const word = new Set(hits.map((l) => l.slice(pre.length, l.length - post.length)));
    assert.deepEqual([...word], ["player07"], `${pre}…${post}`);
    n += hits.length;
  }
  assert.equal(n, 49);
});
