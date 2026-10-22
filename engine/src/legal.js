import { planClaim } from "./adaptiveMafia.js";
import { copSecondLine, vtLeft } from "./claimLines.js";
import { sheriffShotCheck } from "./sheriffGate.js";
import { isPublicSpeechMeeting } from "./scheduler.js";
import { selfAlive } from "./reducer.js";
import { MAX_SPEECH, NO_ONE } from "./types.js";
import { PUBLIC_MAX, claimedRoleIn, earlyClaimBlock, repeatBlock, repeatedDefense } from "./chatStyle.js";
import { agreedPlan } from "./scumPlan.js";
import { normalizeText } from "./sanitize.js";
import { allies, myFaction } from "./faction.js";
import { chatAuditBlock } from "./chatAudit.js";
import { memoryOf } from "./notes.js";
import { publicRecord, townReads } from "./townReads.js";
import { hammerState } from "./hammer.js";
import { DAY1_LYNCH_OWED, METEOR_DAY, METEOR_NIGHT, NO_LYNCH_LOSES, dayOneLynchOwed, killOptional, lyloToday, meteorOn, noLynchLoses, townSeat } from "./lynchMath.js";

const canVoteIn = (m) => !!(m && m.voting && m.canVote && m.amMember);

// ---------------------------------------------------------------------------------------------------------------
// legalActions: the one source of truth for what a seat may vote. Three layers, kept apart:
//   server   what the Ultimafia server accepts (Games/core/Meeting.js vote(): member, voting, canVote,
//            canUpdateVote, selection in the meeting's targets). Targets are the ones the server offered in the
//            meeting frame; only when a frame has none are they derived from the meeting definitions below.
//   rule     Vinman's hard rules, refused by validateAction: never Vote Kick; no no-lynch into an autoloss
//            (town), on Day 1 while the Sheriff lives (town) or under a day meteor; the kill is owed under a night meteor or while a Cop/Journalist/
//            Sheriff claimer lives (killOptional); the Sheriff's gun waits for the shot rule (sheriffGate).
//   advice   server-legal and not refused, but no bot should pick it: a teammate as the kill (server-legal when
//            the kill meeting is anonymous or the teammate is not in it), a Loyal Lawyer litigating a non-teammate
//            (the server accepts the vote; Role.canTargetPlayer makes the action fizzle), and the Lawyer skipping.
// Flags (lylo, noLynchLoses, day1LynchOwed, meteor, killOptional) describe the phase for the strategy layers; they block nothing.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Frontier Justice core meetings as the server defines them (roles/cards/*.js, items/Gun.js, Meeting.js).
 * targets: include/exclude tags as in Meeting.parseTargetDefinitions; Meeting.js's default is alive minus members.
 * noOne: "*" is added unless the meeting is mustAct (FJ has no Must Act setting) or repeatable.
 */
export const MEETING_DEFS = Object.freeze({
  Village: { kind: "village", states: ["Day"], targets: { include: ["alive"], exclude: [] }, noOne: true }, // VillageCore canBeVoted: alive (self included)
  "Mafia Kill": { kind: "kill", states: ["Night"], targets: { include: ["alive"], exclude: ["membersIfOpen"] }, noOne: true }, // MeetingFaction
  Investigate: { kind: "investigate", states: ["Night"], targets: { include: ["alive"], exclude: ["members"] }, noOne: true }, // LearnAlignment (Cop)
  Save: { kind: "save", states: ["Night"], targets: { include: ["alive"], exclude: ["members"] }, noOne: true }, // NightSaver (Doctor, "House Call")
  "Receive Reports": { kind: "reports", states: ["Night"], targets: { include: ["alive"], exclude: ["self"] }, noOne: true }, // ReceiveReports (Journalist)
  Litigate: { kind: "litigate", states: ["Night"], targets: { include: ["alive"], exclude: ["dead", "self"] }, noOne: true }, // FlipAlignment (Lawyer)
  "Clean Death": { kind: "clean", states: ["Night"], boolean: true, once: true }, // CleanDeath (Janitor): Yes/No, until one clean lands
  "Shoot Gun": { kind: "gun", states: ["Day"], targets: { include: ["alive"], exclude: ["members"] }, noOne: true, once: true }, // items/Gun.js: instant, the gun drops when fired
  "Vote Kick": { kind: "votekick", states: ["Pregame", "Day", "Night"], kick: true },
});

