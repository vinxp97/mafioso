// Build sanitized protocol replay fixtures from live-harness logs (the *.log.err files the live CLI writes).
// The logs are not raw frame dumps: they hold per-type frame counts ("frames {...}"), meeting lines, sends,
// public chat and winners. This rebuilds, per game, a dev-API envelope stream ({accountId, seq, t, event, data})
// that contains every frame type the log saw for that game, in server order, with payload shapes taken
// from the server source (Games/core/*.js). Ids and names are replaced with fakes; no tokens are kept.
//
//   node scripts/build-replays.mjs <out-dir> <log>...
import fs from "node:fs";
import path from "node:path";

const [outDir, ...logs] = process.argv.slice(2);
if (!outDir || !logs.length) { console.error("usage: build-replays.mjs <out-dir> <log>..."); process.exit(2); }

const NON_PLAYER = /^(\*|yes|no|kick|none)$/i;
const ROLE_BY_MEETING = { Investigate: "Cop", "Receive Reports": "Journalist", Litigate: "Lawyer", "Clean Death": "Janitor", "Shoot Gun": "Sheriff" };
const FJ = ["Cop", "Villager", "Mafioso", "Villager", "Villager", "Journalist", "Sheriff", "Lawyer", "Janitor"];
const MAFIA = new Set(["Mafioso", "Lawyer", "Janitor"]);
const PHASES = ["Night 1", "Day 1", "Night 2", "Day 2", "Night 3", "Day 3", "Night 4", "Day 4"];

function parseLog(text) {
  const games = []; let g = null;
  for (const line of text.split(/\r?\n/)) {
    let m = /^game (\S+) accounts=(\S+)/.exec(line);
    if (m) { g = { id: m[1], accounts: m[2].split(","), frames: {}, items: [], stateCount: 0 }; games.push(g); continue; }
    if (!g) continue;
    if (line.startsWith("frames ")) {
      try { g.frames = JSON.parse(line.slice(7)); g.stateCount = g.frames["game:state"] || 0; } catch {}
      continue;
    }
    const phaseNow = () => PHASES[Math.max(0, Math.floor(g.stateCount / g.accounts.length) - 2)] || "Night 1";
    if ((m = /^meeting (\S+) \[([^\]]*)\] (\S+) name="([^"]*)" role=(\S+) vote=(\S+) canVote=(\S+) targets=(\d+)/.exec(line))) {
      g.items.push({ k: "meeting", seat: m[1], phase: m[2] || "Pregame", mid: m[3], name: m[4], role: m[5], voting: m[6] === "true", canVote: m[7] === "true", n: Number(m[8]) });
    } else if ((m = /^send (\S+) (?:\[([^\]]*)\] )?(vote|speak) (\S+) (.*?) source=(\S+)/.exec(line))) {
      const val = m[3] === "speak" ? (() => { try { return JSON.parse(m[5]); } catch { return m[5]; } })() : m[5];
      g.items.push({ k: m[3], seat: m[1], phase: m[2] || phaseNow(), mid: m[4], val, source: m[6] });
    } else if ((m = /^chat \[([^\]]*)\] (\S+) (\S+): (.*)$/.exec(line))) {
      let content = m[4]; try { content = JSON.parse(content); } catch {}
      g.items.push({ k: "chat", phase: m[1], meeting: m[2], sender: m[3], content });
    } else if ((m = /^winners (?:game=\S+ )?(\{.*\})$/.exec(line))) {
      try { g.winners = JSON.parse(m[1]); } catch {}
    }
  }
  return games;
}

