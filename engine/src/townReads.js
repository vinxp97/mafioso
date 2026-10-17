// Town reads from public play, for Village seats only (Frontier Justice). Pure: reads one seat's view.
// It turns the things a careful FJ town player tracks into a suspicion score per living player:
//   - a Cop claim is unverified until something confirms it; two Cop claims mean one is lying;
//   - a claimer whose "guilty" flips town is a proven liar, and so is anyone claiming MY role;
//   - Journalist reports settle Cop claims ("X got no report" = fake Cop);
//   - players who pushed a lynch that flipped town (voted it, first voters most) earn suspicion;
//   - being named a liar by several players, or giving a guilty on a power-role claimer, adds a little.
// Scores are additive and in "evidence points"; TOWN_READS holds every weight. No seed tuning: the
// weights only order evidence (hard > proven lie > report > contested claim > vote history).
import { claimedRoleIn } from "./chatStyle.js";
import { ALIGNMENT, alignmentOf, allies } from "./faction.js";
import { memoryOf } from "./notes.js";

export const TOWN_READS = Object.freeze({
  ownCheck: 20, // my own Guilty (or -20 Innocent)
  claimsMyRole: 10, // someone claims the unique role I hold
  revealedTown: -10, // a living player the server revealed as town (the Sheriff after a shot)
  provenLiar: 8, // their guilty flipped town, their innocent flipped mafia, or they called ME guilty
  janitorReport: 8, // a Journalist says X is the Janitor
  fakeCopReport: 7, // a Journalist says Cop claimer X got no report
  realCopReport: -6, // a Journalist says Cop claimer X got a report
  fakeJournalistReport: 7, // a Journalist says rival Journalist claimer X got no report
  noReport: -0.5, // a Journalist says (Villager claimer) X got no report: fits, weakly
  otherCopWhenReal: 4, // the other Cop claimer when one is confirmed by report
  credibleCop: -4, // their guilty flipped mafia
  contested: 1.5, // one of two+ living claimers of a unique role
  accuser: 1.5, // per distinct player calling them a liar / fake (max 3)
  guiltyOnPower: 1, // gave a guilty on a power-role claimer
  lynchPusher: 2, // voted a Day death that flipped town
  firstPusher: 1, // one of the first two voters on it
  uncontestedPower: -1, // sole claimer of a power role, nothing against it
  credibleAccuser: -4, // called someone a liar who then flipped mafia
  credible: -3, // at or below this, a claimer counts as verified
  vsCredible: 6, // claims a unique role a verified claimer already holds
  credibleGuilty: 7, // named guilty by a verified Cop
  soleCopGuilty: 2, // named guilty by the only Cop claimer (worth a test, not a lynch)
  votedWithScum: 1.5, // voted the same player as a player who later flipped mafia (per day)
  votedOnScum: -1.5, // voted for a player who was lynched and flipped mafia
  votedRevealedTown: 2, // a standing day vote on a living player the server revealed as town
  credibleInno: -3, // innocent from a verified Cop (a living Loyal Lawyer could have faked it)
  clearedInno: -8, // innocent from a verified Cop once the Lawyer has flipped: nothing can fake it
  cleanedClaimer: 6, // claims a unique role whose other claimer was killed at night and cleaned (so was town)
  votedByScum: -1, // a player who flipped mafia voted them (mafia rarely votes a teammate; buses aside)
  roleFlipped: 8, // claims a unique role that a dead player already flipped
  rivalFlippedMafia: -4, // another claimer of my unique role flipped mafia
  lawyerableInno: -6, // my own Cop Innocent: a Loyal Lawyer can fake it on a teammate, so it is not a clear
  innoFlippedMafia: 1, // their innocent flipped mafia: lawyered (a Loyal Lawyer fakes only innocents) or lying
  ownRead: 2, // enough to vote my own read instead of joining a wagon
  ownReadMargin: 1.5, // ...when the wagon's target reads this much lower
  strong: 6, // enough to lynch on
  shoot: 4, // enough for the Sheriff, with a margin
  shootMargin: 2,
});

