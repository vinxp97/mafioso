// Vinman 10/18 (11:05 AM ET): "ask for hammer". The revealed Sheriff (confirmed town by his gun) asks town to
// self-vote; once every other living player has self-voted, his vote is the deciding one (2 votes against 1s).
// He re-asks whoever has not; anyone who still refuses gets bandwagoned by the Sheriff and town. Town bots
// comply when the revealed Sheriff asks. Mafia usually comply too (refusing marks them).
// Self-votes are legal on the server (Vinman, 10/18). Pure: reads one seat's view.
import { revealedSheriff } from "./legal.js";
import { publicRecord, townReads } from "./townReads.js";
import { allies } from "./faction.js";
import { scumFaction } from "./scumPlan.js";
import { dayFraction } from "./sheriffGate.js";

export const HAMMER = Object.freeze({
  askAfterMs: 20_000, // into the day before the ask (claims and results come first)
  reaskAfterMs: 20_000, // after the ask, name whoever has not self-voted
  refuseAfterMs: 15_000, // after the re-ask, a player still not self-voted refused
  lateFraction: 0.85, // this late in the day the Sheriff stops waiting
  minLiving: 4,
  // Vinman 10/18 (11:47): the ask needs a real read: the best eligible read >= minRead and >= minMargin over the next.
  minRead: 6, // tuned on seeds 1-3 (gates 2|4|6 x margin 1|2): 6:1 best; a lynch-level read (TOWN_READS.strong)
  minMargin: 1,
});

/** The gate as configured: view.config.hammerGate "read:margin" overrides HAMMER (self-play tuning). */
function gateOf(view) {
  const g = String(view?.config?.hammerGate || "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return g ? { minRead: Number(g[1]), minMargin: Number(g[2]) } : { minRead: HAMMER.minRead, minMargin: HAMMER.minMargin };
}

/** Living players the Sheriff may hammer: not him, not a Cop or Journalist claimer, not verified town. */
function eligible(view, reads = townReads(view)) {
  const rec = publicRecord(view);
  return living(view).filter((id) => id !== view.selfId && !/^(Cop|Journalist)$/.test(rec.claims[id] || "") && !reads.verified.includes(id));
}

/**
 * The Sheriff's real read, or null: { target, read, next } when his best eligible read is >= minRead and
 * clears the next by minMargin (a Cop guilty or a Journalist report on a player lands there by its weight).
 */
export function hammerRead(view) {
  const reads = townReads(view);
  const ranked = eligible(view, reads).map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [top, next] = ranked;
  // Hard evidence: a living, uncontested Cop claimer's guilty, or a Journalist's Janitor / fake-Cop report, on an
  // eligible player who has not flipped (the strongest such read).
  const rec = reads.record;
  const ok = new Set(ranked.map(([id]) => id));
  const copOk = (by) => alive(view, by) && Object.entries(rec.claims).filter(([id, r]) => r === "Cop" && alive(view, id)).length === 1;
  const hard = ranked.find(([id]) => rec.guilty.some((x) => x.target === id && !x.relay && rec.claims[x.by] === "Cop" && copOk(x.by))
    || rec.reports.some((r) => r.target === id && (r.kind === "janitor" || r.kind === "fakecop") && alive(view, r.by)));
  if (hard && ok.has(hard[0]) && hard[1] > 0) return { target: hard[0], read: hard[1], next: next?.[1] || 0, why: `hard evidence: ${(reads.reasons[hard[0]] || []).join("; ")}` };
  const g = gateOf(view);
  if (!top || top[1] < g.minRead || top[1] - (next?.[1] || 0) < g.minMargin) return null;
  return { target: top[0], read: top[1], next: next?.[1] || 0, why: (reads.reasons[top[0]] || []).join("; ") };
}
export const HAMMER_ASK_RE = /\bself[- ]?vote\b|\bvote (?:your ?self|yourselves)\b|\bgive (?:me )?(?:the )?hammer\b/i;

const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const living = (view) => Object.keys(view?.players || {}).filter((id) => alive(view, id));
const nm = (view, id) => String(view?.players?.[id]?.name || id).toLowerCase();
const GUN = /^(?::gun:\s*)?(.+?) pulls a gun and shoots (?:at )?(.+?)!*$/i;
const villageOf = (view) => Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.voting) || null;
const voteOf = (m, id) => { const v = m?.votes?.[id]; return Array.isArray(v) ? v[0] ?? null : v ?? null; };
const todayLines = (view, by) => (view?.messages || []).filter((m) => m?.senderId === by && m.public !== false && (!m.phase || m.phase === view?.phase?.name));

/** The Sheriff who has shot (gun line or reveal) and is alive, from this seat's view; null otherwise. */
export function hammerSheriff(view) {
  if (/^sheriff$/i.test(String(view?.role || "")) && alive(view, view.selfId)) {
    const me = nm(view, view.selfId);
    const shot = (view.messages || []).some((m) => (!m?.senderId || m.senderId === "server") && GUN.exec(String(m.content || "").trim())?.[1]?.trim().toLowerCase() === me);
    return shot ? view.selfId : null;
  }
  return revealedSheriff(view);
}