// Older or test views name a role's meeting after the role or the action.
const DEF_ALIASES = { Cop: "Investigate", Doctor: "Save", "House Call": "Save", Journalist: "Receive Reports", Lawyer: "Litigate", Janitor: "Clean Death", Sheriff: "Shoot Gun", Shoot: "Shoot Gun" };
const defName = (m) => [m?.rawName, m?.name, m?.actionName].map((x) => String(x || "")).map((x) => (MEETING_DEFS[x] ? x : DEF_ALIASES[x])).find(Boolean) || null;
const KILL_NAME = /^(mafia|cult)( kill)?$/i;
/** The kind of a meeting in this view: village, kill, investigate, save, reports, litigate, clean, gun, votekick, faction-action, other. */
export function meetingKind(m) {
  if (!m) return null;
  const name = String(m.rawName || m.name || "");
  if (/vote\s*kick/i.test(name) || ((m.targets || []).length === 1 && /^kick$/i.test(String(m.targets[0])))) return "votekick";
  if (m.factionRole === "kill" || (m.factionRole !== "action" && m.factionRole !== "chat" && KILL_NAME.test(name)) || (m.name && KILL_NAME.test(m.name) && m.voting && m.factionRole !== "action")) return "kill";
  if (m.factionRole === "action") return "faction-action";
  if (/\b(shoot|gun)\b/i.test(`${name} ${m.actionName || ""}`)) return "gun";
  return MEETING_DEFS[defName(m)]?.kind || "other";
}

const livingIds = (view) => Object.keys(view?.players || {}).filter((id) => !view.players[id]?.left && !view.dead?.[id]);

/** Targets from the meeting definition, for a frame that carried none. */
export function derivedTargets(view, m) {
  const def = meetingKind(m) === "kill" ? MEETING_DEFS["Mafia Kill"] : MEETING_DEFS[defName(m)];
  if (!def) return [];
  if (def.kick) return ["Kick"];
  if (def.boolean) return ["Yes", "No"];
  const members = new Set((m.members || []).map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean));
  if (!members.size && view?.selfId) members.add(view.selfId);
  const ex = new Set(def.targets.exclude);
  const ids = livingIds(view).filter((id) => !(ex.has("self") && id === view.selfId) && !(ex.has("members") && members.has(id)) && !(ex.has("membersIfOpen") && !m.anonymous && members.has(id)));
  return def.noOne ? [...ids, NO_ONE] : ids;
}

const voteOf = (m, seat) => {
  const v = m?.votes?.[seat];
  return v == null || (Array.isArray(v) && !v.length) ? null : v;
};