const UNIQUE = new Set(["Cop", "Journalist", "Sheriff"]);
const POWER = new Set(["Cop", "Journalist", "Sheriff", "Doctor"]);
const GUILTY = /\b(guilty|mafia|scum|red)\b/i;
const NOT_GUILTY = /\b(not|isn'?t|no)\s+(guilty|mafia|scum)\b/i;
const INNO = /\b(inno|innocent|town|clear(?:ed)?)\b/i;
const LIAR = /\b(lying|liar|lies|fake)\b/i;
const NO_REPORT = /\b(got no report|no reports?|received no)\b/i;
const GOT_REPORT = /\b(got a (?:cop )?report|real cop)\b/i;
const JANITOR = /\bis (?:the )?janitor\b/i;
const FAKE_JOURNALIST = /\bfake journ(?:alist|o)?\b/i;
const RELAY = /\b(?:report said|it said|their report)\b/i;

/** Night N < Day N < Night N+1: an ordinal for comparing phases ("" sorts last). */
const phaseOrdinal = (name) => {
  const m = /^(day|night)\s*(\d+)/i.exec(String(name || ""));
  return m ? Number(m[2]) * 2 + (/^day/i.test(m[1]) ? 1 : 0) : Infinity;
};
const roleName = (r) => (r ? String(r).charAt(0).toUpperCase() + String(r).slice(1).toLowerCase() : null);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namesIn(view, text) {
  const t = String(text || "").toLowerCase();
  const out = [];
  for (const [id, p] of Object.entries(view?.players || {})) {
    const n = String(p?.name || "").toLowerCase();
    if (n.length < 2) continue;
    const m = t.match(new RegExp(`(^|[^a-z0-9_])${esc(n)}([^a-z0-9_]|$)`));
    if (m) out.push({ id, at: m.index });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.id);
}

function publicLines(view) {
  return (view?.messages || []).filter((m) => m && m.senderId && m.senderId !== "server" && m.senderId !== "anonymous" && m.public !== false);
}

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const revealedAlign = (view, id) => alignmentOf(view?.reveals?.[id]);

/** Everything said in public that the reads use. */
export function publicRecord(view) {
  const claims = {}; // id -> role (first unique claim)
  const guilty = []; // { by, target, phase }
  const inno = [];
  const liar = []; // { by, target }
  const reports = []; // { by, target, kind: "fakecop"|"fakejournalist"|"noreport"|"realcop"|"janitor" }
  const claimedAt = {}; // id -> phase ordinal of the first claim
  for (const m of publicLines(view)) {
    const by = m.senderId;
    const text = String(m.content || "");
    const claimed = roleName(claimedRoleIn(text) || (view.claims?.[by]?.kind !== "retract" ? view.claims?.[by]?.role : null));
    if (claimed && claimed !== "Villager" && !claims[by]) { claims[by] = claimed; claimedAt[by] = phaseOrdinal(m.phase); }
    const segs = text.split(/[.;!?,]+/);
    for (const [si, seg] of segs.entries()) {
      const ids = namesIn(view, seg).filter((id) => id !== by);
      if (!ids.length) continue;
      const target = ids[0];
      if (claims[by] === "Journalist" && JANITOR.test(seg)) reports.push({ by, target, kind: "janitor" });
      else if (claims[by] === "Journalist" && NO_REPORT.test(seg)) {
        // FJ: a real Journalist always has a report, a Villager never does. Only a Cop or Journalist claim is
        // exposed by "no report"; on anyone else it just fits.
        const said = `${seg} ${segs[si + 1] || ""}`; // "x got no report, fake journalist"
        const kind = FAKE_JOURNALIST.test(said) || claims[target] === "Journalist" ? "fakejournalist"
          : /fake cop/i.test(said) || claims[target] === "Cop" ? "fakecop" : "noreport";
        reports.push({ by, target, kind });
      }
      else if (claims[by] === "Journalist" && GOT_REPORT.test(seg)) reports.push({ by, target, kind: "realcop" });
      if (claims[by] === "Journalist" && RELAY.test(seg) && GUILTY.test(seg)) { guilty.push({ by, target, phase: m.phase || "", relay: true }); continue; }
      if (LIAR.test(seg)) liar.push({ by, target });
      else if (claims[by] === "Cop" && GUILTY.test(seg) && !NOT_GUILTY.test(seg)) guilty.push({ by, target, phase: m.phase || "" });
      else if (claims[by] === "Cop" && INNO.test(seg)) inno.push({ by, target, phase: m.phase || "" });
    }
  }
  // Repeating a result ("results: x guilty" each day) is one call, not new evidence.
  const once = (list) => { const seen = new Set(); return list.filter((x) => { const k = `${x.by}|${x.target}|${x.relay ? 1 : 0}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  return { claims, claimedAt, guilty: once(guilty), inno: once(inno), liar, reports: once(reports.map((r) => ({ ...r, relay: r.kind }))).map(({ relay, ...r }) => r) };
}

/**
 * Suspicion per living player (not self, not known allies). Higher = more likely mafia.
 * @returns {{score:Object<string,number>, reasons:Object<string,string[]>, contested:Object<string,string[]>, record:object}}
 */
export function townReads(view) {
  const W = TOWN_READS;
  const score = {};
  const reasons = {};
  const mates = allies(view);
  const self = view?.selfId;
  const add = (id, pts, why) => {
    if (!id || id === self || mates.has(id) || !alive(view, id) || !pts) return;
    score[id] = (score[id] || 0) + pts;
    (reasons[id] ||= []).push(`${pts > 0 ? "+" : ""}${pts} ${why}`);
  };
  const rec = publicRecord(view);
  const mem = memoryOf(view);
  const myRole = roleName(view?.role);
  const town = ALIGNMENT[myRole] === "Village";

  // Hard facts this seat holds.
  for (const [id, c] of Object.entries(mem.checks || {})) {
    const txt = `${c?.result || ""} ${c?.detail || ""}`;
    // FJ's Lawyer is Loyal: Litigate only works on a teammate and makes it read Innocent. A Guilty is a
    // fact; an Innocent can be a lawyered mafia player, so it only offsets up to a lynch-level read.
    if (/^mafia$/i.test(String(c?.result)) || /guilty/i.test(txt)) add(id, W.ownCheck, "my check: guilty");
    else if (/^village$/i.test(String(c?.result)) || /innocent/i.test(txt)) add(id, W.lawyerableInno, "my check: innocent (could be lawyered)");
    if (/no reports?/i.test(txt) && rec.claims[id] === "Cop") add(id, W.ownCheck / 2, "claims Cop, my visit saw no report");
  }
  for (const id of Object.keys(view?.reveals || {})) if (alive(view, id) && revealedAlign(view, id) === "Village") add(id, W.revealedTown, "revealed town");

  // Claims: my unique role, contested unique roles, sole power claims.
  const byRole = {};
  for (const [id, role] of Object.entries(rec.claims)) (byRole[role] ||= []).push(id);
  const contested = {};
  const soleClaims = []; // credited at the end, only when nothing else counts against the claimer
  for (const [role, ids] of Object.entries(byRole)) {
    const living = ids.filter((id) => alive(view, id) && revealedAlign(view, id) !== "Village");
    if (town && role === myRole && UNIQUE.has(role)) for (const id of living) add(id, W.claimsMyRole, `claims ${role}, which I am`);
    if (UNIQUE.has(role) && living.length >= 2) { contested[role] = living; for (const id of living) add(id, W.contested, `one of ${living.length} ${role} claimers`); }
    if (POWER.has(role) && living.length === 1 && ids.length === 1) soleClaims.push([living[0], role]);
    if (UNIQUE.has(role)) {
      // A unique role has one holder: a dead claimer who flipped it proves every other claimer a liar, and a
      // rival claimer who flipped mafia makes the remaining claimer credible.
      // The true holder may never have claimed: any dead player who flipped the role counts.
      const flippedRole = (id) => roleName(String(view?.reveals?.[id] || "").split(" (")[0]) === role;
      const trueHolder = ids.find((id) => !alive(view, id) && flippedRole(id))
        || Object.keys(view?.reveals || {}).find((id) => view?.players?.[id] && !alive(view, id) && flippedRole(id));
      // Only a claimer who stood against the rival while he was alive earns that credit (claiming a role
      // after its fake has flipped is free).
      const diedAt = (id) => phaseOrdinal((mem.deaths || []).find((d) => d.id === id)?.phase);
      const mafiaRivals = ids.filter((id) => !alive(view, id) && revealedAlign(view, id) === "Mafia");
      for (const id of living) {
        if (trueHolder && trueHolder !== id) add(id, W.roleFlipped, `claims ${role}, but ${view.players?.[trueHolder]?.name || "a dead player"} flipped ${role}`);
        else if (mafiaRivals.some((r) => (rec.claimedAt[id] ?? Infinity) <= diedAt(r))) add(id, W.rivalFlippedMafia, `a rival ${role} claimer flipped mafia`);
      }
    }
  }

  // Guilty/innocent calls checked against flips; calls on me.
  for (const g of rec.guilty) {
    const flip = revealedAlign(view, g.target);
    if (flip === "Village") add(g.by, W.provenLiar, "their guilty flipped town");
    else if (flip === "Mafia") add(g.by, W.credibleCop, "their guilty flipped mafia");
    if (town && g.target === self) add(g.by, W.provenLiar, "called me guilty");
    if (POWER.has(rec.claims[g.target] || "") && !flip) add(g.by, W.guiltyOnPower, `guilty on a ${rec.claims[g.target]} claimer`);
  }
  // An innocent that flips mafia is not proof of a lie under a Loyal Lawyer (that is exactly what Litigate does).
  for (const c of rec.inno) if (revealedAlign(view, c.target) === "Mafia") add(c.by, W.innoFlippedMafia, "their innocent flipped mafia (lawyered or lying)");

  // Liar accusations: distinct accusers, capped.
  const accusers = {};
  for (const l of rec.liar) if (l.by !== l.target) (accusers[l.target] ||= new Set()).add(l.by);
  for (const [id, set] of Object.entries(accusers)) {
    add(id, W.accuser * Math.min(3, set.size), `called a liar by ${set.size}`);
    if (revealedAlign(view, id) === "Mafia") for (const by of set) add(by, W.credibleAccuser, "called a liar who flipped mafia");
  }

  // Journalist reports (halved when the Journalist claim itself is contested).
  for (const r of rec.reports) {
    const k = contested.Journalist?.includes(r.by) ? 0.5 : 1;
    if (r.kind === "janitor") add(r.target, W.janitorReport * k, "Journalist: Janitor");
    if (r.kind === "fakecop") add(r.target, W.fakeCopReport * k, "Journalist: Cop claim got no report");
    if (r.kind === "fakejournalist") add(r.target, W.fakeJournalistReport * k, "Journalist: rival Journalist claim got no report");
    if (r.kind === "noreport") add(r.target, W.noReport * k, "Journalist: got no report (fits a Villager)");
    if (r.kind === "realcop") {
      add(r.target, W.realCopReport * k, "Journalist: Cop claim got a report");
      for (const other of byRole.Cop || []) if (other !== r.target) add(other, W.otherCopWhenReal * k, "other Cop claim vs a confirmed Cop");
    }
  }

  // Vote history: Day deaths that flipped town. Voters on them, first two more.
  const deaths = (mem.deaths || []).filter((d) => /^day/i.test(String(d.phase || "")) && revealedAlign(view, d.id) === "Village");
  for (const d of deaths) {
    const seen = [];
    for (const v of mem.votes || []) if (v.phase === d.phase && v.target === d.id && !seen.includes(v.voterId)) seen.push(v.voterId);
    seen.forEach((voter, i) => add(voter, W.lynchPusher + (i < 2 ? W.firstPusher : 0), "voted a town flip"));
  }
  // Vote company: who voted alongside a player who flipped mafia, and who voted the mafia lynch itself.
  const lastVotes = {}; // phase -> voter -> target (the vote that stood)
  for (const v of mem.votes || []) if (/^day/i.test(String(v.phase || ""))) (lastVotes[v.phase] ||= {})[v.voterId] = v.target;
  for (const d of mem.deaths || []) {
    if (revealedAlign(view, d.id) !== "Mafia") continue;
    for (const [phase, byVoter] of Object.entries(lastVotes)) {
      const t = byVoter[d.id];
      if (t && t !== "*" && revealedAlign(view, t) !== "Mafia") {
        add(t, W.votedByScum, `${view.players?.[d.id]?.name || "a scum"} (flipped mafia) voted them on ${phase}`);
        for (const [voter, x] of Object.entries(byVoter)) if (voter !== d.id && x === t) add(voter, W.votedWithScum, `voted with ${view.players?.[d.id]?.name || "a scum"} (flipped mafia) on ${phase}`);
      }
      if (phase === d.phase) for (const [voter, x] of Object.entries(byVoter)) if (x === d.id) add(voter, W.votedOnScum, `voted the mafia lynch on ${phase}`);
      // A flipped mafia's fake guilty is that player's push: voting its target that day is voting with them.
      for (const g of rec.guilty) {
        if (g.by !== d.id || g.relay || g.phase !== phase || g.target === t || revealedAlign(view, g.target) === "Mafia") continue;
        add(g.target, W.votedByScum, `${view.players?.[d.id]?.name || "a scum"} (flipped mafia) called them guilty`);
        for (const [voter, x] of Object.entries(byVoter)) if (voter !== d.id && x === g.target) add(voter, W.votedWithScum, `voted ${view.players?.[g.target]?.name || "the"} target of a flipped mafia's fake guilty on ${phase}`);
      }
    }
  }
  // Standing votes on a living revealed-town player (the Sheriff after a shot).
  for (const byVoter of Object.values(lastVotes)) for (const [voter, t] of Object.entries(byVoter)) {
    if (alive(view, t) && revealedAlign(view, t) === "Village") add(voter, W.votedRevealedTown, `voted ${view.players?.[t]?.name || "a revealed townie"}, revealed town`);
  }
  // A dead player with no role shown was cleaned by the Janitor, i.e. killed by the mafia: town. Their unique
  // claim was true, so any other claimer of that role is lying.
  for (const [role, ids] of Object.entries(byRole)) {
    if (!UNIQUE.has(role)) continue;
    const cleanedHolder = ids.find((id) => view?.players?.[id] && !alive(view, id) && !view?.reveals?.[id]);
    if (cleanedHolder) for (const id of ids) if (id !== cleanedHolder && alive(view, id)) add(id, W.cleanedClaimer, `claims ${role}, but ${view.players?.[cleanedHolder]?.name || "a cleaned player"} claimed it and was killed at night`);
  }
  // Trust transfers: a unique role has one holder. A verified claimer makes rival claimers liars, and a
  // verified Cop's guilty is evidence; the only Cop claimer's guilty is worth a little (a test).
  // Being one of two claimers is not evidence against the one with independent support: ignore it here.
  const contestPts = (id) => (Object.values(contested).some((l) => l.includes(id)) ? W.contested : 0);
  const verified = (id) => (alive(view, id) ? (score[id] || 0) - contestPts(id) <= W.credible : !!rec.claims[id] && roleName(view?.reveals?.[id]) === rec.claims[id]);
  for (const [role, ids] of Object.entries(contested)) {
    const good = ids.filter(verified);
    if (good.length === 1) for (const id of ids) if (id !== good[0]) add(id, W.vsCredible, `claims ${role} against a verified ${role}`);
  }
  const copClaimers = (byRole.Cop || []).filter((id) => alive(view, id));
  for (const g of rec.guilty) {
    if (revealedAlign(view, g.target)) continue;
    if (g.relay) { if (rec.claims[g.by] === "Journalist" && !contested.Journalist) add(g.target, W.credibleGuilty, "Journalist relayed a Cop's guilty report"); continue; }
    if (verified(g.by)) add(g.target, W.credibleGuilty, alive(view, g.by) ? "guilty from a verified Cop" : "guilty from a Cop who flipped Cop");
    else if (copClaimers.length === 1 && copClaimers[0] === g.by && (score[g.by] || 0) <= 0) add(g.target, W.soleCopGuilty, "guilty from the only Cop claimer");
  }
  const lawyerFlipped = Object.entries(view?.reveals || {}).some(([id, r]) => !alive(view, id) && /^lawyer/i.test(String(r)));
  for (const c of rec.inno) {
    if (revealedAlign(view, c.target) || c.target === self || !verified(c.by)) continue;
    add(c.target, lawyerFlipped ? W.clearedInno : W.credibleInno, lawyerFlipped ? "innocent from a verified Cop, Lawyer gone" : "innocent from a verified Cop");
  }
  for (const [id, role] of soleClaims) if ((score[id] || 0) <= 0) add(id, W.uncontestedPower, `sole ${role} claim`);
  const verifiedClaimers = Object.keys(rec.claims).filter((id) => alive(view, id) && verified(id));
  for (const id of Object.keys(score)) score[id] = Math.round(score[id] * 100) / 100;
  return { score, reasons, contested, record: rec, verified: verifiedClaimers };
}

/** Today's public lines only. */
function today(view, list) {
  const phase = view?.phase?.name || "";
  return list.filter((x) => !x.phase || x.phase === phase);
}

/**
 * Town day vote from the reads, or null to leave the vote to the usual rules.
 * - a strong read (>= TOWN_READS.strong, top and clear of the next) is the vote;
 * - otherwise, when Cop claims are contested, or today's guilty names a power-role claimer, nobody's
 *   claim is trusted enough to lynch on: vote no-one ("*") so a mafia bloc cannot pick the lynch.
 */
export function townDayPick(view, meeting) {
  if (!view?.selfId || ALIGNMENT[roleName(view.role)] !== "Village") return null;
  const targets = (meeting?.targets || []).filter((t) => t !== "*" && t !== view.selfId && alive(view, t));
  const reads = townReads(view);
  const ranked = targets.map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  // A clear lead, or two lynch-level reads (either is a lynch on evidence; take the stronger).
  if (top && top[1] >= TOWN_READS.strong && (top[1] - (next?.[1] || 0) >= TOWN_READS.shootMargin || (next?.[1] || 0) >= TOWN_READS.strong)) {
    return { target: top[0], why: `strong read: ${(reads.reasons[top[0]] || []).join("; ")}`, reads };
  }
  const noOne = (meeting?.targets || []).includes("*");
  // Contested means nobody has independent support yet; a verified Cop settles the contest.
  const contestedCop = (reads.contested.Cop || []).length >= 2 && !reads.contested.Cop.some((id) => reads.verified.includes(id));
  // A guilty from a claimer who has since died (or flipped mafia) no longer holds the vote hostage.
  const guiltyOnPower = today(view, reads.record.guilty).some((g) => alive(view, g.by) && POWER.has(reads.record.claims[g.target] || "") && alive(view, g.target));
  if (noOne && (contestedCop || guiltyOnPower)) {
    return { target: "*", why: contestedCop ? "Cop claims contested: no lynch on either claim" : "guilty on a power-role claimer: no lynch", reads };
  }
  return null;
}

/** Sheriff target from the reads: top score >= TOWN_READS.shoot and clear of the next. */
export function sheriffReadTarget(view, targets) {
  const reads = townReads(view);
  const ranked = (targets || []).filter((t) => t !== "*" && t !== view.selfId && alive(view, t))
    .map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (top && top[1] >= TOWN_READS.shoot && top[1] - (next?.[1] || 0) >= TOWN_READS.shootMargin) return { target: top[0], why: (reads.reasons[top[0]] || []).join("; ") };
  return null;
}

/**
 * A short public line that tells the town's story from the evidence (Village seats, Day), or null.
 * Said at most once per seat per line; the harness also caps it at one per seat per day.
 *   - my own Cop Innocent on someone still suspicious: a Loyal Lawyer can fake an Innocent;
 *   - a claim of a unique role that a dead player already flipped;
 *   - a verified Cop's guilty: a Loyal Lawyer cannot fake a Guilty, so vote it today;
 *   - two unverified Cop claims: one is lying, test before lynching on either.
 */
export function townCounterLine(view) {
  if (!view?.selfId || view?.phase?.phase !== "Day" || ALIGNMENT[roleName(view.role)] !== "Village") return null;
  const reads = townReads(view);
  const nm = (id) => String(view.players?.[id]?.name || "").toLowerCase();
  const said = (view.messages || []).filter((m) => m?.senderId === view.selfId).map((m) => String(m.content || "").toLowerCase());
  const fresh = (line) => (line && !said.some((s) => s === line) ? line : null);
  const mem = memoryOf(view);
  if (/^cop$/i.test(String(view.role || ""))) {
    for (const [id, c] of Object.entries(mem.checks || {})) {
      if (!alive(view, id) || !/^village$|innocent/i.test(`${c?.result || ""}`)) continue;
      if ((reads.score[id] || 0) > 0) { const l = fresh(`${nm(id)} came back inno but a lawyer can fake that, still sus`); if (l) return l; }
    }
  }
  for (const [id, why] of Object.entries(reads.reasons)) {
    const flip = why.find((w) => /flipped (Cop|Journalist|Sheriff)$/.test(w) && /claims/.test(w));
    if (flip && alive(view, id)) {
      const m = /claims (\w+), but (\w+) flipped/.exec(flip);
      const l = m && fresh(`${nm(id)} claims ${m[1].toLowerCase()} but ${m[2].toLowerCase()} already flipped ${m[1].toLowerCase()}, ${nm(id)} is lying`);
      if (l) return l;
    }
  }
  for (const g of today(view, reads.record.guilty)) {
    if (!alive(view, g.target) || g.relay || g.target === view.selfId) continue;
    if (reads.verified.includes(g.by) || g.by === view.selfId) {
      const l = fresh(`lawyer cant fake a guilty, only an inno, so ${nm(g.target)} is mafia, vote ${nm(g.target)}`);
      if (l) return l;
    }
  }
  const cops = (reads.contested.Cop || []).filter((id) => alive(view, id));
  if (cops.length >= 2 && !cops.some((id) => reads.verified.includes(id)) && !cops.includes(view.selfId)) {
    return fresh("two cops and one is lying, no lynch on either guilty till one is tested");
  }
  return null;
}
