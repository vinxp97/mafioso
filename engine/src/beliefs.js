// One seat's private reads. Every entry cites FactLedger ids. Hard checks and reveals win.
import { alignmentOf } from "./faction.js";
import { defang } from "./sanitize.js";

const LABELS = new Set(["confirmed", "likely", "possible", "unlikely", "claimed"]);

export function emptyBeliefs() {
  return { entries: {}, rejected: [], source: "rules", phase: "" };
}

export function isLiving(view, id) {
  const player = view?.players?.[id];
  return !!player && !player.left && !view.dead?.[id];
}

export function beliefAlign(role) {
  if (/^(village|town|villager)$/i.test(String(role || ""))) return "Village";
  if (/^mafia$/i.test(String(role || ""))) return "Mafia";
  if (/^cult$/i.test(String(role || ""))) return "Cult";
  return alignmentOf(role);
}

function hardProfile(view, playerId) {
  let align = null;
  let role = null;
  for (const fact of view?.ledger?.facts || []) {
    if (!fact.hard || fact.playerId !== playerId) continue;
    if (fact.kind === "check") {
      if (fact.align) align = fact.align;
      if (fact.role) role = fact.role;
    } else if (fact.kind === "reveal" || fact.kind === "self") {
      if (fact.role) role = fact.role;
      const next = alignmentOf(fact.role);
      if (next) align = next;
    }
  }
  return { align, role };
}

/** Empty string when the role is allowed. A Town check cannot be read as Mafia. */
export function contradictionReason(view, playerId, role) {
  const hard = hardProfile(view, playerId);
  const align = beliefAlign(role);
  if (hard.role && alignmentOf(role) && String(role).toLowerCase() !== String(hard.role).toLowerCase()) {
    return `contradicts hard role ${hard.role}`;
  }
  if (hard.align && align && align !== hard.align) return `contradicts hard alignment ${hard.align}`;
  return "";
}

function fail(playerId, reason) {
  return { ok: false, reason, playerId: playerId || "" };
}

function labelFromProbability(probability) {
  if (probability >= 0.85) return "confirmed";
  if (probability >= 0.6) return "likely";
  if (probability >= 0.3) return "possible";
  return "unlikely";
}

/** Accept one belief or reject it. Missing ids and hard contradictions do not enter the board. */
export function judgeBelief(view, raw) {
  const playerId = String(raw?.playerId || raw?.id || "").trim();
  if (!playerId || !view?.players?.[playerId]) return fail(playerId, "unknown player");
  if (!isLiving(view, playerId)) return fail(playerId, "not a living player");
  const role = String(raw?.role || "").trim();
  if (!role || role.length > 40) return fail(playerId, "missing role");
  let probability = null;
  if (raw?.probability != null && raw.probability !== "") {
    const n = Number(raw.probability);
    if (!Number.isFinite(n) || n < 0 || n > 1) return fail(playerId, "probability out of range");
    probability = n;
  }
  let label = String(raw?.label || "").toLowerCase();
  if (!LABELS.has(label)) {
    if (probability == null) return fail(playerId, "need a label or probability");
    label = labelFromProbability(probability);
  }
  const reliability = raw?.reliability;
  if (!Number.isInteger(reliability) || reliability < 1 || reliability > 10) return fail(playerId, "reliability must be an integer 1-10");
  const reason = defang(raw?.reason, 180);
  if (!reason) return fail(playerId, "missing reason");
  const evidence = [...new Set((Array.isArray(raw?.evidence) ? raw.evidence : []).map((id) => String(id).trim()).filter(Boolean))];
  if (!evidence.length) return fail(playerId, "missing evidence");
  const ids = new Set((view.ledger?.facts || []).map((fact) => fact.id));
  const missing = evidence.filter((id) => !ids.has(id));
  if (missing.length) return fail(playerId, `missing evidence ${missing.join(",")}`);
  const contradiction = contradictionReason(view, playerId, role);
  if (contradiction) return fail(playerId, contradiction);
  return {
    ok: true,
    belief: { playerId, role, label, probability, reliability, reason, evidence },
  };
}

export function judgeBeliefs(view, list) {
  const entries = {};
  const rejected = [];
  for (const raw of list || []) {
    const judged = judgeBelief(view, raw);
    if (!judged.ok) rejected.push({ playerId: judged.playerId, reason: judged.reason });
    else entries[judged.belief.playerId] = judged.belief;
  }
  return { entries, rejected };
}