function build(g, index, source) {
  const n = g.accounts.length;
  const acc = new Map(g.accounts.map((a, i) => [a, `acc${String(i + 1).padStart(2, "0")}`]));
  // Players: every id a send or the winners named, first-seen order; seat i is bound to player i (the logs
  // do not record which account sat in which player slot, so this binding is made up).
  const pids = [];
  const addPid = (id) => { if (id && !NON_PLAYER.test(id) && !pids.includes(id)) pids.push(id); };
  for (const it of g.items) if (it.k === "vote") addPid(it.val);
  for (const id of g.winners?.players || []) addPid(id);
  const fakePid = new Map(pids.map((id, i) => [id, `p${String(i + 1).padStart(2, "0")}`]));
  const players = [];
  for (let i = 0; i < Math.max(n, pids.length); i++) players.push(`p${String(i + 1).padStart(2, "0")}`);
  const seatPid = new Map(g.accounts.map((a, i) => [a, players[i]]));
  const name = (pid) => `Player${pid.slice(1)}`;
  // Chat names: first-seen order onto players.
  const realNames = [];
  for (const it of g.items) if (it.k === "chat" && !realNames.includes(it.sender)) realNames.push(it.sender);
  const nameToPid = new Map(realNames.map((nm, i) => [nm, players[i % players.length]]));
  const mids = new Map();
  const mid = (id) => { if (!mids.has(id)) mids.set(id, `m${String(mids.size + 1).padStart(2, "0")}`); return mids.get(id); };
  const allRaw = [...g.accounts, ...pids, g.id];
  const scrub = (text) => {
    let s = String(text ?? "");
    for (const [nm, pid] of [...nameToPid].sort((a, b) => b[0].length - a[0].length)) {
      s = s.replace(new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (hit) => (hit === hit.toLowerCase() ? name(pid).toLowerCase() : name(pid)));
    }
    for (const raw of allRaw.sort((a, b) => b.length - a.length)) s = s.split(raw).join(fakePid.get(raw) || acc.get(raw) || "game");
    for (const [raw, f] of mids) s = s.split(raw).join(f);
    // Every dev name seen anywhere in the logs, in full ("CordiaSpohr29", "cordiaspohr29") or as a
    // nickname the bots use ("Cordia", "Cordy", "Cotta" for Cottle): same fake name for the same person.
    s = s.replace(/\b[A-Za-z]{3,}\d{0,3}\b/g, (hit) => {
      const owner = nameOwner(hit);
      if (!owner) return hit;
      const fake = fakeName(owner);
      return hit === hit.toLowerCase() ? fake.toLowerCase() : fake;
    });
    s = s.replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{9,12}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*(?:\d|_|-|[a-z][A-Z]))[A-Za-z0-9_-]{9,12}/g, (hit) => {
      if (/^(player|guest)\d+$/i.test(hit)) return hit;
      if (!extraIds.has(hit)) extraIds.set(hit, `x${String(extraIds.size + 1).padStart(2, "0")}`);
      return extraIds.get(hit);
    });
    return s.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9+/_-]{24,}\b/g, "[redacted]");
  };
  const extraNames = new Map(); const extraIds = new Map();
  const fakeName = (real) => {
    const pid = nameToPid.get(real);
    if (pid) return name(pid);
    if (!extraNames.has(real)) extraNames.set(real, `Guest${String(extraNames.size + 1).padStart(2, "0")}`);
    return extraNames.get(real);
  };
  const mapSel = (sel) => (NON_PLAYER.test(sel) ? sel : fakePid.get(sel) || sel);

  // Meetings per phase: from meeting lines; else from sends (the seat that sent in a meeting is a member).
  const phases = [];
  const phaseOf = (p) => { let x = phases.find((q) => q.name === p); if (!x) { x = { name: p, meetings: new Map(), votes: [], speech: [] }; phases.push(x); } return x; };
  for (const it of g.items) {
    if (it.k === "chat" || !it.phase) continue;
    const ph = phaseOf(it.phase);
    const id = mid(it.mid);
    let m = ph.meetings.get(id);
    if (!m) { m = { id, name: null, members: new Set(), voting: true, speech: false, n: null, targets: new Set() }; ph.meetings.set(id, m); }
    m.members.add(it.seat);
    if (it.k === "meeting") { m.name = it.name; m.voting = it.voting; m.speech = it.role === "chat" || it.name === "Village"; m.n = it.n; m.canVote = it.canVote; }
    if (it.k === "vote") { m.targets.add(mapSel(it.val)); ph.votes.push({ seat: it.seat, mid: id, sel: mapSel(it.val) }); }
    if (it.k === "speak") { m.speech = true; ph.speech.push({ seat: it.seat, mid: id, content: scrub(it.val) }); }
  }
  for (const it of g.items) if (it.k === "chat") {
    const ph = phaseOf(it.phase);
    ph.chat = ph.chat || [];
    ph.chat.push({ sender: nameToPid.get(it.sender), meeting: it.meeting, content: scrub(it.content) });
  }
  const order = (p) => (p === "Pregame" ? -1 : PHASES.indexOf(p));
  phases.sort((a, b) => order(a.name) - order(b.name));
  // Name unnamed meetings: a day meeting most seats vote in is the Village; the rest are night actions.
  for (const ph of phases) for (const m of ph.meetings.values()) {
    if (m.name) continue;
    if (/^Day/.test(ph.name) && m.members.size >= Math.ceil(n / 2)) { m.name = "Village"; m.speech = true; }
    else m.name = m.speech ? "Mafia Meeting" : /^Day/.test(ph.name) ? "Day Action" : "Night Action";
  }
  // Roles: from the seat's meetings when the log has them, else the Frontier Justice list in seat order.
  const role = new Map();
  const seen = new Map(g.accounts.map((a) => [a, new Set()]));
  for (const ph of phases) for (const m of ph.meetings.values()) for (const s of m.members) seen.get(s)?.add(m.name);
  const haveMeetingLines = g.items.some((it) => it.k === "meeting" && it.phase !== "Pregame");
  g.accounts.forEach((a, i) => {
    const names = [...seen.get(a)];
    const r = names.map((x) => ROLE_BY_MEETING[x]).find(Boolean) || (names.includes("Mafia Kill") ? "Mafioso" : null);
    role.set(a, haveMeetingLines ? (r || "Villager") : FJ[i % FJ.length]);
  });

  const F = g.frames;
  const has = (t) => (F[`game:${t}`] || 0) > 0;
  const out = [];
  const seq = new Map(); let t = 1_800_000_000_000;
  const emit = (a, event, data) => { const s = (seq.get(a) || 0) + 1; seq.set(a, s); out.push({ accountId: acc.get(a), seq: s, t: (t += 37), event, ...(data === undefined ? {} : { data }) }); };
  const all = (event, data) => { for (const a of g.accounts) emit(a, event, typeof data === "function" ? data(a) : data); };
  const playerInfo = (pid) => ({ id: pid, anonId: null, name: name(pid), userId: `u${pid.slice(1)}`, avatar: false });
  const playersMsg = Object.fromEntries(players.map((p) => [p, playerInfo(p)]));
  const dead = new Set();
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
  // Lobby: the server's Pregame chat meeting, the start countdown and join lines.
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
      else if (!targets.length || targets.some((x) => !NON_PLAYER.test(x)) || m.targets.size === 0) {
        const pool = m.name === "Mafia Kill" ? living.filter((p) => !g.accounts.some((b) => seatPid.get(b) === p && MAFIA.has(role.get(b)))) : living.filter((p) => p !== self || m.name === "Village");
        targets = [...new Set([...pool.slice(0, m.n ?? pool.length), ...[...m.targets].filter((x) => !NON_PLAYER.test(x))]), ...[...m.targets].filter((x) => NON_PLAYER.test(x))];
      }
    }
    return {
      id: m.id, name: m.name, actionName: m.name, members: [...m.members].map((b) => ({ id: seatPid.get(b), canUpdateVote: true, canVote: m.canVote !== false })),
      group: m.members.size > 1, speech: !!m.speech, voting: !!m.voting, instant: false, anonymous: false, multi: false,
      targets, inputType: "player", votes: {}, voteRecord: [], messages: [], canVote: m.canVote !== false, canUpdateVote: true, amMember: true,
    };
  }

  const majority = (votes) => { const c = {}; for (const v of votes) if (!NON_PLAYER.test(v.sel)) c[v.sel] = (c[v.sel] || 0) + 1; return Object.entries(c).sort((x, y) => y[1] - x[1])[0]?.[0] || null; };
  for (const ph of phases.filter((p) => p.name !== "Pregame")) {
    stateId += 1;
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
    for (const s of ph.speech) for (const a of ph.meetings.get(s.mid)?.members || []) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: seatPid.get(s.seat), content: s.content, meetingId: s.mid, time: t });
    const vil = meetings.find((m) => m.name === "Village");
    const spoken = new Set(ph.speech.map((x) => x.content));
    for (const c of ph.chat || []) if (vil && has("message") && !spoken.has(c.content)) for (const a of alive) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: c.sender, content: c.content, meetingId: vil.id, time: t });
    if (has("message")) for (const a of alive) to(a, "message", { id: `msg${stateId}-${++mi}`, senderId: "server", content: `${ph.name} has begun.`, meetingId: vil?.id, time: t });
    if (has("vote")) for (const v of ph.votes) for (const a of ph.meetings.get(v.mid)?.members || []) to(a, "vote", { voterId: seatPid.get(v.seat), target: v.sel, meetingId: v.mid });
    if (has("youAreBeingVoteKicked") && /^Day/.test(ph.name)) { const lazy = alive.find((a) => !ph.votes.some((v) => v.seat === a)); if (lazy) { to(lazy, "youAreBeingVoteKicked", { status: true }); } }
    if (has("clearTimer")) for (const a of alive) to(a, "clearTimer", "main");
    if (has("leftMeeting")) for (const m of meetings) if (m.name !== "Village") for (const a of m.members) if (alive.includes(a)) to(a, "leftMeeting", m.id);
    // Deaths: night = majority of the faction kill; day = majority of the Village vote.
    const kill = /^Night/.test(ph.name) ? majority(ph.votes.filter((v) => ph.meetings.get(v.mid)?.name === "Mafia Kill" || ph.meetings.get(v.mid)?.name === "Night Action")) : vil ? majority(ph.votes.filter((v) => v.mid === vil.id)) : null;
    if (/^Day/.test(ph.name) && kill && has("condemn")) for (const a of alive) to(a, "condemn");
    if (/^Day/.test(ph.name) && has("audio") && kill) for (const a of alive) to(a, "audio", "veg");
    if (kill && players.includes(kill) && !dead.has(kill)) {
      for (const a of alive) to(a, "death", kill);
      if (has("deathSounds")) for (const a of alive) to(a, "deathSounds", ["/audio/death.mp3"]);
      if (has("exorcised")) for (const a of alive) to(a, "exorcised", kill);
      if (has("obituaries")) for (const a of alive) to(a, "obituaries", { id: `${stateId}:${ph.name.split(" ")[0]}`, obituaries: [{ id: kill, playerInfo: playerInfo(kill), snippets: ["was found dead"] }], source: ph.name.split(" ")[0], time: t, dayCount: Number(ph.name.split(" ")[1]) || 0 });
      if (has("reveal")) for (const a of alive) to(a, "reveal", { playerId: kill, role: role.get(g.accounts[players.indexOf(kill)]) || "Villager" });
      dead.add(kill);
      const victim = g.accounts[players.indexOf(kill)];
      if (victim && has("isSpectator")) emit(victim, "isSpectator");
    }
    if (has("gunshot") && /^Day/.test(ph.name) && ph.votes.some((v) => ph.meetings.get(v.mid)?.name === "Shoot Gun")) for (const a of alive) to(a, "gunshot");
  }
  // The log saw deaths the sends do not explain (kills by other means): the last living player dies.
  if ((has("death") || has("exorcised")) && !out.some((e) => e.event === "death" || e.event === "exorcised")) {
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
  // Every frame type the log saw must be in the fixture.
  const types = Object.keys(F).filter((k) => k.startsWith("game:")).map((k) => k.slice(5));
  const missing = types.filter((ty) => !out.some((e) => e.event === ty));
  if (missing.length) throw new Error(`${g.id}: missing ${missing.join(",")}`);
  // Nothing real leaks: no raw account/player/meeting/game id and no chat name survives.
  const blob = JSON.stringify(out);
  for (const raw of [...allRaw, ...mids.keys(), ...realNames, ...REAL_NAMES]) if (raw.length >= 5 && blob.toLowerCase().includes(raw.toLowerCase())) throw new Error(`${g.id}: raw id/name leaked`);
  return { out, types: Object.fromEntries(types.map((ty) => [ty, F[`game:${ty}`]])), source, phases: phases.map((p) => p.name), seats: n };
}

