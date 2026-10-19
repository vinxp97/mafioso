// The town's day vote from the suspicion model (townReads), over the seat's legal picks (legalActions).
// One scorer, one rule: no belief board, notes lean or noise on top.
//   value(t) = read(t) + TOWN_VOTE.wagon per current vote on t by a player I don't suspect (max TOWN_VOTE.wagonCap)
//   - never a trusted player (verified claimer, or read <= TOWN_READS.credible);
//   - townDayPick first: a strong read is the vote; contested Cop claims mean no lynch;
//   - otherwise the best value above 0, else no-one when legal, else the best value.
import { meetingActions, revealedSheriff, soleClaimers } from "./legal.js";
import { publicRecord, TOWN_READS, townDayPick, townReads } from "./townReads.js";
import { dayOneLynchOwed, lyloToday, noLynchLoses, wrongLynchCostly } from "./lynchMath.js";

export const TOWN_VOTE = Object.freeze({ wagon: 1, wagonCap: 3, deferBelow: 2 });

/** Two or more living players have votes and nobody is strictly ahead. */
function voteSplit(meeting, view) {
  const counts = {};
  for (const [voter, raw] of Object.entries(meeting?.votes || {})) {
    if (view?.dead?.[voter]) continue;
    const t = Array.isArray(raw) ? raw[0] : raw;
    if (!t || t === "*") continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  const ns = Object.values(counts).sort((a, b) => b - a);
  return ns.length >= 2 && ns[0] === ns[1];
}

/**
 * Who town should follow: the revealed Sheriff, then a verified claimer, then a living uncontested Cop,
 * then a Journalist who is verified or confirmed (sole, or the counterclaim was lynched).
 * Their vote, when it is on a legal target other than me and not a self-vote: { by, target } or null.
 */
export function confirmedLead(view, meeting, reads = townReads(view)) {
  const sheriff = revealedSheriff(view);
  const rec = reads.record || publicRecord(view);
  const sole = soleClaimers(view);
  const livingClaim = (role) => Object.entries(rec.claims || {}).filter(([id, r]) => r === role && !view.dead?.[id] && view.players?.[id] && !view.players[id].left).map(([id]) => id);
  const uncontested = (role) => {
    const ids = livingClaim(role);
    return ids.length === 1 && !(reads.contested?.[role] || []).includes(ids[0]) ? ids[0] : null;
  };
  const cop = uncontested("Cop");
  const journalist = reads.verified.find((id) => rec.claims?.[id] === "Journalist")
    || [...sole].find((id) => rec.claims?.[id] === "Journalist")
    || uncontested("Journalist");
  const leaders = [sheriff, ...reads.verified, cop, journalist].filter((id, i, a) => id && id !== view.selfId && a.indexOf(id) === i && !view.dead?.[id]);
  for (const by of leaders) {
    const v = meeting?.votes?.[by];
    const t = Array.isArray(v) ? v[0] : v;
    if (t && t !== "*" && t !== by && t !== view.selfId && !view.dead?.[t] && t !== sheriff) return { by, target: t };
  }
  return null;
}

/**
 * @param {{follow?: boolean}} [opt] follow: the suspicion arm's rule (live L2-1018, D2): with no read above
 *   zero, follow the strongest wagon, else the best untrusted read, instead of abstaining; no-one only when it is
 *   clearly better (LYLO: a wrong lynch loses today and a no-lynch does not).
 * @returns {{target:string, why:string}|null} null when the meeting is closed or nothing is legal.
 */
export function townVote(view, meeting, { follow = false } = {}) {
  if (!meeting) return null;
  const e = meetingActions(view, meeting);
  // Never the revealed Sheriff, whatever the layer (L3: a tie-break ballot went on him).
  const sheriff = revealedSheriff(view);
  const opts = (e.picks.length ? e.picks : e.allowed).filter((t) => t !== sheriff || t === view.selfId);
  if (e.closed || !opts.length) return null;
  const strong = townDayPick(view, meeting);
  if (strong && opts.includes(strong.target)) return { target: strong.target, why: strong.why };
  const reads = townReads(view);
  const read = (id) => reads.score[id] || 0;
  const trusted = (id) => reads.verified.includes(id) || read(id) <= TOWN_READS.credible;
  const backers = {};
  for (const [voter, v] of Object.entries(meeting.votes || {})) {
    const sel = Array.isArray(v) ? v[0] : v;
    if (voter !== view.selfId && sel && sel !== "*" && read(voter) <= 0) backers[sel] = (backers[sel] || 0) + 1;
  }
  const ranked = opts.filter((t) => t !== "*" && t !== view.selfId && !trusted(t))
    .map((t) => [t, read(t) + TOWN_VOTE.wagon * Math.min(TOWN_VOTE.wagonCap, backers[t] || 0)])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [best] = ranked;
  // A weak read follows confirmed town. On a split, anyone short of a lynch-level read does too,
  // including when abstaining would be the costly-day default.
  const lead = confirmedLead(view, meeting, reads);
  const myTop = Math.max(0, ...ranked.map(([t]) => read(t)));
  const split = voteSplit(meeting, view);
  if (lead && opts.includes(lead.target) && !trusted(lead.target) && (myTop < TOWN_VOTE.deferBelow || (split && myTop < TOWN_READS.strong))) {
    return { target: lead.target, why: `weak read (${myTop}): follow confirmed town ${view.players?.[lead.by]?.name || lead.by}` };
  }
  // L3 (10/18): when a wrong lynch is costly (it loses now, or gives parity with tonight's kill), or on Day 1
  // with the Sheriff alive, a wagon is no evidence (mafia start them): rank by real reads only. The best positive
  // read; else no-lynch where legal and safe; else the least-bad by reads.
  if (follow && (wrongLynchCostly(view) || dayOneLynchOwed(view))) {
    const byRead = opts.filter((t) => t !== "*" && t !== view.selfId && !trusted(t))
      .map((t) => [t, read(t)]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = byRead[0];
    if (top && top[1] > 0) return { target: top[0], why: `costly wrong lynch: best read ${top[1]}: ${(reads.reasons[top[0]] || []).join("; ")}` };
    if (opts.includes("*")) return { target: "*", why: "costly wrong lynch, no read above zero: no lynch" };
    if (top) return { target: top[0], why: `costly wrong lynch, must lynch: least-bad read ${top[1]} (wagons ignored)` };
  }
  if (best && best[1] > 0) return { target: best[0], why: `top suspicion ${best[1]}: ${(reads.reasons[best[0]] || ["wagon"]).join("; ")}` };
  if (follow && best && !(opts.includes("*") && lyloToday(view) && !noLynchLoses(view))) {
    const wagon = ranked.filter(([t]) => (backers[t] || 0) > 0).sort((a, b) => (backers[b[0]] || 0) - (backers[a[0]] || 0) || b[1] - a[1])[0];
    if (wagon) return { target: wagon[0], why: `no read above zero: follow the wagon (${backers[wagon[0]]} votes)` };
    return { target: best[0], why: `no read above zero: best read ${best[1]}` };
  }
  if (opts.includes("*")) return { target: "*", why: follow && best ? "no read above zero: no lynch (LYLO, a wrong lynch loses)" : "no read above zero: no lynch" };
  if (best) return { target: best[0], why: "no-one not allowed: top suspicion" };
  const other = opts.find((t) => t !== "*" && t !== view.selfId);
  return { target: other || opts[0], why: "only legal option" };
}