/** Phase facts for one meeting, computed on first use (validateAction checks one selection at a time). */
function context(view, m, kind) {
  const memo = {};
  const once = (k, f) => (k in memo ? memo[k] : (memo[k] = f()));
  return {
    kind, view,
    get town() { return once("town", () => townSeat(view)); },
    get meteor() { return once("meteor", () => meteorOn(view)); },
    get noLynchLoses() { return once("nll", () => this.town && noLynchLoses(view)); },
    get day1Owed() { return once("d1", () => this.town && dayOneLynchOwed(view)); },
    get killOptional() { return once("ko", () => killOptional(view)); },
    get mates() { return once("mates", () => allies(view)); },
    // Vinman 10/18: nobody lynches the Sheriff once the gun has revealed him (town: hard rule; mafia: never vote him).
    get sheriff() { return once("sheriff", () => revealedSheriff(view)); },
    // L6 (10/18): town never lynches a living, uncounterclaimed Cop or Journalist claimer without hard evidence.
    get trustedClaimers() { return once("tc", () => (this.town ? trustedClaimers(view) : new Set())); },
    // Vinman 10/18 (11:05): the Cop never checks the sole, uncontested claimer of a unique role.
    get soleClaimers() { return once("sole", () => soleClaimers(view)); },
    get hammer() { return once("hammer", () => !!hammerState(view)); },
    get loyal() { return once("loyal", () => String(view?.config?.lawyer || "loyal") === "loyal"); },
    // The Sheriff rule depends on the selection (the ready target, the asked seat's answer, the vote leader):
    // one check per option. Keyed once for all players, it judged every target by the first one (L8 replay:
    // the asked Villager was refused because the first player in the list was unasked).
    gun: (sel) => once(`gun:${sel}`, () => sheriffShotCheck(view, { event: "vote", data: { meetingId: m.id, selection: sel } })),
  };
}

/** The rule or advice note on one option, or null (see the layers above). */
function noteFor(c, sel, view = c.view) {
  switch (c.kind) {
    case "votekick": return { tier: "rule", reason: "never vote kick" };
    case "gun": { const g = c.gun(sel); return g.ok ? null : { tier: "rule", reason: g.reason }; }
    case "village":
      // A self-vote is legal on the server (Vinman 10/18) but only makes sense for the Sheriff's hammer ask.
      if (sel === view.selfId) return c.hammer ? null : { tier: "advice", reason: "self-vote: only for the Sheriff's hammer ask" };
      if (sel !== NO_ONE) return sel === c.sheriff ? { tier: "rule", reason: NEVER_LYNCH_SHERIFF } : c.trustedClaimers.has(sel) ? { tier: "rule", reason: NEVER_LYNCH_CLAIMER } : null;
      if (c.noLynchLoses) return { tier: "rule", reason: NO_LYNCH_LOSES };
      if (c.day1Owed) return { tier: "rule", reason: DAY1_LYNCH_OWED };
      return c.meteor === "Day" ? { tier: "rule", reason: METEOR_DAY } : null;
    case "kill":
      if (sel === NO_ONE) return c.meteor === "Night" ? { tier: "rule", reason: METEOR_NIGHT } : c.killOptional ? null : { tier: "rule", reason: KILL_OWED };
      return c.mates.has(sel) ? { tier: "advice", reason: "a teammate" } : null;
    case "investigate":
      return sel !== NO_ONE && sel !== view.selfId && c.soleClaimers.has(sel) ? { tier: "rule", reason: COP_SKIPS_SOLE_CLAIMER } : null;
    case "litigate":
      if (sel === NO_ONE) return { tier: "advice", reason: "the Lawyer always litigates a teammate" };
      return c.loyal && !c.mates.has(sel) ? { tier: "advice", reason: "a Loyal Lawyer only litigates teammates" } : null;
    default: return null;
  }
}

function closedReason(view, m, myVote) {
  if (!selfAlive(view)) return "dead seat";
  if (!canVoteIn(m)) return "cannot vote in meeting";
  if (m.used) return "instant meeting already used";
  if (myVote != null && !m.multi && m.canUpdateVote === false) return "vote locked";
  return null;
}

/** One meeting's legal votes for this seat (see the layers above). */
export function meetingActions(view, m) {
  const kind = meetingKind(m);
  const myVote = voteOf(m, view.selfId);
  const entry = { meetingId: m.id, name: m.name, kind, myVote, server: [], allowed: [], picks: [], notes: {}, closed: closedReason(view, m, myVote), flags: {} };
  // The lists describe the meeting's options even when this seat can't cast now (closed says why).
  entry.server = Array.isArray(m.targets) ? m.targets.map(String) : derivedTargets(view, m);
  // The server takes a self-vote in the village meeting (Vinman 10/18) even when the frame's list omits it.
  if (kind === "village" && view?.selfId && selfAlive(view) && !entry.server.includes(view.selfId)) entry.server = [...entry.server, view.selfId];
  const c = context(view, m, kind);
  if (kind === "village") entry.flags = { lylo: c.town && lyloToday(view), noLynchLoses: c.noLynchLoses, day1LynchOwed: c.day1Owed, meteor: c.meteor === "Day" };
  if (kind === "kill") entry.flags = { meteor: c.meteor === "Night", killOptional: c.killOptional };
  for (const sel of entry.server) {
    const note = noteFor(c, sel);
    if (note) entry.notes[sel] = note;
    if (note?.tier !== "rule") entry.allowed.push(sel);
    if (!note) entry.picks.push(sel);
  }
  return entry;
}

