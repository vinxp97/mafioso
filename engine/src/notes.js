// Per-bot memory. Updated only from events this seat received.
// Nothing here is shared with another account.
// Checks, deaths, and votes are facts. Claims stay claims; the fact ledger gives them evidence ids.
import { alignmentOf, allies } from "./faction.js";

export function emptyNotes() {
  return { checks: {}, cleared: [], suspects: [], deaths: [], votes: [], heard: [], plan: null };
}

/** A report only the Janitor gets: its clean result (live ":mop: You discover X's role is Y."). */
export const JANITOR_REPORT = /janitor|\bclean(?:ed|s)?\b|(?:discover|learn that) .+?'s role is/i;
const SIDED = /^(.+?) is sided with the (Village|Mafia|Cult|Town)\b/i;
const ROLE_LINE = /^(.+?) is (?:a |an |the )?([A-Za-z][A-Za-z ]+?)\.?$/;

function namedId(view, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  for (const p of Object.values(view.players || {})) {
    if (!p) continue;
    if (String(p.id).toLowerCase() === n || String(p.name || "").toLowerCase() === n) return p.id;
  }
  return null;
}

function resultAlign(result) {
  if (/^(Village|Town)$/i.test(result)) return "Village";
  if (/^Mafia$/i.test(result) || /^guilty$/i.test(result)) return "Mafia";
  if (/^innocent$/i.test(result)) return "Village";
  if (/^Cult$/i.test(result)) return "Cult";
  return alignmentOf(result);
}

function pushCap(list, item, cap) {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function memoryOf(view) {
  const notes = view?.notes || emptyNotes();
  const cleared = new Set(notes.cleared || []);
  const suspects = new Set(notes.suspects || []);
  for (const [id, app] of Object.entries(view?.reveals || {})) {
    if (id === view?.selfId) continue;
    const align = alignmentOf(app);
    if (align === "Village") cleared.add(id);
    else if (align === "Mafia" || align === "Cult") suspects.add(id);
  }
  const byRole = new Map();
  for (const [id, claim] of Object.entries(view?.claims || {})) {
    if (!claim?.role || claim.kind === "retract" || id === view?.selfId) continue;
    if (!byRole.has(claim.role)) byRole.set(claim.role, []);
    byRole.get(claim.role).push(id);
  }
  for (const ids of byRole.values()) if (ids.length > 1) for (const id of ids) suspects.add(id);
  if (view?.selfId) for (const id of allies(view)) { cleared.delete(id); suspects.delete(id); }
  return {
    checks: notes.checks || {},
    cleared,
    suspects,
    deaths: notes.deaths || [],
    votes: notes.votes || [],
    heard: notes.heard || [],
    claims: view?.claims || {},
  };
}

/** Server investigation line, or null. A player saying the same words is not a check. */
export function parseServerInfo(view, data) {
  const sender = data?.senderId;
  if (sender && sender !== "server" && sender !== "anonymous") return null;
  let text = String(data?.content || "").trim();
  // Live server wording: Cop "Your investigation shows that X is Guilty"; Journalist report lines.
  // Live alerts carry an emoji tag (":invest:", ":journ:", ":mop:"); the FJ Cop card (LearnAlignment) says
  // "After investigating, you learn that X is Mafia!".
  text = text.replace(/^(?::[\w-]+:\s*)+/, "").replace(/^after investigating,?\s+you learn that\s+(.+?)!*$/i, "$1");
  text = text.replace(/^your investigation shows that\s+/i, "").replace(/^you learn that your\s+(.+?)'s alignment is\s+/i, "$1 is ");
  const noRep = text.match(/^you learn that (.+?) received no reports\.?$/i);
  const allRep = text.match(/^you received all reports that (.+?) received:\s*(.+?)\.?$/i);
  if (noRep || allRep) {
    const pid = namedId(view, (noRep || allRep)[1]);
    if (!pid || pid === view.selfId) return null;
    const detail = noRep ? "no reports" : `reports: ${allRep[2]}`;
    return { playerId: pid, detail, align: "", role: JANITOR_REPORT.test(detail) ? "Janitor" : null, text };
  }
  const sided = text.match(SIDED);
  const roleLine = sided ? null : text.match(ROLE_LINE);
  if (!sided && !roleLine) return null;
  const playerId = namedId(view, (sided || roleLine)[1]);
  if (!playerId || playerId === view.selfId) return null;
  const detail = (sided || roleLine)[2].trim();
  const align = resultAlign(detail);
  return { playerId, detail, align: align || "", role: alignmentOf(detail) ? detail : null, text };
}

function rememberCheck(view, data) {
  const info = parseServerInfo(view, data);
  if (!info) return;
  const { playerId: id, detail, align } = info;
  view.notes.checks[id] = { result: align || detail, detail, phase: view.phase?.name || "" };
  const cleared = new Set(view.notes.cleared);
  const suspects = new Set(view.notes.suspects);
  if (align === "Village") { cleared.add(id); suspects.delete(id); }
  else if (align === "Mafia" || align === "Cult") { suspects.add(id); cleared.delete(id); }
  view.notes.cleared = [...cleared];
  view.notes.suspects = [...suspects];
}

function rememberHeard(view, data) {
  if (!data?.meetingId || data.senderId === "server") return;
  const meeting = view.meetings?.[data.meetingId];
  if (!meeting?.amMember) return;
  const name = meeting.name || "";
  if (name !== "Mafia" && name !== "Cult" && !/whisper/i.test(name)) return;
  const text = String(data.content || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!text) return;
  pushCap(view.notes.heard, { senderId: data.senderId || "", meeting: name, text }, 20);
}

export function applyNotes(view, frame) {
  if (!view.notes) view.notes = emptyNotes();
  const event = frame?.event;
  const data = frame?.data;
  if (event === "death" || event === "exorcised" || event === "history" || event === "revival") {
    const seen = new Set(view.notes.deaths.map((d) => d.id));
    for (const [id, dead] of Object.entries(view.dead || {})) {
      if (dead && !seen.has(id)) view.notes.deaths.push({ id, phase: view.phase?.name || "" });
    }
  }
  if (event === "vote" && data?.voterId && data?.target != null) {
    pushCap(view.notes.votes, {
      voterId: String(data.voterId),
      target: String(data.target),
      meetingId: data.meetingId ? String(data.meetingId) : "",
      phase: view.phase?.name || "",
    }, 200);
  }
  if ((event === "message" || event === "quote") && data) {
    rememberCheck(view, data);
    rememberHeard(view, data);
  }
  return view;
}
