// Offline latency breakdown of the stale rejects in live logs (no model calls). The logs carry no per-call
// timestamps, so each line's time is interpolated between the nearest t= stamped lines; at llm concurrency=1
// the model is a single serial server, so a completion's service time is the gap since the previous completion.
// Usage: node scripts/stale-latency.mjs <log.err ...> [--json out.json] [--dist out.json]
import fs from "node:fs";

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
export const SERVICE_CAP_MS = 60_000; // a longer gap between completions is an idle GPU, not one call

/** Parse a log into timed lines: {i, kind, acc, phase, t (stamped or interpolated), stamped, raw}. */
export function parseLog(text) {
  const lines = text.split("\n").map((raw, i) => {
    const kind = (/^[a-z-]+/.exec(raw) || [""])[0];
    const acc = /^(?:send|speech-reject|sched|town-vote|hammer|meeting) (\S+)/.exec(raw)?.[1] || null;
    const phase = /\[((?:Day|Night) \d+)\]/.exec(raw)?.[1] || null;
    const t = Number(/ t=(\d{12,})/.exec(raw)?.[1]) || null;
    return { i, kind, acc, phase, t, stamped: t != null, raw };
  });
  // Interpolate unstamped lines by index between stamped neighbours.
  const st = lines.filter((l) => l.stamped);
  let k = 0;
  for (const l of lines) {
    if (l.stamped) continue;
    while (k < st.length - 1 && st[k + 1].i < l.i) k++;
    const a = st[k], b = st.slice(k).find((x) => x.i > l.i);
    if (!a || a.i > l.i) { l.t = b?.t ?? null; continue; }
    l.t = b ? a.t + ((b.t - a.t) * (l.i - a.i)) / (b.i - a.i) : a.t;
  }
  // The log's "game" line names the accounts; the seatmap names their players.
  const accounts = /accounts=(\S+)/.exec(lines.find((l) => l.kind === "game")?.raw || "")?.[1]?.split(",") || [];
  return { lines, accounts };
}

const isCompletion = (l) => (l.kind === "speech-reject" && /source=llm/.test(l.raw) && !/model error: stale/.test(l.raw) && !/held line invalid/.test(l.raw) && !/stale reply/.test(l.raw))
  || (l.kind === "send" && / speak /.test(l.raw) && /source=llm/.test(l.raw));

/** Each stale reject with its time split: model call, queue wait, retries, pacing (table gap, own cooldown, reply beat). */
export function breakdown(text, game = "") {
  const { lines } = parseLog(text);
  const comps = lines.filter(isCompletion);
  const svc = new Map();
  for (let j = 1; j < comps.length; j++) { const d = comps[j].t - comps[j - 1].t; if (d > 0 && d < SERVICE_CAP_MS) svc.set(comps[j].i, d); }
  const serviceMed = median([...svc.values()]) ?? 0;
  const chats = lines.filter((l) => l.kind === "chat" && l.stamped);
  const publicSends = lines.filter((l) => l.kind === "send" && / speak /.test(l.raw) && l.stamped && /^\[Day/.test((/\[(.*?)\]/.exec(l.raw) || [""])[0]));
  const out = [];
  for (const l of lines) {
    if (l.kind !== "speech-reject") continue;
    const reason = /reasons=\["([^"]*)/.exec(l.raw)?.[1] || "";
    const kind = /^stale reply/.test(reason) ? "stale reply" : /^model error: stale/.test(reason) ? "model stale"
      : /^held line invalid at send/.test(reason) ? "held" : /dead-sus|vote-dead/.test(reason) ? "dead-sus" : null;
    if (!kind) continue;
    const rec = { game, line: l.i, acc: l.acc, phase: l.phase, kind, reason, at: l.t };
    if (kind === "stale reply") {
      const age = Number(/stale reply \((\d+)s/.exec(reason)[1]) * 1000;
      // Pacing: the drop happens at the send check; if the check came after a pacing wait, that wait is pacing's.
      const dropAt = l.t, answeredAt = dropAt - age;
      const prior = comps.filter((c) => c.i < l.i && c.acc === l.acc && c.t >= answeredAt);
      const last = [...comps].reverse().find((c) => c.i < l.i) || null;
      const callMs = svc.get(l.i) ?? serviceMed;
      // The completion that produced this line: the drop itself (first check) unless the line was held.
      const doneAt = dropAt;
      const ownLast = publicSends.filter((s) => s.acc === l.acc && s.t < doneAt).slice(-1)[0];
      const tableLast = publicSends.filter((s) => s.t < doneAt).slice(-1)[0];
      const own = ownLast ? Math.max(0, ownLast.t + 6000 - doneAt) : 0;
      const table = tableLast ? Math.max(0, tableLast.t + 2500 - doneAt) : 0;
      const retries = prior.reduce((s, c) => s + (svc.get(c.i) ?? serviceMed), 0);
      const queue = Math.max(0, age - callMs - retries);
      Object.assign(rec, { ageMs: age, callMs, retries: prior.length, retriesMs: retries, queueMs: queue, ownGapMs: own, tableGapMs: table, othersBetween: comps.filter((c) => c.t >= answeredAt && c.i < l.i && c.acc !== l.acc).length, lastCompletionGapMs: last ? dropAt - last.t : null });
    } else if (kind === "model stale") {
      // Dropped from the queue: the state changed (phase end, death) while it waited. Wait ≈ since this seat's
      // previous completion (it re-queues at once), bounded by the phase start.
      const prev = [...comps].reverse().find((c) => c.i < l.i && c.acc === l.acc);
      const ahead = comps.filter((c) => prev && c.i > prev.i && c.i < l.i).length;
      Object.assign(rec, { queueMs: prev ? l.t - prev.t : null, callsAhead: ahead });
    } else {
      // Line written on a state that changed before it went out: held by pacing (held) or in the model call (dead-sus).
      const prev = [...comps].reverse().find((c) => c.i < l.i && c.acc === l.acc);
      Object.assign(rec, { sinceOwnCompletionMs: prev ? l.t - prev.t : null, callMs: svc.get(l.i) ?? serviceMed });
    }
    out.push(rec);
  }
  return { rejects: out, serviceMs: [...svc.values()], completions: comps.length };
}

if (process.argv[1] && process.argv[1].endsWith("stale-latency.mjs")) {
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !["--json", "--dist"].includes(all[i - 1]));
  const opt = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const all = [], service = [];
  files.forEach((f, n) => { const r = breakdown(fs.readFileSync(f, "utf8"), `g0${n + 1}`); all.push(...r.rejects); service.push(...r.serviceMs); });
  if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify(all, null, 1));
  if (opt("--dist")) fs.writeFileSync(opt("--dist"), JSON.stringify({ note: "model service times (ms) between serial completions, live L2-L8 10/18", serviceMs: service.sort((a, b) => a - b) }));
  const s = (xs) => `n=${xs.length} median=${(median(xs) / 1000).toFixed(1)}s`;
  console.log(`completions' service time: ${s(service)}`);
  for (const k of ["model stale", "stale reply", "held", "dead-sus"]) console.log(k, all.filter((r) => r.kind === k).length);
}
