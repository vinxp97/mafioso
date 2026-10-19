// Certain role-claim extraction (regex only, no LLM). Adapted from
// UM-Autobot-Player/src/claims.js extractCertainClaims + mentions.js ROLE_ALIASES (trimmed).
export const ROLE_ALIASES = {
  "Town Crier": ["town crier", "crier", "tc"], Oracle: ["oracle", "orc"], Caroler: ["caroler"],
  Cop: ["cop"], Journalist: ["journalist", "journo"], Sheriff: ["sheriff"], Doctor: ["doctor", "doc"], Hooker: ["hooker", "rb"],
  Janitor: ["janitor", "jan"], Mafioso: ["mafioso"], Godfather: ["godfather", "gf"],
  Tracker: ["tracker"], Watcher: ["watcher"], Villager: ["villager", "blue", "vt", "v/t"],
};

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function aliasMap(roles) {
  const allow = roles?.length ? new Set(roles.map((r) => String(r).split(":")[0])) : null;
  const map = new Map();
  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) {
    if (allow && !allow.has(role)) continue;
    for (const a of [role.toLowerCase(), ...aliases]) if (!map.has(a)) map.set(a, role);
  }
  for (const r of allow || []) if (!map.has(r.toLowerCase())) map.set(r.toLowerCase(), r);
  return map;
}

/** @returns {{playerId:string, role:string, kind:'claim'|'cc'|'retract', quote:string}|null} */
export function extractClaim(message, roles) {
  if (!message || !message.senderId || ["server", "anonymous"].includes(message.senderId)) return null;
  const text = String(message.content || "").trim();
  if (!text) return null;
  const map = aliasMap(roles);
  const alt = [...map.keys()].sort((a, b) => b.length - a.length).map(esc).join("|");
  const tries = [
    ["retract", String.raw`\b(?:retract(?:ing)?|unclaim(?:ing)?)\s+(?:as\s+)?(?:the\s+)?(${alt})\b`],
    ["cc", String.raw`\b(?:cc(?:ing)?|counter[- ]?claim(?:ing)?)\s+(?:as\s+)?(?:the\s+)?(${alt})\b`],
    // "claiming cop" is a claim only in the first person or opening the line: "player08 claiming cop feels
    // suspicious" (L5 replay, 10/18) is about someone else, and tagged the speaker as a Cop claimer.
    ["claim", String.raw`(?:\bi(?:['’]?m| am)|(?:^|[.!?]\s*|\bi(?:['’]?m| am| will|['’]ll)?\s+)claim(?:ing)?(?:\s+as)?)\s+(?:a\s+|an\s+|the\s+)?(${alt})\b`],
    ["soft", String.raw`\b(?:might be|could be|maybe)\s+(?:a\s+|an\s+|the\s+)?(${alt})\b`],
  ];
  for (const [kind, re] of tries) {
    const m = text.match(new RegExp(re, "i"));
    if (m) return { playerId: message.senderId, role: map.get(m[1].toLowerCase()), kind, quote: text.slice(0, 120) };
  }
  return null;
}

/** Pure: ClaimBoard = {[playerId]: {role, kind, history:[...]}}. Retract clears. */
export function reduceClaims(board, message, roles) {
  const c = extractClaim(message, roles);
  if (!c) return board;
  const next = { ...board };
  const prev = next[c.playerId]?.history || [];
  next[c.playerId] = c.kind === "retract"
    ? { role: null, kind: "retract", history: [...prev, c] }
    : { role: c.role, kind: c.kind, history: [...prev, c] };
  return next;
}
