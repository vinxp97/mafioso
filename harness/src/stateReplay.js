// Fixture frames -> stateModel events, then the model over them (engine/src/stateModel.js).
// A fixture holds every seat's stream: one fact reaches each seat that sees it. A frame becomes one model event
// the first time any seat sees it, again only when the same seat sees the same frame again (a real repeat).
// Deaths are one per player (death and exorcised frames name the same death).
import { createStateModel, stepModel, parseModelPhase } from "mafioso-engine";

const SKIP_NAMES = /^(Pregame|Vote Kick)$/;
// Older logs name a role meeting generically ("Night Action", "Day Action"): the holder's role names it.
const BY_ROLE = { Cop: "Investigate", Journalist: "Receive Reports", Doctor: "Save", Janitor: "Clean Death", Lawyer: "Litigate", "Loyal Lawyer": "Litigate", Sheriff: "Shoot Gun" };
const GUN_LINE = /^:gun:\s*(.+?) pulls a gun and shoots (?:at )?(.+?)!*$/;

function meetingName(m, roleOfPid) {
  const name = String(m?.name || "");
  if (/^(mafia|cult)( meeting| chat)?$/i.test(name)) return name.split(" ")[0][0].toUpperCase() + name.split(" ")[0].slice(1).toLowerCase();
  if (/^(Day|Night) Action$/.test(name)) {
    const holder = (m.members || []).map((x) => (typeof x === "string" ? x : x?.id))[0];
    return BY_ROLE[roleOfPid(holder)] || name;
  }
  return name;
}

