// Mixed-table mode (Night 6, offline): one real bot seat and eight scripted human-like seats.
// The scripted seats read only what a human at the table could see (public chat, votes, deaths, reveals, their own
// role, their own night results, and their mafia teammates), speak in varied styles, claim villager or blue (never
// vt) when asked or late, sometimes never claim, now and then fake a Cop claim as scum, and vote noisily.
// Wording is drawn from the phrasing seen in the re-sanitized Night 5 logs and the solo-timeline fixtures; every
// template names players only through {X} / {R} placeholders, so no real name can appear.
import { claimedRoleIn, createSeededRng } from "mafioso-engine";
import { mixSeed } from "./arena.js";

const SCUM = new Set(["Mafioso", "Janitor", "Lawyer"]);

/** Style bank. {X} = a player name, {R} = inno/guilty. Each style also sets how chatty and how sloppy it is. */
export const STYLES = Object.freeze({
  terse: {
    sheriff: ["im sheriff", "sheriff here"], journalist: ["journalist", "im journalist"],
    lines: [2, 4], caps: false,
    opener: ["hi", "morning", "ok", "who we voting", "any claims"],
    read: ["{X} sus", "{X} is sus", "{X} quiet", "{X} feels off", "watching {X}", "{X} lying"],
    filler: ["idk", "hmm", "not sure", "go on", "lol", "fair", "agreed"],
    ask: ["{X} claim?", "{X} what are you", "{X} role?"],
    push: ["vote {X}", "{X} vote", "voting {X}", "lynch {X}"],
    claim: ["villager", "blue", "im villager", "blue here"],
    defend: ["why me", "not me", "wrong guy", "look elsewhere"],
    cop: ["cop. {X} {R}", "im cop, {X} {R}"],
  },
  chatty: {
    sheriff: ["ok im sheriff, claim when i ask pls", "sheriff here, dont make me shoot"], journalist: ["im journalist, nothing useful yet", "journalist lol, no reports to share"],
    lines: [4, 7], caps: false,
    opener: ["hey all, anyone got anything?", "ok who do we think cop is", "morning, lets not waste the day", "so who are we looking at"],
    read: ["{X} has been kinda sus ngl", "idk {X} is giving me bad vibes", "{X} is pushing really hard for no reason", "{X} keeps dodging, sus", "{X} voting weird"],
    filler: ["lol", "wait what", "i really need someone to start pushing here", "need more info honestly", "this is chaotic lol", "hmm ok"],
    ask: ["{X} what are you claiming?", "{X} can you claim pls", "{X} whats your role", "{X} claim before we lynch"],
    push: ["ok im throwing my vote at {X}", "vote {X} before we lose the lynch", "im voting {X}, change my mind", "{X} is the play today"],
    claim: ["im villager, no results lol", "just blue, nothing to show", "villager, look elsewhere", "blue. promise"],
    defend: ["why me?? i literally did nothing", "bro im town lol stop", "{X} why are you on me", "not me, look at {X}"],
    cop: ["ok im cop, {X} came back {R}", "cop here, i checked {X}: {R}"],
  },
  proper: {
    sheriff: ["I'm the sheriff.", "Sheriff here. Claims, please."], journalist: ["I'm the journalist.", "Journalist, nothing to report yet."],
    lines: [3, 5], caps: true,
    opener: ["Morning everyone.", "Any claims so far?", "Let's not lynch randomly."],
    read: ["{X} seems suspicious.", "I don't trust {X}.", "{X} is deflecting.", "{X}'s vote looked off."],
    filler: ["Not sure yet.", "Need more here.", "Still looking.", "Fair point."],
    ask: ["{X}, claim please.", "{X}, what is your role?", "{X}, can you claim?"],
    push: ["Vote {X}.", "I'm voting {X}.", "{X} is my vote today."],
    claim: ["Villager.", "I'm a villager.", "Blue, nothing to report."],
    defend: ["Why me?", "Not me, look elsewhere.", "{X}, that's a stretch."],
    cop: ["I'm cop. {X} is {R}.", "Cop here: {X} {R}."],
  },
  quiet: {
    sheriff: ["sheriff"], journalist: ["journalist"],
    lines: [0, 2], caps: false,
    opener: ["hi"],
    read: ["{X}?", "maybe {X}"],
    filler: ["idk", "ok", "k"],
    ask: ["{X} claim"],
    push: ["{X}"],
    claim: ["villager", "blue"],
    defend: ["no", "not me"],
    cop: ["cop {X} {R}"],
  },
});
const STYLE_NAMES = Object.keys(STYLES);