/**
 * Today's hammer state, or null when the Sheriff has not asked:
 * { sheriffId, askAt, reaskAt, complied, pending, refusers, ready }.
 */
export function hammerState(view, { now = view?.clock } = {}) {
  if (view?.phase?.phase !== "Day") return null;
  const sheriffId = hammerSheriff(view);
  const m = villageOf(view);
  if (!sheriffId || !m) return null;
  const asks = todayLines(view, sheriffId).filter((x) => HAMMER_ASK_RE.test(String(x.content || "")));
  if (!asks.length) return null;
  const askAt = Number(asks[0].t);
  const reaskAt = asks.length > 1 ? Number(asks[asks.length - 1].t) : null;
  const others = living(view).filter((id) => id !== sheriffId);
  const complied = others.filter((id) => voteOf(m, id) === id);
  const pending = others.filter((id) => voteOf(m, id) !== id);
  const t = Number(now);
  const late = (dayFraction(view, { now }) ?? 0) >= HAMMER.lateFraction;
  const timedOut = reaskAt != null && Number.isFinite(t) && t - reaskAt >= HAMMER.refuseAfterMs;
  const refusers = late || timedOut ? pending : [];
  return { sheriffId, askAt, reaskAt, complied, pending, refusers, ready: pending.length === 0, late };
}

/** The Sheriff's hammer line due now ("everyone self-vote", then the re-ask by name), or null. */
export function hammerAskLine(view, { now = view?.clock } = {}) {
  if (view?.phase?.phase !== "Day" || view?.config?.hammer === "off") return null;
  if (hammerSheriff(view) !== view?.selfId || !villageOf(view) || living(view).length < HAMMER.minLiving) return null;
  const t = Number(now);
  const start = Number(view.phaseStartedAt);
  const st = hammerState(view, { now });
  if (!st) {
    if (Number.isFinite(start) && Number.isFinite(t) && t - start < HAMMER.askAfterMs) return null;
    // A 5-alive day with the Sheriff up must ask, even with no read. Larger days still need one.
    if (living(view).length !== 5 && !hammerRead(view)) return null;
    return "everyone self-vote, ill cast the deciding vote";
  }
  if (st.reaskAt == null && st.pending.length && Number.isFinite(t) && t - st.askAt >= HAMMER.reaskAfterMs) {
    return `${st.pending.map((id) => nm(view, id)).join(", ")} self-vote pls, i hammer last`.slice(0, 120);
  }
  return null;
}

/** Ms until the Sheriff's next hammer step (re-ask or refusal), for a timer; null when none is pending. */
export function hammerNextMs(view, { now = view?.clock } = {}) {
  const st = hammerState(view, { now });
  if (!st || hammerSheriff(view) !== view?.selfId || !st.pending.length) return null;
  const t = Number(now);
  const due = st.reaskAt == null ? st.askAt + HAMMER.reaskAfterMs : st.reaskAt + HAMMER.refuseAfterMs;
  return due > t ? due - t : null; // past the deadline: nothing left to wait for
}

/**
 * This seat's village vote under a hammer ask: { target, why } to vote, { hold: true, why } for the Sheriff
 * waiting on self-votes, or null when no hammer is on.
 * Sheriff: a refuser first (top read among them); once all have self-voted, his best read that is not a
 * Cop or Journalist claimer; late in the day, the same without waiting.
 * Town: self-vote; once the Sheriff votes a refuser, follow him. Mafia: comply (self-vote); join the
 * bandwagon on a refuser unless it is a teammate.
 */
export function hammerVote(view, { now = view?.clock } = {}) {
  if (view?.config?.hammer === "off") return null;
  const st = hammerState(view, { now });
  if (!st) return null;
  const m = villageOf(view);
  const me = view.selfId;
  if (st.sheriffId === me) {
    const reads = townReads(view);
    const rank = (ids) => ids.map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || null;
    if (st.refusers.length) return { target: rank(st.refusers), why: `hammer: ${nm(view, rank(st.refusers))} refused to self-vote` };
    if (!st.ready && !st.late) return { hold: true, why: `hammer: waiting on ${st.pending.length} self-vote(s)` };
    const pick = hammerRead(view)?.target || rank(eligible(view, reads)) || rank(living(view).filter((id) => id !== me));
    return pick ? { target: pick, why: `hammer: deciding vote, read ${reads.score[pick] || 0}` } : null;
  }
  const sv = voteOf(m, st.sheriffId);
  const onRefuser = sv && st.refusers.includes(sv) && sv !== me;
  if (scumFaction(view)) {
    if (onRefuser && !allies(view).has(sv)) return { target: sv, why: "hammer: join the Sheriff's bandwagon on a refuser" };
    return { target: me, why: "hammer: comply (self-vote is the safe answer)" };
  }
  if (onRefuser) return { target: sv, why: "hammer: follow the Sheriff onto a refuser" };
  return { target: me, why: "hammer: the revealed Sheriff asked for a self-vote" };
}