/** Parse a server report line for its holder: [kind, targetName, result] or null. */
export function reportLine(text) {
  let m = /^:journ: You learn that (.+?) received no reports\.$/.exec(text);
  if (m) return ["journalist", m[1], "no reports"];
  if ((m = /^:journ: You received all reports that (.+?) received: (.*)$/.exec(text))) return ["journalist", m[1], m[2]];
  if ((m = /^:invest: After investigating, you learn that (.+?) is (Innocent|Guilty)!$/.exec(text))) return ["cop", m[1], m[2]];
  if ((m = /^:mop: You discover (.+?)'s role is (.+?)\.$/.exec(text))) return ["janitor", m[1], m[2]];
  return null;
}

/** { players, roles, events, notes } from fixture entries. */
export function fixtureEvents(entries, opts = {}) {
  const players = {}; const roles = {}; const selfOf = {};
  for (const e of entries) {
    if (e.event === "players") for (const [id, p] of Object.entries(e.data || {})) players[id] = p?.name || players[id] || id;
    if (e.event === "playerJoin" && e.data?.id) players[e.data.id] = e.data.name || players[e.data.id] || e.data.id;
    if (e.event === "roleReveal" && e.data?.playerId) { roles[e.data.playerId] = String(e.data.role).split(":")[0]; players[e.data.playerId] ||= e.data.playerId; }
    if (e.event === "self") selfOf[e.accountId] = e.data;
  }
  const byName = Object.fromEntries(Object.entries(players).map(([id, n]) => [String(n).toLowerCase(), id]));
  const pidOf = (name) => byName[String(name).toLowerCase()] || null;
  const meetings = {}; const events = []; const notes = { privateReveals: 0, unparsedServer: 0 };
  const trusted = opts.roles === undefined ? roles : opts.roles;
  const count = {}; const emitted = {}; // first-seen per frame, per seat repeats
  const once = new Set(); const dead = new Set(); const shots = new Set(); let phase = "Pregame"; const dayShots = {};
  const fresh = (acc, key) => {
    const c = (count[`${acc}|${key}`] = (count[`${acc}|${key}`] || 0) + 1);
    if ((emitted[key] || 0) >= c) return false;
    emitted[key] = c; return true;
  };
  const push = (ev, src) => events.push({ ...ev, src });
  for (const [i, e] of entries.entries()) {
    const d = e.data; const acc = e.accountId;
    switch (e.event) {
      case "state": {
        const p = parseModelPhase(d?.name);
        if (p && p.name !== phase && !once.has(`state|${p.name}`) && once.add(`state|${p.name}`)) { phase = p.name; push({ type: "phase", name: p.name }, i); }
        break;
      }
      case "meeting": if (d?.id) meetings[d.id] = meetingName(d, (pid) => trusted?.[pid]); break;
      case "vote": case "unvote": {
        const name = meetings[d?.meetingId];
        if (!name || SKIP_NAMES.test(name) || !fresh(acc, `${phase}|${e.event}|${JSON.stringify(d)}`)) break;
        // A generic action meeting whose holder's role is unknown: nothing names it, so nothing checks it.
        if (/^(Day|Night) Action$/.test(name)) { notes.unnamedMeetingVotes = (notes.unnamedMeetingVotes || 0) + 1; break; }
        if (name === "Shoot Gun" && d.target !== "*") {
          if (e.event === "vote" && !shots.has(`${phase}|${d.voterId}`)) { shots.add(`${phase}|${d.voterId}`); (dayShots[phase] ||= new Set()).add(d.target); push({ type: "shot", by: d.voterId, target: d.target }, i); }
          break;
        }
        push(e.event === "vote" ? { type: "vote", voter: d.voterId, meeting: name, target: d.target } : { type: "unvote", voter: d.voterId, meeting: name }, i);
        break;
      }
      case "message": {
        if (!d) break;
        const text = String(d.content || "");
        if (d.senderId === "server") {
          const gun = GUN_LINE.exec(text);
          if (gun) {
            const by = pidOf(gun[1]); const target = pidOf(gun[2]);
            if (by && target && !shots.has(`${phase}|${by}`)) { shots.add(`${phase}|${by}`); (dayShots[phase] ||= new Set()).add(target); push({ type: "shot", by, target }, i); }
            break;
          }
          const rep = reportLine(text);
          if (rep && fresh(acc, `${phase}|report|${text}`)) {
            push({ type: "result", kind: rep[0], to: selfOf[acc], target: pidOf(rep[1]), result: rep[2] }, i);
          } else if (!rep && !/has begun\.$/.test(text)) notes.unparsedServer += 1;
          break;
        }
        // Old logs kept no text for some lines (the builder writes ""): no speech to check.
        if (!text.trim()) { notes.noText = (notes.noText || 0) + 1; break; }
        const name = meetings[d.meetingId] || (d.meetingId ? null : "Village");
        if (!name || name === "Pregame" || !fresh(acc, `${phase}|say|${d.senderId}|${d.meetingId}|${text}`)) break;
        push({ type: "speak", by: d.senderId, meeting: name, text }, i);
        break;
      }
      case "death": case "exorcised": {
        if (typeof d !== "string" || dead.has(d)) break;
        dead.add(d);
        const kind = phase.split(" ")[0];
        const cause = kind === "Night" ? "night" : dayShots[phase]?.has(d) ? "gun" : "condemn";
        push({ type: "death", id: d, cause }, i);
        break;
      }
      case "reveal": {
        if (!d?.playerId || !fresh(acc, `reveal|${d.playerId}|${d.role}`)) break;
        if (dead.has(d.playerId)) push({ type: "reveal", id: d.playerId, role: String(d.role).split(":")[0] }, i);
        else notes.privateReveals += 1; // a teammate or own-role reveal, or the Sheriff's (the shot reveals him)
        break;
      }
      case "winners": if (!once.has("winners") && once.add("winners")) push({ type: "end", winner: d?.groups?.[0] ?? "No one" }, i); break;
      default: break;
    }
  }
  return { players, roles, events, notes };
}

/**
 * How much of a fixture's roles the model may trust, from its manifest entry: an exact seat binding (seatmap,
 * recovered) keeps every role; a partial one drops the ambiguous seats' roles (they could swap); a guessed one,
 * or a log without phase tags (phases estimated from frame counts), keeps none.
 */
export function trustedRoles(roles, facts = {}) {
  if (!facts.seatBinding) return roles;
  if (facts.phaseTags !== "logged" || facts.seatBinding === "guessed" || facts.roles === "setup order") return null;
  if (facts.seatBinding === "partial") {
    const amb = new Set((facts.ambiguousSeats || []).map((a) => facts.pidOf?.[a] ?? a));
    return Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, amb.has(id) ? null : r]));
  }
  return roles;
}

/** Replay a fixture through the model: the final model, refused events, and counts. facts: its manifest entry. */
export function replayFixture(entries, facts = {}) {
  const all = fixtureEvents(entries, { roles: null });
  const pidOf = Object.fromEntries(entries.filter((e) => e.event === "self").map((e) => [e.accountId, e.data]));
  const trusted = Object.keys(all.roles).length ? trustedRoles(all.roles, { ...facts, pidOf }) : null;
  const { players, events, notes } = fixtureEvents(entries, { roles: trusted });
  let model = createStateModel({ players, roles: trusted });
  const refused = []; const kinds = {};
  for (const ev of events) {
    kinds[ev.type] = (kinds[ev.type] || 0) + 1;
    const r = stepModel(model, ev);
    if (r.ok) model = r.model; else refused.push({ ...ev, phase: model.phase.name, reason: r.reason });
  }
  // The ballots' outcome next to the recorded one (not an illegal action: a consistency check).
  const outcomes = [];
  for (const [name, day] of Object.entries(model.days)) {
    const exp = day.expected; const got = day.lynched;
    const sameNoLynch = !got && (exp == null || exp === "*");
    if (day.expected !== undefined && !(exp === got || sameNoLynch) && !day.shots.some((s) => s.target === exp)) outcomes.push({ phase: name, expected: exp, got: got ?? "no lynch" });
  }
  return { model, events, refused, kinds, notes, outcomes };
}
