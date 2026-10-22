// Night 5 solo flags (10/20, Nightshift): one bot among humans. Every flag is OFF by default: with none of
// these keys in view.config / table.config the engine and harness behave exactly as before.
//   voteHold: "on"           a town seat's day ballot waits for a confident read (or ~60% of the day), then goes
//                            on its top suspect. The hard rules stay: the hammer ask, stuck-vote switching, never
//                            the revealed Sheriff, follow a confirmed-town lead, no Day 1 no-lynch while the
//                            Sheriff lives, the ballot net before the vote kick.
//   soloCounterclaim: "on"   with config.botSeats (the harness's own seats), only bot teammates count for the
//                            Night 5 mafia counterclaim: a lone bot counterclaims the asked power role itself
//                            (mafiaCounter.js counterclaimMates). Once, 3-7s later, never Sheriff, never the Sheriff.
//   groundedSpeech: "on"     the day opener, silence filler and speech floor say a line grounded in public facts
//                            or this seat's own read, or nothing (no "watching x" / "not sure yet").
//   voteKickGuard: "on"      the Sheriff's gun reacts to a Vote Kick only when the kick is aimed at him
//                            (sheriffGate.kickAimedAtMe); a kick on someone else no longer fires it.
import { chatAudit, groundedLine } from "./chatAudit.js";
import { earlyClaimBlock } from "./chatStyle.js";
import { allies } from "./faction.js";
import { machineLeak, publicLeak, revealedSheriff } from "./legal.js";
import { publicFactLines } from "./quietTable.js";
import { dayFraction } from "./sheriffGate.js";
import { TOWN_READS, townDayPick, townReads } from "./townReads.js";
import { TOWN_VOTE, confirmedLead } from "./townVote.js";

export const SOLO_FLAG_KEYS = Object.freeze(["voteHold", "soloCounterclaim", "groundedSpeech", "voteKickGuard"]);
/** The flags in force (each true only when its config value is "on"). */
export function soloFlagsOf(config) {
  return Object.fromEntries(SOLO_FLAG_KEYS.map((k) => [k, config?.[k] === "on"]));
}

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const nm = (view, id) => String(view?.players?.[id]?.name || id).toLowerCase();
function lineOk(view, content) {
  return !!content && !publicLeak(view, content) && !machineLeak(view, content) && !earlyClaimBlock(view, content) && !chatAudit(view, content).length;
}

// ---- voteHold ----
export const VOTE_HOLD = Object.freeze({ fraction: 0.6, remainingMs: 60_000 });

