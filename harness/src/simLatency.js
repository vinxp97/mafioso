// Simulated model latency for self-play (stale-latency 10/19; test-only, off by default; no model, no network).
// Replays the live L2-L8 latency record (latency-live1018.json): each model call takes a service time drawn from
// the logged distribution on the virtual clock, the harness runs one call at a time (live LM Studio concurrency 1),
// and a game draws one logged game's rejection rate, so a share of model lines fail chatAudit and are regenerated
// as they were live. Lines are stand-ins: a short reply to the latest line, or a known-bad flip line when rejected.
import fs from "node:fs";

export const SIM_LATENCY = Object.freeze({ live1018: new URL("./latency-live1018.json", import.meta.url) });

export function loadLatency(name = "live1018") {
  const url = SIM_LATENCY[name];
  if (!url) throw new Error(`unknown --sim-latency ${name} (have: ${Object.keys(SIM_LATENCY).join(", ")})`);
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

const REPLIES = ["{n} why that read", "{n} what makes you say that", "not sure about {n} yet", "{n} explain your vote", "hmm {n}, maybe", "{n} who is your top read", "ok {n}, and who else"];

/**
 * Wrap the offline complete: same answers, after a sampled delay; speech prompts the offline model would refuse
 * get a stand-in line (a reply, or with the game's logged rejection rate a line chatAudit rejects).
 */
export function createSimLatencyComplete(base, { clock, rng, dist, viewByName }) {
  const g = dist.games[Math.floor(rng() * dist.games.length)];
  const pReject = g.completions ? g.rejected / g.completions : 0;
  const svc = dist.serviceMs;
  // close(): the game is over; calls still waiting on the virtual clock fail now (their real model timeout would hold the process).
  const waiting = new Set(); let closed = false;
  const delay = () => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("game over"));
    const w = { reject }; waiting.add(w);
    clock.setTimer(() => { waiting.delete(w); resolve(); }, svc[Math.floor(rng() * svc.length)]);
  });
  const close = () => { closed = true; for (const w of waiting) w.reject(new Error("game over")); waiting.clear(); };
  const sim = { game: g.live, pReject, calls: 0 };
  const complete = async (input = {}) => {
    sim.calls++;
    const reject = rng() < pReject, pick = rng();
    await delay();
    if (input.purpose !== "speech") return base(input);
    try { return await base(input); } catch { /* the offline model has no line: the stand-in speaks */ }
    const me = (String(input.user || "").match(/^you are (.+?)\. role \(secret\)/m) || [])[1];
    const view = me && viewByName ? viewByName(me) : null;
    if (!view) throw new Error("offline: no model");
    const name = (id) => String(view.players?.[id]?.name || "").toLowerCase();
    const others = Object.keys(view.players || {}).filter((id) => id !== view.selfId && !view.dead?.[id] && !view.players[id]?.left);
    if (!others.length) throw new Error("offline: no model");
    if (reject) return `${name(others[Math.floor(pick * others.length)])} flipped mafia`;
    const last = (view.messages || []).filter((m) => m?.senderId && m.senderId !== "server" && m.senderId !== view.selfId && m.public !== false && others.includes(m.senderId)).slice(-1)[0];
    const who = last ? last.senderId : others[Math.floor(pick * others.length)];
    return REPLIES[Math.floor(pick * REPLIES.length)].replace("{n}", name(who));
  };
  return { complete, sim, close };
}