export const COP_SKIPS_SOLE_CLAIMER = "the Cop never checks the sole uncontested claimer of a role";
const SOLE_ROLES = new Set(["Cop", "Journalist", "Sheriff", "Doctor"]);
/**
 * Living players the Cop must not check: the only living claimer of a unique role, when nobody flipped that
 * role and every other claimer is gone by a day lynch (a counterclaim that was lynched confirms the survivor).
 * A night kill does not confirm them. A dead player who flipped the role means the survivor is the fake.
 */
export function soleClaimers(view) {
  const claims = publicRecord(view).claims || {};
  const by = {};
  for (const [id, r] of Object.entries(claims)) if (SOLE_ROLES.has(r) && id !== view?.selfId) (by[r] ||= []).push(id);
  const mem = memoryOf(view);
  const dayLynched = (id) => {
    const ph = (mem.deaths || []).find((d) => d.id === id)?.phase;
    return !!(ph && /^day/i.test(String(ph)) && (mem.votes || []).some((v) => v.phase === ph && v.target === id));
  };
  const out = new Set();
  for (const [role, list] of Object.entries(by)) {
    const flipped = Object.entries(view?.reveals || {}).some(([id, a]) => view?.dead?.[id] && String(a).split(/:| \(/)[0] === role);
    // I hold the role myself: his claim is contested (a rival Cop claimer is a fake).
    const mine = String(view?.role || "").toLowerCase() === role.toLowerCase();
    if (mine || flipped) continue;
    const living = list.filter((id) => view?.players?.[id] && !view.dead?.[id]);
    if (living.length !== 1) continue;
    const others = list.filter((id) => id !== living[0]);
    if (others.length === 0 || others.every((id) => view.dead?.[id] && dayLynched(id))) out.add(living[0]);
  }
  return out;
}
export const NEVER_LYNCH_SHERIFF = "never lynch the revealed Sheriff";
export const NEVER_LYNCH_CLAIMER = "never lynch an uncounterclaimed Cop or Journalist claimer without hard evidence";

// Hard evidence against a power claimer: a rival claim, a flip, a Journalist report, a proven lie.
const HARD_EVIDENCE = /flipped|^Journalist: (?:Cop claim got no report|rival Journalist|Janitor)|other Cop claim vs a confirmed Cop|called me guilty|one of \d+ (?:Cop|Journalist) claimers/;
/**
 * Living Cop / Journalist claimers no one counterclaimed and nothing hard stands against (L6, 10/18: a sole Cop
 * claimer was lynched Day 1 on a 1.5 read, one mafia "liar" call). Like the revealed Sheriff, off the table
 * for town votes.
 */
export function trustedClaimers(view) {
  const out = new Set();
  const reads = townReads(view);
  for (const [id, role] of Object.entries(reads.record?.claims || {})) {
    if (role !== "Cop" && role !== "Journalist") continue;
    if (id === view?.selfId || !view?.players?.[id] || view.players[id].left || view.dead?.[id]) continue;
    if ((reads.contested?.[role] || []).includes(id)) continue;
    if (String(view?.role || "") === role) continue; // I hold that role: the claim is a lie
    if ((reads.reasons?.[id] || []).some((w) => HARD_EVIDENCE.test(w))) continue;
    out.add(id);
  }
  return out;
}

/** The living player the server revealed as Sheriff (the gun announces him), or null. */
export function revealedSheriff(view) {
  for (const [id, a] of Object.entries(view?.reveals || {})) {
    if (String(a || "").split(/[ :(]/)[0] !== "Sheriff") continue;
    if (view.players?.[id] && !view.players[id].left && !view.dead?.[id]) return id;
  }
  return null;
}

export const KILL_OWED = "kill owed: a Cop, Journalist or Sheriff claimer is alive";

/**
 * Every vote this seat may cast, per voting meeting it sits in: server (the options the server accepts),
 * allowed (server minus Vinman's hard rules: what validateAction passes), picks (allowed minus advice), with each
 * refusal's tier and reason in notes, and the phase flags. closed (dead seat, cannot vote, vote locked) means the
 * seat can cast none of them now. A view is one seat's: another seat's meetings are not visible here.
 */
export function legalActions(view, seat = view?.selfId) {
  if (!view?.selfId || seat !== view.selfId) return { seat, meetings: [] };
  return { seat, meetings: Object.values(view.meetings || {}).filter((m) => m?.voting && m.amMember).map((m) => meetingActions(view, m)) };
}

/** @returns {{meetingId:string, name:string, targets:string[], myVote:any}[]} votable meetings, targets that validateAction passes. */
export function legalVotes(view) {
  return legalActions(view).meetings.filter((e) => !e.closed).map((e) => ({ meetingId: e.meetingId, name: e.name, targets: [...e.allowed], myVote: e.myVote }));
}

/** Does the server accept this vote (ignoring Vinman's rules)? */
export function serverAccepts(view, action) {
  const m = view?.meetings?.[action?.data?.meetingId];
  if (!m || action?.event !== "vote") return false;
  const e = meetingActions(view, m);
  return !e.closed && e.server.includes(String(action.data.selection));
}

/** @returns {{ok:true}|{ok:false, reason:string}} */
export function validateAction(view, action) {
  const no = (reason) => ({ ok: false, reason });
  if (!action || typeof action.data !== "object" || action.data === null) return no("malformed");
  if ((action.event === "vote" || action.event === "speak") && !selfAlive(view)) return no("dead seat");
  // Hard ban on EVERY meeting (public, Mafia, Lawyer, anything): no PLAN syntax, key=value or raw ids.
  if (action.event === "speak") {
    const machine = machineLeak(view, action.data?.content);
    if (machine) return no(`machine text: ${machine}`);
  }
  // Prompt text and the rest of the public checks only apply to public chat.
  if (action.event === "speak" && view.meetings?.[action.data?.meetingId] && isPublicSpeechMeeting(view.meetings[action.data.meetingId])) {
    const leak = publicLeak(view, action.data?.content);
    if (leak) return no(`public leak: ${leak}`);
    if (String(action.data?.content || "").length > PUBLIC_MAX) return no("too long for chat");
    const claim = earlyClaimBlock(view, action.data?.content, planClaim(view));
    if (claim) return no(claim);
    // Night 5: one Cop line per seat per day; no vt left after the wording repair (claimLines.js).
    const split = copSecondLine(view, action.data?.content);
    if (split) return no(split);
    const vt = vtLeft(view, action.data?.content);
    if (vt) return no(`town claim wording: says "${vt}" (villager or blue only)`);
    // A role claim is information, not chatter: a real Cop answering a fake Cop's identical line must go out.
    const again = claimedRoleIn(action.data?.content) ? repeatedDefense(view, action.data?.content) : repeatBlock(view, action.data.meetingId, action.data?.content);
    if (again) return no(again);
    // Grounding: every stated fact matches engine state; no hidden info (chatAudit.js).
    const audit = chatAuditBlock(view, action.data?.content);
    if (audit) return no(audit);
  }
  const m = view.meetings?.[action.data.meetingId];
  if (!m) return no("unknown meeting");
  switch (action.event) {
    case "vote": {
      const sel = String(action.data.selection);
      const kind = meetingKind(m);
      const c = context(view, m, kind);
      // Bots never kick (Vote Kick ejects players who have not acted, often our own teammate).
      if (kind === "votekick") return no("never vote kick");
      if (kind === "gun") { const g = c.gun(sel); if (!g.ok) return no(g.reason); }
      const closed = closedReason(view, m, voteOf(m, view.selfId));
      if (closed) return no(closed);
      const server = Array.isArray(m.targets) ? m.targets.map(String) : derivedTargets(view, m);
      if (!server.includes(sel)) return no("selection not in targets");
      const note = noteFor(c, sel);
      if (note?.tier === "rule") return no(note.reason);
      return { ok: true };
    }
    case "unvote":
      if (!canVoteIn(m)) return no("cannot vote in meeting");
      if (m.noUnvote) return no("unvote not allowed");
      return { ok: true };
    case "speak": {
      if (!m.speech || !m.amMember) return no("cannot speak in meeting");
      const c = action.data.content;
      if (typeof c !== "string" || !c.trim()) return no("empty content");
      if (c.length > MAX_SPEECH) return no("content too long");
      return { ok: true };
    }
    default: return no("unsupported event");
  }
}

const MACHINE_RE = /\bPLAN\b|\b[A-Za-z_]{2,}\s*=\s*\S|\b(kill|lynch|condemn|claim|lawyer|janitor|speaker)\s*:\s*\S/;
/** Coordination syntax or a raw player id: never allowed in any chat. Checked on normalized text (zero-width, full-width). */
export function machineLeak(view, content) {
  const raw = String(content || "");
  if (/\p{Cf}/u.test(raw)) return "invisible characters";
  const text = normalizeText(raw);
  const m = text.match(MACHINE_RE);
  if (m) return `contains "${m[0]}"`;
  for (const id of Object.keys(view?.players || {})) if (id.length >= 4 && text.includes(id)) return "contains a player id";
  return null;
}

const LEAK_RE = /\bPLAN\b|\b(kill|lynch|condemn|claim|lawyer|speaker)=|\bsystem\b|\bprompt\b|\binstructions?\b/i;
const ADMIT_RE = /\b(i'?m|i am|im|we'?re|we are|me)\s+(the\s+|a\s+|also\s+)?(mafia|maf|scum|mafioso)\b/i;
// Naming a teammate AS team ("my team is X", "X is my partner", "me and X") is blocked; accusing one ("X is scum") is a bus and allowed.
const TEAM_RE = /\b(my|our)\s+(team|teammates?|partners?|buddy|buddies|mafia|maf|scum|crew)\b/i;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reason a public line must not go out, or null. */
export function publicLeak(view, content) {
  const text = normalizeText(content);
  const m = text.match(LEAK_RE);
  if (m) return `contains "${m[0]}"`;
  // Scum seats: never admit the faction or name a teammate as team in public (hostile "type your teammates" bait).
  if (view?.selfId && /^(mafia|cult)$/i.test(String(myFaction(view) || ""))) {
    if (ADMIT_RE.test(text)) return "admits faction";
    for (const id of allies(view)) {
      const name = view.players?.[id]?.name;
      if (id === view.selfId || !name) continue;
      const n = escRe(name);
      if (TEAM_RE.test(text) && new RegExp(`(^|[^a-z0-9_])${n}([^a-z0-9_]|$)`, "i").test(text)) return "names a teammate";
      if (new RegExp(`\\b(me|i)\\s+(and|&|n)\\s+${n}\\b|\\b${n}\\s+(and|&|n)\\s+(me|i)\\b|\\b${n}\\b[^.!?]*\\b(we|us)\\s+(are|were)\\b`, "i").test(text)) return "pairs self with a teammate";
    }
  }
  for (const id of Object.keys(view?.players || {})) {
    if (id.length >= 4 && text.includes(id)) return "contains a player id";
  }
  return null;
}
