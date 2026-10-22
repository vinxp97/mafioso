// What the speech model should talk about (GAME01: every line was an empty question while the Sheriff's claim and
// his shot on a flipped mafioso went unremarked). Trusted facts only (server shots, flips, deaths, this seat's reads),
// plus public claims, results and votes from the record. Every name is defanged like chat.
import { townReads } from "./townReads.js";
import { publicReads } from "./adaptiveMafia.js";
import { allies } from "./faction.js";
import { scumFaction } from "./scumPlan.js";
import { defang } from "./sanitize.js";

// items/Gun.js (revealing gun): ":gun: X pulls a gun and shoots at Y!".
const SHOT = /^(?::gun:\s*)?(.+?) pulls a gun and shoots (?:at )?(.+?)!*$/i;
const alive = (view, id) => !!view?.players?.[id] && !view.players[id].left && !view.dead?.[id];

/** Short fact lines for the speech prompt, most useful first; [] when nothing has happened. */
export function speechFacts(view, { max = 6 } = {}) {
  const nm = (id) => defang(String(view?.players?.[id]?.name || "?").toLowerCase(), 30);
  const idOf = (name) => Object.keys(view?.players || {}).find((id) => String(view.players[id]?.name || "").toLowerCase() === String(name).trim().toLowerCase());
  const flip = (id) => (view?.reveals?.[id] ? String(view.reveals[id]).split(/:| \(/)[0].toLowerCase() : null);
  const out = [];
  const shotIds = new Set();
  for (const m of view?.messages || []) {
    if (m?.senderId && m.senderId !== "server") continue;
    const hit = SHOT.exec(String(m?.content || "").trim());
    const [by, at] = hit ? [idOf(hit[1]), idOf(hit[2])] : [];
    if (!by || !at) continue;
    shotIds.add(at);
    out.push(`${nm(by)} (sheriff) shot ${nm(at)}${flip(at) ? `, who flipped ${flip(at)}` : ""}`);
  }
  for (const id of Object.keys(view?.dead || {}).filter((d) => view.dead[d] && !shotIds.has(d)).slice(-3)) {
    out.push(`${nm(id)} died, ${flip(id) ? `flipped ${flip(id)}` : "no flip (cleaned)"}`);
  }
  // Scum read the board as town sees it (public evidence only); town uses its own reads (its checks included).
  const reads = scumFaction(view) ? publicReads(view) : townReads(view);
  const rec = reads.record;
  const claims = Object.entries(rec.claims).filter(([id]) => id !== view.selfId).map(([id, r]) => `${nm(id)} ${String(r).toLowerCase()}${alive(view, id) ? "" : " (dead)"}`);
  if (claims.length) out.push(`claims: ${claims.join(", ")}`);
  for (const g of rec.guilty.slice(-2)) out.push(g.relay ? `${nm(g.by)} relayed a cop report: ${nm(g.target)} guilty` : `${nm(g.by)} says ${nm(g.target)} guilty`);
  for (const r of rec.reports.slice(-2)) out.push(`${nm(r.by)} says ${nm(r.target)} ${r.kind === "realcop" ? "got a cop report" : r.kind === "janitor" ? "is janitor" : "got no report"}`);
  const village = Object.values(view?.meetings || {}).find((m) => m?.name === "Village" && m.voting);
  const tally = {};
  for (const t of Object.values(village?.votes || {})) for (const x of [].concat(t)) if (x && x !== "*" && view.players?.[x]) tally[x] = (tally[x] || 0) + 1;
  const lead = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (lead.length) out.push(`votes now: ${lead.map(([id, n]) => `${nm(id)} ${n}`).join(", ")}`);
  const mates = allies(view);
  const top = Object.entries(reads.score).filter(([id]) => id !== view.selfId && !mates.has(id) && alive(view, id)).sort((a, b) => b[1] - a[1])[0];
  const why = top && top[1] > 0 ? [...(reads.reasons[top[0]] || [])].sort((a, b) => parseFloat(b) - parseFloat(a))[0] : null;
  const facts = out.slice(-(max - 1));
  if (why) facts.push(`your top read: ${nm(top[0])} (${defang(why.replace(/^[+-]?[\d.]+\s*/, ""), 80)})`);
  return facts;
}
