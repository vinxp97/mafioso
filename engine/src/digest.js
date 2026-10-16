// Rolling phase summary for one seat. Rewritten at phase boundaries and capped.
export const DIGEST_WORD_CAP = 150;

export function emptyDigest() {
  return { text: "", phase: "", source: "rules" };
}

export function digestWords(text) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

/** Keep the newest words. A rolling summary drops the oldest lines when it would grow past the cap. */
export function capWords(text, cap = DIGEST_WORD_CAP) {
  const words = digestWords(text);
  if (words.length <= cap) return words.join(" ");
  return words.slice(-cap).join(" ");
}

function list(items) {
  return items.length ? items.join(", ") : "none";
}

/** Append the phase that just ended, then cap. Claims are described as claims. */
export function rollDigest(previous, prevPhase, view) {
  const facts = (view?.ledger?.facts || []).filter((fact) => fact.phase === prevPhase);
  const deaths = facts.filter((fact) => fact.kind === "death").map((fact) => fact.playerId);
  const checks = facts.filter((fact) => fact.kind === "check").map((fact) => `${fact.playerId} ${fact.detail || fact.align}`);
  const claims = facts
    .filter((fact) => fact.kind === "claim" && fact.claimKind !== "retract")
    .map((fact) => `${fact.playerId} claims ${fact.role}`);
  const sentence = `${prevPhase} ended. Deaths: ${list(deaths)}. Checks: ${list(checks)}. Claims: ${list(claims)}. Now ${view?.phase?.name || "unknown"}.`;
  return capWords(`${previous || ""} ${sentence}`.trim());
}

export function formatDigest(view) {
  const text = view?.digest?.text?.trim();
  return `PHASE DIGEST: ${text || "none"}`;
}