function latest(facts, pred) {
  for (let i = facts.length - 1; i >= 0; i--) if (pred(facts[i])) return facts[i];
  return null;
}

function roleFromCheck(fact) {
  if (fact.role) return fact.role;
  if (alignmentOf(fact.detail)) return fact.detail;
  if (fact.align === "Village") return "Town";
  if (fact.align === "Mafia") return "Mafia";
  if (fact.align === "Cult") return "Cult";
  return fact.detail || fact.align || "unknown";
}

function rulesBeliefFor(view, playerId, facts) {
  const reveal = latest(facts, (fact) => fact.hard && fact.playerId === playerId && (fact.kind === "reveal" || (fact.kind === "self" && playerId === view.selfId)));
  if (reveal?.role && !contradictionReason(view, playerId, reveal.role)) {
    return {
      playerId, role: reveal.role, label: "confirmed", probability: 0.99, reliability: 10,
      reason: reveal.kind === "self" ? "own role" : "server reveal", evidence: [reveal.id],
    };
  }
  const check = latest(facts, (fact) => fact.kind === "check" && fact.hard && fact.playerId === playerId);
  if (check) {
    const role = roleFromCheck(check);
    if (!contradictionReason(view, playerId, role)) {
      return {
        playerId, role, label: "confirmed", probability: 0.95, reliability: 10,
        reason: `server check ${check.detail || check.align}`, evidence: [check.id],
      };
    }
  }
  const claim = latest(facts, (fact) => fact.kind === "claim" && fact.playerId === playerId);
  if (claim?.role && claim.claimKind !== "retract" && !contradictionReason(view, playerId, claim.role)) {
    const soft = claim.claimKind === "soft";
    return {
      playerId, role: claim.role, label: soft ? "possible" : "claimed", probability: soft ? 0.25 : 0.4,
      reliability: soft ? 3 : 4, reason: `said they are ${claim.role}`, evidence: [claim.id],
    };
  }
  return null;
}

/** Structured fallback. Only living players, and only when a ledger fact supports the read. */
export function rulesBeliefBoard(view) {
  const facts = view?.ledger?.facts || [];
  const entries = {};
  for (const id of Object.keys(view?.players || {})) {
    if (!isLiving(view, id)) continue;
    const belief = rulesBeliefFor(view, id, facts);
    if (belief) entries[id] = belief;
  }
  return { entries, rejected: [], source: "rules", phase: view?.phase?.name || "" };
}

/** Drop dead players, missing evidence, and reads that fight a hard fact. */
export function enforceBoard(view) {
  if (!view.beliefs) view.beliefs = emptyBeliefs();
  const entries = {};
  const rejected = [...(view.beliefs.rejected || [])];
  const ids = new Set((view.ledger?.facts || []).map((fact) => fact.id));
  for (const [id, belief] of Object.entries(view.beliefs.entries || {})) {
    if (!isLiving(view, id)) {
      rejected.push({ playerId: id, reason: "not a living player" });
      continue;
    }
    const missing = (belief?.evidence || []).filter((factId) => !ids.has(factId));
    if (!belief?.evidence?.length || missing.length) {
      rejected.push({ playerId: id, reason: missing.length ? `missing evidence ${missing.join(",")}` : "missing evidence" });
      continue;
    }
    const why = contradictionReason(view, id, belief.role);
    if (why) {
      rejected.push({ playerId: id, reason: why });
      continue;
    }
    entries[id] = belief;
  }
  view.beliefs = { ...view.beliefs, entries, rejected };
  return view;
}

export function formatBeliefs(view) {
  const entries = Object.values(view?.beliefs?.entries || {});
  const lines = ["BELIEF BOARD (this seat only):"];
  if (!entries.length) {
    lines.push("none");
    return lines.join("\n");
  }
  for (const belief of entries) {
    const probability = belief.probability == null ? "" : ` probability=${belief.probability}`;
    lines.push(`${belief.playerId} ${belief.label} ${belief.role}${probability} reliability=${belief.reliability} evidence=${belief.evidence.join(",")} — ${belief.reason}`);
  }
  return lines.join("\n");
}
