// Per-seat facts this account actually received. Claims are records of speech, not roles.
import { extractClaim } from "./claims.js";
import { parseServerInfo } from "./notes.js";
import { splitAppearance } from "./reducer.js";
import { sanitizeChat } from "./sanitize.js";

export function emptyLedger() {
  return { nextId: 1, facts: [] };
}

function pushFact(view, fact) {
  if (!view.ledger) view.ledger = emptyLedger();
  const id = `f${view.ledger.nextId++}`;
  view.ledger.facts.push({ id, phase: view.phase?.name || "", ...fact });
  return id;
}

function hasFact(view, pred) {
  return (view.ledger?.facts || []).some(pred);
}

function ensureSelf(view) {
  if (!view.selfId || !view.role) return;
  if (hasFact(view, (fact) => fact.kind === "self" && fact.playerId === view.selfId && fact.role === view.role)) return;
  pushFact(view, { kind: "self", playerId: view.selfId, role: view.role, hard: true });
}

function recordDeaths(view) {
  for (const [id, dead] of Object.entries(view.dead || {})) {
    if (!dead || hasFact(view, (fact) => fact.kind === "death" && fact.playerId === id)) continue;
    pushFact(view, { kind: "death", playerId: id, hard: true });
  }
}

function recordReveals(view) {
  for (const [id, appearance] of Object.entries(view.reveals || {})) {
    if (!appearance || id === view.selfId) continue;
    const role = splitAppearance(appearance).role;
    if (!role || hasFact(view, (fact) => fact.kind === "reveal" && fact.playerId === id && fact.role === role)) continue;
    pushFact(view, { kind: "reveal", playerId: id, role, appearance: String(appearance), hard: true });
  }
}

function recordCheck(view, data) {
  const info = parseServerInfo(view, data);
  if (!info) return false;
  if (hasFact(view, (fact) => fact.kind === "check" && fact.playerId === info.playerId && fact.detail === info.detail && fact.align === info.align)) return false;
  pushFact(view, {
    kind: "check", playerId: info.playerId, detail: info.detail, align: info.align || "",
    role: info.role || null, hard: true,
  });
  return true;
}

function recordClaim(view, data) {
  const claim = extractClaim(data);
  if (!claim?.playerId) return;
  pushFact(view, {
    kind: "claim", playerId: claim.playerId, role: claim.role, claimKind: claim.kind,
    quote: claim.quote, hard: false,
  });
}

function recordHeard(view, data) {
  if (!data?.meetingId || data.senderId === "server") return;
  const meeting = view.meetings?.[data.meetingId];
  if (!meeting?.amMember) return;
  const name = meeting.name || "";
  if (name !== "Mafia" && name !== "Cult" && !/whisper/i.test(name)) return;
  const text = String(data.content || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!text) return;
  pushFact(view, { kind: "heard", playerId: data.senderId || "", meeting: name, text, hard: false });
}

/** Append facts for one frame. Does not infer roles from claims. */
export function applyLedger(view, frame) {
  if (!view.ledger) view.ledger = emptyLedger();
  const event = frame?.event;
  const data = frame?.data;
  if (event === "death" || event === "exorcised" || event === "history" || event === "revival") recordDeaths(view);
  if (event === "reveal" || event === "roleReveal" || event === "history") recordReveals(view);
  if (event === "vote" && data?.voterId && data?.target != null) {
    pushFact(view, {
      kind: "vote", playerId: String(data.voterId), target: String(data.target),
      meetingId: data.meetingId ? String(data.meetingId) : "", hard: true,
    });
  }
  if ((event === "message" || event === "quote") && data) {
    recordCheck(view, data);
    recordClaim(view, data);
    recordHeard(view, data);
  }
  ensureSelf(view);
  return view;
}

function formatFact(fact) {
  if (fact.kind === "claim") return `${fact.id} [unconfirmed claim/${fact.claimKind}] ${fact.playerId} says ${fact.role || "-"} (not confirmed)`;
  if (fact.kind === "check") return `${fact.id} [hard check] ${fact.playerId} ${fact.detail || fact.align}`;
  if (fact.kind === "death") return `${fact.id} [hard death] ${fact.playerId}`;
  if (fact.kind === "vote") return `${fact.id} [hard vote] ${fact.playerId}->${fact.target}`;
  if (fact.kind === "reveal") return `${fact.id} [hard reveal] ${fact.playerId} ${fact.role}`;
  if (fact.kind === "self") return `${fact.id} [hard self] ${fact.playerId} ${fact.role}`;
  if (fact.kind === "heard") return `${fact.id} [unconfirmed heard] ${fact.meeting} ${fact.playerId || "?"}: ${sanitizeChat(fact.text)}`;
  return `${fact.id} [${fact.hard ? "hard" : "unconfirmed"} ${fact.kind}] ${fact.playerId || ""}`;
}

export function formatLedger(view, { limit = 40 } = {}) {
  const facts = view?.ledger?.facts || [];
  const shown = facts.slice(-limit);
  const lines = ["FACT LEDGER (known facts; a claim is not a confirmed role):"];
  if (!shown.length) {
    lines.push("none");
    return lines.join("\n");
  }
  if (facts.length > shown.length) lines.push(`(${facts.length - shown.length} earlier)`);
  for (const fact of shown) lines.push(formatFact(fact));
  return lines.join("\n");
}