// All dev display names in the input logs ("FirstLast12"), split into parts for nickname matching.
const STOP = new Set("left lefty shut wash ward warden wardrobe bell belly bells burn burns burned burning fish fishy germ german mild glance glanced clarify clarity clarified strike strip strict string strong cotton cottage pinch prudent patrol patron array calibrate alliance ally malaria melody melon nappy silo christ cathedral hesitate robe robot robust mare dowel balsa balsam glen glens takeaway inside fishing fished fisher".split(" "));
const REAL_NAMES = [...new Set(logs.flatMap((f) => fs.readFileSync(f, "utf8").match(/\b[A-Z][a-z]+[A-Z][a-z]+\d{1,3}\b/g) || []))];
const PARTS = REAL_NAMES.map((full) => ({ full, letters: full.replace(/\d+$/, "").toLowerCase(), parts: full.replace(/\d+$/, "").match(/[A-Z][a-z]+/g).map((x) => x.toLowerCase()) }));
function nameOwner(word) {
  const w = word.toLowerCase(); const letters = w.replace(/\d+$/, "");
  if (/^(player|guest)$/.test(letters)) return null;
  for (const p of PARTS) if (letters === p.letters) return p.full;                        // full name, any digits
  if (letters.length >= 8) for (const p of PARTS) if (p.parts.some((x) => x.length >= 5 && letters.includes(x))) return p.full; // run-together "petertertius23"
  if (STOP.has(letters) || /\d/.test(w)) return null;
  for (const p of PARTS) if (p.parts.includes(letters)) return p.full;                    // a first or last name
  const capital = word[0] === word[0].toUpperCase();
  if (letters.length >= (capital ? 4 : 5)) {
    // Nickname: same first 4 letters as a name part, not longer than it (+1 when capitalized).
    for (const p of PARTS) if (p.parts.some((x) => x.length >= 5 && x.slice(0, 4) === letters.slice(0, 4) && letters.length <= x.length + (capital ? 1 : 0))) return p.full;
  }
  return null;
}

