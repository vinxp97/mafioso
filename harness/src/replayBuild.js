// Build sanitized protocol replay fixtures from live-harness logs (the *.log.err files the live CLI writes).
// The logs are not raw frame dumps: they hold per-type frame counts ("frames {...}"), meeting lines, sends,
// public chat, alerts, dead-seat scheduler lines and winners. This rebuilds, per game, a dev-API envelope
// stream ({accountId, seq, t, event, data}) with every frame type the log saw, in server order, with payload
// shapes from the server source (Games/core/*.js). Ids and names are replaced with fakes; no tokens are kept.
//
// Seat binding (which account sat in which player slot) is recovered from the log, not guessed:
//   - a "seatmap" line (live harness, newer logs) is exact;
//   - otherwise every assignment consistent with the log is searched: a seat never targets itself in a role
//     meeting, sends nothing after its player died, has a "seat is dead" scheduler line only after its player
//     died, and the Mafia's seats hold the players the winners list names as Mafia (never a kill target).
// Deaths follow the server's rules (engine tally: "*" counts, ties kill nobody; the gun first, ballots on the
// shot cleared; votes from dead seats dropped); a cleaned kill has no flip; alert lines become the server's
// report messages to that seat.
import { tally } from "mafioso-engine";

export const NON_PLAYER = /^(\*|yes|no|kick|none)$/i;
export const PHASES = ["Night 1", "Day 1", "Night 2", "Day 2", "Night 3", "Day 3", "Night 4", "Day 4", "Night 5", "Day 5"];
const ROLE_BY_MEETING = { Investigate: "Cop", "Receive Reports": "Journalist", Litigate: "Lawyer", "Clean Death": "Janitor", "Shoot Gun": "Sheriff" };
const MEETING_BY_ROLE = Object.fromEntries(Object.entries(ROLE_BY_MEETING).map(([m, r]) => [r, m]));
export const FJ = ["Cop", "Villager", "Mafioso", "Villager", "Villager", "Journalist", "Sheriff", "Lawyer", "Janitor"];
const MAFIA = new Set(["Mafioso", "Lawyer", "Janitor"]);
const SELF_OK = new Set(["Village", "Vote Kick", "Pregame", "Mafia Meeting"]);
const idx = (phase) => (phase === "Pregame" ? -1 : PHASES.indexOf(phase));

export function parseLog(text) {
  const games = []; let g = null; let lastPhase = "Pregame";
  for (const line of text.split(/\r?\n/)) {
    let m = /^game (\S+) accounts=(\S+)/.exec(line);
    if (m) { g = { id: m[1], accounts: m[2].split(","), frames: {}, items: [], stateCount: 0, dead: [] }; games.push(g); lastPhase = "Pregame"; continue; }
    if (!g) continue;
    const tag = /^\S+ \S+ \[([^\]]+)\]/.exec(line) || /^chat \[([^\]]+)\]/.exec(line);
    if (tag && (tag[1] === "Pregame" || PHASES.includes(tag[1]))) lastPhase = tag[1];
    if ((m = /^seatmap (.*)$/.exec(line))) {
      // Exact seat binding from the live harness: s<N>=<playerId>:"<handle>", N = position in accounts=.
      g.seatmap = [...m[1].matchAll(/s(\d+)=(\S+?):("(?:[^"\\]|\\.)*")/g)].map((x) => ({ seat: Number(x[1]), pid: x[2], name: JSON.parse(x[3]) })).sort((a, b) => a.seat - b.seat);
      continue;
    }
    if (line.startsWith("frames ")) {
      try { g.frames = JSON.parse(line.slice(7)); g.stateCount = g.frames["game:state"] || 0; } catch {}
      continue;
    }
    const phaseNow = () => PHASES[Math.max(0, Math.floor(g.stateCount / g.accounts.length) - 2)] || "Night 1";
    if ((m = /^sched (\S+) skip .*path=dead/.exec(line))) {
      if (!g.dead.some((d) => d.seat === m[1])) g.dead.push({ seat: m[1], phase: lastPhase });
    } else if ((m = /^meeting (\S+) \[([^\]]*)\] (\S+) name="([^"]*)" role=(\S+) vote=(\S+) canVote=(\S+) targets=(\d+)/.exec(line))) {
      g.items.push({ k: "meeting", seat: m[1], phase: m[2] || "Pregame", mid: m[3], name: m[4], role: m[5], voting: m[6] === "true", canVote: m[7] === "true", n: Number(m[8]) });
    // L4+ logs (10/18) carry "t=<ms>" after the phase tag on sends and after the text on chat lines.
    } else if ((m = /^send (\S+) (?:\[([^\]]*)\] )?(?:t=\d+ )?(vote|speak) (\S+) (.*?) source=(\S+)/.exec(line))) {
      const val = m[3] === "speak" ? (() => { try { return JSON.parse(m[5]); } catch { return m[5]; } })() : m[5];
      const ms = /\] t=(\d+) /.exec(line);
      g.items.push({ k: m[3], seat: m[1], phase: m[2] || phaseNow(), tagged: !!m[2], mid: m[4], val, source: m[6], ...(ms ? { ms: Number(ms[1]) } : {}) });
    } else if ((m = /^chat \[([^\]]*)\] (\S+) (\S+): (.*?)(?: t=\d+)?$/.exec(line))) {
      let content = m[4]; try { content = JSON.parse(content); } catch {}
      const ms = / t=(\d+)$/.exec(line);
      g.items.push({ k: "chat", phase: m[1], meeting: m[2], sender: m[3], content, ...(ms ? { ms: Number(ms[1]) } : {}) });
    } else if ((m = /^speech-reject (\S+) \[([^\]]*)\] source=(\S+) reasons=(\[.*?\])(?: line=("(?:[^"\\]|\\.)*"))?$/.exec(line))) {
      // A line the harness held or rejected (chatAudit, validators, pacing). Not a frame: kept as a sidecar.
      let reasons = []; try { reasons = JSON.parse(m[4]); } catch { reasons = [m[4]]; }
      let text = null; if (m[5]) { try { text = JSON.parse(m[5]); } catch { text = m[5]; } }
      g.items.push({ k: "reject", seat: m[1], phase: m[2], source: m[3], reasons, line: text });
    } else if ((m = /^alert (\S+) \[([^\]]*)\] kind=(\S+) target=("(?:[^"\\]|\\.)*") result=("(?:[^"\\]|\\.)*")/.exec(line))) {
      g.items.push({ k: "alert", seat: m[1], phase: m[2], kind: m[3], target: JSON.parse(m[4]), result: JSON.parse(m[5]) });
    } else if ((m = /^winners (?:game=\S+ )?(\{.*\})$/.exec(line))) {
      try { g.winners = JSON.parse(m[1]); } catch {}
    }
  }
  return games;
}

