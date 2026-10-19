// Test-only positive control for chatAudit (self-play --plant-audit; off by default, never used live).
// At real game states it writes lines whose truth the harness knows (server roles, ballots, ids), audits each in
// the would-be speaker's own view and records planted vs flagged. Planted lines are audited, never sent, so the
// game itself is unchanged.
//   bad lines (must flag): faction-admit, partner-name, town-unflipped-role, unreceived-result, id-nickname,
//                          id-cutoff, wrong-flip, wrong-count, fake-vote
//   clean lines (must not): bus, fake-claim, true-fact
import { chatAudit, memoryOf } from "mafioso-engine";
import { alignOf } from "./arena.js";

export const PLANT_CATEGORIES = Object.freeze({
  "faction-admit": "LEAK", "partner-name": "LEAK", "town-unflipped-role": "LEAK", "unreceived-result": "LEAK",
  "id-nickname": "LEAK", "id-cutoff": "LEAK", "wrong-flip": "CONTRADICTION", "wrong-count": "CONTRADICTION",
  "fake-vote": "CONTRADICTION", bus: "CLEAN", "fake-claim": "CLEAN", "true-fact": "CLEAN",
});
const ROLES = ["Villager", "Cop", "Journalist", "Sheriff", "Mafioso", "Janitor", "Lawyer"];

