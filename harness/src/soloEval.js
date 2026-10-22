// Night 5 offline "one bot among humans" eval. Pure over fixture entries, no network, no model.
//   surveyFixture  who sat at the table: bot seats (a harness account bound by a "self" frame) vs seats no
//                  account drove (a human, or a seat the log never bound), and how much public chat each side had.
//   soloReplay     one seat driven by Mafioso's rules path (the live table in fast mode with no `complete`: rules,
//                  seed and floor speech, the Night 5 guards). Every other seat is the log. The seat's own logged
//                  votes and lines are taken out of its stream and the bot's own sends are echoed back to it, so its
//                  view holds what IT did. Nothing it does reaches the others: their frames are the log.
//   scoreSolo      claims, votes, night picks, Sheriff timing and shots, reads vs the true roles, the five Night 5
//                  rules, all next to what the logged occupant of the seat did.
import { validateAction, dayFraction, createSeededRng, claimedRoleIn, vtLeft, isCopClaim, isCopResultLine, townReads, allies, ALIGNMENT, shotStatus, sheriffAsks, sheriffSeat, mafiaCounterclaimer, mafiaCounterclaim, myFaction, MAFIA_CC } from "mafioso-engine";
import { createBotTable, onGameEntry, SPEECH_FLOOR } from "./live.js";
import { createVirtualClock, settleTick } from "./clock.js";

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const roleBase = (r) => String(r || "").split(":")[0];

/** Fixture-wide facts: seat of each account, names, true roles and alignments, meeting names, day starts. */
export function tableFacts(entries) {
  const pidOf = {}; const names = {}; const roles = {}; const align = {}; const meetings = {}; const dayStart = {}; const phaseOrder = [];
  let winner = null;
  for (const e of entries) {
    const d = e.data;
    if (e.event === "self") pidOf[e.accountId] = String(d);
    if (e.event === "players") for (const [id, p] of Object.entries(d || {})) names[id] = p?.name || names[id] || id;
    if (e.event === "playerJoin" && d?.id) names[d.id] ||= d.name || d.id;
    if (e.event === "roleReveal" && d?.playerId) {
      roles[d.playerId] = roleBase(d.role);
      align[d.playerId] = d.roleData?.alignment || ALIGNMENT[roles[d.playerId]] || "Unknown";
    }
    if (e.event === "meeting" && d?.id) meetings[d.id] = String(d.name || "");
    if (e.event === "state" && d?.name && !(d.name in dayStart)) { dayStart[d.name] = e.t; phaseOrder.push(d.name); }
    if (e.event === "winners" && !winner) winner = d?.groups?.[0] || null;
  }
  return { pidOf, names, roles, align, meetings, dayStart, phaseOrder, winner };
}

/**
 * Public (Village) chat lines once each, in order: { by, text, t, phase }. Every seat gets its own copy of a
 * line (own message id and stamp, a few ms apart), so a line is new the first time any seat sees it, and again
 * only when the same seat sees the same text from the same sender again in the phase (a real repeat).
 */
export function publicLines(entries, facts = tableFacts(entries)) {
  const count = {}; const emitted = {}; const out = []; let phase = "Pregame";
  for (const e of entries) {
    if (e.event === "state" && e.data?.name) phase = e.data.name;
    if (e.event !== "message" || !e.data) continue;
    const d = e.data;
    if (!d.senderId || d.senderId === "server") continue;
    if (facts.meetings[d.meetingId] !== "Village") continue;
    const key = `${phase}|${d.senderId}|${d.content}`;
    const c = (count[`${e.accountId}|${key}`] = (count[`${e.accountId}|${key}`] || 0) + 1);
    if ((emitted[key] || 0) >= c) continue;
    emitted[key] = c;
    out.push({ by: d.senderId, text: String(d.content || ""), t: d.time ?? e.t, phase });
  }
  return out;
}