/** Meeting type per phase+meeting id: the meeting line's name, else inferred from who sent what. */
function meetingTypes(g) {
  const named = new Map(); const sends = new Map();
  for (const it of g.items) {
    if (it.k === "meeting") named.set(`${it.phase}|${it.mid}`, it.name);
    if (it.k === "vote" || it.k === "speak") {
      const key = `${it.phase}|${it.mid}`;
      if (!sends.has(key)) sends.set(key, { phase: it.phase, mid: it.mid, seats: new Set(), vals: [], speak: false });
      const s = sends.get(key); s.seats.add(it.seat);
      if (it.k === "vote") s.vals.push(it.val); else s.speak = true;
    }
  }
  const type = new Map(named);
  const nightMafia = new Set();
  for (const [key, s] of sends) {
    if (type.has(key)) continue;
    if (s.vals.length && s.vals.every((v) => /^kick$/i.test(v))) type.set(key, "Vote Kick");
    else if (s.speak && !s.vals.length) type.set(key, /^Day/.test(s.phase) ? "Village" : "Mafia Meeting");
    else if (/^Night/.test(s.phase) && s.vals.some((v) => /^(yes|no)$/i.test(v))) type.set(key, "Clean Death");
    else if (/^Night/.test(s.phase) && s.seats.size >= 2) { type.set(key, "Mafia Kill"); for (const x of s.seats) nightMafia.add(x); }
  }
  // Day: the meeting most seats vote in is the Village; another day meeting with a player target is the gun.
  for (const phase of new Set([...sends.values()].map((s) => s.phase))) {
    if (!/^Day/.test(phase)) continue;
    const open = [...sends.entries()].filter(([k, s]) => s.phase === phase && !type.has(k) && s.vals.length);
    open.sort((a, b) => b[1].seats.size - a[1].seats.size);
    if (open[0] && ![...type.entries()].some(([k, t]) => k.startsWith(`${phase}|`) && t === "Village")) type.set(open.shift()[0], "Village");
    // Only a game whose frames saw a gunshot had a shot: otherwise the extra meeting is some other day action.
    for (const [k] of open) type.set(k, g.frames["game:gunshot"] ? "Shoot Gun" : "Day Action");
  }
  // Mafia seats: kill-meeting members (named or inferred) and the Janitor; a mafia seat's other night action is Litigate.
  for (const it of g.items) if ((it.k === "meeting" || it.k === "vote") && ["Mafia Kill", "Clean Death", "Litigate", "Mafia Meeting"].includes(type.get(`${it.phase}|${it.mid}`))) nightMafia.add(it.seat);
  for (const [key, s] of sends) if (!type.has(key) && /^Night/.test(s.phase)) type.set(key, [...s.seats].every((x) => nightMafia.has(x)) ? "Litigate" : "Night Action");
  return { type, mafiaSeats: nightMafia };
}

/** Deaths by player id, phase by phase, from the ballots (seatPid: account -> pid, to drop dead seats' ballots). */
function deathsFrom(g, type, seatPid, mafiaPids) {
  const dead = new Map(); const out = []; let cleanUsed = false;
  const phases = [...new Set(g.items.filter((it) => it.phase && it.phase !== "Pregame" && idx(it.phase) >= 0).map((it) => it.phase))].sort((a, b) => idx(a) - idx(b));
  for (const phase of phases) {
    const i = idx(phase);
    const live = (seat) => !dead.has(seatPid?.get(seat));
    const ballots = (t) => {
      const b = {};
      for (const it of g.items) if (it.k === "vote" && it.phase === phase && type.get(`${phase}|${it.mid}`) === t && live(it.seat)) { delete b[it.seat]; b[it.seat] = it.val; }
      return b;
    };
    const die = (pid, cause, cleaned = false) => { dead.set(pid, i); out.push({ pid, phase, idx: i, cause, cleaned }); };
    if (/^Night/.test(phase)) {
      const t = tally(ballots("Mafia Kill"));
      const victim = t && !NON_PLAYER.test(t) && !dead.has(t) && !mafiaPids?.has(t) ? t : null;
      const clean = victim && !cleanUsed && Object.values(ballots("Clean Death")).some((v) => /^yes$/i.test(v));
      if (clean) cleanUsed = true;
      if (victim) die(victim, "mafia", !!clean);
    } else {
      // The gun is instant: the first gun vote fires. Re-aims after it went nowhere (L4: the server ignored them).
      const firstGun = {};
      for (const it of g.items) if (it.k === "vote" && it.phase === phase && type.get(`${phase}|${it.mid}`) === "Shoot Gun" && live(it.seat) && !(it.seat in firstGun)) firstGun[it.seat] = it.val;
      for (const [s, t] of Object.entries(firstGun)) if (!NON_PLAYER.test(t) && !dead.has(t)) { die(t, "gun"); out[out.length - 1].by = s; break; }
      const vote = Object.fromEntries(Object.entries(ballots("Village")).filter(([s, t]) => live(s) && (NON_PLAYER.test(t) || !dead.has(t))));
      const t = tally(vote);
      if (t && !NON_PLAYER.test(t)) die(t, "condemn");
    }
  }
  return out;
}

/**
 * Every account -> player assignment the log allows (see the file comment), searched in seat order with
 * players in first-seen order, so with no evidence it is the old guess (seat i -> player i).
 * Returns { seatPid, quality: "seatmap" | "recovered" | "partial" | "guessed", ambiguous: [accounts] }.
 */
