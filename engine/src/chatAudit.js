// chatAudit: is a public line grounded in what this seat knows? Pure: reads the speaker's own view.
// Every assertion a line makes is checked against engine state (reveals, deaths, votes, the public record from
// townReads, this seat's notes); opinions (accusations, "vote x", bussing a teammate) are not assertions.
//   LEAK           hidden info the speaker must not say or cannot have: PLAN syntax / ids / faction admissions
//                  (publicLeak), seat-id fragments (id-prefix nicknames, ids cut at the chat limit), a town seat naming an unflipped player's role it has no source for, a night
//                  result this seat never received, a scum seat naming a teammate's real role.
//   CONTRADICTION  a public fact stated wrong: a flip, a death, a vote, a vote count, a claim, a result that
//                  differs from the one received, a reply to an accusation nobody made.
//   SCUM_MISTAKE   a scum fake claim or fake result that public facts already disprove (a role that flipped
//                  elsewhere, a guilty on a revealed townie). Fakes that fit the public facts pass: deception.
import { claimedRoleIn, earlyClaimBlock, roleClaimLine } from "./chatStyle.js";
import { repairSpentGunThreat, sheriffGunSpent, SPENT_GUN_THREAT } from "./sheriffGate.js";
import { alignmentOf, allies } from "./faction.js";
import { machineLeak, publicLeak, revealedSheriff } from "./legal.js";
import { JANITOR_REPORT, memoryOf } from "./notes.js";
import { scumFaction } from "./scumPlan.js";
import { townCounterLine, townReads } from "./townReads.js";
import { sheriffSeat } from "./sheriffAsk.js";

