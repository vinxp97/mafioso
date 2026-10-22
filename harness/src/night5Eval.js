// Night 5 evaluation of one live game log (the stderr of scripts/live.mjs / scripts/mac-container-run.sh).
// Pure: parseLiveLog(text) -> events, evaluateLog(text) -> report. Judged from the angle of ONE bot among
// humans in a normal lobby: per-seat speech success, what the chat checker throws away, how human the timing
// is, and whether the five Night 5 claim rules held. No secrets are read or printed (the log is redacted).
const LINE = {
  send: /^send (\S+) \[([^\]]*)\] t=(\d+) (speak|vote) (\S+) (.*?) source=(\S+) prompt=/,
  chat: /^chat \[([^\]]*)\] (\S+) ([^:]+): "(.*)" t=(\d+)\s*$/,
  reject: /^speech-reject (\S+) \[([^\]]*)\] source=(\S+) reasons=(\[.*?\])(?: line=(".*"))?\s*$/,
  meeting: /^meeting (\S+) \[([^\]]*)\] (\S+) name="([^"]*)"/,
  alert: /^alert (\S+) \[([^\]]*)\] kind=(\S+) target="([^"]*)" result="(.*)"\s*$/,
  game: /^game (\S+) accounts=(\S+)/,
  seatmap: /^seatmap (.*)$/,
  delay: /^sheriff-claim-delay (\S+) \[([^\]]*)\] ms=(\d+) due=(\d+)/,
  end: /^game_end status=(\S+)(?: reason=(\S+))? game=(\S+)(?: winner=(\S+))?/,
  seatError: /^seat-error (\S+) (.*)$/,
  ballotNet: /^ballot-net (\S+) \[([^\]]*)\] t=(\d+) pick=(\S+) why=(.*)$/,
};
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function parseLiveLog(text) {
  const out = { game: null, accounts: [], seats: {}, sends: [], chats: [], rejects: [], meetings: [], alerts: [], delays: [], end: null, seatErrors: [], ballotNets: [] };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const l = raw.trimEnd();
    let m;
    if ((m = LINE.send.exec(l))) {
      const [, acct, phase, t, event, meetingId, rest, source] = m;
      const content = event === "speak" ? json(rest.trim(), rest.trim()) : null;
      out.sends.push({ acct, phase, t: Number(t), event, meetingId, content, selection: event === "vote" ? rest.trim() : null, source });
    } else if ((m = LINE.chat.exec(l))) out.chats.push({ phase: m[1], meeting: m[2], name: m[3], content: json(`"${m[4]}"`, m[4]), t: Number(m[5]) });
    else if ((m = LINE.reject.exec(l))) out.rejects.push({ acct: m[1], phase: m[2], source: m[3], reasons: json(m[4], [m[4]]), line: m[5] ? json(m[5], m[5]) : null });
    else if ((m = LINE.meeting.exec(l))) out.meetings.push({ acct: m[1], phase: m[2], id: m[3], name: m[4] });
    else if ((m = LINE.alert.exec(l))) out.alerts.push({ acct: m[1], phase: m[2], kind: m[3], target: m[4], result: m[5] });
    else if ((m = LINE.game.exec(l))) { out.game = m[1]; out.accounts = m[2].split(","); }
    else if ((m = LINE.seatmap.exec(l))) {
      for (const [, slot, pid, name] of m[1].matchAll(/s(\d+)=([^:\s]+):"([^"]*)"/g)) out.seats[out.accounts[Number(slot) - 1] || `s${slot}`] = { playerId: pid, name };
    } else if ((m = LINE.delay.exec(l))) out.delays.push({ acct: m[1], phase: m[2], ms: Number(m[3]), due: Number(m[4]) });
    else if ((m = LINE.end.exec(l))) out.end = { status: m[1], reason: m[2] || null, game: m[3], winner: m[4] || null };
    else if ((m = LINE.seatError.exec(l))) out.seatErrors.push({ acct: m[1], what: m[2].slice(0, 200) });
    else if ((m = LINE.ballotNet.exec(l))) out.ballotNets.push({ acct: m[1], phase: m[2], t: Number(m[3]), pick: m[4], why: m[5] });
  }
  return out;
}