function recoverBinding(g, pids, type, deaths, mafiaSeats) {
  const n = g.accounts.length;
  if (g.seatmap?.length === n) return { seatPid: new Map(g.seatmap.map((sm) => [g.accounts[sm.seat - 1], sm.pid])), quality: "seatmap", ambiguous: [] };
  const deathIdx = new Map(deaths.map((d) => [d.pid, d.idx]));
  const lastSend = new Map(); const notSelf = new Map(g.accounts.map((a) => [a, new Set()]));
  const killTargets = new Set();
  for (const it of g.items) {
    if (it.k !== "vote" && it.k !== "speak") continue;
    lastSend.set(it.seat, Math.max(lastSend.get(it.seat) ?? -1, idx(it.phase)));
    const t = type.get(`${it.phase}|${it.mid}`);
    if (it.k === "vote" && !NON_PLAYER.test(it.val) && !SELF_OK.has(t)) notSelf.get(it.seat)?.add(it.val);
    if (it.k === "vote" && t === "Mafia Kill") killTargets.add(it.val);
  }
  const deadLine = new Map(g.dead.map((d) => [d.seat, idx(d.phase)]));
  // A handle ties to an account when its public chat line is that account's speak send, and to a player when a
  // report names it (the reporter's target that night): the two give the account's player.
  const fixed = new Map();
  const nameAcc = new Map();
  for (const it of g.items) if (it.k === "chat" && !nameAcc.has(it.sender)) {
    const own = g.items.find((s) => s.k === "speak" && s.phase === it.phase && s.val === it.content);
    if (own) nameAcc.set(it.sender, own.seat);
  }
  for (const it of g.items) if (it.k === "alert" && nameAcc.has(it.target)) {
    const p = rawAlertTarget(g, it, type, deaths);
    if (p) fixed.set(nameAcc.get(it.target), p);
  }
  const w = g.winners;
  let mafiaPids = null;
  if (w?.playersByGroup?.Mafia?.length) mafiaPids = new Set(w.playersByGroup.Mafia);
  else if (w?.groups?.includes("Village") && w.players?.length) mafiaPids = new Set(pids.filter((p) => !w.players.includes(p) && !/^unseen/.test(p)));
  const mafiaComplete = mafiaPids && mafiaSeats.size === mafiaPids.size;
  // A journalist told a player "received no reports" that night: no seat with a report that night sits there.
  const noReports = new Map();
  for (const it of g.items) if (it.k === "alert" && it.kind === "journalist" && /^no reports$/i.test(it.result)) {
    const p = rawAlertTarget(g, it, type, deaths);
    if (p) for (const x of g.items) if (x.k === "alert" && x.phase === it.phase) { if (!noReports.has(x.seat)) noReports.set(x.seat, new Set()); noReports.get(x.seat).add(p); }
  }
  const ok = (a, p, useDead) => {
    if (noReports.get(a)?.has(p)) return false;
    if (fixed.has(a) ? fixed.get(a) !== p : [...fixed.values()].includes(p)) return false;
    if (notSelf.get(a)?.has(p)) return false;
    const d = deathIdx.get(p);
    if (d != null && (lastSend.get(a) ?? -1) > d) return false;
    if (useDead && deadLine.has(a) && !(d != null && d <= deadLine.get(a))) return false;
    if (mafiaSeats.has(a) && killTargets.has(p)) return false;
    if (mafiaPids) {
      if (mafiaSeats.has(a) && !mafiaPids.has(p)) return false;
      if (mafiaComplete && !mafiaSeats.has(a) && mafiaPids.has(p)) return false;
    }
    return true;
  };
  // First assignment in seat order (players in first-seen order), with some seats forced to a player.
  const first = (useDead, force = new Map()) => {
    const used = new Set(); const cur = [];
    const go = (i) => {
      if (i === n) return true;
      const a = g.accounts[i];
      for (const p of force.has(i) ? [force.get(i)] : pids) {
        if (used.has(p) || ![...force].every(([j, q]) => j === i || q !== p) || !ok(a, p, useDead)) continue;
        used.add(p); cur.push(p);
        if (go(i + 1)) return true;
        cur.pop(); used.delete(p);
      }
      return false;
    };
    return go(0) ? cur : null;
  };
  let useDead = true;
  let sol = first(true);
  if (!sol) { useDead = false; sol = first(false); }
  if (!sol) return { seatPid: new Map(g.accounts.map((a, i) => [a, pids[i]])), quality: "guessed", ambiguous: [...g.accounts] };
  // A seat is ambiguous when the log also allows it another player.
  const ambiguous = g.accounts.filter((a, i) => pids.some((p) => p !== sol[i] && first(useDead, new Map([[i, p]]))));
  const quality = !ambiguous.length ? "recovered" : ambiguous.length === n ? "guessed" : "partial";
  return { seatPid: new Map(g.accounts.map((a, i) => [a, sol[i]])), quality, ambiguous, mafiaPids };
}

/** The raw player an alert line reports on: the reporter's own target the night before (Janitor: the cleaned victim). */
function rawAlertTarget(g, it, type, deaths) {
  const night = `Night ${it.phase.split(" ")[1]}`;
  if (it.kind === "janitor") return deaths.find((x) => x.phase === night && x.cleaned)?.pid || null;
  const want = it.kind === "cop" ? "Investigate" : "Receive Reports";
  const s = g.items.filter((x) => x.k === "vote" && x.seat === it.seat && x.phase === night && ["Night Action", want].includes(type.get(`${night}|${x.mid}`)) && !NON_PLAYER.test(x.val)).pop();
  return s ? s.val : null;
}

/**
 * Options, both off by default (the committed fixtures are built without them; found by the state-model replay,
 * scripts/state-replay.mjs, 2026-10-20):
 *   alertRoles  a Janitor's alert names the cleaned player's role: that seat gets it. Off, a seat that died before
 *               its role meeting (L2: the Sheriff, killed and cleaned Night 1) took a leftover role (Villager) and a
 *               living Villager was handed the Sheriff.
 *   voteOrder   "log": a day's ballots go out in log order around the Sheriff's shot, and a ballot the shot victim
 *               sent after he died is dropped. Off ("after"), every ballot follows the shot (L5: the shot Janitor's
 *               earlier ballot then arrives after his death).
 * And one found by the Night 5 rebuild of g05/g14/g16 (docs/night5-fixture-diff.md):
 *   nickVariants  bots' spellings of a short (3-4 letter) first name are scrubbed like the name: the plural or
 *               possessive ("<name>s") and the "ck" spelling ("<na>ck" for "<na>k"). Off, those words pass the
 *               nickname matcher (it needs 5+ letters to guess) and a real first name's variant stays in the chat
 *               (g14: two such variants of one dev handle, 49 lines).
 * And one for the Night 5 single-bot eval (harness/src/soloEval.js):
 *   timeline    "log": frames carry the log's own times (the t= of L4+ sends and chat lines, shifted to the fixture
 *               epoch) and a phase's speech, chat and ballots go out in one log-ordered stream around the shot. A
 *               phase starts TIMELINE_LEAD_MS before its first timed line (the log has no phase-start time). Off
 *               ("order"), every frame is 37 ms after the one before and a day is all its speech, then its chat,
 *               then its ballots: fine for state, useless for timing (a whole L10 day is ~5 s).
 */
export const BUILD_DEFAULTS = Object.freeze({ alertRoles: false, voteOrder: "after", nickVariants: false, timeline: "order" });
export const TIMELINE_LEAD_MS = 2_000;

