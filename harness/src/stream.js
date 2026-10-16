import { emptyView, reduce as engineReduce, validateAction, isPublicSpeak, proposeSeatActions, rulesSeatActions, speechStamp } from "mafioso-engine";

/** Parse one SSE block ("event: game\ndata: {...}") → {type, entry} or null (comments/keepalive). */
export function parseStreamFrame(block) {
  let type = "message"; const data = [];
  for (const line of String(block).split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  try { return { type, entry: JSON.parse(data.join("\n")) }; } catch { return null; }
}

/** Split a raw SSE text buffer into parsed frames. */
export const parseSse = (text) => String(text).split(/\n\n+/).map(parseStreamFrame).filter(Boolean);

/** Fold entries {accountId, seq, event, data} into per-account views (dedup by seq). */
export function replayStream(entries, reduce = engineReduce, views = {}) {
  const out = { ...views }; const lastSeq = {};
  for (const e of entries) {
    const id = e.accountId ?? "_";
    if (e.seq != null && lastSeq[id] != null && e.seq <= lastSeq[id]) continue;
    lastSeq[id] = e.seq;
    out[id] = reduce(out[id] ?? emptyView(), e);
  }
  return out;
}

/**
 * Offline loop sketch: reduce → decide → validate → collect proposed sends.
 * Does not send. Optionally de-dups so one meeting gets one proposal per state.
 */
export function runLoop(entries, { decideFn, rng, now } = {}) {
  const views = {}; const proposed = []; const seen = new Set(); const said = {};
  for (const e of entries) {
    const id = e.accountId ?? "_";
    views[id] = engineReduce(views[id] ?? emptyView(), e);
    const clock = e.t != null && Number.isFinite(Number(e.t)) ? Number(e.t) : now;
    const actions = decideFn ? decideFn(views[id], { rng }) : rulesSeatActions(views[id], { rng, now: clock }).actions;
    const stamp = speechStamp(views[id]);
    for (const a of actions) {
      if (!validateAction(views[id], a).ok) continue;
      const key = isPublicSpeak(views[id], a)
        ? `${id}|${stamp}|speak|${a.data.meetingId}|${a.data.content}`
        : `${id}|${views[id].stateId}|${a.event}|${a.data.meetingId}`;
      if (isPublicSpeak(views[id], a) && said[id] === stamp) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isPublicSpeak(views[id], a)) said[id] = stamp;
      proposed.push({ accountId: id, afterSeq: e.seq, ...a });
    }
  }
  return { views, proposed };
}

/**
 * Async variant. With {complete} the LLM adapter decides (validated, falls back to rules);
 * without it behaves like runLoop. Never sends.
 */
export async function runLoopAsync(entries, { complete, rng, maxRetries, now } = {}) {
  const views = {}; const proposed = []; const seen = new Set(); const said = {};
  for (const e of entries) {
    const id = e.accountId ?? "_";
    views[id] = engineReduce(views[id] ?? emptyView(), e);
    const v = views[id];
    const clock = e.t != null && Number.isFinite(Number(e.t)) ? Number(e.t) : now;
    const plan = complete
      ? await proposeSeatActions(v, { complete, rng, maxRetries, now: clock, scheduleComplete: complete })
      : rulesSeatActions(v, { rng, now: clock });
    const stamp = speechStamp(v);
    for (const a of plan.actions) {
      if (!validateAction(v, a).ok) continue;
      const key = isPublicSpeak(v, a)
        ? `${id}|${stamp}|speak|${a.data.meetingId}|${a.data.content}`
        : `${id}|${v.stateId}|${a.event}|${a.data.meetingId}`;
      if (isPublicSpeak(v, a) && said[id] === stamp) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isPublicSpeak(v, a)) said[id] = stamp;
      proposed.push({ accountId: id, afterSeq: e.seq, source: plan.source, ...a });
    }
  }
  return { views, proposed };
}