/** Seats and chat: how human was this table? */
export function surveyFixture(entries, manifest = {}) {
  const f = tableFacts(entries);
  // Every account in a fixture is a harness seat (the logs are the harness's own). Older logs kept no "self"
  // frame: the seats are still all ours, only which account sat where is unknown.
  const accounts = new Set(entries.map((e) => e.accountId).filter(Boolean));
  const bound = new Set(Object.values(f.pidOf));
  const seats = Object.keys(f.names).length ? Object.keys(f.names) : [...bound];
  const humanSeatIds = bound.size ? seats.filter((id) => !bound.has(id)) : seats.slice(accounts.size);
  const isHuman = (id) => humanSeatIds.includes(id);
  const lines = publicLines(entries, f).filter((l) => l.text.trim());
  const human = lines.filter((l) => isHuman(l.by));
  const bot = lines.filter((l) => !isHuman(l.by));
  const count = {};
  for (const l of bot) { const k = l.text.toLowerCase().trim(); count[k] = (count[k] || 0) + 1; }
  const floor = new Set(SPEECH_FLOOR.lines);
  const canned = bot.filter((l) => floor.has(l.text.trim()) || count[l.text.toLowerCase().trim()] >= 3).length;
  const days = new Set(lines.map((l) => l.phase).filter((p) => /^Day/.test(p))).size;
  return {
    seats: seats.length, botSeats: accounts.size, humanSeats: humanSeatIds.length, seatsBound: bound.size,
    publicLines: lines.length, humanLines: human.length, botLines: bot.length, days,
    linesPerSeatDay: days && seats.length ? Math.round((10 * lines.length) / (days * seats.length)) / 10 : 0,
    meanWords: bot.length ? Math.round((10 * bot.reduce((a, l) => a + words(l.text), 0)) / bot.length) / 10 : 0,
    distinctPct: bot.length ? Math.round((100 * Object.keys(count).length) / bot.length) : 0,
    cannedPct: bot.length ? Math.round((100 * canned) / bot.length) : 0,
    rolesTrusted: manifest.roles === "meetings" && (manifest.seatBinding === "seatmap" || manifest.seatBinding === "recovered"),
    seatBinding: manifest.seatBinding || null, roles: manifest.roles || null, sourceKind: /qwen|muse|deepseek|openrouter|live/.test(String(manifest.sourceLog || "")) ? "LLM bot table" : "unknown",
  };
}

export const TICK_MS = 2_500;
const isVoteOf = (e, pid) => (e.event === "vote" || e.event === "unvote") && String(e.data?.voterId) === pid;
const isLineOf = (e, pid) => e.event === "message" && String(e.data?.senderId) === pid;

/**
 * One seat on the rules path, everything else the log. Returns { acc, pid, role, proposals, logged, snapshots }.
 * proposals: the bot's sends ({ event, data, t, phase, source }); logged: the occupant's own votes and lines,
 * which were taken out of the seat's stream; snapshots: the bot's view at the end of each Day (for reads).
 */
