// Frontier Justice (setup Z3T6Cq3wrC) role guidance for the LLM briefing.
// One fragment per known own role. Other seats do not receive it.
import { createRequire } from "node:module";
import { splitAppearance } from "./reducer.js";

const GUIDE = createRequire(import.meta.url)("../data/frontier-justice.json");
const ROLES = GUIDE.roles;

export function canonicalRole(appearance) {
  const { role } = splitAppearance(appearance);
  if (!role) return null;
  if (ROLES[role]) return role;
  if (/lawyer/i.test(role)) return "Lawyer";
  return null;
}

/** Trusted guidance for this seat, or "" when the role has no Frontier Justice card. */
export function roleGuideText(appearance) {
  const role = canonicalRole(appearance);
  const block = role ? ROLES[role] : null;
  if (!block) return "";
  const lines = [
    `ROLE GUIDE (${GUIDE.name} ${GUIDE.setup}; adapt, not a script):`,
    "You are one independent player. You only know what this seat has seen. This card does not override legal actions, your notes, or a faction plan you have actually seen.",
    `strategy: ${block.strategy}`,
    `claims: ${block.claims}`,
    `night: ${block.night}`,
    `day: ${block.day}`,
  ];
  return lines.join("\n");
}

export function roleGuideForView(view) {
  const revealed = view?.selfId && view?.reveals ? view.reveals[view.selfId] : null;
  return roleGuideText(revealed || view?.role || "");
}