fs.mkdirSync(outDir, { recursive: true });
const manifest = [];
const seenShapes = new Set();
let k = 0;
for (const file of logs) {
  for (const g of parseLog(fs.readFileSync(file, "utf8"))) {
    if (Object.keys(g.frames).length < 6) continue; // runs that never got past the handshake
    k++;
    const id = `g${String(k).padStart(2, "0")}`;
    const r = build(g, k, path.basename(file));
    const shape = JSON.stringify(r.out.map(({ t, ...e }) => e));
    if (seenShapes.has(shape)) { k--; continue; } // same frames as an earlier run (e.g. two connect-only retries)
    seenShapes.add(shape);
    fs.writeFileSync(path.join(outDir, `${id}.jsonl`), r.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    manifest.push({ fixture: `${id}.jsonl`, sourceLog: r.source, seats: r.seats, phases: r.phases, entries: r.out.length, observedFrameCounts: r.types });
  }
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
  note: "Rebuilt from live-harness logs (frame-type counts, meeting lines, sends, public chat, winners), not raw frame dumps. Ids, names and game ids are fake; seat-to-player binding and roles in games without meeting lines are made up. Payload shapes follow the server source.",
  fixtures: manifest,
}, null, 2) + "\n");
console.error(`wrote ${manifest.length} fixtures to ${outDir}`);