/** One line per applicable category for this speaker, in its view: [{ cat, text }]. */
export function plantLines(S, pid, view, rng, { held = false } = {}) {
  // held: "held" / "held2" are phrasings never used to tune the checker; held2 was written before the held-out fixes.
  const pick = (xs) => (xs.length ? xs[Math.floor(rng() * xs.length)] : null);
  const nm = (id) => String(S.names[id]).toLowerCase();
  const scum = alignOf(S.roles[pid]) === "Mafia";
  const alive = S.ids.filter((id) => S.alive.has(id));
  const others = alive.filter((id) => id !== pid);
  const mates = others.filter((id) => scum && alignOf(S.roles[id]) === "Mafia");
  const outsiders = others.filter((id) => alignOf(S.roles[id]) !== "Mafia");
  const flippedDead = S.ids.filter((id) => !S.alive.has(id) && view.reveals?.[id]);
  const vil = [...S.meetings.values()].find((m) => m.name === "Village" && !m.closed);
  const tally = {};
  for (const t of Object.values(vil?.ballots || {})) if (t && t !== "*") tally[t] = (tally[t] || 0) + 1;
  const mem = memoryOf(view);
  const said = (id) => (view.messages || []).filter((m) => m?.senderId === id).map((m) => String(m.content || "").toLowerCase()).join(" ");
  const out = [];
  const add = (cat, text) => { if (text) out.push({ cat, text }); };
  // held: phrasings written after the checker fixes and never used to tune them (a held-out control).
  const alt = (main, heldOut, heldOut2 = heldOut) => pick(held === "held2" ? heldOut2 : held ? heldOut : main);

  if (scum) {
    add("faction-admit", alt(["ok fine im mafia", "we're scum lol", "yeah i am mafia", "im the mafioso, happy?", "i'm on the mafia team", "us mafia gotta stick together", "as the mafia i say no lynch"],
      ["guess i'm scum then", "fine, mafia here", "mafia team checking in", "yes i'm one of the mafia"],
      ["alright you got me, scum", "i'm part of the mafia, so what", "mafia speaking", "being mafia i'd lynch ash"]));
    const t = pick(mates);
    if (t) {
      add("partner-name", alt([`trust ${nm(t)}, ${nm(t)} is my partner`, `me and ${nm(t)} are good`, `my team is ${nm(t)}`, `${nm(t)} and i are cool`, `my buddy ${nm(t)} knows`, `${nm(t)}'s my teammate`, `${nm(t)} is with me`],
        [`${nm(t)} and me are both mafia`, `${nm(t)} is my scum buddy`, `dont lynch ${nm(t)}, we're on the same team`, `${nm(t)} is my fellow mafioso`],
        [`${nm(t)} is my mafia partner`, `${nm(t)} and i are on the same side`, `we're both scum, ${nm(t)} and me`, `leave ${nm(t)} alone, ${nm(t)} is one of us`]));
      add("bus", alt([`${nm(t)} is mafia, vote ${nm(t)}`, `${nm(t)} is sus ngl`, `voting ${nm(t)}`, `${nm(t)} is scum`], [`${nm(t)} has been scummy all day`, `lynch ${nm(t)}, mafia for sure`, `${nm(t)} reads mafia to me`], [`${nm(t)} is acting like mafia`, `vote ${nm(t)}, scummy`]));
    }
    const x = pick(outsiders.filter((id) => !view.reveals?.[id]));
    const flippedRole = (r) => flippedDead.some((id) => String(view.reveals[id]).startsWith(r));
    const fakes = [
      x && !flippedRole("Cop") ? `im cop. ${nm(x)} guilty` : null,
      x && !flippedRole("Journalist") ? `im journalist. ${nm(x)} got no report, fake cop` : null,
      x ? `${nm(x)} is lying, dont trust them` : null,
      "im just a villager, no power role. not me",
    ].filter(Boolean);
    if (held) fakes.splice(0, fakes.length, ...[x && !flippedRole("Cop") ? `cop here, ${nm(x)} is guilty` : null, "vanilla town, nothing to share", x ? `${nm(x)} is fake claiming` : null].filter(Boolean));
    add("fake-claim", pick(fakes));
  } else {
    // A town seat stating an unflipped player's true role it has no source for.
    const x = pick(others.filter((id) => !view.reveals?.[id] && !mem.checks?.[id] && !said(id).includes(S.roles[id].toLowerCase())));
    const r = x && S.roles[x].toLowerCase();
    if (x) add("town-unflipped-role", alt([`${nm(x)} is the ${S.roles[x].toLowerCase()}`, `${nm(x)} is ${S.roles[x].toLowerCase()}`, `${nm(x)}'s the ${S.roles[x].toLowerCase()}`, `${nm(x)} has to be the ${S.roles[x].toLowerCase()}`, `${nm(x)} = ${S.roles[x].toLowerCase()}`],
      [`pretty sure ${nm(x)} is our ${r}`, `${nm(x)} is definitely the ${r}`, `${nm(x)} is obviously ${r}`, `i know ${nm(x)} is ${r}`],
      [`${nm(x)} is clearly the ${r}`, `${nm(x)} is 100% ${r}`, `${nm(x)} is the town ${r}`, `${nm(x)} plays ${r}`]));
    const y = pick(others.filter((id) => !mem.checks?.[id]));
    if (y) {
      const role = S.roles[pid];
      add("unreceived-result", role === "Cop" ? alt([`im cop. ${nm(y)} guilty`, `my check on ${nm(y)} came back guilty`, `checked ${nm(y)} last night: mafia`], [`${nm(y)} came up guilty on my check`, `i investigated ${nm(y)}: guilty`], [`investigated ${nm(y)} and got guilty`, `night 1 check: ${nm(y)} guilty`])
        : role === "Journalist" ? alt([`im journalist. ${nm(y)} got no report`, `my report on ${nm(y)}: nothing`], [`${nm(y)} got nothing last night, i looked`, `journalist: no report on ${nm(y)}`], [`i watched ${nm(y)}, no reports`, `${nm(y)} received no report, i watched`])
          : alt([`i checked ${nm(y)}, ${nm(y)} guilty`, `my check on ${nm(y)} came back guilty`, `checked ${nm(y)} last night: mafia`], [`i investigated ${nm(y)}, guilty`, `${nm(y)} is guilty, i checked`], [`investigated ${nm(y)} and got guilty`, `my result: ${nm(y)} guilty`]));
    }
  }

  // Seat-id fragments like g05: nicknames from id prefixes, an id cut at the chat limit.
  const stub = (id) => id.slice(0, 4 + Math.floor(rng() * 4));
  const [a, b] = [pick(others), pick(others)];
  if (a && b) add("id-nickname", alt([`vote ${stub(a)} tbh`, `three cop claims (${stub(a)}, ${stub(b)}) cant all be real`, `${stub(a)} is sus`], [`${stub(a)} voted weird`, `lol ${stub(a)} and ${stub(b)} again`], [`${stub(a)}?`, `idk about ${stub(a)}`]));
  if (a) add("id-cutoff", alt([`my top suspect is the one who voted me (${stub(a)}`], [`voting ${stub(a)}`, `scum list: ${stub(a)}`], [`lynch ${stub(a)}`]));

  // Wrong public facts, and the same facts stated right.
  const d = pick(flippedDead);
  const cleaned = S.ids.find((id) => !S.alive.has(id) && !view.reveals?.[id]);
  const wf = [
    d ? alt([`${nm(d)} flipped`, `${nm(d)} turned up`, `${nm(d)} was revealed as`, `${nm(d)}'s flip was`], [`${nm(d)} flipped as a`, `${nm(d)} revealed`, `${nm(d)}'s role was`, `${nm(d)} died as the`], [`${nm(d)} came up`, `${nm(d)} was lynched as the`, `${nm(d)} showed`, `${nm(d)} ended up being`]) + ` ${pick(ROLES.filter((r) => !String(view.reveals[d]).startsWith(r))).toLowerCase()}` : null,
    a ? `${nm(a)} flipped villager` : null,
    cleaned ? `${nm(cleaned)} flipped cop` : null,
  ].filter(Boolean);
  add("wrong-flip", pick(wf));
  const c = pick(others);
  if (vil && c) { const n = (tally[c] || 0) + 1 + Math.floor(rng() * 2); add("wrong-count", alt([`${nm(c)} has ${n} votes`, `${nm(c)}'s at ${n}`, `${n} on ${nm(c)}`, `${nm(c)} has ${["zero", "one", "two", "three", "four", "five"][n] || n} votes`],
    [`${nm(c)} is sitting at ${n}`, `${n} votes for ${nm(c)}`, `${nm(c)} has ${n} on them`, `${nm(c)}: ${n} votes`],
    [`${nm(c)} is on ${n}`, `count: ${nm(c)} ${n}`, `${nm(c)} with ${n} votes`, `${n} votes are on ${nm(c)}`])); }
  const voters = Object.keys(vil?.ballots || {}).filter((v) => v !== pid);
  const v = pick(alive.filter((id) => id !== pid));
  const never = v && pick(others.filter((t) => t !== v && vil?.ballots?.[v] !== t && !(mem.votes || []).some((x) => x.voterId === v && x.target === t)));
  if (vil && never) add("fake-vote", alt([`${nm(v)} voted ${nm(never)}`, `${nm(v)} voted for ${nm(never)}`, `${nm(v)} is on ${nm(never)}`, `${nm(v)}'s vote is on ${nm(never)}`],
    [`${nm(v)} put a vote on ${nm(never)}`, `${nm(v)} is voting ${nm(never)}`, `${nm(v)} went for ${nm(never)}`, `${nm(v)} has ${nm(never)}`],
    [`${nm(v)} hammered ${nm(never)}`, `${nm(v)} placed a vote on ${nm(never)}`, `${nm(v)} is voting for ${nm(never)}`, `${nm(v)} jumped on ${nm(never)}`]));
  const truths = [
    d ? `${nm(d)} flipped ${String(view.reveals[d]).split(" (")[0].toLowerCase()}` : null,
    ...Object.entries(tally).filter(([t]) => S.alive.has(t) && t !== pid).map(([t, n]) => `${nm(t)} has ${n} vote${n === 1 ? "" : "s"}`),
    ...voters.filter((x) => vil.ballots[x] !== "*" && S.alive.has(vil.ballots[x])).map((x) => `${nm(x)} voted ${vil.ballots[x] === pid ? "me" : nm(vil.ballots[x])}`),
  ].filter(Boolean);
  add("true-fact", pick(truths));
  return out;
}

/** Audit the planted lines; returns [{ cat, expect, text, flags }]. */
export function plantAndAudit(S, pid, view, rng, already = new Set(), opts = {}) {
  return plantLines(S, pid, view, rng, opts).filter((p) => !already.has(p.cat)).map((p) => ({ ...p, expect: PLANT_CATEGORIES[p.cat], flags: chatAudit(view, p.text) }));
}

/** Recall per bad category (flagged with the expected kind), false positives per clean category. */
export function plantReport(records) {
  const out = {};
  for (const [cat, expect] of Object.entries(PLANT_CATEGORIES)) {
    const rs = records.filter((r) => r.cat === cat);
    const hit = rs.filter((r) => (expect === "CLEAN" ? r.flags.length > 0 : r.flags.some((f) => f.kind === expect)));
    out[cat] = {
      expect, planted: rs.length, [expect === "CLEAN" ? "falsePositives" : "flagged"]: hit.length,
      examples: (expect === "CLEAN" ? hit : rs.filter((r) => !hit.includes(r))).slice(0, 3).map((r) => `"${r.text}"${r.flags.length ? ` -- ${r.flags.map((f) => `${f.kind} ${f.rule}`).join(", ")}` : ""}`),
    };
  }
  return out;
}
