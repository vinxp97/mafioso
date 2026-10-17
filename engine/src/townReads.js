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
  const reports = []; // { by, target, kind: "fakecop"|"realcop"|"janitor" }
  for (const m of publicLines(view)) {
    const by = m.senderId;
    const text = String(m.content || "");
    const claimed = roleName(claimedRoleIn(text) || (view.claims?.[by]?.kind !== "retract" ? view.claims?.[by]?.role : null));
    if (claimed && claimed !== "Villager" && !claims[by]) claims[by] = claimed;
    for (const seg of text.split(/[.;!?,]+/)) {
      const ids = namesIn(view, seg).filter((id) => id !== by);
      if (!ids.length) continue;
      const target = ids[0];
      if (claims[by] === "Journalist" && JANITOR.test(seg)) reports.push({ by, target, kind: "janitor" });
      else if (claims[by] === "Journalist" && NO_REPORT.test(seg)) reports.push({ by, target, kind: "fakecop" });
      else if (claims[by] === "Journalist" && GOT_REPORT.test(seg)) reports.push({ by, target, kind: "realcop" });
      if (LIAR.test(seg)) liar.push({ by, target });
      else if (claims[by] === "Cop" && GUILTY.test(seg) && !NOT_GUILTY.test(seg)) guilty.push({ by, target, phase: m.phase || "" });
      else if (claims[by] === "Cop" && INNO.test(seg)) inno.push({ by, target, phase: m.phase || "" });
    }
  }
  return { claims, guilty, inno, liar, reports };
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
    if (/^mafia$/i.test(String(c?.result)) || /guilty/i.test(txt)) add(id, W.ownCheck, "my check: guilty");
    else if (/^village$/i.test(String(c?.result)) || /innocent/i.test(txt)) add(id, -W.ownCheck, "my check: innocent");
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
  }

  // Guilty/innocent calls checked against flips; calls on me.
  for (const g of rec.guilty) {
    const flip = revealedAlign(view, g.target);
    if (flip === "Village") add(g.by, W.provenLiar, "their guilty flipped town");
    else if (flip === "Mafia") add(g.by, W.credibleCop, "their guilty flipped mafia");
    if (town && g.target === self) add(g.by, W.provenLiar, "called me guilty");
    if (POWER.has(rec.claims[g.target] || "") && !flip) add(g.by, W.guiltyOnPower, `guilty on a ${rec.claims[g.target]} claimer`);
  }
  for (const c of rec.inno) if (revealedAlign(view, c.target) === "Mafia") add(c.by, W.provenLiar, "their innocent flipped mafia");

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
  // Trust transfers: a unique role has one holder. A verified claimer makes rival claimers liars, and a
  // verified Cop's guilty is evidence; the only Cop claimer's guilty is worth a little (a test).
  // Being one of two claimers is not evidence against the one with independent support: ignore it here.
  const contestPts = (id) => (Object.values(contested).some((l) => l.includes(id)) ? W.contested : 0);
  const verified = (id) => (score[id] || 0) - contestPts(id) <= W.credible && alive(view, id);
  for (const [role, ids] of Object.entries(contested)) {
    const good = ids.filter(verified);
    if (good.length === 1) for (const id of ids) if (id !== good[0]) add(id, W.vsCredible, `claims ${role} against a verified ${role}`);
  }
  const copClaimers = (byRole.Cop || []).filter((id) => alive(view, id));
  for (const g of rec.guilty) {
    if (revealedAlign(view, g.target)) continue;
    if (verified(g.by)) add(g.target, W.credibleGuilty, "guilty from a verified Cop");
    else if (copClaimers.length === 1 && copClaimers[0] === g.by) add(g.target, W.soleCopGuilty, "guilty from the only Cop claimer");
  }
  for (const [id, role] of soleClaims) if ((score[id] || 0) <= 0) add(id, W.uncontestedPower, `sole ${role} claim`);
  for (const id of Object.keys(score)) score[id] = Math.round(score[id] * 100) / 100;
  return { score, reasons, contested, record: rec };
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
  if (top && top[1] >= TOWN_READS.strong && top[1] - (next?.[1] || 0) >= TOWN_READS.shootMargin) {
    return { target: top[0], why: `strong read: ${(reads.reasons[top[0]] || []).join("; ")}`, reads };
  }
  const noOne = (meeting?.targets || []).includes("*");
  const contestedCop = (reads.contested.Cop || []).length >= 2;
  const guiltyOnPower = today(view, reads.record.guilty).some((g) => POWER.has(reads.record.claims[g.target] || "") && alive(view, g.target));
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
