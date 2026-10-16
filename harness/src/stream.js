import { emptyView, reduce as engineReduce, decide, validateAction, llmDecide, supplementActions } from "mafioso-engine";

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
export function runLoop(entries, { decideFn = decide, rng } = {}) {
  const views = {}; const proposed = []; const seen = new Set();
  for (const e of entries) {
    const id = e.accountId ?? "_";
    views[id] = engineReduce(views[id] ?? emptyView(), e);
    for (const a of decideFn(views[id], { rng })) {
      if (!validateAction(views[id], a).ok) continue;
      const key = `${id}|${views[id].stateId}|${a.event}|${a.data.meetingId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposed.push({ accountId: id, afterSeq: e.seq, ...a });
    }
  }
  return { views, proposed };
}

/**
 * Async variant. With {complete} the LLM adapter decides (validated, falls back to rules);
 * without it behaves like runLoop. Never sends.
 */
export async function runLoopAsync(entries, { complete, rng, maxRetries } = {}) {
  const views = {}; const proposed = []; const seen = new Set();
  for (const e of entries) {
    const id = e.accountId ?? "_";
    views[id] = engineReduce(views[id] ?? emptyView(), e);
    const v = views[id];
    // only consult the model when there is something unvoted to act on
    const open = decide(v, { rng });
    if (!open.length) continue;
    const keyOf = (a) => `${id}|${v.stateId}|${a.event}|${a.data.meetingId}`;
    if (open.every((a) => seen.has(keyOf(a)))) continue;
    const r = complete ? await llmDecide(v, { complete, rng, maxRetries }) : { actions: open, source: "rules" };
    for (const a of supplementActions(r.actions, open, v)) {
      if (!validateAction(v, a).ok) continue;
      const key = keyOf(a);
      if (seen.has(key)) continue;
      seen.add(key);
      proposed.push({ accountId: id, afterSeq: e.seq, source: r.actions.includes(a) ? r.source : "rules", ...a });
    }
  }
  return { views, proposed };
}