// voteKick "drop" (default): the builder opens a logged Vote Kick meeting at the START of its phase (the log has
// no time for it), which trips the ballot net's "vote kick open" deadline at once (instant shot, instant ballot).
// "keep" replays it as built (how the bot reacts to a vote kick opening; the timing is the builder's, not the game's).
// config: createBotTable options for the seat (the Night 5 solo flags: { voteHold: "on", ... }); {} = defaults.
export async function soloReplay(entries, acc, { seed = 7, facts = tableFacts(entries), voteKick = "drop", config = {} } = {}) {
  const pid = facts.pidOf[acc];
  if (!pid) throw new Error(`no seat bound for ${acc}`);
  const own = entries.filter((e) => e.accountId === acc);
  let ph = "Pregame"; const logged = [];
  for (const e of own) { if (e.event === "state" && e.data?.name) ph = e.data.name; if (isVoteOf(e, pid) || isLineOf(e, pid)) logged.push({ ...e, phase: ph }); }
  const kick = new Set(Object.entries(facts.meetings).filter(([, n]) => /^vote ?kick$/i.test(n)).map(([id]) => id));
  const kickFrame = (e) => voteKick === "drop" && ((e.event === "meeting" && kick.has(e.data?.id)) || ((e.event === "members" || e.event === "vote" || e.event === "unvote") && kick.has(e.data?.meetingId)) || e.event === "youAreBeingVoteKicked");
  const stream = own.filter((e) => !isVoteOf(e, pid) && !isLineOf(e, pid) && !kickFrame(e));
  const clock = createVirtualClock(stream[0]?.t ?? 0);
  const table = createBotTable([{ accountId: acc }], { ...config, clock, rng: createSeededRng(seed), sheriffDelayRng: createSeededRng(seed + 1000) });
  // voteHold: each hold decision that cast a ballot ({ t, target, why, confident }).
  const holds = []; table.onVoteHold = (id, held, t) => holds.push({ t, target: held.target, why: held.why, confident: !!held.confident });
  const errors = []; const opts = { dryRun: true, fast: true, onError: (err) => errors.push(String(err?.message || err)) };
  let echoed = 0; let n = 0; const snapshots = {};
  // The server's echo of our own sends: our seat sees its vote land and its line in the chat.
  const echo = async () => {
    while (echoed < table.proposed.length) {
      const p = table.proposed[echoed++];
      p.t ??= clock.now();
      const v = table.views[acc];
      // Illegal-action check: the send against the seat's view at the moment it went out (must stay 0).
      const legal = v ? validateAction({ ...v, clock: p.t }, { event: p.event, data: p.data }) : { ok: true };
      if (!legal.ok) p.illegal = legal.reason || "illegal";
      if (p.event === "vote" && /shoot gun/i.test(String(v?.meetings?.[p.data.meetingId]?.name || ""))) {
        p.gun = shotStatus(v, String(p.data.selection), { now: p.t });
      }
      // The seat's reads at the moment it cast a Village ballot (did it vote its own top read?).
      if (p.event === "vote" && v?.meetings?.[p.data.meetingId]?.name === "Village") { p.readsAt = readAccuracy(v, facts.align); p.dayFrac = dayFraction(v, { now: p.t }); }
      const frame = p.event === "vote" ? { event: "vote", data: { voterId: pid, target: p.data.selection, meetingId: p.data.meetingId } }
        : p.event === "speak" ? { event: "message", data: { id: `solo-${++n}`, senderId: pid, content: p.data.content, meetingId: p.data.meetingId, time: p.t } }
        : null;
      if (frame) await onGameEntry(table, { accountId: acc, t: p.t, ...frame }, opts);
    }
  };
  // Night 5 rule 2, judged when it happens: each power answer to the Sheriff's ask, who the faction's
  // counterclaimer was at that moment (from this seat's view), and when this seat's counterclaim was due.
  const ccSeen = {};
  const noteCC = () => {
    const v = table.views[acc];
    if (v?.phase?.phase !== "Day" || myFaction(v) !== "Mafia" || v.dead?.[pid]) return;
    const sh = sheriffSeat(v);
    if (!sh) return;
    const mates = new Set([pid, ...allies(v)]);
    for (const a of sheriffAsks(v, sh)) {
      if (a.reply?.kind !== "power" || !MAFIA_CC.roles.includes(a.reply.role) || mates.has(a.target)) continue;
      const k = `${v.phase.name}|${a.target}`;
      ccSeen[k] ||= { phase: v.phase.name, target: a.target, role: a.reply.role, replyAt: a.reply.at, picker: mafiaCounterclaimer(v, a.target), mates: [...mates].filter((m) => m !== pid), due: null };
      const due = mafiaCounterclaim(v, { now: clock.now() });
      if (due && due.target === a.target && ccSeen[k].due == null) ccSeen[k].due = due.at;
    }
  };
  const settle = async () => { for (let i = 0; i < 4; i++) await settleTick(); await echo(); noteCC(); };
  const runTo = async (T) => {
    while (clock.nextAt != null && clock.nextAt <= T) { clock.runNext(); await settle(); }
    if (T > clock.now()) clock.advance(T - clock.now());
  };
  // A live seat is woken by the server's timer frames every second; the fixture keeps two per phase. A tick
  // every TICK_MS stands in (named so the reducer ignores it: no fake timer values reach the view).
  let lastT = stream[0]?.t ?? 0;
  for (const e of stream) {
    for (let at = lastT + TICK_MS; at < e.t && /^(Day|Night)$/.test(table.views[acc]?.phase?.phase || "") && !table.views[acc]?.winners; at += TICK_MS) {
      await runTo(at);
      await onGameEntry(table, { accountId: acc, t: at, event: "time", data: { name: "solo-tick" } }, opts);
      await settle();
    }
    await runTo(e.t);
    lastT = Math.max(lastT, e.t);
    const before = table.views[acc]?.phase?.name;
    if (e.event === "state" && /^Day/.test(before || "") && e.data?.name !== before) snapshots[before] = table.views[acc];
    await onGameEntry(table, e, opts);
    await settle();
  }
  const last = table.views[acc];
  if (/^Day/.test(last?.phase?.name || "") && !snapshots[last.phase.name]) snapshots[last.phase.name] = last;
  return { acc, pid, role: facts.roles[pid], proposals: table.proposed.filter((p) => p.accountId === acc), logged, snapshots, errors, view: last, table, ccSeen: Object.values(ccSeen), holds };
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const FLOOR = new Set(SPEECH_FLOOR.lines);
/** Deaths with their phase and cause, from the whole fixture (what happened at the table). */
function deathsOf(entries) {
  const out = []; const seen = new Set(); let phase = "Pregame"; const shot = new Set();
  for (const e of entries) {
    if (e.event === "state" && e.data?.name) phase = e.data.name;
    if (e.event === "message" && e.data?.senderId === "server" && /pulls a gun and shoots/.test(String(e.data.content))) shot.add(phase);
    if ((e.event === "death") && typeof e.data === "string" && !seen.has(e.data)) {
      seen.add(e.data);
      out.push({ id: e.data, phase, cause: /^Night/.test(phase) ? "night" : (shot.has(phase) && !out.some((d) => d.phase === phase && d.cause === "gun")) ? "gun" : "condemn" });
    }
  }
  return out;
}

/** Pairwise read accuracy: of (mafia, town) pairs among the players this seat reads, how often mafia scored higher. */
export function readAccuracy(view, align) {
  if (!view?.selfId) return null;
  const { score } = townReads(view);
  const mates = allies(view);
  const pool = Object.keys(view.players || {}).filter((id) => id !== view.selfId && !mates.has(id) && !view.dead?.[id] && !view.players[id]?.left);
  const maf = pool.filter((id) => align[id] === "Mafia"); const town = pool.filter((id) => align[id] === "Village");
  if (!maf.length || !town.length) return null;
  let wins = 0;
  for (const m of maf) for (const t of town) wins += (score[m] || 0) > (score[t] || 0) ? 1 : (score[m] || 0) === (score[t] || 0) ? 0.5 : 0;
  const top = pool.slice().sort((a, b) => (score[b] || 0) - (score[a] || 0) || a.localeCompare(b))[0];
  return { pairs: maf.length * town.length, acc: Math.round((100 * wins) / (maf.length * town.length)), top, topAlign: align[top] || null, topScore: score[top] || 0, anyRead: Object.values(score).some((x) => x > 0) };
}

/** Score one soloReplay run against the table's truth and the logged occupant. */
export function scoreSolo(entries, run, facts = tableFacts(entries)) {
  const { pid } = run; const me = facts.align[pid]; const myRole = facts.roles[pid];
  const sinceDay = (phase, t) => (facts.dayStart[phase] != null ? t - facts.dayStart[phase] : null);
  const mname = (mid) => facts.meetings[mid] || "";
  const bot = run.proposals.map((p) => ({ illegal: p.illegal || null, phase: p.phase, t: p.t, event: p.event, meeting: mname(p.data.meetingId), sel: p.event === "vote" ? String(p.data.selection) : null, text: p.event === "speak" ? String(p.data.content) : null, source: p.source, gun: p.gun || null, readsAt: p.readsAt || null }));
  const log = run.logged.map((e) => ({ phase: e.phase, t: e.t, event: e.event === "message" ? "speak" : e.event, meeting: mname(e.data.meetingId), sel: e.event === "vote" ? String(e.data.target) : null, text: e.event === "message" ? String(e.data.content) : null }));
  const deaths = deathsOf(entries);
  const lynch = Object.fromEntries(deaths.filter((d) => d.cause === "condemn").map((d) => [d.phase, d.id]));
  const myDeath = deaths.find((d) => d.id === pid) || null;
  const good = (target) => (target == null || !/^p\d+$/.test(target) ? null : me === "Village" ? facts.align[target] === "Mafia" : facts.align[target] === "Village");
  const lastVote = (xs, phase, meet) => xs.filter((x) => x.event === "vote" && x.phase === phase && meet(x.meeting)).at(-1)?.sel ?? null;
  const phases = facts.phaseOrder.filter((p) => /^(Day|Night)/.test(p) && (!myDeath || facts.phaseOrder.indexOf(p) <= facts.phaseOrder.indexOf(myDeath.phase)));
  const village = (m) => m === "Village";
  const night = (m) => !!m && !/^(Village|Shoot Gun|Pregame|Vote Kick|Mafia Meeting)$/.test(m);
  const dayVotes = phases.filter((p) => /^Day/.test(p)).map((p) => {
    const b = lastVote(bot, p, village); const l = lastVote(log, p, village);
    const bv = bot.filter((x) => x.event === "vote" && x.phase === p && village(x.meeting)).at(-1);
    const lv = log.filter((x) => x.event === "vote" && x.phase === p && village(x.meeting)).at(-1);
    return { phase: p, botMs: bv ? sinceDay(p, bv.t) : null, loggedMs: lv ? sinceDay(p, lv.t) : null, botVotes: bot.filter((x) => x.event === "vote" && x.phase === p && village(x.meeting)).length, botTopRead: bv?.readsAt?.top ?? null, botTopAlign: bv?.readsAt?.topAlign ?? null, botReadAcc: bv?.readsAt?.acc ?? null, botSource: bv?.source ?? null, bot: b, botGood: good(b), logged: l, loggedGood: good(l), lynched: lynch[p] || null, lynchedAlign: facts.align[lynch[p]] || null, same: b === l };
  });
  const nights = phases.filter((p) => /^Night/.test(p)).map((p) => {
    const ms = [...new Set([...bot, ...log].filter((x) => x.event === "vote" && x.phase === p && night(x.meeting)).map((x) => x.meeting))];
    return ms.map((m) => { const b = lastVote(bot, p, (x) => x === m); const l = lastVote(log, p, (x) => x === m); return { phase: p, meeting: m, bot: b, logged: l, same: b === l, botAlign: facts.align[b] || b, loggedAlign: facts.align[l] || l }; });
  }).flat();
  const pubB = bot.filter((x) => x.event === "speak" && village(x.meeting));
  const pubL = log.filter((x) => x.event === "speak" && village(x.meeting));
  const claimsOf = (xs) => xs.filter((x) => claimedRoleIn(x.text)).map((x) => ({ phase: x.phase, ms: sinceDay(x.phase, x.t), role: claimedRoleIn(x.text), text: x.text }));
  // A shot after an ask the logged table never heard: the log can't answer it (a counterfactual artifact).
  const nameRe = (id) => new RegExp(`\\b${String(facts.names[id] || id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const ASK_RE = /\b(claim\??|claiming|role|what are you|whats your role|what'?s your role)\b/i;
  const allLines = publicLines(entries, facts);
  const gunOf = (xs) => xs.filter((x) => x.event === "vote" && /shoot gun/i.test(x.meeting)).map((x) => {
    const loggedAsked = pubL.some((l) => l.phase === x.phase && ASK_RE.test(l.text) && nameRe(x.sel).test(l.text));
    const answered = allLines.some((l) => l.phase === x.phase && l.by === x.sel && claimedRoleIn(l.text));
    return { phase: x.phase, ms: sinceDay(x.phase, x.t), target: x.sel, align: facts.align[x.sel] || null, status: x.gun?.status ?? null, loggedAsked, answeredInLog: answered, artifact: x.gun?.status === "open" && !loggedAsked && !answered };
  });
  const reads = Object.entries(run.snapshots).map(([phase, v]) => ({ phase, ...(readAccuracy(v, facts.align) || { acc: null }) }));

  // ---- the five Night 5 rules, on the bot's own sends ----
  const shots = gunOf(bot);
  const r1 = myRole === "Sheriff" ? { cases: shots.map((s) => ({ ...s, ok: s.status !== "pending-vt" })), ok: shots.every((s) => s.status !== "pending-vt") } : null;
  let r2 = null;
  if (me === "Mafia") {
    const ccs = pubB.filter((x) => /is lying, im the real/i.test(x.text));
    const opps = (run.ccSeen || []).map((o) => {
      const cc = ccs.find((x) => x.phase === o.phase && x.t >= o.replyAt);
      return { ...o, mine: o.picker === pid, cc: cc ? { text: cc.text, delayMs: cc.t - o.replyAt } : null };
    });
    r2 = { opportunities: opps, sent: ccs.length, ok: ccs.length <= 1 && opps.every((o) => (o.mine ? !!o.cc && o.cc.delayMs >= MAFIA_CC.minMs && o.cc.delayMs <= 10_000 : !o.cc)) };
  }
  const copDays = {};
  for (const x of pubB) if (isCopClaim(x.text) || (myRole === "Cop" && isCopResultLine(x.text))) (copDays[x.phase] ||= []).push(x.text);
  const r3 = { cases: Object.entries(copDays).map(([phase, ls]) => ({ phase, lines: ls, ok: ls.length === 1 && !/\n/.test(ls[0]) })) };
  r3.ok = r3.cases.every((c) => c.ok);
  const sClaim = claimsOf(pubB).find((c) => c.role === "sheriff");
  const sawDay = phases.some((p) => /^Day/.test(p));
  const r4 = myRole === "Sheriff" && sawDay ? { claim: sClaim || null, ok: !!sClaim && sClaim.ms >= 1000 && sClaim.ms <= 10_500 } : null;
  const vt = pubB.filter((x) => vtLeft({}, x.text));
  const r5 = { townClaims: claimsOf(pubB).filter((c) => /villager|blue/.test(c.role) || c.role === "villager"), vtLines: vt.map((x) => x.text), ok: vt.length === 0 };

  const days = phases.filter((p) => /^Day/.test(p)).length || 1;
  return {
    pid, role: myRole, align: me, died: myDeath ? `${myDeath.phase} (${myDeath.cause})` : "survived", winner: facts.winner, teamWon: facts.winner === me,
    lines: pubB.map((x) => x.text),
    speech: { bot: pubB.length, logged: pubL.length, botPerDay: Math.round((10 * pubB.length) / days) / 10, loggedPerDay: Math.round((10 * pubL.length) / days) / 10, botFloorPct: pct(pubB.filter((x) => FLOOR.has(x.text)).length, pubB.length), botSources: Object.entries(pubB.reduce((o, x) => ((o[x.source] = (o[x.source] || 0) + 1), o), {})).sort((a, b) => b[1] - a[1]) },
    claims: { bot: claimsOf(pubB), logged: claimsOf(pubL) },
    dayVotes, nights, gun: myRole === "Sheriff" ? { bot: shots, logged: gunOf(log) } : null, reads,
    rules: { r1_sheriffWaitsOnVillager: r1, r2_mafiaCounterclaim: r2, r3_copOneLine: r3, r4_sheriffClaimDelay: r4, r5_noVt: r5 },
    errors: run.errors,
    illegal: bot.filter((x) => x.illegal).map((x) => `${x.phase} ${x.event} ${x.meeting}: ${x.illegal}`),
  };
}

const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const rate = (xs, f) => { const v = xs.filter((x) => x != null); return v.length ? { n: v.length, pct: pct(v.filter(f).length, v.length) } : { n: 0, pct: null }; };
const ROLE_GROUP = (r) => (/^(Mafioso|Janitor|Lawyer)$/.test(r) ? `mafia:${r}` : r);

/** Roll scored seats up by role: the bot next to the logged occupant. */
export function aggregate(scored) {
  const by = {};
  for (const s of scored) (by[ROLE_GROUP(s.role)] ||= []).push(s);
  const roles = Object.fromEntries(Object.entries(by).sort().map(([role, xs]) => {
    const dv = xs.flatMap((s) => s.dayVotes);
    const nv = xs.flatMap((s) => s.nights).filter((n) => /Investigate|Receive Reports|Mafia Kill/.test(n.meeting));
    const goodNight = (who) => (n) => (/Mafia Kill/.test(n.meeting) ? n[`${who}Align`] === "Village" : n[`${who}Align`] === "Mafia");
    const reads = xs.flatMap((s) => s.reads).map((r) => r.acc);
    return [role, {
      seats: xs.length,
      dayVoteGood: { bot: rate(dv.map((d) => d.botGood), Boolean), logged: rate(dv.map((d) => d.loggedGood), Boolean) },
      dayVoteSame: rate(dv.filter((d) => d.bot != null || d.logged != null).map((d) => d.same), Boolean),
      noBallot: { bot: dv.filter((d) => d.bot == null).length, logged: dv.filter((d) => d.logged == null).length, days: dv.length },
      nightGood: { bot: rate(nv.map((n) => (n.bot == null ? null : n)), goodNight("bot")), logged: rate(nv.map((n) => (n.logged == null ? null : n)), goodNight("logged")), botMissing: nv.filter((n) => n.bot == null && n.logged != null).length },
      claims: {
        bot: { seats: xs.filter((s) => s.claims.bot.length).length, firstMs: med(xs.map((s) => s.claims.bot[0]?.ms)), roles: [...new Set(xs.flatMap((s) => s.claims.bot.map((c) => c.role)))] },
        logged: { seats: xs.filter((s) => s.claims.logged.length).length, firstMs: med(xs.map((s) => s.claims.logged[0]?.ms)), roles: [...new Set(xs.flatMap((s) => s.claims.logged.map((c) => c.role)))] },
      },
      speech: { botPerDay: med(xs.map((s) => s.speech.botPerDay)), loggedPerDay: med(xs.map((s) => s.speech.loggedPerDay)), botFloorPct: med(xs.map((s) => s.speech.botFloorPct)) },
      readAcc: med(reads),
    }];
  }));
  const rules = {};
  for (const k of ["r1_sheriffWaitsOnVillager", "r2_mafiaCounterclaim", "r3_copOneLine", "r4_sheriffClaimDelay", "r5_noVt"]) {
    const cs = scored.map((s) => s.rules[k]).filter(Boolean);
    const applies = k === "r3_copOneLine" ? cs.filter((c) => c.cases.length) : k === "r5_noVt" ? cs : k === "r2_mafiaCounterclaim" ? cs.filter((c) => c.opportunities.length || c.sent) : cs;
    rules[k] = { seats: applies.length, pass: applies.filter((c) => c.ok).length, fails: scored.filter((s) => s.rules[k] && !s.rules[k].ok).map((s) => `${s.fixture}:${s.pid}`) };
  }
  const sheriff = scored.filter((s) => s.gun).map((s) => ({ fixture: s.fixture, bot: s.gun.bot.map((g) => `${g.phase} ${g.target}(${g.align}) at ${Math.round(g.ms / 1000)}s [${g.status}]`), logged: s.gun.logged.map((g) => `${g.phase} ${g.target}(${g.align}) at ${Math.round(g.ms / 1000)}s`), claimMs: s.rules.r4_sheriffClaimDelay?.claim?.ms ?? null, loggedClaimMs: s.claims.logged.find((c) => c.role === "sheriff")?.ms ?? null }));
  const cc = scored.filter((s) => s.rules.r2_mafiaCounterclaim?.opportunities.length).map((s) => ({ fixture: s.fixture, pid: s.pid, role: s.role, opps: s.rules.r2_mafiaCounterclaim.opportunities.map((o) => ({ phase: o.phase, target: o.target, role: o.role, mine: o.mine, picker: o.picker, cc: o.cc })) }));
  return { seats: scored.length, roles, rules, sheriff, counterclaims: cc, errors: scored.flatMap((s) => s.errors.map((e) => `${s.fixture}:${s.pid} ${e}`)) };
}