/** This seat's reads over a meeting's legal, untrusted, living targets, best first: [[id, score], ...]. */
function rankedReads(view, meeting, reads) {
  const trusted = (t) => reads.verified.includes(t) || (reads.score[t] ?? 0) <= TOWN_READS.credible;
  const sheriff = revealedSheriff(view);
  return (meeting?.targets || []).filter((t) => t !== "*" && t !== view.selfId && t !== sheriff && alive(view, t) && !trusted(t))
    .map((t) => [t, reads.score[t] || 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/**
 * voteHold: the ballot this town seat would cast now, or null to keep holding. { target, why }.
 * Confident: a lynch-level read (townDayPick), a confirmed-town lead to follow when its own read is weak, or a top
 * read at TOWN_READS.ownRead clear of the next by ownReadMargin. Past VOTE_HOLD (60% of the day, or a minute
 * left): the top suspect (a read above zero), else null and the usual rules pick.
 */
export function voteHoldPick(view, meeting, { now = view?.clock, late = null } = {}) {
  const reads = townReads(view);
  const strong = townDayPick(view, meeting);
  if (strong) return { target: strong.target, why: `confident: ${strong.why}`, confident: true };
  const ranked = rankedReads(view, meeting, reads);
  const [top, next] = ranked;
  const lead = confirmedLead(view, meeting, reads);
  if (lead && (!top || top[1] < TOWN_VOTE.deferBelow) && (meeting?.targets || []).includes(lead.target)) return { target: lead.target, why: "confident: follows confirmed town", confident: true };
  if (top && top[1] >= TOWN_READS.ownRead && top[1] - (next?.[1] || 0) >= TOWN_READS.ownReadMargin) return { target: top[0], why: `confident: top read ${top[1]}`, confident: true };
  const isLate = late ?? voteHoldLate(view, now);
  if (!isLate) return null;
  if (top && top[1] > 0) return { target: top[0], why: `held to ${isLate}: top read ${top[1]}`, confident: false };
  return { target: null, why: `held to ${isLate}: no read above zero`, confident: false };
}

/** The hold's deadline: 60% of the day, or a minute left on the day timer. null while it holds. */
export function voteHoldLate(view, now = view?.clock) {
  const f = dayFraction(view, { now });
  if (f != null && f >= VOTE_HOLD.fraction) return `fraction ${f.toFixed(2)}`;
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  if (tm?.last != null && tm.first != null && tm.last < tm.first && tm.last <= VOTE_HOLD.remainingMs) return `remaining ${tm.last}`;
  return null;
}

/** No readable day timer: the hold has no clock to wait on (the usual gate decides). */
export function voteHoldBlind(view, now = view?.clock) {
  const tm = view?.timer?.stateId === view?.stateId ? view.timer : null;
  return dayFraction(view, { now }) == null && !(tm?.last != null && tm.first != null && tm.last < tm.first);
}

// ---- groundedSpeech ----
// A read reason, said the way a player would. Only these shapes are said; anything else is just "my read is x".
const REASON_PHRASES = [
  [/(started|joined) a wagon on .* \(flipped town\)/, "pushed a town flip"],
  [/voted with .* \(flipped mafia\)/, "voted with the mafia flip"],
  [/^called a liar by/, "called fake by others"],
  [/^claims \w+, but .* flipped/, "that role already flipped"],
  [/^claims \w+ against a verified/, "counterclaimed a confirmed claimer"],
  [/^one of \d+ \w+ claimers/, "contested claim"],
  [/, a verified claimer, today$/, "voting a confirmed claimer"],
  [/, revealed town$/, "voting revealed town"],
];
function reasonPhrase(reasons) {
  for (const r of reasons || []) for (const [re, phrase] of REASON_PHRASES) if (re.test(String(r))) return phrase;
  return null;
}

/**
 * groundedSpeech: lines grounded in the public record or this seat's own read, best first. [] = say nothing.
 * The town counter-story, a confident read (with its reason when it has a sayable one), then public facts
 * (the vote tally once anyone has voted, living claims, flips). Every line passes the leak, claim and chat audits.
 */
export function groundedSpeechLines(view) {
  if (view?.phase?.phase !== "Day" || !view?.selfId) return [];
  const out = [];
  const counter = groundedLine(view);
  if (counter) out.push(counter);
  const reads = townReads(view);
  const mates = allies(view);
  const ranked = Object.keys(view.players || {}).filter((id) => id !== view.selfId && alive(view, id) && !mates.has(id))
    .map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [top, next] = ranked;
  if (top && top[1] >= TOWN_READS.ownRead && top[1] - (next?.[1] || 0) >= TOWN_READS.ownReadMargin) {
    const why = reasonPhrase(reads.reasons[top[0]]);
    if (why) out.push(`my read is ${nm(view, top[0])}, ${why}`);
    out.push(`my read is ${nm(view, top[0])}`);
  }
  // A tally is news once a wagon has formed (2+ votes on someone); "x 1" restated is filler.
  for (const line of publicFactLines(view)) {
    if (line === "no votes yet") continue;
    if (/^votes so far:/.test(line) && Math.max(...(line.match(/\d+/g) || ["0"]).map(Number)) < 2) continue;
    out.push(line);
  }
  return [...new Set(out)].filter((line) => lineOk(view, line));
}