export function build(g, { source, realNames: REAL_NAMES = [], alertRoles = BUILD_DEFAULTS.alertRoles, voteOrder = BUILD_DEFAULTS.voteOrder, nickVariants = BUILD_DEFAULTS.nickVariants, timeline = BUILD_DEFAULTS.timeline } = {}) {
  const n = g.accounts.length;
  const acc = new Map(g.accounts.map((a, i) => [a, `acc${String(i + 1).padStart(2, "0")}`]));
  // Players: the seatmap's, then every id a send or the winners named, first-seen order.
  const pidsRaw = [];
  const addPid = (id) => { if (id && !NON_PLAYER.test(id) && !pidsRaw.includes(id)) pidsRaw.push(id); };
  const seatmap = g.seatmap?.length === n ? g.seatmap : null;
  for (const sm of seatmap || []) addPid(sm.pid);
  for (const it of g.items) if (it.k === "vote") addPid(it.val);
  for (const id of g.winners?.players || []) addPid(id);
  const universe = [...pidsRaw];
  while (universe.length < n) universe.push(`unseen${universe.length + 1}`);
  const fakePid = new Map(universe.map((id, i) => [id, `p${String(i + 1).padStart(2, "0")}`]));
  const players = universe.map((id) => fakePid.get(id));
  const name = (pid) => `Player${pid.slice(1)}`;

  // Binding, deaths and roles from the log's evidence (deaths and binding refine each other once).
  const { type, mafiaSeats } = meetingTypes(g);
  let deaths = deathsFrom(g, type, null, null);
  let bind = recoverBinding(g, universe, type, deaths, mafiaSeats);
  for (let k = 0; k < 2; k++) {
    const again = deathsFrom(g, type, bind.seatPid, bind.mafiaPids);
    if (JSON.stringify(again) === JSON.stringify(deaths)) break;
    deaths = again; bind = recoverBinding(g, universe, type, deaths, mafiaSeats);
  }
  const rawSeatPid = bind.seatPid;
  const seatPid = new Map(g.accounts.map((a) => [a, fakePid.get(rawSeatPid.get(a))]));
  const seatOfRaw = new Map([...rawSeatPid].map(([a, p]) => [p, a]));
  if (bind.mafiaPids) for (const p of bind.mafiaPids) if (seatOfRaw.has(p)) mafiaSeats.add(seatOfRaw.get(p));

  // Roles: from each seat's meetings; seats the log cannot place get the setup's remaining roles, mafia to mafia.
  const role = new Map();
  for (const it of g.items) {
    if (it.k !== "meeting" && it.k !== "vote") continue;
    const r = ROLE_BY_MEETING[type.get(`${it.phase}|${it.mid}`)];
    if (r && !role.has(it.seat)) role.set(it.seat, r);
  }
  const haveMeetingLines = g.items.some((it) => it.k === "meeting" && it.phase !== "Pregame");
  const evidence = haveMeetingLines || g.items.some((it) => it.k === "vote" && it.phase !== "Pregame");
  const left = [...FJ];
  const take = (r) => { const i = left.indexOf(r); if (i >= 0) left.splice(i, 1); return i >= 0; };
  for (const [a, r] of [...role]) if (!take(r)) role.delete(a);
  if (alertRoles) for (const it of g.items) {
    if (it.k !== "alert" || it.kind !== "janitor") continue;
    const seat = seatOfRaw.get(rawAlertTarget(g, it, type, deaths));
    if (seat && !role.has(seat) && !mafiaSeats.has(seat) && take(String(it.result))) role.set(seat, String(it.result));
  }
  if (!evidence) g.accounts.forEach((a, i) => role.set(a, FJ[i % FJ.length]));
  const nightActor = new Set(g.items.filter((it) => it.k === "vote" && type.get(`${it.phase}|${it.mid}`) === "Night Action").map((it) => it.seat));
  for (const a of g.accounts) {
    if (role.has(a)) continue;
    const pick = mafiaSeats.has(a) ? (left.includes("Mafioso") ? "Mafioso" : left.find((r) => MAFIA.has(r)))
      : nightActor.has(a) ? left.find((r) => r === "Cop" || r === "Journalist") : left.find((r) => r === "Villager") || left.find((r) => !MAFIA.has(r));
    if (pick) { take(pick); role.set(a, pick); } else role.set(a, "Villager");
  }
  // A "Night Action" now has its seat's role: name it after the role's meeting.
  for (const it of g.items) {
    const key = `${it.phase}|${it.mid}`;
    if (type.get(key) === "Night Action" && it.seat) type.set(key, MEETING_BY_ROLE[role.get(it.seat)] || "Night Action");
  }

  // Chat names: from the seatmap; from a seat's own speak line (same text); from an alert's target; else first-seen.
  const nameToPid = new Map(seatmap ? seatmap.map((sm) => [sm.name, fakePid.get(sm.pid)]) : []);
  for (const it of g.items) if (it.k === "chat" && !nameToPid.has(it.sender)) {
    const own = g.items.find((s) => s.k === "speak" && s.phase === it.phase && s.val === it.content);
    if (own) nameToPid.set(it.sender, seatPid.get(own.seat));
  }
  const alertTarget = (it) => fakePid.get(rawAlertTarget(g, it, type, deaths)) || null;
  for (const it of g.items) if (it.k === "alert" && !nameToPid.has(it.target)) { const p = alertTarget(it); if (p) nameToPid.set(it.target, p); }
  const realNames = [...nameToPid.keys()];
  for (const it of g.items) if (it.k === "chat" && !realNames.includes(it.sender)) realNames.push(it.sender);
  const taken = new Set(nameToPid.values());
  const free = players.filter((p) => !taken.has(p));
  for (const nm of realNames) if (!nameToPid.has(nm) && free.length) nameToPid.set(nm, free.shift());

  const mids = new Map();
  const mid = (id) => { if (!mids.has(id)) mids.set(id, `m${String(mids.size + 1).padStart(2, "0")}`); return mids.get(id); };
  const allRaw = [...g.accounts, ...pidsRaw, g.id];
  const extraNames = new Map(); const extraIds = new Map();
  const ID_SHAPED = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:\d|_|-|[a-z][A-Z]))[A-Za-z0-9_-]{9,12}(?![A-Za-z0-9_-])/g;
  const idsSeen = [...new Set([...allRaw.filter((r) => String(r).length >= 8), ...(JSON.stringify(g).match(ID_SHAPED) || [])])];
  const PARTS = REAL_NAMES.map((full) => ({ full, letters: full.replace(/\d+$/, "").toLowerCase(), parts: full.replace(/\d+$/, "").match(/[A-Z][a-z]+/g).map((x) => x.toLowerCase()) }));
  const nameOwner = (word) => ownerOf(word, PARTS, { nickVariants });
  const fakeName = (real) => {
    const pid = nameToPid.get(real);
    if (pid) return name(pid);
    if (!extraNames.has(real)) extraNames.set(real, `Guest${String(extraNames.size + 1).padStart(2, "0")}`);
    return extraNames.get(real);
  };
  const scrub = (text) => {
    let s = String(text ?? "");
    for (const [nm, pid] of [...nameToPid].sort((a, b) => b[0].length - a[0].length)) {
      s = s.replace(new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (hit) => (hit === hit.toLowerCase() ? name(pid).toLowerCase() : name(pid)));
    }
    for (const raw of allRaw.sort((a, b) => b.length - a.length)) s = s.split(raw).join(fakePid.get(raw) || acc.get(raw) || "game");
    for (const [raw, f] of mids) s = s.split(raw).join(f);
    // Bots shorten ids into nicknames ("q7Rx, M2kd, Tz9wPa1"): a 4+ char id-shaped prefix of a seen id gets that id's fake.
    s = s.replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:\d|_|[a-z][A-Z]))[A-Za-z0-9_-]{4,11}(?![A-Za-z0-9_-])/g, (hit) => {
      const full = idsSeen.find((r) => r.length > hit.length && r.startsWith(hit));
      if (!full) return hit;
      if (fakePid.has(full) || acc.has(full)) return fakePid.get(full) || acc.get(full);
      if (!extraIds.has(full)) extraIds.set(full, `x${String(extraIds.size + 1).padStart(2, "0")}`);
      return extraIds.get(full);
    });
    // Every dev name seen anywhere in the logs, in full or as a nickname the bots use: same fake per person.
    s = s.replace(/\b[A-Za-z]{3,}\d{0,3}\b/g, (hit) => {
      const owner = nameOwner(hit);
      if (!owner) return hit;
      const fake = fakeName(owner);
      return hit === hit.toLowerCase() ? fake.toLowerCase() : fake;
    });
    s = s.replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{9,12}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*(?:\d|_|-|[a-z][A-Z]))[A-Za-z0-9_-]{9,12}/g, (hit) => {
      if (/^(player|guest)\d+$/i.test(hit)) return hit;
      // "self-vote", "fake-claim": a lowercase hyphenated word is an id only when the log saw that exact raw id.
      if (/^[a-z]+(?:-[a-z]+)+$/.test(hit) && !allRaw.includes(hit)) return hit;
      if (!extraIds.has(hit)) extraIds.set(hit, `x${String(extraIds.size + 1).padStart(2, "0")}`);
      return extraIds.get(hit);
    });
    // A chat line cut at the length limit can end in part of an id ("... voted me (Hb4Ke9"): drop the stub.
    s = s.replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:\d[A-Za-z]|[A-Za-z]\d|[a-z][A-Z]))[A-Za-z0-9_-]{4,8}$/, (hit) => (/^(player|guest|x)\d+$/i.test(hit) ? hit : "[cut]"));
    return s.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9+/_-]{24,}\b/g, "[redacted]");
  };
  const mapSel = (sel) => (NON_PLAYER.test(sel) ? sel : fakePid.get(sel) || sel);
  const deathAt = new Map(deaths.map((d) => [fakePid.get(d.pid), d.idx]));
  const deadBy = (seat, i) => { const d = deathAt.get(seatPid.get(seat)); return d != null && d < i; };

  // Meetings per phase from meeting lines and sends; a dead seat's late send is dropped (the server rejects it).
  const phases = [];
  const phaseOf = (p) => { let x = phases.find((q) => q.name === p); if (!x) { x = { name: p, meetings: new Map(), votes: [], speech: [] }; phases.push(x); } return x; };
  for (const [at, it] of g.items.entries()) {
    if (it.k === "chat" || it.k === "alert" || it.k === "reject" || !it.phase) continue;
    if (it.k !== "meeting" && deadBy(it.seat, idx(it.phase))) continue;
    const ph = phaseOf(it.phase);
    const id = mid(it.mid);
    let m = ph.meetings.get(id);
    if (!m) { m = { id, name: type.get(`${it.phase}|${it.mid}`) || null, members: new Set(), voting: true, speech: false, n: null, targets: new Set() }; ph.meetings.set(id, m); }
    m.members.add(it.seat);
    if (it.k === "meeting") { m.voting = it.voting; m.speech = it.role === "chat" || it.name === "Village"; m.n = it.n; m.canVote = it.canVote; }
    if (it.k === "vote") { m.targets.add(mapSel(it.val)); ph.votes.push({ seat: it.seat, mid: id, sel: mapSel(it.val), at, ms: it.ms }); }
    if (it.k === "speak") { m.speech = true; ph.speech.push({ seat: it.seat, mid: id, content: scrub(it.val), at, ms: it.ms }); }
  }
  for (const [at, it] of g.items.entries()) if (it.k === "chat" && nameToPid.has(it.sender)) {
    const ph = phaseOf(it.phase);
    ph.chat = ph.chat || [];
    ph.chat.push({ sender: nameToPid.get(it.sender), meeting: it.meeting, content: scrub(it.content), at, ms: it.ms });
  }
  // Rejected/held lines (sidecar): placed among the phase's own sends in log order; they emit no frame.
  const rejects = [];
  for (const [at, it] of g.items.entries()) if (it.k === "reject") {
    const ph = phases.find((p) => p.name === it.phase);
    const rec = { accountId: acc.get(it.seat), phase: it.phase, source: it.source, reasons: it.reasons.map((r) => String(r).replace(/^((?:held line invalid at send: )?chat-audit: [A-Z_]+ [a-z-]+ )?([\s\S]*)$/, (_, head = "", rest) => head + scrub(rest))), line: it.line == null ? null : scrub(it.line), outIndex: null };
    rejects.push(rec);
    if (ph) (ph.rejects ||= []).push({ at, rec });
  }
  phases.sort((a, b) => idx(a.name) - idx(b.name));
  for (const ph of phases) for (const m of ph.meetings.values()) {
    if (m.name === "Village") m.speech = true;
    if (!m.name) m.name = m.speech ? "Mafia Meeting" : /^Day/.test(ph.name) ? "Day Action" : "Night Action";
  }

  const F = g.frames;
  const has = (t) => (F[`game:${t}`] || 0) > 0;
  const out = [];
  const seq = new Map(); let t = 1_800_000_000_000;
  const emit = (a, event, data) => { const s = (seq.get(a) || 0) + 1; seq.set(a, s); out.push({ accountId: acc.get(a), seq: s, t: (t += 37), event, ...(data === undefined ? {} : { data }) }); };
  const all = (event, data) => { for (const a of g.accounts) emit(a, event, typeof data === "function" ? data(a) : data); };
  const playerInfo = (pid) => ({ id: pid, anonId: null, name: name(pid), userId: `u${pid.slice(1)}`, avatar: false });
  const playersMsg = Object.fromEntries(players.map((p) => [p, playerInfo(p)]));
  const dead = new Set();
  const roleOfPid = (pid) => role.get(g.accounts.find((a) => seatPid.get(a) === pid)) || "Villager";
  let stateId = 0;

  // Join burst (Game.js sendStateInfo order).
  if (has("connected")) all("connected");
  if (has("authSuccess")) all("authSuccess");
  if (has("self")) all("self", (a) => seatPid.get(a));
  if (has("players")) all("players", playersMsg);
  if (has("options")) all("options", { private: true, anonymousGame: false, spectating: false, voiceChat: false, readyCheck: false });
  if (has("history")) all("history", {});
  if (has("state")) all("state", { id: stateId, name: "Pregame", dayCount: 0 });
  if (has("stateEvents")) all("stateEvents", []);
  if (has("setup")) all("setup", { id: "setup01", name: "Frontier Justice", total: n, roles: [Object.fromEntries(FJ.map((r) => [`${r}:`, 1]))] });
  if (has("emojis")) all("emojis", {});
  if (has("isStarted")) all("isStarted", false);
  if (has("spectatorCount")) all("spectatorCount", 0);
  if (has("spectators")) all("spectators", {});
  if (has("dev")) all("dev");
  if (has("loaded")) all("loaded");
  if (has("playerJoin")) for (const p of players.slice(1)) all("playerJoin", playerInfo(p));
  if (has("readyCheck success")) all("readyCheck success", {});
  const lobby = { id: mid("pregame-chat"), name: "Pregame", members: new Set(g.accounts), voting: false, speech: true, n: 0, targets: new Set() };
  if (has("meeting")) all("meeting", (a) => meetingInfo(lobby, a, []));
  if (has("timerInfo")) all("timerInfo", { name: "pregameCountdown", delay: 10000 });
  if (has("time")) all("time", { name: "pregameCountdown", time: 2000 });
  if (has("message")) all("message", { id: "msg0-1", senderId: "server", content: `${name(players[0])} has joined.`, meetingId: lobby.id, time: t });
  if (has("clearTimer")) all("clearTimer", "pregameCountdown");
  if (has("leftMeeting")) all("leftMeeting", lobby.id);
  const pre = phases.find((p) => p.name === "Pregame");
  if (pre) {
    for (const m of pre.meetings.values()) for (const a of m.members) emit(a, "meeting", meetingInfo(m, a, ["Kick"]));
    if (has("youAreBeingVoteKicked")) for (const m of pre.meetings.values()) for (const a of m.members) emit(a, "youAreBeingVoteKicked", { status: true });
  }
  if (has("start")) all("start");
  if (has("roleReveal")) all("roleReveal", (a) => ({ playerId: seatPid.get(a), role: role.get(a), roleData: { alignment: MAFIA.has(role.get(a)) ? "Mafia" : "Village" } }));
  if (has("reveal")) for (const a of g.accounts) if (MAFIA.has(role.get(a))) for (const b of g.accounts) if (b !== a && MAFIA.has(role.get(b))) emit(a, "reveal", { playerId: seatPid.get(b), role: role.get(b) });

  function meetingInfo(m, a, forced) {
    const self = seatPid.get(a);
    const living = players.filter((p) => !dead.has(p));
    let targets = forced || [...m.targets].filter((x) => NON_PLAYER.test(x));
    if (!forced) {
      if (/Clean Death|Mafia Action/.test(m.name) || (m.n === 2 && !targets.length)) targets = ["Yes", "No"];
      else if (m.name === "Vote Kick") targets = ["Kick"];
      // Player targets (or none recorded): offer the living pool plus every recorded option. The old test looked
      // for players among the already-filtered non-player options, so a "*" plus player votes offered only "*".
      else if (!targets.length || [...m.targets].some((x) => !NON_PLAYER.test(x))) {
        const pool = m.name === "Mafia Kill" ? living.filter((p) => !MAFIA.has(roleOfPid(p))) : living.filter((p) => p !== self || m.name === "Village");
        targets = [...new Set([...pool.slice(0, m.n ?? pool.length), ...[...m.targets].filter((x) => !NON_PLAYER.test(x))]), ...[...m.targets].filter((x) => NON_PLAYER.test(x))];
      }
    }
    return {
      id: m.id, name: m.name, actionName: m.name, members: [...m.members].map((b) => ({ id: seatPid.get(b), canUpdateVote: true, canVote: m.canVote !== false })),
      group: m.members.size > 1, speech: !!m.speech, voting: !!m.voting, instant: m.name === "Shoot Gun", anonymous: false, multi: false,
      targets, inputType: "player", votes: {}, voteRecord: [], messages: [], canVote: m.canVote !== false, canUpdateVote: true, amMember: true,
    };
  }

  // Server report wording (LearnAlignment, ReceiveReports/ReportsInfo, CleanDeath) for an alert line.
  const alertText = (it, pid) => {
    const who = pid ? name(pid) : fakeName(it.target);
    if (it.kind === "cop") return `:invest: After investigating, you learn that ${who} is ${/^(village|innocent)$/i.test(it.result) ? "Innocent" : /^(mafia|guilty)$/i.test(it.result) ? "Guilty" : scrub(it.result)}!`;
    if (it.kind === "janitor") return `:mop: You discover ${who}'s role is ${scrub(it.result)}.`;
    if (/^no reports$/i.test(it.result)) return `:journ: You learn that ${who} received no reports.`;
    return `:journ: You received all reports that ${who} received: ${scrub(String(it.result).replace(/^reports:\s*/i, ""))}.`;
  };
  let alertCount = 0;

  // timeline "log": the log's clock, shifted so the game starts a minute after the join burst.
  const logMs = timeline === "log" ? g.items.map((it) => it.ms).filter(Number.isFinite) : [];
  const ms0 = logMs.length ? Math.min(...logMs) : null;
  const t0 = t + 60_000;
  const stamp = (ms) => { if (ms0 != null && Number.isFinite(ms)) t = Math.max(t, t0 + ms - ms0); };
  for (const ph of phases.filter((p) => p.name !== "Pregame")) {
    stateId += 1;
    if (ms0 != null) {
      const first = [...ph.speech, ...ph.votes, ...(ph.chat || [])].map((x) => x.ms).filter(Number.isFinite);
      if (first.length) stamp(Math.min(...first) - TIMELINE_LEAD_MS);
    }
    const alive = g.accounts.filter((a) => !dead.has(seatPid.get(a)));
    const to = (a, event, data) => { if (!dead.has(seatPid.get(a))) emit(a, event, data); };
    if (has("state")) for (const a of alive) to(a, "state", { id: stateId, name: ph.name, dayCount: Number(ph.name.split(" ")[1]) || 0 });
    if (has("stateEvents")) for (const a of alive) to(a, "stateEvents", []);
    if (has("timerInfo")) for (const a of alive) to(a, "timerInfo", { name: "main", delay: /^Day/.test(ph.name) ? 300000 : 60000 });
    const meetings = [...ph.meetings.values()];
    if (/^Day/.test(ph.name) && !meetings.some((m) => m.name === "Village")) {
      const vm = { id: mid(`village-${ph.name}`), name: "Village", members: new Set(alive), voting: true, speech: true, n: null, targets: new Set() };
      meetings.push(vm); ph.meetings.set(vm.id, vm);
    }
    for (const m of meetings) if (m.name === "Village") for (const a of alive) m.members.add(a);
    for (const m of meetings) for (const a of m.members) if (alive.includes(a)) to(a, "meeting", meetingInfo(m, a));
    if (has("members")) for (const m of meetings) for (const a of m.members) if (alive.includes(a)) to(a, "members", { meetingId: m.id, members: [...m.members].map((b) => ({ id: seatPid.get(b), canUpdateVote: true, canVote: true })) });
    if (has("time")) for (const ms of [5000, 30000]) for (const a of alive) to(a, "time", { name: "main", time: ms });
    let mi = 0;
    const vil = meetings.find((m) => m.name === "Village");
    if (has("message")) for (const a of alive) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: "server", content: `${ph.name} has begun.`, meetingId: vil?.id, time: t });
    // Last night's reports reach their seats at the start of the day.
    for (const it of g.items.filter((x) => x.k === "alert" && x.phase === ph.name)) {
      if (!alive.includes(it.seat)) continue;
      to(it.seat, "message", { id: `msg${stateId}-${++mi}`, senderId: "server", content: alertText(it, alertTarget(it)), time: t });
      alertCount += 1;
    }
    // The Sheriff's shot lands where the log had it: his gun vote, the server's gun line (live logs never
    // printed it; items/Gun.js text), the gunshot, the death and the reveal, then the rest of the day's chat.
    const shot = has("vote") && /^Day/.test(ph.name) ? deaths.find((d) => d.phase === ph.name && d.cause === "gun" && d.by) : null;
    const shotVote = shot ? ph.votes.find((v) => v.seat === shot.by && v.sel === fakePid.get(shot.pid) && ph.meetings.get(v.mid)?.name === "Shoot Gun") : null;
    const fire = () => {
      const kill = fakePid.get(shot.pid);
      for (const a of ph.meetings.get(shotVote.mid)?.members || []) to(a, "vote", { voterId: seatPid.get(shotVote.seat), target: shotVote.sel, meetingId: shotVote.mid });
      if (has("message")) for (const a of alive) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: "server", content: `:gun: ${name(seatPid.get(shot.by))} pulls a gun and shoots at ${name(kill)}!`, meetingId: vil?.id, time: t });
      if (has("gunshot")) for (const a of alive) to(a, "gunshot");
      for (const a of alive) to(a, "death", kill);
      if (has("deathSounds")) for (const a of alive) to(a, "deathSounds", ["/audio/death.mp3"]);
      if (has("obituaries")) for (const a of alive) to(a, "obituaries", { id: `${stateId}:Day:gun`, obituaries: [{ id: kill, playerInfo: playerInfo(kill), snippets: ["was shot"] }], source: "Day", time: t, dayCount: Number(ph.name.split(" ")[1]) || 0 });
      if (has("reveal")) for (const a of alive) to(a, "reveal", { playerId: kill, role: roleOfPid(kill) });
      dead.add(kill);
      const victim = g.accounts.find((a) => seatPid.get(a) === kill);
      if (victim && has("isSpectator")) emit(victim, "isSpectator");
    };
    const spoken = new Set(ph.speech.map((x) => x.content));
    const lines = [
      ...ph.speech.map((s) => ({ at: s.at, ms: s.ms, send: () => { for (const a of ph.meetings.get(s.mid)?.members || []) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: seatPid.get(s.seat), content: s.content, meetingId: s.mid, time: t }); } })),
      ...(ph.rejects || []).map((r) => ({ at: r.at, send: () => { r.rec.outIndex = out.length; } })),
      ...(ph.chat || []).filter((c) => vil && has("message") && !spoken.has(c.content)).map((c) => ({ at: c.at, ms: c.ms, chat: true, send: () => { for (const a of alive) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: c.sender, content: c.content, meetingId: vil.id, time: t }); } })),
    ];
    // Speech first, then chat (the old order) unless a shot splits the day.
    const before = shotVote ? lines.filter((l) => l.at < shotVote.at) : lines;
    const after = shotVote ? lines.filter((l) => l.at >= shotVote.at) : [];
    const reAim = (v) => shotVote && v.seat === shotVote.seat && v.mid === shotVote.mid;
    const sendVote = (v) => { for (const a of ph.meetings.get(v.mid)?.members || []) to(a, "vote", { voterId: seatPid.get(v.seat), target: v.sel, meetingId: v.mid }); };
    const ballots = has("vote") ? ph.votes.filter((v) => v !== shotVote && !reAim(v)) : [];
    const early = voteOrder === "log" && shotVote ? ballots.filter((v) => v.at < shotVote.at) : [];
    if (ms0 != null) {
      // One stream in log order (to() drops the shot victim's later frames), each frame at its logged time.
      const stream = [...lines.map((l) => ({ at: l.at, ms: l.ms, go: l.send })), ...ballots.map((v) => ({ at: v.at, ms: v.ms, go: () => sendVote(v) })), ...(shotVote ? [{ at: shotVote.at, ms: shotVote.ms, go: fire }] : [])];
      for (const x of stream.sort((a, b) => a.at - b.at)) { stamp(x.ms); x.go(); }
    } else {
      for (const group of [before, after]) {
        for (const l of group.filter((x) => !x.chat).sort((a, b) => a.at - b.at)) l.send();
        for (const l of group.filter((x) => x.chat)) l.send();
        if (group === before && shotVote) { early.forEach(sendVote); fire(); }
      }
      // to() already drops a dead seat's frames; voteOrder "log" also drops the shot victim's ballots sent after the shot.
      for (const v of ballots) if (!early.includes(v)) sendVote(v);
    }
    if (has("youAreBeingVoteKicked") && /^Day/.test(ph.name)) { const lazy = alive.find((a) => !ph.votes.some((v) => v.seat === a)); if (lazy) { to(lazy, "youAreBeingVoteKicked", { status: true }); } }
    if (has("clearTimer")) for (const a of alive) to(a, "clearTimer", "main");
    if (has("leftMeeting")) for (const m of meetings) if (m.name !== "Village") for (const a of m.members) if (alive.includes(a)) to(a, "leftMeeting", m.id);
    const here = deaths.filter((d) => d.phase === ph.name);
    if (has("gunshot") && !shotVote && here.some((d) => d.cause === "gun")) for (const a of alive) to(a, "gunshot");
    if (here.some((d) => d.cause === "condemn") && has("condemn")) for (const a of alive) to(a, "condemn");
    if (here.some((d) => d.cause === "condemn") && has("audio")) for (const a of alive) to(a, "audio", "veg");
    for (const d of here) {
      const kill = fakePid.get(d.pid);
      if (!players.includes(kill) || dead.has(kill)) continue;
      for (const a of alive) to(a, "death", kill);
      if (has("deathSounds")) for (const a of alive) to(a, "deathSounds", ["/audio/death.mp3"]);
      if (has("exorcised")) for (const a of alive) to(a, "exorcised", kill);
      if (has("obituaries")) for (const a of alive) to(a, "obituaries", { id: `${stateId}:${ph.name.split(" ")[0]}`, obituaries: [{ id: kill, playerInfo: playerInfo(kill), snippets: ["was found dead"] }], source: ph.name.split(" ")[0], time: t, dayCount: Number(ph.name.split(" ")[1]) || 0 });
      // CleanDeath: a cleaned kill shows no role.
      if (has("reveal") && !d.cleaned) for (const a of alive) to(a, "reveal", { playerId: kill, role: roleOfPid(kill) });
      dead.add(kill);
      const victim = g.accounts.find((a) => seatPid.get(a) === kill);
      if (victim && has("isSpectator")) emit(victim, "isSpectator");
    }
  }
  // The log saw deaths the sends do not explain (kills by other means): the last living player dies.
  let unexplainedDeath = false;
  if ((has("death") || has("exorcised")) && !out.some((e) => e.event === "death" || e.event === "exorcised")) {
    unexplainedDeath = true;
    const victim = [...players].reverse().find((p) => !dead.has(p));
    for (const a of g.accounts.filter((b) => !dead.has(seatPid.get(b)))) { if (has("death")) emit(a, "death", victim); if (has("exorcised")) emit(a, "exorcised", victim); }
    dead.add(victim);
  }
  // Frame types the log saw but the rebuilt story had no natural place for: one server-shaped frame each.
  const SHAPES = { audio: "veg", condemn: undefined, gunshot: undefined, deathSounds: ["/audio/death.mp3"], youAreBeingVoteKicked: { status: false },
    isSpectator: undefined, leftMeeting: lobby.id, clearTimer: "main", exorcised: null, obituaries: { id: `${stateId}:Day`, obituaries: [], source: "Day", time: t, dayCount: 0 },
    death: null, reveal: null, members: { meetingId: lobby.id, members: [] }, vote: null };
  for (const ty of Object.keys(F).filter((x) => x.startsWith("game:")).map((x) => x.slice(5))) {
    if (out.some((e) => e.event === ty) || !(ty in SHAPES) || SHAPES[ty] === null) continue;
    for (const a of g.accounts.filter((b) => !dead.has(seatPid.get(b)))) emit(a, ty, SHAPES[ty]);
  }
  if (has("winners") || g.winners) {
    if (!has("winners")) F["game:winners"] = 1;
    const w = g.winners || { groups: ["Village"], players: [], messages: [], playersByGroup: {} };
    const ww = JSON.parse(scrub(JSON.stringify(w)));
    ww.players = (w.players || []).map((p) => fakePid.get(p) || p);
    ww.playersByGroup = Object.fromEntries(Object.entries(w.playersByGroup || {}).map(([k, v]) => [k, v.map((p) => fakePid.get(p) || p)]));
    all("winners", ww);
  }
  if (has("finished")) all("finished");
  if (has("kudos")) all("kudos", { open: true, votes: {}, myVote: null });
  const types = Object.keys(F).filter((k) => k.startsWith("game:")).map((k) => k.slice(5));
  const missing = types.filter((ty) => !out.some((e) => e.event === ty));
  if (missing.length) throw new Error(`${g.id}: missing ${missing.join(",")}`);
  // Nothing real leaks: no raw account/player/meeting/game id and no chat or alert name survives.
  for (const r of rejects) if (r.outIndex == null) r.outIndex = out.length; // Postgame and other unplaced lines: at the end
  const blob = JSON.stringify(out) + JSON.stringify(rejects);
  for (const raw of [...allRaw, ...mids.keys(), ...realNames, ...REAL_NAMES]) if (raw.length >= 5 && blob.toLowerCase().includes(raw.toLowerCase())) throw new Error(`${g.id}: raw id/name leaked`);
  const confirmed = deaths.filter((d) => g.dead.some((x) => rawSeatPid.get(x.seat) === d.pid)).length;
  return {
    out, rejects, types: Object.fromEntries(types.map((ty) => [ty, F[`game:${ty}`]])), source, phases: phases.map((p) => p.name), seats: n,
    seatBinding: bind.quality, ambiguousSeats: bind.ambiguous.map((a) => acc.get(a)),
    roles: haveMeetingLines ? "meetings" : evidence ? "inferred" : "setup order",
    phaseTags: g.items.some((it) => it.k === "vote" && it.tagged) ? "logged" : phases.some((p) => p.name !== "Pregame") ? "frame counts" : "none",
    unexplainedDeath,
    deaths: deaths.length, deathsConfirmedByDeadLines: confirmed, cleaned: deaths.filter((d) => d.cleaned).length, alerts: alertCount,
  };
}

