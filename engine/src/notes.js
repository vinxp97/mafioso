// Per-bot memory. Updated only from events this seat received.
// Nothing here is shared with another account.
import { alignmentOf, allies } from "./faction.js";

export function emptyNotes() {
  return { checks: {}, cleared: [], suspects: [], deaths: [], votes: [], heard: [], plan: null };
}

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
  if (/^Mafia$/i.test(result)) return "Mafia";
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

function rememberCheck(view, data) {
  const sender = data?.senderId;
  if (sender && sender !== "server" && sender !== "anonymous") return;
  const text = String(data?.content || "").trim();
  const sided = text.match(SIDED);
  const roleLine = sided ? null : text.match(ROLE_LINE);
  if (!sided && !roleLine) return;
  const id = namedId(view, (sided || roleLine)[1]);
  if (!id || id === view.selfId) return;
  const detail = (sided || roleLine)[2].trim();
  const align = resultAlign(detail);
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
    }, 40);
  }
  if ((event === "message" || event === "quote") && data) {
    rememberCheck(view, data);
    rememberHeard(view, data);
  }
  return view;
}
