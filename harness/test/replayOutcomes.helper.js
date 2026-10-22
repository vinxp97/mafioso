// Read a replay fixture into what the server recorded per phase, and replay its recorded ballots through the
// engine resolver. The fixtures are rebuilt from live logs (scripts/build-replays.mjs), so the recorded
// outcomes are the builder's story: deaths from the kill/Village plurality, the dead seat's role as its flip.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newGame, resolvePhase } from "mafioso-engine";

export const REPLAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "replays");

const MANIFEST = () => JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, "manifest.json"), "utf8")).fixtures;

export function readRecorded(file) {
  const facts = MANIFEST().find((f) => f.fixture === file) || {};
  const rows = fs.readFileSync(path.join(REPLAY_DIR, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const roles = {}; const meetings = {}; const selfOf = {}; const phases = []; let cur = null; let winner = null; let winners = {};
  const seen = new Set();
  for (const r of rows) {
    const d = r.data;
    if (r.event === "roleReveal" && d?.playerId) roles[d.playerId] = d.role;
    if (r.event === "self") selfOf[r.accountId] = d;
    if (r.event === "meeting" && d?.id) meetings[d.id] = d.name;
    if (r.event === "state" && d?.name && d.name !== "Pregame") {
      if (!phases.some((p) => p.name === d.name)) phases.push({ name: d.name, ballots: {}, deaths: [], flips: {}, gunshot: false });
      cur = phases.find((p) => p.name === d.name);
    }
    if (r.event === "winners") { winner = d?.groups?.[0] ?? null; winners = d?.playersByGroup || {}; }
    if (!cur) continue;
    // Frames go to every seat that sees them: count each fact once.
    const key = `${cur.name}|${r.event}|${JSON.stringify(d)}`;
    if (r.event === "vote" && d?.voterId && d.meetingId) {
      const name = meetings[d.meetingId] || d.meetingId;
      const ballots = (cur.ballots[name] ||= {});
      delete ballots[d.voterId]; ballots[d.voterId] = d.target; // last vote wins
    }
    // A night's reports reach their seats as server messages at the start of the next day.
    const rep = r.event === "message" && d?.senderId === "server" && report(d.content);
    if (rep) {
      const night = phases.find((p) => p.name === `Night ${cur.name.split(" ")[1]}`);
      if (night) (night.reports ||= []).push([selfOf[r.accountId], ...rep]);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.event === "death" && typeof d === "string" && !cur.deaths.includes(d)) {
      cur.deaths.push(d);
      if (cur.gunshot && !cur.shot) cur.shot = d; // the server sends the gunshot right before its death
    }
    if (r.event === "reveal" && d?.playerId && cur.deaths.includes(d.playerId)) cur.flips[d.playerId] = d.role;
    if (r.event === "gunshot") cur.gunshot = true;
  }
  // What the fixture can support: "named" = the log tagged each send with its phase, so meetings, ballots and
  // the deaths they cause are the log's own (seat binding per manifest seatBinding); "unnamed" = an older log
  // without phase tags, phases estimated from frame counts, so only the Village vote is compared; "none" = the
  // game never got past the lobby.
  const level = !phases.length ? "none" : facts.phaseTags === "logged" ? "named" : "unnamed";
  return { roles, phases, winner, winners, level };
}

const pidOf = (name) => `p${name.replace(/^Player/, "")}`;
/** [kind, target, result] from a report message in the server's wording, else null. */
export function report(text) {
  let m = /^:invest: After investigating, you learn that (Player\d+) is (Innocent|Guilty)!$/.exec(text);
  if (m) return ["cop", pidOf(m[1]), m[2]];
  if ((m = /^:journ: You learn that (Player\d+) received no reports\.$/.exec(text))) return ["journalist", pidOf(m[1]), "no reports"];
  if ((m = /^:journ: You received all reports that (Player\d+) received: (.*)\.$/.exec(text))) return ["journalist", pidOf(m[1]), m[2]];
  if ((m = /^:mop: You discover (Player\d+)'s role is (.+)\.$/.exec(text))) return ["janitor", pidOf(m[1]), m[2]];
  return null;
}

/** Per phase: what the fixture recorded vs what the resolver gets from the same ballots. */
export function compareFixture(file, opts = {}) {
  const rec = readRecorded(file);
  let game = newGame(rec.roles, opts);
  const rows = [];
  for (const ph of rec.phases) {
    const before = game;
    let ballots = ph.ballots;
    if (rec.level === "unnamed") {
      // Only the Village vote is real: take the recorded night deaths as given and resolve the day vote alone.
      if (/^Night/.test(ph.name)) {
        game = structuredClone(game); game.phase = ph.name;
        for (const id of ph.deaths) game.alive[id] = false;
        rows.push({ phase: ph.name, ended: !!before.winner, skipped: true, expected: {}, got: {} });
        continue;
      }
      // The gun victim is given too: which seat holds the gun is part of the made-up roles.
      ballots = { Village: ph.ballots.Village || {} };
      if (ph.shot) { game = structuredClone(game); game.alive[ph.shot] = false; }
    }
    const { game: next, out } = resolvePhase(game, ph.name, ballots);
    game = next;
    rows.push({
      phase: ph.name,
      ended: !!before.winner,
      expected: ((ds) => ({ deaths: ds, flips: ds.map((id) => ph.flips[id] ?? null), gunshot: ph.gunshot }))(rec.level === "unnamed" ? ph.deaths.filter((id) => id !== ph.shot) : ph.deaths),
      got: { deaths: out.deaths.map((x) => x.id), flips: out.flips.map((x) => x.role), gunshot: out.shots.length > 0, reports: sortReports(out.reports.map((x) => [x.to, x.kind, x.target, typeof x.result === "string" ? x.result : JSON.stringify(x.result)])) },
      recordedReports: ph.reports ? sortReports(ph.reports) : null,
      out,
    });
  }
  return { rec, rows, winner: rec.level === "named" ? { expected: rec.winner, got: game.winner } : { expected: null, got: null } };
}

const sortReports = (list) => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Flat list of differences: { fixture, phase, field, expected, got }. */
export function mismatches(file, opts) {
  const { rec, rows, winner } = compareFixture(file, opts);
  const list = [];
  const fields = (lvl) => (lvl === "named" ? ["deaths", "flips", "gunshot"] : ["deaths", "flips"]);
  for (const r of rows.filter((x) => !x.skipped)) for (const field of fields(rec.level)) {
    if (JSON.stringify(r.expected[field]) !== JSON.stringify(r.got[field])) list.push({ fixture: file, phase: r.phase, field, expected: r.expected[field], got: r.got[field] });
  }
  // Reports: only where the log had alert lines (the fixture carries the server's report messages).
  // A night the game ended in has no next day, so its reports were never delivered.
  const delivered = (night) => rec.phases.some((p) => p.name === `Day ${night.split(" ")[1]}`);
  if (rec.level === "named" && rec.phases.some((p) => p.reports)) for (const r of rows.filter((x) => !x.skipped && /^Night/.test(x.phase) && delivered(x.phase))) {
    const want = r.recordedReports || [];
    if (JSON.stringify(want) !== JSON.stringify(r.got.reports)) list.push({ fixture: file, phase: r.phase, field: "reports", expected: want, got: r.got.reports });
  }
  if (winner.expected && winner.expected !== winner.got) list.push({ fixture: file, phase: "end", field: "winner", expected: winner.expected, got: winner.got });
  return list;
}