/** Mixed-table defaults: how often humans claim when asked, fake-claim, and how good their reads are. */
export const MIXED = Object.freeze({
  answerAsk: 0.8, // town human answers a direct claim ask
  lateClaim: 0.35, // town human with 2+ votes on them claims late
  fakeCop: 0.2, // per game: one scum human fakes Cop
  copClaims: 0.55, // per day: human Cop claims with a result
  readSignal: 1.0, // town human read: scum get +signal on the gut score (noise sd 1); 1.0 puts a Villager-bot table near 50% (16/30 calibration seeds 7001-7030)
  bandwagon: 0.3, // chance a human moves to the leading wagon late
  noOne: 0.04, // chance a town human votes no one
  humanShot: 0.25, // human Sheriff shoots its top read on a day (if strong)
  sheriffClaim: 0.5, // human Sheriff claims on Day 1 and asks two reads to claim
  journalistAnswer: 0.6, // human Journalist answers a claim ask as journalist (else villager)
});

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const gauss = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

/** Fill a template; capitalise for the proper style. */
export function render(style, tpl, { X = "", R = "" } = {}) {
  let t = tpl.replace(/\{X\}/g, X).replace(/\{R\}/g, R);
  if (!style.caps) t = t.toLowerCase().replace(/\b(i)'m\b/g, "im");
  return t;
}

/**
 * The scripted seats. createHumans(S) is called by the self-play server once seats are dealt.
 * humans.observe(pid, event, data) receives every frame a human would get; humans.tick(S, act) runs due actions,
 * act(pid, event, data) applies one through the server's checks.
 */
export function createHumans(S, botIds, opts = {}) {
  const cfg = { ...MIXED, ...(opts || {}) };
  const H = new Map();
  const humans = S.ids.filter((id) => !botIds.has(id));
  const scumHumans = humans.filter((id) => SCUM.has(S.roles[id]));
  const rngG = createSeededRng(mixSeed(S.gseed, "humans"));
  const sc = cfg.scenario || null; // Night 6 part 4 counterclaim scenarios (scenarioPlan below)
  const fakerRoll = scumHumans.length && rngG() < cfg.fakeCop ? pick(rngG, scumHumans) : null;
  const faker = sc ? (sc.cc === "teamCop" ? scumHumans[0] || null : null) : fakerRoll;
  const powerId = sc ? humans.find((id) => S.roles[id] === sc.power) || null : null;
  const sheriffHuman = sc ? humans.find((id) => S.roles[id] === "Sheriff") || null : null;
  const scLog = sc ? { power: sc.power, powerSeat: powerId && S.names[powerId], sheriffSeat: sheriffHuman && S.names[sheriffHuman], events: [] } : null;
  for (const pid of humans) {
    const rng = createSeededRng(mixSeed(S.gseed, `human:${pid}`));
    const styleName = pick(rng, STYLE_NAMES);
    const gut = {};
    for (const o of S.ids) if (o !== pid) gut[o] = gauss(rng) + (!SCUM.has(S.roles[pid]) && SCUM.has(S.roles[o]) ? cfg.readSignal : 0);
    H.set(pid, { pid, role: S.roles[pid], scum: SCUM.has(S.roles[pid]), styleName, style: STYLES[styleName], rng, gut, plan: [], claimed: false, faker: pid === faker, fakeDone: false, results: [], askedAt: null, accusedBy: new Set(), checked: new Set(), copClaimDay: null });
  }
  const stats = { lines: 0, byStyle: {}, claims: { town: 0, fakeCop: 0, cop: 0, none: 0 }, illegal: 0, shots: 0 };
  const name = (id) => S.names[id];
  const idByName = new Map(S.ids.map((id) => [S.names[id].toLowerCase(), id]));
  const live = () => S.ids.filter((id) => S.alive.has(id));
  const scumIds = new Set(S.ids.filter((id) => SCUM.has(S.roles[id])));
  const reveals = {};
  const publicEvidence = {}; // target -> score from claims (cop guilty +2, inno -1)

  function suspect(h, { exclude = [] } = {}) {
    const pool = live().filter((id) => id !== h.pid && !exclude.includes(id) && !(h.scum && scumIds.has(id)) && !reveals[id]);
    if (!pool.length) return null;
    const score = (id) => (h.scum ? (h.accusedBy.has(id) ? 1.5 : 0) + (S.roles[id] !== "Villager" && claimedOf[id] ? 1 : 0) + h.rng() : h.gut[id] + (publicEvidence[id] || 0) * 0.8 + (h.accusedBy.has(id) ? 0.4 : 0));
    return pool.sort((a, b) => score(b) - score(a))[0];
  }
  const claimedOf = {};

  function say(h, kind, vars = {}, meeting = "Village") { h.plan.push({ at: S.clock.now(), kind: "speak", meeting, text: render(h.style, pick(h.rng, h.style[kind]), vars) }); }

  function planDay(h) {
    const dayMs = S.opts.dayMs; const t0 = S.clock.now();
    const [lo, hi] = h.style.lines; const n = lo + Math.floor(h.rng() * (hi - lo + 1));
    for (let i = 0; i < n; i++) {
      const at = t0 + Math.round((0.03 + 0.8 * h.rng()) * dayMs);
      const r = h.rng();
      const kind = i === 0 && r < 0.5 ? "opener" : r < 0.45 ? "read" : r < 0.7 ? "filler" : r < 0.85 ? "ask" : "push";
      h.plan.push({ at, kind: "line", line: kind });
    }
    h.plan.push({ at: t0 + Math.round((0.3 + 0.55 * h.rng()) * dayMs), kind: "vote" });
    if (h.rng() < cfg.bandwagon) h.plan.push({ at: t0 + Math.round((0.86 + 0.08 * h.rng()) * dayMs), kind: "wagon" });
    if (h.role === "Cop" && h.results.length && h.rng() < cfg.copClaims) h.plan.push({ at: t0 + Math.round((0.15 + 0.6 * h.rng()) * dayMs), kind: "copClaim" });
    if (sc && S.day === 1) scenarioPlan(h, t0);
    if (h.faker && !h.fakeDone && !sc && h.rng() < 0.6) h.plan.push({ at: t0 + Math.round((0.2 + 0.5 * h.rng()) * dayMs), kind: "fakeCop" });
    if (h.role === "Sheriff" && S.day === 1 && !h.claimed && !sc && h.rng() < cfg.sheriffClaim) {
      const at = t0 + Math.round((0.05 + 0.25 * h.rng()) * dayMs);
      h.plan.push({ at, kind: "sheriffClaim" }, { at: at + 20_000 + Math.round(40_000 * h.rng()), kind: "line", line: "ask" }, { at: at + 70_000 + Math.round(60_000 * h.rng()), kind: "line", line: "ask" });
    }
    if (h.role === "Sheriff" && !S.gunUsed && !(sc && S.day === 1) && h.rng() < cfg.humanShot) h.plan.push({ at: t0 + Math.round((0.55 + 0.3 * h.rng()) * dayMs), kind: "shoot" });
    if (!h.claimed) h.plan.push({ at: t0 + Math.round((0.7 + 0.2 * h.rng()) * dayMs), kind: "lateClaim" });
  }
  /**
   * Counterclaim scenario, Day 1 (cfg.scenario = { cc: "lone" | "team" | "teamCop", power: "Cop" | "Journalist" }):
   * the scripted Sheriff claims at 15-30s and asks the real Cop or Journalist (sc.power) 15-25s later; that seat
   * answers with a power claim 5-15s after the ask. 70s after his first ask he asks the bot; 40s after that he
   * shoots: one of two same-role power claimers if there are any (50/50), else his top read outside the power
   * claimers. teamCop: the first scripted mafia seat fakes Cop at 2-5s, before the Sheriff claims.
   */
  function scenarioPlan(h, t0) {
    const r = (lo, hi) => Math.round((lo + (hi - lo) * h.rng()) * 1000);
    if (h.pid === sheriffHuman) {
      const claim = t0 + r(15, 30); const ask = claim + r(15, 25);
      h.plan.push({ at: claim, kind: "sheriffClaim" }, { at: ask, kind: "scAsk", target: powerId }, { at: ask + 70_000, kind: "scAsk", target: [...botIds][0] }, { at: ask + 110_000, kind: "scShoot" });
    }
    if (h.faker && !h.fakeDone) h.plan.push({ at: t0 + r(2, 5), kind: "fakeCop" });
  }
  const powerClaims = () => { const by = {}; for (const [id, role] of Object.entries(claimedOf)) if (S.alive.has(id) && (role === "cop" || role === "journalist")) (by[role] ||= []).push(id); return by; };

  function planNight(h) { h.plan.push({ at: S.clock.now() + Math.round((5 + 35 * h.rng()) * 1000), kind: "night" }); }

  const meetingOf = (nm, pid) => [...S.meetings.values()].find((m) => m.name === nm && !m.closed && m.members.includes(pid));
  const votesOn = (pid) => { const v = meetingOf("Village", pid) || [...S.meetings.values()].find((m) => m.name === "Village"); return v ? Object.values(v.ballots).filter((t) => t === pid).length : 0; };

  // Night 6 part 5: ground truth for the claim parser. Each public scripted line with the role it claims (null: no claim).
  function tag(text, role) { (stats.spoken ||= []).push({ text, role }); return text; }
  function tagClaim(h) { const line = claimLine(h); return tag(line, h.lastClaimRole); }
  function claimLine(h) {
    h.claimed = true;
    if (h.role === "Journalist" && h.rng() < cfg.journalistAnswer) { stats.claims.journalist = (stats.claims.journalist || 0) + 1; h.lastClaimRole = "journalist"; return render(h.style, pick(h.rng, h.style.journalist)); }
    if (h.scum || h.role === "Villager" || h.role === "Journalist" || h.role === "Sheriff") { stats.claims.town += 1; h.lastClaimRole = "villager"; return render(h.style, pick(h.rng, h.style.claim)); }
    if (h.role === "Cop" && h.results.length) { stats.claims.cop += 1; h.lastClaimRole = "cop"; const r = h.results[h.results.length - 1]; return render(h.style, pick(h.rng, h.style.cop), { X: name(r.target), R: r.guilty ? "guilty" : "inno" }); }
    stats.claims.town += 1; h.lastClaimRole = "villager"; return render(h.style, pick(h.rng, h.style.claim));
  }

  async function run(h, a, act) {
    if (!S.alive.has(h.pid)) return;
    const day = S.phase.startsWith("Day");
    if (a.kind === "speak") return act(h.pid, "speak", a.meeting, a.meeting === "Village" ? tag(a.text, null) : a.text);
    if (a.kind === "line" && day) {
      const X = name(suspect(h) || h.pid);
      if (a.line === "ask" && X === name(h.pid)) return;
      return act(h.pid, "speak", "Village", tag(render(h.style, pick(h.rng, h.style[a.line]), { X }), null));
    }
    if (a.kind === "scAsk" && day) {
      if (!a.target || !S.alive.has(a.target)) { scLog.events.push({ kind: "askSkipped", t: S.clock.now() }); return; }
      const line = render(h.style, pick(h.rng, h.style.ask), { X: name(a.target) });
      if (a.target === powerId) { const p = H.get(powerId); p.plan.push({ at: S.clock.now() + Math.round((5 + 10 * p.rng()) * 1000), kind: "powerAnswer" }); }
      scLog.events.push({ kind: "ask", target: name(a.target), bot: botIds.has(a.target), at: S.clock.now() });
      return act(h.pid, "speak", "Village", tag(line, null));
    }
    if (a.kind === "powerAnswer" && day) {
      h.claimed = true; h.answeredAt = S.clock.now(); stats.claims[h.role === "Cop" ? "cop" : "journalist"] = (stats.claims[h.role === "Cop" ? "cop" : "journalist"] || 0) + 1;
      scLog.events.push({ kind: "powerAnswer", at: S.clock.now() });
      const res = h.results[h.results.length - 1];
      let line = h.role === "Cop" ? (res ? render(h.style, pick(h.rng, h.style.cop), { X: name(res.target), R: res.guilty ? "guilty" : "inno" }) : render(h.style, "im cop, no results yet")) : render(h.style, pick(h.rng, h.style.journalist));
      // The scenario needs the answer to read as a claim: two style lines don't parse as one (see docs), use a plain one.
      if (!sc.rawAnswers && claimedRoleIn(line) !== h.role.toLowerCase()) { stats.unparsedPowerAnswer = (stats.unparsedPowerAnswer || 0) + 1; line = h.role === "Cop" ? render(h.style, res ? "im cop, {X} {R}" : "im cop, no results yet", res ? { X: name(res.target), R: res.guilty ? "guilty" : "inno" } : {}) : render(h.style, "im journalist"); }
      return act(h.pid, "speak", "Village", tag(line, h.role.toLowerCase()));
    }
    if (a.kind === "scShoot" && day) {
      const m = meetingOf("Shoot Gun", h.pid); if (!m || S.gunUsed) return;
      const pair = Object.values(powerClaims()).find((ids) => ids.length >= 2);
      const claimers = new Set(Object.values(powerClaims()).flat());
      const t = pair ? pick(h.rng, pair) : suspect(h, { exclude: [...claimers] });
      scLog.events.push({ kind: "shoot", target: t && name(t), contested: !!pair, at: S.clock.now() });
      if (t) { stats.shots += 1; return act(h.pid, "vote", "Shoot Gun", t); }
      return;
    }
    if (a.kind === "sheriffClaim" && day && !h.claimed) { h.claimed = true; stats.claims.sheriff = (stats.claims.sheriff || 0) + 1; return act(h.pid, "speak", "Village", tag(render(h.style, pick(h.rng, h.style.sheriff)), "sheriff")); }
    if (a.kind === "answer" && day && !h.claimed) { h.answeredAt = S.clock.now(); return act(h.pid, "speak", "Village", tagClaim(h)); }
    if (a.kind === "defend" && day) return act(h.pid, "speak", "Village", ((t) => tag(t, /\bim town\b/i.test(t) ? "villager" : null))(render(h.style, pick(h.rng, h.style.defend), { X: name(a.by) })));
    if (a.kind === "lateClaim" && day && !h.claimed) {
      if (votesOn(h.pid) >= 2 && h.rng() < cfg.lateClaim) return act(h.pid, "speak", "Village", tagClaim(h));
      stats.claims.none += 1; return;
    }
    if (a.kind === "copClaim" && day && h.copClaimDay !== S.day) {
      h.copClaimDay = S.day; h.claimed = true; stats.claims.cop += 1;
      const r = h.results[h.results.length - 1];
      return act(h.pid, "speak", "Village", tag(render(h.style, pick(h.rng, h.style.cop), { X: name(r.target), R: r.guilty ? "guilty" : "inno" }), "cop"));
    }
    if (a.kind === "fakeCop" && day && !h.fakeDone) {
      const town = live().filter((id) => !scumIds.has(id) && id !== h.pid);
      if (!town.length) return;
      const target = botIds.has(town.find((id) => botIds.has(id))) && h.rng() < 0.4 ? town.find((id) => botIds.has(id)) : suspect(h) || pick(h.rng, town);
      h.fakeDone = true; h.claimed = true; stats.claims.fakeCop += 1;
      let line = render(h.style, pick(h.rng, h.style.cop), { X: name(target), R: "guilty" });
      // Scenario teamCop: the pre-claim must read as a Cop claim (the quiet "cop X guilty" doesn't parse; see docs).
      if (sc && !sc.rawAnswers && claimedRoleIn(line) !== "cop") line = render(h.style, "im cop, {X} {R}", { X: name(target), R: "guilty" });
      return act(h.pid, "speak", "Village", tag(line, "cop"));
    }
    if (a.kind === "vote" && day) {
      const m = meetingOf("Village", h.pid); if (!m) return;
      const t = !h.scum && h.rng() < cfg.noOne ? "*" : suspect(h);
      if (t) { h.voted = t; return act(h.pid, "vote", "Village", t); }
      return;
    }
    if (a.kind === "wagon" && day) {
      const m = meetingOf("Village", h.pid); if (!m) return;
      const counts = {}; for (const t of Object.values(m.ballots)) if (t && t !== "*") counts[t] = (counts[t] || 0) + 1;
      const lead = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0];
      if (lead && lead !== h.pid && S.alive.has(lead) && !(h.scum && scumIds.has(lead))) return act(h.pid, "vote", "Village", lead);
      return;
    }
    if (a.kind === "shoot" && day) {
      const m = meetingOf("Shoot Gun", h.pid); const t = suspect(h);
      if (m && t && (publicEvidence[t] || 0) + h.gut[t] > 1.2) { stats.shots += 1; return act(h.pid, "vote", "Shoot Gun", t); }
      return;
    }
    if (a.kind === "night" && !day) {
      const others = live().filter((id) => id !== h.pid);
      if (h.scum) {
        const kill = meetingOf("Mafia Kill", h.pid);
        if (kill) {
          const botVote = Object.entries(kill.ballots).find(([v]) => botIds.has(v))?.[1];
          const town = others.filter((id) => !scumIds.has(id));
          const claimedPr = town.filter((id) => claimedOf[id] && claimedOf[id] !== "villager");
          const t = botVote && h.rng() < 0.85 ? botVote : claimedPr.length && h.rng() < 0.6 ? pick(h.rng, claimedPr) : pick(h.rng, town);
          if (t) await act(h.pid, "vote", "Mafia Kill", t);
          if (h.rng() < 0.3 && t) await act(h.pid, "speak", "Mafia", render(h.style, pick(h.rng, ["kill {X}?", "{X} tonight", "ok {X}"]), { X: name(t) }));
        }
        const end = meetingOf("Mafia Action", h.pid); if (end) await act(h.pid, "vote", "Mafia Action", "Yes");
      }
      if (h.role === "Cop") { const m = meetingOf("Cop", h.pid); const pool = others.filter((id) => !h.checked.has(id)); const t = pool.length ? pick(h.rng, pool) : "*"; if (m) { if (t !== "*") h.checked.add(t); h.lastCheck = t; await act(h.pid, "vote", "Cop", t); } }
      if (h.role === "Journalist") { const m = meetingOf("Journalist", h.pid); if (m) await act(h.pid, "vote", "Journalist", pick(h.rng, others)); }
      if (h.role === "Lawyer") { const m = meetingOf("Litigate", h.pid); const mates = others.filter((id) => scumIds.has(id)); if (m) await act(h.pid, "vote", "Litigate", mates.length && h.rng() < 0.6 ? pick(h.rng, mates) : "*"); }
      if (h.role === "Janitor") { const m = meetingOf("Clean Death", h.pid); if (m) await act(h.pid, "vote", "Clean Death", h.rng() < 0.3 ? "Yes" : "No"); }
    }
  }

  return {
    stats, ids: humans, H,
    observe(pid, event, data) {
      const h = H.get(pid); if (!h) return;
      if (event === "state") { h.plan = []; if (String(data?.name).startsWith("Night")) planNight(h); else if (String(data?.name).startsWith("Day")) planDay(h); return; }
      if (event === "reveal") { reveals[data.playerId] = data.role; return; }
      if (event !== "message") return;
      const text = String(data?.content || "");
      if (data?.senderId === "server") {
        const m = /investigation shows that (\w+) is (Guilty|Innocent)/.exec(text);
        if (m && idByName.has(m[1].toLowerCase())) h.results.push({ target: idByName.get(m[1].toLowerCase()), guilty: m[2] === "Guilty" });
        return;
      }
      const from = data.senderId; if (!from || from === pid) return;
      const low = text.toLowerCase(); const me = name(pid).toLowerCase();
      if (pid === humans[0]) {
        // Public evidence is shared table knowledge: process each public line once.
        const role = claimedRoleIn(text); if (role) claimedOf[from] = role;
        const cop = /\b(guilty|inno|innocent)\b/.exec(low);
        if (role === "cop" && cop) for (const [n, id] of idByName) if (id !== from && new RegExp(`\\b${n}\\b`).test(low)) publicEvidence[id] = (publicEvidence[id] || 0) + (cop[1] === "guilty" ? 2 : -1);
      }
      if (!new RegExp(`\\b${me}\\b`).test(low)) return;
      const now = S.clock.now();
      if (/\b(claim|what are you|role|whats your)\b/.test(low) && !h.claimed && !h.plan.some((x) => x.kind === "answer" || x.kind === "powerAnswer") && h.rng() < cfg.answerAsk) { const at = now + Math.round((4 + 50 * h.rng()) * 1000); h.plan.push({ at, kind: "answer", askedAt: now }); stats.answerDelays = stats.answerDelays || []; stats.answerDelays.push(Math.round((at - now) / 1000)); }
      else if (/\b(sus|lying|scum|mafia|vote|guilty|off)\b/.test(low)) { h.accusedBy.add(from); if (h.rng() < 0.6) h.plan.push({ at: now + Math.round((3 + 25 * h.rng()) * 1000), kind: "defend", by: from }); }
    },
    async tick(act) {
      const now = S.clock.now();
      for (const h of H.values()) {
        const due = h.plan.filter((a) => a.at <= now); if (!due.length) continue;
        h.plan = h.plan.filter((a) => a.at > now);
        for (const a of due.sort((x, y) => x.at - y.at)) await run(h, a, act);
      }
    },
    /** A claim answer this seat has scheduled and not yet said (seconds until it would be said), or null. */
    pendingAnswer(pid) { const a = H.get(pid)?.plan.find((x) => x.kind === "answer"); return a ? Math.round((a.at - S.clock.now()) / 1000) : null; },
    answeredAgo(pid, now) { const h = H.get(pid); return h?.answeredAt != null ? Math.round((now - h.answeredAt) / 1000) : null; },
    scenario: scLog,
    /** Scenario: seats the server keeps alive through Night 1 (the scripted Sheriff and the asked power seat). */
    scenarioProtects(pid, day) { return !!sc && day === 1 && (pid === sheriffHuman || pid === powerId); },
    /** Scenario "lone": the scripted mafia seats leave at Day 1 start (no reveal), so the bot is the only mafia. */
    scenarioRemove(day) { return sc?.cc === "lone" && day === 1 ? scumHumans.filter((id) => S.alive.has(id)) : []; },
    noteLine(pid) { const h = H.get(pid); if (!h) return; stats.lines += 1; stats.byStyle[h.styleName] = (stats.byStyle[h.styleName] || 0) + 1; },
  };
}
