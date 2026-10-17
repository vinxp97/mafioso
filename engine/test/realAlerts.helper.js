// Runs the real-alert fixtures (test/fixtures/real-alerts.json) through an engine's parsers.
// Shared by test/realAlerts.test.js and by before/after measurement against older checkouts.
const NAMES = ["Ash", "Bea", "Cal", "Dot", "Eli", "Fin", "Gil", "Hap", "Ivo", "Jo", "Kit", "Lu", "Max", "Ned", "Oz", "Pia", "Quin", "Rex", "Sol", "Tam"];
export const players = Object.fromEntries([["me", { id: "me", name: "Me" }], ...NAMES.map((n) => [n.toLowerCase(), { id: n.toLowerCase(), name: n }])]);
const ALIGN = { innocent: "Village", village: "Village", guilty: "Mafia", mafia: "Mafia", cult: "Cult" };

/** @returns {{ok:boolean, got:any}} */
export function checkFixture(fx, { parseServerInfo, cleanedRoles }) {
  const view = { selfId: "me", players, messages: [], dead: {} };
  const data = { senderId: fx.sender === "player" ? "ash" : "server", content: fx.text };
  const e = fx.expected;
  if (fx.category === "janitor") {
    const got = cleanedRoles({ ...view, messages: [data] });
    return { ok: got[e.target.toLowerCase()] === e.role, got };
  }
  const r = parseServerInfo(view, data);
  const got = r && { playerId: r.playerId, detail: r.detail, align: r.align, role: r.role };
  if (e === null) return { ok: r === null, got };
  if (!r || r.playerId !== e.target.toLowerCase()) return { ok: false, got };
  if (fx.category === "cop-alignment") {
    const want = ALIGN[e.result.toLowerCase()] || "";
    return { ok: String(r.detail).toLowerCase() === e.result.toLowerCase() && (r.align || "") === want, got };
  }
  if (fx.category === "cop-role") {
    if (e.role) return { ok: r.detail === e.role, got };
    return { ok: r.detail === e.detail && !/^(Village|Mafia)$/.test(r.align || ""), got }; // "not X, or Y" is no read
  }
  if (/^journalist/.test(fx.category)) {
    const detailOk = e.detail === "no reports" ? r.detail === "no reports" : /^reports?:/.test(r.detail);
    return { ok: detailOk && (r.role === "Janitor") === e.janitor && !r.align, got };
  }
  return { ok: false, got };
}