// Nickname matching for dev display names ("FirstLast12" in the logs).
const STOP = new Set("left lefty shut wash ward warden wardrobe bell belly bells burn burns burned burning fish fishy germ german mild glance glanced clarify clarity clarified strike strip strict string strong cotton cottage pinch prudent patrol patron array calibrate alliance ally malaria melody melon nappy silo christ cathedral hesitate robe robot robust mare dowel balsa balsam glen glens takeaway inside fishing fished fisher".split(" "));
// Three-part names count too ("McQuarrieDell30" is Mc + Quarrie + Dell).
export function realNamesIn(texts) { return [...new Set(texts.flatMap((t) => t.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\d{1,3}\b/g) || []))]; }
function editsAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function ownerOf(word, PARTS, { nickVariants = false } = {}) {
  const w = word.toLowerCase(); const letters = w.replace(/\d+$/, "");
  if (/^(player|guest)$/.test(letters)) return null;
  for (const p of PARTS) if (letters === p.letters) return p.full;
  if (letters.length >= 8) for (const p of PARTS) if (p.parts.some((x) => x.length >= 5 && letters.includes(x))) return p.full;
  // A run-on nickname past the first part ("osrinav" for OsrinAvelina70, L4).
  if (letters.length >= 5) for (const p of PARTS) if (p.letters.startsWith(letters) && letters.length > p.parts[0].length) return p.full;
  // ...or one typo off such a run-on ("mcphal" for McPhailBrennan7, L5). 6+ letters keeps plain words out.
  if (letters.length >= 6 && !STOP.has(letters)) for (const p of PARTS) for (const n of [letters.length - 1, letters.length, letters.length + 1]) {
    if (n > p.parts[0].length && n >= 5 && n <= p.letters.length && editsAtMostOne(letters, p.letters.slice(0, n))) return p.full;
  }
  // A surname split off with the number ("kestrel barlow91"): the part plus the full name's digits.
  const digits = /\d+$/.exec(w)?.[0];
  if (digits) for (const p of PARTS) if (p.parts.includes(letters) && p.full.endsWith(digits)) return p.full;
  if (STOP.has(letters) || /\d/.test(w)) return null;
  for (const p of PARTS) if (p.parts.includes(letters)) return p.full;
  // nickVariants: "<part>s" and the "ck" spelling of a short part ("tock" for Tok). Longer parts already match
  // through the run-on and one-edit rules above.
  if (nickVariants) for (const p of PARTS) for (const x of p.parts) if (x.length >= 3 && (letters === `${x}s` || (letters.includes("ck") && letters.replace(/ck/g, "k") === x))) return p.full;
  const capital = word[0] === word[0].toUpperCase();
  if (letters.length >= (capital ? 4 : 5)) {
    for (const p of PARTS) if (p.parts.some((x) => x.length >= 5 && x.slice(0, 4) === letters.slice(0, 4) && letters.length <= x.length + (capital ? 1 : 0))) return p.full;
  }
  return null;
}
