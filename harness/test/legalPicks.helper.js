// Shared by legalActions.test.js (g01-g16) and live1019Night5.test.js (L9-L10): walk a fixture seat by seat and,
// at every decision point (a seat with an open vote), check every vote the bots pick is server-legal and passes
// Vinman's rules: rules decide, rulesSeatActions (scum plans and the kill fallback), the rule bot, the selector over
// every server option (rule-refused and advised ones included), and llmDecide with a model that asks for each option.
import { reduce, emptyView, selfAlive, legalActions, serverAccepts, meetingActions, validateAction, decide, rulesSeatActions, ruleBotActions, selectAction, openDecisions, llmDecide, createSeededRng } from "mafioso-engine";

export async function picks(entries) {
  const views = {}; const seen = new Set(); const bad = []; let points = 0; let checked = 0;
  for (const e of entries) {
    const v = (views[e.accountId] = reduce(views[e.accountId] || emptyView(), e));
    if (!v.selfId || !selfAlive(v) || v.finished || !/^(Day|Night)$/.test(v.phase?.phase || "")) continue;
    if (!Object.values(v.meetings || {}).some((m) => m?.voting && m.amMember && m.canVote !== false && m.votes?.[v.selfId] == null)) continue;
    const open = legalActions(v).meetings.filter((m) => !m.closed && m.myVote == null && m.server.length);
    if (!open.length) continue;
    const key = `${e.accountId}|${v.stateId}|${(v.messages || []).length}|${Object.keys(v.dead || {}).length}|${JSON.stringify(Object.values(v.meetings).map((x) => x.votes))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points += 1;
    const where = `${e.accountId} ${v.phase.name} ${v.role}`;
    const check = (who, actions) => {
      for (const a of actions || []) {
        if (a?.event !== "vote") continue;
        checked += 1;
        const m = v.meetings[a.data.meetingId];
        const allowed = m ? meetingActions(v, m).allowed : [];
        if (!serverAccepts(v, a) || !allowed.includes(String(a.data.selection)) || !validateAction(v, a).ok) bad.push(`${where}: ${who} ${m?.name} ${a.data.selection}`);
      }
    };
    check("decide", decide(v, { rng: createSeededRng(7) }));
    check("rules", rulesSeatActions(v, { rng: createSeededRng(7), now: e.t }).actions);
    check("rulebot", ruleBotActions(v, { seed: 7, now: e.t }).actions);
    const decisions = openDecisions(v).filter((d) => d.kind === "night-target" || d.kind === "day-vote");
    const candidates = open.flatMap((m) => m.server.map((target) => ({ kind: v.phase.phase === "Night" && m.name !== "Village" ? "night-target" : "day-vote", decisionId: `x:${m.meetingId}`, meetingId: m.meetingId, target, reason: "replay" })));
    check("selector", selectAction(v, candidates, { seed: 7, decisions }).actions);
    // The model asks for every rule-refused or advised option, the first option, and one the server never offered.
    for (const m of open) for (const target of [...new Set([...Object.keys(m.notes), m.server[0], "p99"])]) {
      const res = await llmDecide(v, { complete: async () => JSON.stringify({ action: "vote", meeting: m.meetingId, target }), maxRetries: 0, memory: false, now: e.t, rng: createSeededRng(7) });
      check(`llm(${target})`, res.actions);
    }
  }
  return { points, checked, bad };
}