export const AUDIT_KINDS = Object.freeze(["LEAK", "CONTRADICTION", "SCUM_MISTAKE"]);
const ROLES = { cop: "Cop", journalist: "Journalist", sheriff: "Sheriff", doctor: "Doctor", villager: "Villager", janitor: "Janitor", lawyer: "Lawyer", mafioso: "Mafioso" };
const UNIQUE = new Set(["Cop", "Journalist", "Sheriff"]);
const ROLE = Object.keys(ROLES).join("|");
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const roleOf = (appearance) => (appearance ? String(appearance).split(/:| \(/)[0] : null);
const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];
const GUILTY_RESULT = /mafia|guilty|cult|scum/i;
const INVESTIGATOR_LINE = /\b(?:i'?m|i am)\s+(?:the\s+real\s+)?(cop|journalist)\b|\bresults?:|\bmy (?:check|report)s?\b|\b(?:i )?(?:checked|investigated|looked)\b|\bjournalist:|\bno reports? on\b/i;

const GUN_SHOT_LINE = /^(?::gun:\s*)?(.+?) pulls a gun and shoots (?:at )?(.+?)!*$/i;
const SHERIFF_ACCUSE = /\b(sus|sussy|suspicious|scum|scummy|mafia|maf|fake|faking|lying|liar|lies|guilty|shady|sketchy|red|evil)\b/;
const SHERIFF_DEFEND = /\b(not|isn'?t|isnt|never|don'?t|dont|no)\s+(?:\w+\s+)?(sus|sussy|suspicious|scum|scummy|mafia|maf|fake|lying|guilty|vote|voting|lynch|hang)\b|\b(town|confirmed|cleared|trust)\b/;
// Doubt about a claim ("sheriff claim is weak", "s8 claim feels weak", "pure bs", "not buying it").
const DEAD_SUS = /\b(sus|sussy|suspicious|sketchy|shady|scummy|is scum|is mafia|lynch|vote)\b/;
const CLAIM_DOUBT = /\b(weak|bs|bogus|flimsy|shaky|fishy|questionable|doubt|doubtful|dubious|made up|not buying|don'?t buy|dont buy|doesn'?t (?:hold|add up)|not real|fake claim|(?:don'?t|dont|cant|can'?t) (?:trust|believe))\b/;
// L4: attacks on the revealed Sheriff ("he's a wolf", "blind wolf", "why would you trust him").
const SHERIFF_ATTACK = /(?:\b(?:is|are|r|re|s|seems?|looks?|feels?|sounds?|acting|being|ur|youre|you'?re|he'?s|hes|she'?s|shes|ya|yer)\s+(?:(?:so|kinda|pretty|prob|probably|def|definitely|totally|super|such|clearly|obviously|actually|the|a|an|blind|real|fake)\s+)*(?:wolf|wolfy|scum|scummy|mafia|maf|mafioso|sus|sussy|suspicious|faking|lying|liar|shady|sketchy|evil)\b)|\bblind wolf\b|\bred flag\b|\bwhy (?:would|should|do|does) (?:we|you|i|anyone|u) (?:trust|believe|listen to)\b/;
const SHERIFF_TRUST_Q = /\bwhy (?:would|should|do|does) (?:we|you|i|anyone|u) (?:trust|believe|listen to)\b/g;
// Holding his shot of a villager against him: "shot a villager, why...", "why did you shoot a villager".
const SHERIFF_CHARGE = /\b(?:shot|shoot|shooting|shoots)\s+(?:a\s+|an\s+|the\s+)?(?:villager|vt|townie|town|innocent)\b.*\b(?:why|trust|wolf|sus|scum|mafia|red flag|then|lol|lmao|blind)\b|\bwhy (?:did|would) (?:you|he|she|u) shoot\b|\b(?:botched|bad|blind) shot\b/;
// L5: "is x really the sheriff or a fake?"
const SHERIFF_DOUBT = /\b(?:really|actually|truly)\s+(?:the\s+|a\s+)?sheriff\b|\bor\s+(?:a\s+|just\s+a\s+)?(?:fake|faker|liar|bluff)\b|\bfake\s+sheriff\b|\bsheriff\s+(?:claim\s+)?(?:is\s+)?(?:fake|a bluff|bluffing)\b/;
const CLAIM_TRUST = /(?<!(?:n'?t|not|dont) )\b(solid|legit|confirmed|trust|true|believe)\b(?![^.]*\b(?:weak|bs|doubt)\b)|\bnot (?:weak|bs|fake)\b/;
const FLIP_TALK = /\b(flip|flipped|flips|flipping|revealed|turned up as)\b|'s (?:flip|role) was/;
const NO_FLIP = /\b(no|didn'?t|didnt|never|without|wont|won'?t|cant|can'?t)\s+(?:\w+\s+)?(flip|flipped|reveal|revealed)\b|\bcleaned\b|\bno flip\b/;
const STOP = new Set(["the", "and", "you", "was", "were", "are", "for", "that", "this", "with", "his", "her", "she", "him", "they", "them", "its", "not", "but", "just", "said", "says", "lol", "like", "about", "what", "who", "why", "how", "she's", "he's", "has", "have", "had", "did", "does", "will", "would", "can", "could", "out", "all"]);
/** Lower-case content words (3+ letters, no stopwords). */
function contentWords(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}
/** A quote matches when this share of its content words are in one line the quoted player said. */
export const QUOTE_MATCH = 0.6;
function namesIn(seg, lex) {
  return [...String(seg).matchAll(new RegExp(lex.N, "gi"))].map((m) => m[1]);
}

/** Players by lower-case name, longest first, plus "me"/"i" for the speaker. */
const NICK_STOP = new Set(["that", "this", "they", "them", "what", "when", "will", "just", "like", "vote", "town", "mafia", "cop", "lol", "same", "sure", "real", "fake", "last", "good", "nice", "kind", "rose", "mark", "hope", "lynch"]);
/** Short names players use for a handle: "ReedKorbin18" -> reedkorbin, reed; only when unique at the table. */
export function nicknamesOf(name) {
  const n = String(name || "");
  const out = new Set();
  const noDigits = n.replace(/[0-9_]+$/, "");
  if (noDigits.length >= 4 && noDigits !== n) out.add(noDigits.toLowerCase());
  const first = (n.match(/^[A-Z]?[a-z]+/) || [""])[0];
  if (first.length >= 4 && first.length < noDigits.length) out.add(first.toLowerCase());
  return [...out].filter((x) => !NICK_STOP.has(x));
}
function lexicon(view) {
  const byName = {};
  for (const [id, p] of Object.entries(view?.players || {})) if (String(p?.name || "").length >= 2) byName[String(p.name).toLowerCase()] = id;
  const nickCount = {};
  const nicks = Object.entries(view?.players || {}).flatMap(([id, p]) => nicknamesOf(p?.name).map((k) => [k, id]));
  for (const [k] of nicks) nickCount[k] = (nickCount[k] || 0) + 1;
  for (const [k, id] of nicks) if (nickCount[k] === 1 && !(k in byName)) byName[k] = id;
  const names = Object.keys(byName).sort((a, b) => b.length - a.length).map(esc);
  if (!names.length) return null;
  return { byName, N: `(?<![a-z0-9_])(${names.join("|")})(?![a-z0-9_])` };
}

/** Village votes per voter as this seat saw them (memory), plus the open meeting's standing votes. */
function voteFacts(view) {
  const mem = memoryOf(view);
  const today = view?.phase?.name || "";
  const village = Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.voting);
  const standing = {};
  for (const [v, t] of Object.entries(village?.votes || {})) { const x = Array.isArray(t) ? t[0] : t; if (x != null) standing[v] = String(x); }
  const ever = (mem.votes || []).filter((v) => /^day/i.test(String(v.phase || "")));
  const tally = {};
  for (const t of Object.values(standing)) if (t !== "*") tally[t] = (tally[t] || 0) + 1;
  return { standing, tally, ever, today: ever.filter((v) => v.phase === today) };
}

/**
 * @returns {{kind:"LEAK"|"CONTRADICTION"|"SCUM_MISTAKE", rule:string, detail:string}[]} empty when grounded.
 */
export function chatAudit(view, content) {
  const flags = [];
  const flag = (kind, rule, detail) => flags.push({ kind, rule, detail });
  const raw = String(content || "");
  const leak = machineLeak(view, raw) || publicLeak(view, raw);
  if (leak) flag("LEAK", "public-leak", leak);
  // L5 (10/18): template placeholders ("Target claim your role immediately.", "<name>", "{target}").
  const ph = /<\s*(?:name|player|target|seat|role)\s*>|\{\s*(?:name|player|target|seat|role)\s*\}|\[\s*(?:name|player|target|seat)\s*\]|^\s*(?:target|player|name)\b[\s,:]+(?!is\b|was\b)|(?<![A-Za-z0-9_])(?:Target|Player|PLAYER|TARGET|NAME)(?![A-Za-z0-9_])/.exec(raw);
  if (ph) flag("LEAK", "placeholder", `template placeholder "${ph[0].trim()}"`);
  // Seat-id fragments (g05): a nickname made from an id prefix, or an id cut off at the chat limit.
  const ids = Object.keys(view?.players || {}).filter((id) => id.length >= 6);
  for (const [tok] of raw.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g)) {
    const id = ids.find((x) => x !== tok && x.startsWith(tok));
    if (id) { flag("LEAK", "id-fragment", `"${tok}" is the start of a seat id`); break; }
  }
  const lex = lexicon(view);
  if (!lex || !view?.selfId) return flags;
  const text = raw.toLowerCase();
  const { N, byName } = lex;
  const idOf = (name) => (/^(me|i)$/.test(name) ? view.selfId : byName[name]);
  const nm = (id) => String(view.players?.[id]?.name || id).toLowerCase();
  const scum = !!scumFaction(view);
  const mates = allies(view);
  const mem = memoryOf(view);
  let record = null;
  const recOf = () => (record ||= townReads(view).record);
  const myRole = ROLES[String(view.role || "").toLowerCase()] || null;
  // Public flips only: a scum view also holds its living teammates' roles as reveals (the harness roster).
  const flipped = (id) => (mates.has(id) && alive(view, id) ? null : roleOf(view.reveals?.[id]));
  const claimOf = (id) => {
    const c = view.claims?.[id];
    const said = (view.messages || []).filter((m) => m?.senderId === id && m.public !== false).map((m) => ROLES[claimedRoleIn(m.content)]).filter(Boolean);
    return new Set([recOf().claims[id], c && c.kind !== "retract" ? ROLES[String(c.role || "").toLowerCase()] : null, ...said].filter(Boolean));
  };
  const votes = voteFacts(view);
  const shotIds = new Set();
  const shots = [];
  for (const m of view.messages || []) {
    if (m?.senderId && m.senderId !== "server") continue;
    const hit = GUN_SHOT_LINE.exec(String(m?.content || "").trim());
    const at = hit && Object.keys(view.players || {}).find((id) => String(view.players[id]?.name || "").toLowerCase() === hit[2].trim().toLowerCase());
    if (at) shotIds.add(at);
    const by = hit && Object.keys(view.players || {}).find((id) => String(view.players[id]?.name || "").toLowerCase() === hit[1].trim().toLowerCase());
    if (at) shots.push({ by, at });
  }
  const each = (re, fn) => { for (const m of text.matchAll(new RegExp(re, "gi"))) fn(m); };
  // config.auditTight "on" (10/19, off by default): extra held-out phrasings; tighten only.
  const tight = view.config?.auditTight === "on";

  // Talking about myself by my own handle ("vote saga instead" from Saga, "riley's lawyer" from Riley).
  for (const m of text.matchAll(new RegExp(N, "gi"))) {
    if (byName[m[1]] === view.selfId && !/^(me|i|my)$/.test(m[1])) { flag("CONTRADICTION", "self-third-person", `refers to itself as ${m[1]}`); break; }
  }

  // Own role claim: a unique role that a dead player already flipped; a scum seat outing its real mafia role.
  const claimed = ROLES[claimedRoleIn(raw.replace(/\b(?:died|flipped|revealed|lynched|killed|shot)\s+as\b/gi, " "))];
  if (claimed) {
    const holder = Object.keys(view.reveals || {}).find((id) => id !== view.selfId && !alive(view, id) && flipped(id) === claimed);
    if (UNIQUE.has(claimed) && holder) flag(scum ? "SCUM_MISTAKE" : "CONTRADICTION", "claims-flipped-role", `claims ${claimed}, but ${nm(holder)} flipped ${claimed}`);
    if (scum && alignmentOf(claimed) === "Mafia") flag("LEAK", "admits-mafia-role", `says it is the ${claimed}`);
  }

  // Scum admitting the side in other words, or putting a teammate on its side.
  if (scum && /\b(?:on|in) the (?:mafia|scum) (?:team|side)\b|\bus (?:mafia|scum)\b|\b(?:as|being) (?:the )?(?:mafia|scum)\b|\bwe(?:'re| are) (?:the )?(?:mafia|scum)\b|\b(?:i'?m|i am|im)\s+(?:(?:one|part) of\s+|with\s+)?(?:the\s+)?(?:mafia|scum)\b|\b(?:mafia|scum)(?: team| side)?,? (?:here|checking in|reporting)\b/.test(text)) flag("LEAK", "faction-admit", "admits the mafia side");
  if (tight && scum && !flags.some((f) => f.rule === "faction-admit") && /\b(?:mafia|scum) speaking\b|\byou got me\b[^.;!?]*\b(?:mafia|scum)\b|\b(?:mafia|scum)\b[^.;!?]*\byou got me\b|\bpart of the (?:mafia|scum)\b|\b(?:mafia|scum) (?:here|checking in)\b/.test(text)) flag("LEAK", "faction-admit", "admits the mafia side");
  for (const id of mates) {
    const n = esc(nm(id));
    if (new RegExp(`(?<![a-z0-9_])${n}(?:\\s+is|'s)\\s+(?:with me|on my (?:side|team)|one of us)\\b`).test(text)
      || (new RegExp(`(?<![a-z0-9_])${n}(?![a-z0-9_])`).test(text) && /\bsame (?:team|side)\b|\bfellow (?:mafia|mafioso|scum)\b|\b(?:mafia|scum) (?:buddy|partner|teammate|pal)\b|\bboth (?:mafia|scum)\b/.test(text))) { flag("LEAK", "partner-name", `puts teammate ${nm(id)} on its side`); break; }
  }

  // Flips and deaths.
  const flipSaid = (m) => {
    const id = idOf(m[1]); const said = m[2];
    if (!id || id === view.selfId) return;
    const shown = flipped(id);
    // "loyal" is a modifier, not a role: right only if the flip itself says Loyal.
    const loyalOk = said === "loyal" && /loyal/i.test(String(view.reveals?.[id] || ""));
    const wrong = alive(view, id) ? "is alive" : !shown ? "was cleaned (no flip)"
      : said === "loyal" ? (loyalOk ? null : `flipped ${shown}`)
      : ROLES[said] ? (ROLES[said] !== shown ? `flipped ${shown}` : null)
        : ((said === "town") !== (alignmentOf(shown) === "Village") ? `flipped ${shown}` : null);
    if (wrong) flag("CONTRADICTION", "flip", `${nm(id)} ${said}? ${nm(id)} ${wrong}`);
  };
  each(`${N}(?:\\s+(?:(?:already\\s+)?flipped(?:\\s+as)?|turned up|was revealed as|revealed(?:\\s+as)?|died as|was(?:\\s+(?:a|the))?)|'s (?:flip|role) was)\\s+(?:a\\s+|the\\s+)?(${ROLE}|loyal|town|mafia|scum)\\b`, flipSaid);
  // config.auditTight "on" (10/19, off by default; tighten only): held-out flip phrasings.
  if (tight) each(`${N}\\s+(?:showed|came up|ended up(?:\\s+being)?|was (?:lynched|killed|shot|hanged) as|got lynched as|flipped up)\\s+(?:a\\s+|the\\s+)?(${ROLE}|town|mafia|scum)\\b`, flipSaid);
  // "riley's flip is sus" with Riley alive: there is no flip to talk about (L2-1018).
  if (!flags.some((f) => f.rule === "flip")) each(`${N}(?:'s|s)?\\s+flip\\b`, (m) => {
    const id = idOf(m[1]);
    if (id && id !== view.selfId && alive(view, id) && !flags.some((f) => f.rule === "flip")) flag("CONTRADICTION", "flip", `${nm(id)} flip? ${nm(id)} is alive`);
  });
  // L5 (10/18) garbles: "x shot y" against the gun line (the Sheriff shot someone else), and
  // "x vote x, she's mafia" (telling a player to vote themselves while calling them scum).
  each(`${N}\\s+(?:just\\s+)?shot\\s+${N}`, (m) => {
    const x = idOf(m[1]), y = idOf(m[2]);
    if (!x || !y || x === y || flags.some((f) => f.rule === "wrong-shot")) return;
    if (shots.some((h) => h.by === x && h.at === y)) return;
    if (shots.length || alive(view, y)) flag("CONTRADICTION", "wrong-shot", `${nm(x)} did not shoot ${nm(y)}`);
  });
  {
    const lead = new RegExp(`^\\s*${N}\\b`).exec(text);
    const to = lead && idOf(lead[1]);
    if (to && to !== view.selfId) {
      const nmRe = [nm(to), ...nicknamesOf(view.players?.[to]?.name)].map(esc).join("|");
      // Addressed and told to vote ("x, vote x"), not "x is mafia, vote x" (x the subject).
      const urge = new RegExp(`^[\\s,:]*(?:pls\\s+|just\\s+)?vote\\s+(?:out\\s+)?(?:${nmRe})(?![a-z0-9_])`).test(text.slice(lead[0].length));
      if (urge && /\b(mafia|scum|scummy|wolf|sus|sketchy|lying|liar|guilty)\b/.test(text)) flag("CONTRADICTION", "garbled-vote", `tells ${nm(to)} to vote themselves while calling them scum`);
    }
  }
  // L4 (10/18) garbles, cheap checks. "X flip kills Y claim" when Y's claim never touched X (a villager's flip
  // can't break a Cop claim that gave no result on him).
  each(`${N}(?:'s|s)?\\s+flip\\s+(?:kills|killed|breaks|broke|disproves|busts|ruins|debunks|destroys|kills off)\\s+${N}(?:'s|s)?\\s+(?:cop\\s+|journalist\\s+|sheriff\\s+)?claim\\b`, (m) => {
    const x = idOf(m[1]), y = idOf(m[2]);
    if (!x || !y || x === y || alive(view, x) || flags.some((f) => f.rule === "flip")) return;
    const xn = [nm(x), ...nicknamesOf(view.players?.[x]?.name)].map(esc).join("|");
    const touched = (view.messages || []).some((l) => l?.senderId === y && l.public !== false && new RegExp(`(?<![a-z0-9_])(?:${xn})(?![a-z0-9_])`).test(String(l.content || "").toLowerCase()));
    if (!touched) flag("CONTRADICTION", "flip-claim", `${nm(x)}'s flip says nothing about ${nm(y)}'s claim`);
  });
  // Two power roles stacked on one player ("cora u the cop and the sheriff").
  const stack = new RegExp(`\\b(?:u|you|ur|youre|you'?re|he'?s|hes|she'?s|shes|is|are|r)\\s+(?:the\\s+|a\\s+|both\\s+)?(cop|sheriff|journalist|doctor|lawyer|janitor|mafioso)\\s+(?:and|&|\\+)\\s+(?:the\\s+|a\\s+)?(cop|sheriff|journalist|doctor|lawyer|janitor|mafioso)\\b`).exec(text);
  if (stack && stack[1] !== stack[2]) flag("CONTRADICTION", "role-stack", `gives one player two roles (${stack[1]} and ${stack[2]})`);
  // "the janitor flip" when nobody flipped Janitor.
  each(`\\b(${ROLE})\\s+flip(?:ped)?\\b`, (m) => {
    const role = ROLES[m[1]];
    if (!role || role === "Villager" || flags.some((f) => f.rule === "flip")) return;
    const any = Object.keys(view.reveals || {}).some((id) => !alive(view, id) && flipped(id) === role);
    if (!any) flag("CONTRADICTION", "flip", `${m[1]} flip? nobody flipped ${role}`);
  });
  each(`${N}\\s+(?:died|is dead(?!\\s+to\\b)|got (?:shot|killed|lynched)|was (?:shot|killed|lynched))\\b`, (m) => {
    const id = idOf(m[1]);
    if (id && id !== view.selfId && alive(view, id)) flag("CONTRADICTION", "death", `${nm(id)} is alive`);
  });

  // Votes and counts.
  each(`${N.replace("(?<![a-z0-9_])(", "(?<![a-z0-9_])(i|")}\\s+(voted(?:\\s+for)?|is voting(?:\\s+for)?|votes(?:\\s+for)?)\\s+${N.replace("(?<![a-z0-9_])(", "(?<![a-z0-9_])(me|")}`, (m) => {
    const voter = idOf(m[1]); const target = idOf(m[3]);
    if (!voter || !target) return;
    const ok = /^voted/.test(m[2]) ? votes.ever.some((v) => v.voterId === voter && v.target === target) || votes.standing[voter] === target : votes.standing[voter] === target;
    if (!ok) flag("CONTRADICTION", "vote", `${nm(voter)} ${m[2]} ${nm(target)}: no such vote`);
  });
  each(`${N}(?:(?:'s vote)?\\s+is\\s+on|\\s+(?:put|placed) (?:a |their |his |her )?vote on|\\s+went (?:for|with)|\\s+hammered)\\s+${N.replace("(?<![a-z0-9_])(", "(?<![a-z0-9_])(me|")}`, (m) => {
    const voter = idOf(m[1]); const target = idOf(m[2]);
    if (voter && target && votes.standing[voter] !== target) flag("CONTRADICTION", "vote", `${nm(voter)} is on ${nm(target)}: no such vote`);
  });
  if (tight) {
    const onVote = (m) => {
      const voter = idOf(m[1]); const target = idOf(m[2]);
      if (voter && target && voter !== target && votes.standing[voter] !== target && !flags.some((f) => f.rule === "vote")) flag("CONTRADICTION", "vote", `${nm(voter)} is on ${nm(target)}: no such vote`);
    };
    each(`${N}\\s+(?:jumped|hopped|piled)\\s+on\\s+${N.replace("(?<![a-z0-9_])(", "(?<![a-z0-9_])(me|")}`, onVote);
    // "x has y" as a whole clause (a vote shorthand); "x has 2 votes" is a count, "x has a point" no player.
    each(`(?:^|[.;!?,]\\s*)${N}\\s+has\\s+${N.replace("(?<![a-z0-9_])(", "(?<![a-z0-9_])(me|")}\\s*(?=$|[.;!?,])`, onVote);
  }
  const count = (n) => (/^\d$/.test(n) ? Number(n) : NUM[n]);
  const NUMS = `\\d|${Object.keys(NUM).join("|")}`;
  each(`${N}(?:\\s+has|(?:\\s+is|'s)(?:\\s+sitting)?\\s+at|\\s+at|\\s+on|\\s*:)\\s+(${NUMS})(?:\\s+votes?\\b|\\s+on (?:them|him|her)\\b|(?=\\s*$|[.,;!?]))`, (m) => {
    const id = idOf(m[1]); const n = count(m[2]);
    if (id && n !== (votes.tally[id] || 0)) flag("CONTRADICTION", "vote-count", `${nm(id)} has ${votes.tally[id] || 0} votes, not ${n}`);
  });
  each(`(?<![a-z0-9_])(${NUMS})\\s+(?:votes?\\s+(?:on|for)|on)\\s+${N}`, (m) => {
    const id = idOf(m[2]); const n = count(m[1]);
    if (id && n !== (votes.tally[id] || 0)) flag("CONTRADICTION", "vote-count", `${nm(id)} has ${votes.tally[id] || 0} votes, not ${n}`);
  });

  if (tight) {
    const wrongCount = (id, n) => { if (id && n != null && n !== (votes.tally[id] || 0) && !flags.some((f) => f.rule === "vote-count")) flag("CONTRADICTION", "vote-count", `${nm(id)} has ${votes.tally[id] || 0} votes, not ${n}`); };
    each(`${N}\\s+(?:with|is on|is at)\\s+(${NUMS})(?:\\s+votes?\\b|(?=\\s*$|[.,;!?]))`, (m) => wrongCount(idOf(m[1]), count(m[2])));
    each(`(?<![a-z0-9_])(${NUMS})\\s+votes?\\s+(?:are|is)\\s+on\\s+${N}`, (m) => wrongCount(idOf(m[2]), count(m[1])));
    each(`\\bcount:?\\s+${N}\\s*(?:-|:|=|at)?\\s*(${NUMS})\\b`, (m) => wrongCount(idOf(m[1]), count(m[2])));
  }
  // "two cops": two living Cop claimers in the public record. Negation and past tense are not a count.
  if (/\btwo cops\b/.test(text) && !/\b(?:not|no|never|weren'?t|wasn'?t|were|was|had)\s+two cops\b/.test(text)) {
    const cops = Object.keys(view.players || {}).filter((id) => alive(view, id) && claimOf(id).has("Cop"));
    if (cops.length < 2) flag("CONTRADICTION", "claim-count", `${cops.length} living cop claimer(s), not two`);
  }

  // Claims attributed to others.
  each(`${N}\\s+(?:claimed|claims|said (?:they were|he was|she was))\\s+(?:to be\\s+)?(?:the\\s+|a\\s+)?(${ROLE})\\b`, (m) => {
    const id = idOf(m[1]);
    if (id && id !== view.selfId && !claimOf(id).has(ROLES[m[2]])) flag("CONTRADICTION", "claim", `${nm(id)} never claimed ${m[2]}`);
  });

  // "x is <role>": a role assertion about another player.
  const roleSaid = (m) => {
    const id = idOf(m[1]); const role = ROLES[m[2]];
    if (!id || id === view.selfId) return;
    const shown = flipped(id);
    if (shown && shown !== role) return flag(scum ? "SCUM_MISTAKE" : "CONTRADICTION", "role", `${nm(id)} flipped ${shown}, not ${role}`);
    if (shown) return;
    if (scum) {
      // Calling a teammate mafia is a bus (allowed); naming the teammate's real mafia role is knowledge only the team has.
      const real = ROLES[String(view.teammates?.[id]?.role || "").toLowerCase()];
      if (mates.has(id) && alignmentOf(role) === "Mafia" && (!real || real === role) && !claimOf(id).has(role)) flag("LEAK", "teammate-role", `names teammate ${nm(id)} as ${role}`);
      return;
    }
    const check = mem.checks?.[id];
    const sourced = claimOf(id).has(role) || recOf().reports.some((r) => r.target === id && r.kind === "janitor" && role === "Janitor")
      || (check && new RegExp(`\\b${role}\\b`, "i").test(`${check.result || ""} ${check.detail || ""}`))
      || (role === "Janitor" && /^reports?:/i.test(String(check?.detail || "")) && JANITOR_REPORT.test(String(check.detail)));
    if (!sourced) flag("LEAK", "unknown-role", `${nm(id)} is ${role}: no flip, claim, report or own result says so`);
  };
  each(`${N}(?:\\s+is|'s|\\s+(?:has to|must|should|has got to) be|\\s*=)(?:\\s+(?:definitely|obviously|clearly|surely|certainly|totally|def|100%|confirmed))?\\s*(?:the\\s+|a\\s+|our\\s+)?(${ROLE})\\b(?!\\s+claim)`, roleSaid);
  if (tight && !flags.some((f) => /^(?:unknown-role|role|teammate-role)$/.test(f.rule))) each(`${N}\\s+(?:plays|is playing|is the town|is our town|is town|is (?:clearly |obviously |definitely )?the (?:real|actual|town))\\s+(?:the\\s+|a\\s+)?(${ROLE})\\b(?!\\s+claim)`, roleSaid);

  // Night results: only first-person investigator lines (or a seat that already claimed Cop/Journalist).
  const investigator = INVESTIGATOR_LINE.test(text) || ["Cop", "Journalist"].includes(recOf().claims[view.selfId]) || (tight && /\bi (?:watched|followed|tracked)\b|\bwatched\b[^.;!?]*\bno reports?\b|\b(?:night|n)\s*\d+\s+check\b/.test(text));
  if (investigator) {
    let rest = text;
    const result = (id, kind, said, why) => {
      if (!id || id === view.selfId) return;
      if (scum) {
        const shown = alignmentOf(flipped(id));
        if ((said === "guilty" && shown === "Village") || (said === "inno" && shown === "Mafia")) flag("SCUM_MISTAKE", "fake-result", `${nm(id)} ${said}, but ${nm(id)} flipped ${flipped(id)}`);
        return;
      }
      // Notes hold only what the server told this seat (a Cop's alignment result, a Journalist's report).
      const check = mem.checks?.[id];
      if (!check) return flag("LEAK", "result-not-received", `${why}: this seat got no result on ${nm(id)}`);
      const got = `${check.result || ""} ${check.detail || ""}`;
      const wrong = kind === "cop" ? (said === "guilty") !== GUILTY_RESULT.test(got)
        : said === "noreport" ? !/no reports?/i.test(got) : !/investigat|learn that/i.test(got);
      if (wrong) flag("CONTRADICTION", "result", `${why}: this seat's result on ${nm(id)} says otherwise`);
    };
    each(`it said\\s+${N}\\s+(?:is\\s+)?guilty`, (m) => {
      rest = rest.replace(m[0], " ");
      const id = idOf(m[1]);
      if (scum) return result(id, "cop", "guilty", "relay");
      const relayed = Object.values(mem.checks || {}).some((c) => new RegExp(`(?:investigation shows|learn) that ${esc(nm(id))} is (?:guilty|mafia)`, "i").test(String(c?.detail || "")));
      if (!relayed) flag("LEAK", "result-not-received", `relays a cop guilty on ${nm(id)} that no report of this seat holds`);
    });
    each(`${N}\\s+got\\s+(no|a cop)\\s+reports?`, (m) => result(idOf(m[1]), "journalist", m[2] === "no" ? "noreport" : "copreport", `report on ${m[1]}`));
    each(`no reports? on\\s+${N}`, (m) => { rest = rest.replace(m[0], " "); result(idOf(m[1]), "journalist", "noreport", `no report on ${m[1]}`); });
    if (tight) {
      each(`${N}\\s+(?:received|had|gets|got)\\s+(no|a cop)\\s+reports?`, (m) => { rest = rest.replace(m[0], " "); result(idOf(m[1]), "journalist", m[2] === "no" ? "noreport" : "copreport", `report on ${m[1]}`); });
      each(`(?:watched|followed|tracked)\\s+${N}[^.;!?]*?\\b(no reports?|nothing|a cop report)\\b`, (m) => { rest = rest.replace(m[0], " "); result(idOf(m[1]), "journalist", /cop/.test(m[2]) ? "copreport" : "noreport", `watched ${m[1]}`); });
    }
    each(`(?:checked|investigated|looked at|my (?:check|report) on)\\s+${N}[^.;!?]*?(guilty|mafia|scum|inno|innocent|town|clean|nothing|no reports?)\\b`, (m) => {
      rest = rest.replace(m[0], " ");
      const said = /guilty|mafia|scum/.test(m[2]) ? "guilty" : /nothing|no report/.test(m[2]) ? "noreport" : "inno";
      result(idOf(m[1]), said === "noreport" ? "journalist" : "cop", said, `${m[1]} ${m[2]}`);
    });
    for (const m of rest.matchAll(new RegExp(`${N}\\s+(?:is\\s+|came (?:back|up)\\s+|got\\s+)?(guilty|inno|innocent|nothing)\\b`, "gi"))) {
      if (/\bnot\s*$/.test(rest.slice(0, m.index))) continue;
      if (m[2] === "nothing") { result(idOf(m[1]), "journalist", "noreport", `${m[1]} got nothing`); continue; }
      result(idOf(m[1]), "cop", m[2] === "guilty" ? "guilty" : "inno", `${m[1]} ${m[2]}`);
    }
  }

  // Vinman 10/18: mafia never call the Sheriff suspicious (the gun reveal clears him; accusing him only paints scum).
  const sheriff = sheriffSeat(view);
  if (scum && sheriff && sheriff !== view.selfId && !mates.has(sheriff)) {
    const sn = esc(nm(sheriff));
    const sheriffTok = new RegExp(`(?<![a-z0-9_])(?:${sn}|(?:the |our |this )?sheriff)(?![a-z0-9_])`);
    const pushTok = new RegExp(`\\b(?:vote|voting|lynch|hang|hammer|wagon|push|condemn)\\s+(?:on\\s+|for\\s+)?(?:${sn}|(?:the )?sheriff)(?![a-z0-9_])`);
    const sheriffNames = new Set([nm(sheriff), "sheriff", ...nicknamesOf(view.players?.[sheriff]?.name)]);
    const nearerOther = (seg, at) => {
      let best = Infinity;
      for (const [name, id] of Object.entries(byName)) {
        if (id === sheriff || sheriffNames.has(name)) continue;
        const i = seg.indexOf(name);
        if (i < 0) continue;
        best = Math.min(best, Math.abs(i - at), Math.abs(i + name.length - at));
      }
      return best;
    };
    for (const seg of text.split(/[.;!?,]+|\bbut\b/)) {
      const who = sheriffTok.exec(seg);
      if (!who) continue;
      const pushed = pushTok.test(seg);
      const doubt = CLAIM_DOUBT.test(seg) && !CLAIM_TRUST.test(seg);
      const accuse = (SHERIFF_ACCUSE.test(seg) || pushed) && !SHERIFF_DEFEND.test(seg);
      if (!(doubt || accuse)) continue;
      if (!pushed) {
        const charge = CLAIM_DOUBT.exec(seg) || SHERIFF_ACCUSE.exec(seg);
        if (charge) {
          const sheriffDist = Math.min(Math.abs(who.index - charge.index), Math.abs(who.index + who[0].length - charge.index));
          if (nearerOther(seg, charge.index) < sheriffDist) continue;
        }
      }
      flag("SCUM_MISTAKE", "accuses-sheriff", `calls the Sheriff (${nm(sheriff)}) suspicious`);
      break;
    }
  }
  // L3 (10/18): doubting the claim of a Sheriff the server's gun line revealed is a contradiction for anyone
  // ("that sheriff claim is weak" from town too).
  // L4 (10/18): it did not fire on "cora shot a villager, why would you trust him" / "you're a blind wolf":
  // the name test took only the full handle (not the nickname, nor "you"/"he" in a reply to him), and only
  // claim-doubt words counted, not attacks. Now: name, nickname, or a pronoun after his name in the line;
  // claim doubt or an attack (scum words, wolf, "why trust him", "shot a villager" as a charge).
  const shooter = revealedSheriff(view);
  if (!scum && shooter && shooter !== view.selfId) {
    const names = [nm(shooter), ...nicknamesOf(view.players?.[shooter]?.name)].map(esc).join("|");
    const named = new RegExp(`(?<![a-z0-9_])(?:${names}|(?:the |our |this |that |s\\d+ |his |her )?sheriff)(?![a-z0-9_])`);
    const mentioned = named.test(text);
    for (const seg of text.split(/[.;!?,]+|\bbut\b/)) {
      const who = named.test(seg) || (mentioned && /\b(you|you'?re|youre|u|ur|he|him|his|she|her)\b/.test(seg));
      if (!who && !(mentioned && SHERIFF_CHARGE.test(seg))) continue;
      if ((CLAIM_DOUBT.test(seg) || SHERIFF_DOUBT.test(seg)) && !CLAIM_TRUST.test(seg)) { flag("CONTRADICTION", "doubts-sheriff", `doubts the revealed Sheriff (${nm(shooter)})`); break; }
      // "cora who do you think is mafia?" asks him for a read; it is not an attack.
      const asksRead = /\b(?:who|which|whom)\b/.test(seg) && !SHERIFF_CHARGE.test(seg);
      if (!asksRead && (SHERIFF_ATTACK.test(seg) || SHERIFF_CHARGE.test(seg)) && !SHERIFF_DEFEND.test(seg.replace(SHERIFF_TRUST_Q, ""))) { flag("CONTRADICTION", "attacks-sheriff", `attacks the revealed Sheriff (${nm(shooter)})`); break; }
    }
  }
  // "whoever shot ash" when Ash died at night: nobody shot him (the gun line names every shot).
  each(`\\b(?:whoever|who|somebody|someone)\\s+(?:just\\s+)?shot\\s+${N}`, (m) => {
    const id = idOf(m[1]);
    if (!id || alive(view, id) || shotIds.has(id) || flags.some((f) => f.rule === "shot")) return;
    flag("CONTRADICTION", "shot", `${nm(id)} was killed at night, not shot`);
  });
  // L6 (10/18): town calling for the Sheriff's lynch ("believe the cop, vote that sheriff out"), the revealed
  // Sheriff or the living sole Sheriff claimer: never-lynch-the-Sheriff, in chat too.
  const shClaimer = shooter || (() => {
    const ids = [...new Set((view.messages || []).filter((m) => m.public !== false && m.senderId && alive(view, m.senderId) && claimedRoleIn(m.content) === "sheriff").map((m) => m.senderId))];
    return ids.length === 1 ? ids[0] : null;
  })();
  // A Sheriff claimer with a guilty on him (public, or my own check) is fair game.
  const guiltyOnClaimer = (c) => !shooter && (townReads(view).record.guilty.some((g) => g.target === c) || /mafia|guilty/i.test(String(memoryOf(view)?.checks?.[c]?.result || "")));
  if (!scum && shClaimer && shClaimer !== view.selfId && !flags.some((f) => /sheriff/.test(f.rule)) && !guiltyOnClaimer(shClaimer)) {
    const sn = [nm(shClaimer), ...nicknamesOf(view.players?.[shClaimer]?.name)].map(esc).join("|");
    const who = `(?:${sn}|(?:the |that |this |our |their |s\\d+ )?sheriff(?: claim(?:er)?)?)(?!'s\\b)`;
    // "self-vote for the sheriff" is the hammer comply, not a lynch. The object has to be the Sheriff.
    const push = new RegExp(`\\b(?:(?<!self-)vote|voting|lynch|hang|hammer|wagon|push|kill|condemn)\\s+(?:out\\s+)?(?:on\\s+|for\\s+)?${who}(?![a-z0-9_])(?!\\s+(?:is|isnt|isn't)\\b)|${who}\\s+(?:out|needs to go|has to go|must go|gets? lynched)\\b`);
    const negated = /\b(?:don'?t|do not|never)\s+(?:\w+\s+){0,3}(?:vote|voting|lynch|hang|hammer|wagon|push|kill|condemn)\b/.test(text);
    if (push.test(text) && !negated) flag("CONTRADICTION", "lynch-sheriff", `calls for the Sheriff's lynch (${nm(shClaimer)})`);
  }
  // L6: the Sheriff calling his own claim and a Cop claim a conflict ("both claiming law enforcement, someone is
  // lying"): Sheriff and Cop are different roles, nothing conflicts.
  if (/^sheriff$/i.test(String(view.role || "")) && (/\blaw enforcement\b/.test(text) || (/\b(?:cop|sheriff)\b/.test(text) && /\b(?:both|two)\b[^.]*\bclaim|\bconflict|\bclash|\bcant both\b|\bcan'?t both\b/.test(text)))) {
    flag("CONTRADICTION", "sheriff-cop-conflict", "Sheriff and Cop claims do not conflict");
  }
  // Vinman 10/18 (11:05): a dead or shot player (the flipped Janitor too) is never called sus now.
  const deadIds = Object.keys(view.players || {}).filter((id) => id !== view.selfId && !alive(view, id) && !view.players[id]?.left);
  if (deadIds.length) for (const seg of text.split(/[.;!?,]+|\bbut\b|\band\b/)) {
    const sus = DEAD_SUS.exec(seg);
    if (!sus || /\b(was|were|flipped|flip|died|dead|turned out)\b/.test(seg)) continue;
    const named = (chunk) => {
      const hits = [];
      for (const [name, id] of Object.entries(byName)) {
        const re = new RegExp(`(?<![a-z0-9_])${esc(name)}(?![a-z0-9_])`, "g");
        let m;
        while ((m = re.exec(chunk))) hits.push({ id, at: m.index });
      }
      hits.sort((a, b) => a.at - b.at);
      return hits;
    };
    const before = named(seg.slice(0, sus.index));
    const last = before[before.length - 1];
    const after = seg.slice(sus.index + sus[0].length);
    const immediate = named(after).find((h) => after.slice(0, h.at).trim() === "");
    const hit = (last && deadIds.includes(last.id) ? last.id : null) || (immediate && deadIds.includes(immediate.id) ? immediate.id : null);
    if (hit) { flag("CONTRADICTION", "dead-sus", `calls ${nm(hit)} sus, who is dead`); break; }
  }
  // "vote ash" with Ash dead.
  each(`\\b(?:vote|voting|lynch|lynching|hang|hammer|condemn)\\s+(?:for\\s+|on\\s+|out\\s+)?${N}`, (m) => {
    const id = idOf(m[1]);
    if (!id || id === view.selfId || alive(view, id) || !view.players?.[id] || flags.some((f) => f.rule === "vote-dead")) return;
    flag("CONTRADICTION", "vote-dead", `urges a vote on ${nm(id)}, who is dead`);
  });

  // Flip talk about a body the Janitor cleaned: there was no flip ("ash flipped", "clean flip", "ash's flip").
  const cleanedDead = Object.keys(view.players || {}).filter((id) => id !== view.selfId && !alive(view, id) && !view.players[id]?.left && !flipped(id));
  if (cleanedDead.length && !flags.some((f) => f.rule === "flip" && /was cleaned/.test(f.detail))) {
    for (const seg of text.split(/[.;!?,]+/)) {
      if (!FLIP_TALK.test(seg) || NO_FLIP.test(seg)) continue;
      const hit = cleanedDead.find((id) => new RegExp(`(?<![a-z0-9_])${esc(nm(id))}(?![a-z0-9_])`).test(seg));
      const lastDeath = (mem.deaths || []).filter((d) => !view.players?.[d.id]?.left).slice(-1)[0]?.id;
      const target = hit || (/\bclean(?:ly)? flip|\bflip(?:ped)? clean\b/.test(seg) && !namesIn(seg, lex).length && lastDeath && cleanedDead.includes(lastDeath) ? lastDeath : null);
      if (target) { flag("CONTRADICTION", "cleaned-flip", `${nm(target)} was cleaned: no flip`); break; }
    }
  }

  // Quoting another player for something they never said ("ash said she was scum", "bea said vote cal").
  each(`${N}\\s+(?:just\\s+|literally\\s+|already\\s+)?(?:said|says|wrote|typed)\\s+(?:that\\s+)?(["“'])?([^"”.;!?]{3,})`, (m) => {
    const id = idOf(m[1]);
    if (!id || id === view.selfId) return;
    // Unquoted reported speech is checked on its first clause only: what follows a comma or "so/but/right" is
    // the speaker's own commentary ("x said y inno, so lynch z"; audit-fp 10/19: 5 false misquotes in L3/L8).
    const quote = (m[2] ? m[3] : m[3].split(/,|\s+(?:but|so|and|right|lol|though|tho|which|because|cause|cuz|yet)\b/)[0]).trim();
    if (/^(nothing|anything|no(?:thing)?|they were|he was|she was|hi|hello|it|so|this|that)\b/.test(quote)) return;
    const words = contentWords(quote);
    if (!words.length) return;
    const theirs = (view.messages || []).filter((x) => x?.senderId === id && x.public !== false).map((x) => new Set(contentWords(x.content)));
    const best = Math.max(0, ...theirs.map((set) => words.filter((w) => set.has(w)).length / words.length));
    if (best < QUOTE_MATCH) flag("CONTRADICTION", "misquote", `${nm(id)} never said "${quote.slice(0, 40)}"`);
  });

  // A Cop urging a shot or lynch on a player he cleared (his own Innocent result, or his own public "x inno").
  const cleared = new Set();
  if (myRole === "Cop") for (const [id, c] of Object.entries(mem.checks || {})) if ((/^village$/i.test(String(c?.result || "")) || /\binnocent\b/i.test(String(c?.detail || ""))) && !GUILTY_RESULT.test(`${c?.result || ""} ${c?.detail || ""}`)) cleared.add(id);
  for (const c of recOf().inno || []) if (c.by === view.selfId) cleared.add(c.target);
  for (const id of cleared) {
    if (!alive(view, id) || id === view.selfId) continue;
    const n = esc(nm(id));
    const urge = new RegExp(`\\b(?:shoot|lynch|vote(?:\\s+(?:for|out))?|hang|hammer|kill|execute|wagon|push|condemn|elim(?:inate)?)\\s+(?:on\\s+)?${n}(?![a-z0-9_])|(?<![a-z0-9_])${n}\\s+(?:needs to|should|must|has to|gotta)\\s+(?:be\\s+|get\\s+)?(?:shot|lynched|hanged|hung|die|go|be voted)\\b`);
    if (urge.test(text) && !/\b(?:don'?t|do not|never|not|no)\s+(?:shoot|lynch|vote|hang|kill)/.test(text)) {
      flag(scum ? "SCUM_MISTAKE" : "CONTRADICTION", "cop-urges-cleared", `urges a shot or lynch on ${nm(id)}, whom this seat cleared`);
      break;
    }
  }

  // A reply to an accusation ("x why me") says x voted or named this seat today.
  const reply = new RegExp(`^${N}\\s+(?:why me|not me|what did i even do|wrong guy)`, "i").exec(text.trim());
  // A town claim says villager or blue. "vt" and "v/t" are still read as Villager claims from other seats.
  if (/(?:^|[^a-z0-9])(?:i'?m|im|i am)\s+(?:just\s+|a\s+|the\s+)?(?:vt|v\/t)\b|^(?:vt|v\/t)\b|,\s*(?:vt|v\/t)\b/.test(text)) {
    flag("CONTRADICTION", "vt-claim", "a town claim says villager or blue, never vt");
  }
  // After the gun is fired the Sheriff never threatens another shot ("X claim or im shooting").
  if (sheriffGunSpent(view) && SPENT_GUN_THREAT.test(text)) flag("CONTRADICTION", "spent-gun-threat", "the gun is spent: no claim-or-shoot threat");
  if (reply) {
    const by = idOf(reply[1]);
    const me = nm(view.selfId);
    const named = (view.messages || []).some((m) => m?.senderId === by && (!m.phase || m.phase === view.phase?.name) && new RegExp(`(?<![a-z0-9_])${esc(me)}(?![a-z0-9_])`, "i").test(String(m.content || "")));
    const voted = votes.standing[by] === view.selfId || votes.today.some((v) => v.voterId === by && v.target === view.selfId);
    if (by && by !== view.selfId && !named && !voted) flag("CONTRADICTION", "reply", `answers ${nm(by)}, who neither voted nor named this seat today`);
  }
  return flags;
}

/** A replacement line from the town's reads (townCounterLine), or null: scum and quiet seats just drop the line. */
export function groundedLine(view) {
  if (scumFaction(view)) return null;
  const line = townCounterLine(view);
  return line && !chatAudit(view, line).length ? line : null;
}

function lineOk(view, content) {
  return !!content && !publicLeak(view, content) && !machineLeak(view, content) && !earlyClaimBlock(view, content) && !chatAudit(view, content).length;
}

/**
 * A short day line: the seat's claim when that claim is allowed, otherwise its best read, otherwise
 * who it is watching. Never an early claim and never a spent-gun threat.
 */
export function dayOpener(view) {
  if (view?.phase?.phase !== "Day" || !view?.selfId) return null;
  if (!Object.values(view?.meetings || {}).some((m) => m?.name === "Village" && m.speech)) return null;
  const reads = townReads(view);
  const ranked = Object.keys(view.players || {}).filter((id) => id !== view.selfId && alive(view, id))
    .map((id) => [id, reads.score[id] || 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const nm = (id) => String(view.players?.[id]?.name || id).toLowerCase();
  const top = ranked.find(([, score]) => score > 0);
  const watch = ranked[0];
  const candidates = [];
  if (sheriffGunSpent(view)) candidates.push(top ? `guns spent, my read is ${nm(top[0])}` : "guns spent");
  const claim = roleClaimLine(view);
  if (claim) candidates.push(claim);
  if (top) candidates.push(`my read is ${nm(top[0])}`);
  if (watch) candidates.push(`watching ${nm(watch[0])}`);
  candidates.push("watching the votes");
  return candidates.find((line) => lineOk(view, line)) || null;
}

/** Re-check a held line. A line that no longer passes is replaced with a valid one, or null. */
export function reviveSpeech(view, content) {
  const meeting = Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.speech);
  if (!meeting) return null;
  const repaired = repairSpentGunThreat(view, content);
  const candidates = [...new Set([repaired, groundedLine(view), dayOpener(view), "watching the votes", "not sure yet", "need more here", "still looking"].filter(Boolean))];
  const contentOk = lineOk(view, content);
  if (contentOk && repaired === content) return { event: "speak", data: { meetingId: meeting.id, content } };
  for (const line of candidates) {
    if (!lineOk(view, line)) continue;
    return { event: "speak", data: { meetingId: meeting.id, content: line } };
  }
  return null;
}

/** The first blocking flag as a validateAction reason, or null. view.config.chatAudit "measure" never blocks. */
export function chatAuditBlock(view, content) {
  if (view?.config?.chatAudit === "measure") return null;
  const [f] = chatAudit(view, content);
  return f ? `chat-audit: ${f.kind} ${f.rule} (${f.detail})` : null;
}