const stat = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, min: v[0], median: q(0.5), p90: q(0.9), max: v[v.length - 1], mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
};
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const isLlm = (src) => /^llm\b/.test(String(src || ""));
/** "chat-audit: CONTRADICTION dead-sus (calls x sus...)" -> "chat-audit: CONTRADICTION dead-sus"; held-at-send folded in. */
export function reasonKey(r) {
  return String(r || "?").replace(/^held line invalid at send:\s*/, "").replace(/\s*\(.*$/, "").replace(/\s+\d+s\b.*$/, "").replace(/: OpenRouter POST.*$/, ": backend error").trim();
}
const COP_CLAIM = /\b(?:i'?m|im|i am)\s+(?:the\s+)?(?:real\s+)?cop\b/i;
const RESULT_LINE = /^\s*(?:results?\s*[:\-–]|[A-Za-z0-9_'.-]{2,}\s+(?:is\s+)?(?:guilty|inno|innocent)\b)/i;
const ROLE_CLAIM = /\b(?:i'?m|im|i am)\s+(?:(?:a|an|the|just|only|plain|real)\s+)*(cop|journalist|sheriff|doctor|villager|vt|v\/t|blue|town|townie|vanilla)\b|^\s*(blue|villager|vt)\b/i;
const VT = /(^|[^A-Za-z0-9_/])(v\/t|vt)s?(?![A-Za-z0-9_/])/i;
const ASK = /\b(claim\??|claiming|role|what are you|whats your role|what'?s your role)\b/i;

/**
 * The report. roles: inferred from meetings and alerts (Sheriff = Shoot Gun meeting, Cop / Journalist / Janitor
 * from alerts, Mafia = Mafia Meeting). Timing is from the bots' own send times (ms, the Mac's clock).
 */
export function evaluateLog(text, { phaseStarts = null } = {}) {
  const L = parseLiveLog(text);
  const name = (acct) => L.seats[acct]?.name || acct;
  const acctByName = Object.fromEntries(Object.entries(L.seats).map(([a, s]) => [s.name.toLowerCase(), a]));
  const role = {};
  const gunMeetings = new Set(), villageMeetings = new Set();
  for (const m of L.meetings) {
    if (/shoot gun|^gun$/i.test(m.name)) { role[m.acct] = "Sheriff"; gunMeetings.add(m.id); }
    if (/^village$/i.test(m.name)) villageMeetings.add(m.id);
    if (/^investigate$/i.test(m.name)) role[m.acct] ||= "Cop";
    if (/receive reports/i.test(m.name)) role[m.acct] ||= "Journalist";
    if (/clean death/i.test(m.name)) role[m.acct] = "Janitor";
    if (/litigate/i.test(m.name)) role[m.acct] = "Lawyer";
    if (/mafia (meeting|kill)/i.test(m.name)) role[m.acct] ||= "Mafia";
  }
  for (const a of L.alerts) if (a.kind === "cop") role[a.acct] = "Cop"; else if (a.kind === "journalist") role[a.acct] = "Journalist"; else if (a.kind === "janitor") role[a.acct] = "Janitor";
  const mafia = new Set(Object.entries(role).filter(([, r]) => /Mafia|Janitor|Lawyer|Mafioso/.test(r)).map(([a]) => a));
  for (const m of L.meetings) if (/mafia (meeting|kill)/i.test(m.name)) mafia.add(m.acct);
  const pub = L.sends.filter((s) => s.event === "speak" && villageMeetings.has(s.meetingId));

  // ---- speech success ----
  const llmSent = pub.filter((s) => isLlm(s.source));
  const llmRejects = L.rejects.filter((r) => isLlm(r.source));
  const attemptKeys = new Set();
  for (const r of llmRejects) attemptKeys.add(r.line ? `${r.acct}|${r.phase}|${r.line}` : `${r.acct}|${r.phase}|#${attemptKeys.size}`);
  for (const s of llmSent) attemptKeys.delete(`${s.acct}|${s.phase}|${s.content}`);
  const attempts = attemptKeys.size + llmSent.length;
  const byReason = {}, auditByRule = {}, allByReason = {};
  for (const r of L.rejects) for (const why of r.reasons) {
    const k = reasonKey(why);
    allByReason[k] = (allByReason[k] || 0) + 1;
    if (isLlm(r.source)) byReason[k] = (byReason[k] || 0) + 1;
    if (/^chat-audit/.test(k)) auditByRule[k.replace(/^chat-audit:\s*/, "")] = (auditByRule[k.replace(/^chat-audit:\s*/, "")] || 0) + 1;
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  const bySource = {};
  for (const s of pub) { const k = s.source.replace(/\+.*$/, ""); bySource[k] = (bySource[k] || 0) + 1; }

  // ---- phase starts (ms): the sheriff-claim-delay log when present, else the last send/chat of the phase before ----
  const starts = { ...(phaseStarts || {}) };
  for (const d of L.delays) starts[d.phase] ??= d.due - d.ms;
  const timeline = [...L.sends.map((s) => ({ phase: s.phase, t: s.t })), ...L.chats.map((c) => ({ phase: c.phase, t: c.t }))].sort((a, b) => a.t - b.t);
  const phasesInOrder = [...new Set(timeline.map((x) => x.phase))];
  for (let i = 1; i < phasesInOrder.length; i++) {
    const p = phasesInOrder[i];
    if (starts[p] != null) continue;
    const prev = timeline.filter((x) => x.phase === phasesInOrder[i - 1]).map((x) => x.t);
    if (prev.length) starts[p] = Math.max(...prev);
  }
  const startsExact = Object.fromEntries(L.delays.map((d) => [d.phase, true]));

  // ---- public lines in order, with speaker account (ours) ----
  const lines = pub.map((s) => ({ ...s, who: s.acct, speaker: name(s.acct) })).sort((a, b) => a.t - b.t);
  const chatLines = L.chats.filter((c) => /village/i.test(c.meeting));
  const human = chatLines.filter((c) => !acctByName[c.name.toLowerCase()]);

  // ---- 4) Sheriff claim delay ----
  const sheriffAccts = Object.keys(role).filter((a) => role[a] === "Sheriff");
  const sheriffClaims = lines.filter((s) => sheriffAccts.includes(s.acct) && /\b(?:i'?m|im|i am)\s+(?:the\s+)?sheriff\b/i.test(String(s.content)));
  const firstClaim = sheriffClaims[0];
  const sheriffDelay = firstClaim ? { phase: firstClaim.phase, ms: starts[firstClaim.phase] != null ? firstClaim.t - starts[firstClaim.phase] : null, exact: !!startsExact[firstClaim.phase], logged: L.delays[0]?.ms ?? null } : null;
  if (sheriffDelay) sheriffDelay.ok = sheriffDelay.ms != null && sheriffDelay.ms >= 1000 && sheriffDelay.ms <= 10_500;

  // ---- asks, answers, counterclaims ----
  const asks = [];
  for (const s of lines.filter((x) => sheriffAccts.includes(x.acct) && ASK.test(String(x.content)) && !/\bsheriff\b/i.test(String(x.content)))) {
    const target = Object.keys(acctByName).find((n) => new RegExp(`(^|[^a-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i").test(String(s.content)));
    if (!target) continue;
    const tAcct = acctByName[target];
    const reply = lines.find((x) => x.acct === tAcct && x.t > s.t && x.phase === s.phase && ROLE_CLAIM.test(String(x.content)));
    const roleWord = reply ? (String(reply.content).match(ROLE_CLAIM) || [])[1] || (String(reply.content).match(ROLE_CLAIM) || [])[2] : null;
    const kind = !roleWord ? null : /cop|journalist|sheriff|doctor/i.test(roleWord) ? "power" : "villager";
    const shot = L.sends.find((x) => x.event === "vote" && gunMeetings.has(x.meetingId) && x.acct === s.acct && x.phase === s.phase && x.t >= s.t);
    asks.push({ phase: s.phase, at: s.t, target: L.seats[tAcct]?.name || target, targetAcct: tAcct, targetMafia: mafia.has(tAcct), reply: reply ? { t: reply.t, content: reply.content, latencyMs: reply.t - s.t, kind, role: roleWord?.toLowerCase() } : null,
      shot: shot ? { t: shot.t, target: name(Object.keys(L.seats).find((a) => L.seats[a].playerId === shot.selection)) || shot.selection, sinceReplyMs: reply ? shot.t - reply.t : null } : null });
  }
  const gunShots = L.sends.filter((x) => x.event === "vote" && gunMeetings.has(x.meetingId)).map((x) => ({ phase: x.phase, t: x.t, target: name(Object.keys(L.seats).find((a) => L.seats[a].playerId === x.selection)) || x.selection, source: x.source, sinceDayStartMs: starts[x.phase] != null ? x.t - starts[x.phase] : null }));
  const vtAnswers = asks.filter((a) => a.reply?.kind === "villager");
  const rule1 = vtAnswers.map((a) => ({ phase: a.phase, target: a.target, shotSame: a.shot?.target === a.target, shot: a.shot?.target || null, waitedMs: a.shot ? a.shot.t - a.reply.t : null, ok: !a.shot || a.shot.t - a.reply.t >= 12_000 || a.shot.target !== a.target }));
  const powerAnswers = asks.filter((a) => a.reply?.kind === "power" && /cop|journalist/.test(a.reply.role || ""));
  const ccs = [];
  for (const a of powerAnswers) {
    const re = new RegExp(`\\b(?:i'?m|im|i am)\\s+(?:the\\s+)?(?:real\\s+)?${a.reply.role}\\b`, "i");
    const counter = lines.filter((x) => x.acct !== a.targetAcct && x.t > a.reply.t && x.phase === a.phase && re.test(String(x.content)));
    ccs.push({ phase: a.phase, target: a.target, role: a.reply.role, targetMafia: a.targetMafia, mafiaCCs: counter.filter((x) => mafia.has(x.acct)).map((x) => ({ by: name(x.acct), delayMs: x.t - a.reply.t, content: x.content })), townCCs: counter.filter((x) => !mafia.has(x.acct)).map((x) => ({ by: name(x.acct), delayMs: x.t - a.reply.t })) });
  }
  const rule2 = ccs.map((c) => ({ ...c, ok: c.targetMafia ? c.mafiaCCs.length === 0 : c.mafiaCCs.length === 1 && c.mafiaCCs[0].delayMs >= 2_000 && c.mafiaCCs[0].delayMs <= 10_000 }));

  // ---- 3) Cop one line ----
  const copLines = {};
  for (const s of lines) {
    const c = String(s.content);
    if (!COP_CLAIM.test(c) && !RESULT_LINE.test(c)) continue;
    if (!COP_CLAIM.test(c) && !(role[s.acct] === "Cop" || lines.some((x) => x.acct === s.acct && COP_CLAIM.test(String(x.content)) && x.t <= s.t))) continue;
    ((copLines[`${name(s.acct)}|${s.phase}`] ||= [])).push(c);
  }
  const rule3 = Object.entries(copLines).map(([k, ls]) => { const [who, phase] = k.split("|"); return { who, phase, lines: ls, ok: ls.length === 1 && !ls.some((x) => /\n/.test(x)) }; });

  // ---- 5) vt ----
  const vtLines = lines.filter((s) => VT.test(String(s.content))).map((s) => ({ who: name(s.acct), phase: s.phase, content: s.content, source: s.source }));
  const vtBlocked = L.rejects.filter((r) => r.reasons.some((x) => /vt|villager or blue/i.test(x))).length;

  // ---- timing: reply beat (a bot line after the last other public line), our line gaps ----
  const allPublic = [...lines.map((s) => ({ who: s.speaker, t: s.t, ours: true, source: s.source, phase: s.phase })), ...human.map((c) => ({ who: c.name, t: c.t, ours: false, phase: c.phase }))].sort((a, b) => a.t - b.t);
  const beat = [], llmBeat = [];
  for (let i = 1; i < allPublic.length; i++) {
    const x = allPublic[i];
    if (!x.ours) continue;
    const prev = allPublic.slice(0, i).reverse().find((y) => y.who !== x.who && y.phase === x.phase);
    if (!prev) continue;
    beat.push(x.t - prev.t);
    if (isLlm(x.source)) llmBeat.push(x.t - prev.t);
  }
  const sameSecond = beat.filter((d) => d < 1000).length;

  // ---- per seat (one bot among humans): lines per day, model share ----
  const days = [...new Set(lines.map((s) => s.phase).filter((p) => /^Day/.test(p)))];
  const perSeat = Object.keys(L.seats).map((a) => {
    const mine = lines.filter((s) => s.acct === a && /^Day/.test(s.phase));
    return { seat: name(a), role: role[a] || "Villager?", lines: mine.length, llm: mine.filter((s) => isLlm(s.source)).length, perDay: days.length ? Math.round((10 * mine.length) / days.length) / 10 : 0 };
  });

  // ---- illegal / refused ----
  const illegal = { seatErrors: L.seatErrors.length, seatErrorSamples: L.seatErrors.slice(0, 3).map((e) => e.what), ballotNet: L.ballotNets.length, voteKick: L.ballotNets.filter((b) => /vote kick|vote-kick/i.test(b.why)).length,
    gunRejects: L.rejects.filter((r) => r.reasons.some((x) => /sheriff shot/i.test(x))).length, d1Shot: gunShots.some((g) => g.phase === "Day 1") || !sheriffAccts.length };

  return {
    game: L.game, end: L.end, seats: Object.keys(L.seats).length, humanLines: human.length, roles: Object.fromEntries(Object.entries(role).map(([a, r]) => [name(a), r])),
    speech: { llmAttempts: attempts, llmSent: llmSent.length, llmSuccessPct: pct(llmSent.length, attempts), publicSent: pub.length, bySource: sorted(bySource), llmRejectsByReason: sorted(byReason), chatAuditByRule: sorted(auditByRule), allRejectsByReason: sorted(allByReason) },
    timing: { phaseStarts: starts, sheriffClaim: sheriffDelay, gunShots, askReply: stat(asks.map((a) => a.reply?.latencyMs)), replyBeatMs: stat(beat), llmReplyBeatMs: stat(llmBeat), linesUnder1sAfterAnother: sameSecond, mafiaCcDelayMs: stat(ccs.flatMap((c) => c.mafiaCCs.map((x) => x.delayMs))) },
    rules: {
      r1_sheriffVsVillager: { cases: rule1, ok: rule1.every((r) => r.ok) },
      r2_mafiaCounterclaim: { cases: rule2, ok: rule2.every((r) => r.ok) },
      r3_copOneLine: { cases: rule3, ok: rule3.every((r) => r.ok) },
      r4_sheriffDelay: { case: sheriffDelay, ok: !sheriffDelay || !!sheriffDelay.ok },
      r5_noVt: { sent: vtLines, blockedAtSend: vtBlocked, ok: vtLines.length === 0 },
    },
    asks, perSeat, illegal,
  };
}

/** A short text summary of a report (the markdown the Night 5 notes quote). */
export function summarize(r) {
  const s = r.speech, t = r.timing, R = r.rules;
  const top = (o, n = 6) => Object.entries(o).slice(0, n).map(([k, v]) => `${k} ${v}`).join("; ") || "none";
  const fmt = (x) => (x?.n ? `median ${(x.median / 1000).toFixed(1)}s, p90 ${(x.p90 / 1000).toFixed(1)}s (n=${x.n})` : "n/a");
  return [
    `game ${r.game} ${r.end ? `${r.end.status}${r.end.winner ? ` winner=${r.end.winner}` : ""}` : "(no end line)"}; ${r.seats} bot seats, ${r.humanLines} non-bot public lines`,
    `speech: LLM ${s.llmSent}/${s.llmAttempts} sent (${s.llmSuccessPct ?? "n/a"}%); public lines ${s.publicSent} by source: ${top(s.bySource, 10)}`,
    `LLM rejects by reason: ${top(s.llmRejectsByReason, 8)}`,
    `chat checker (chat-audit) by rule: ${top(s.chatAuditByRule, 8)}`,
    `timing: sheriff claim ${t.sheriffClaim ? `${t.sheriffClaim.ms == null ? "?" : (t.sheriffClaim.ms / 1000).toFixed(1)}s after day start${t.sheriffClaim.exact ? "" : " (approx: from the last event of the night)"}` : "n/a"}; ask->answer ${fmt(t.askReply)}; reply beat ${fmt(t.replyBeatMs)}; LLM reply beat ${fmt(t.llmReplyBeatMs)}; ${t.linesUnder1sAfterAnother} bot lines <1s after another speaker; mafia CC delay ${fmt(t.mafiaCcDelayMs)}`,
    `gun: ${t.gunShots.map((g) => `${g.phase} -> ${g.target}${g.sinceDayStartMs != null ? ` at ${(g.sinceDayStartMs / 1000).toFixed(0)}s` : ""}`).join(", ") || "none"}`,
    `rule 1 (sheriff vs villager answer): ${R.r1_sheriffVsVillager.cases.length ? R.r1_sheriffVsVillager.cases.map((c) => `${c.target}: shot ${c.shot || "-"}${c.waitedMs != null ? ` after ${(c.waitedMs / 1000).toFixed(1)}s` : ""}${c.ok ? "" : " FAIL"}`).join("; ") : "no case"}`,
    `rule 2 (mafia CC on asked Cop/Journalist): ${R.r2_mafiaCounterclaim.cases.length ? R.r2_mafiaCounterclaim.cases.map((c) => `${c.target} (${c.role}${c.targetMafia ? ", mafia" : ""}): mafia CC ${c.mafiaCCs.length}${c.mafiaCCs[0] ? ` +${(c.mafiaCCs[0].delayMs / 1000).toFixed(1)}s` : ""}, town CC ${c.townCCs.length}${c.ok ? "" : " FAIL"}`).join("; ") : "no case"}`,
    `rule 3 (cop one line): ${R.r3_copOneLine.cases.map((c) => `${c.who} ${c.phase}: ${c.lines.length} line(s)${c.ok ? "" : " FAIL"}`).join("; ") || "no cop lines"}`,
    `rule 4 (sheriff delay 1-10s): ${R.r4_sheriffDelay.ok ? "ok" : "FAIL"}${R.r4_sheriffDelay.case?.ms != null ? ` (${(R.r4_sheriffDelay.case.ms / 1000).toFixed(1)}s)` : ""}`,
    `rule 5 (no vt): ${R.r5_noVt.sent.length} vt line(s) sent, ${R.r5_noVt.blockedAtSend} blocked`,
    `refused/illegal: seat-errors ${r.illegal.seatErrors}, gun rejects ${r.illegal.gunRejects}, ballot-net ${r.illegal.ballotNet} (vote-kick ${r.illegal.voteKick}), Day 1 shot ${r.illegal.d1Shot ? "yes" : "NO"}`,
    `per seat (Day lines, LLM): ${r.perSeat.map((p) => `${p.seat}[${p.role}] ${p.lines}/${p.llm}`).join(", ")}`,
  ].join("\n");
}
