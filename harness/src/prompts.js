// Prompt lineages for the bots. The seed is the engine SYSTEM_PROMPT.
// After a game, Qwen may propose a child prompt. It is stored only if it still
// refuses to admit being an AI and still requires one JSON action.
import fs from "node:fs/promises";
import path from "node:path";
import { SYSTEM_PROMPT } from "mafioso-engine";

export const PROMPT_SEED_URL = new URL("../data/prompts/seed.json", import.meta.url);
export const REQUIRED_NEVER_AI = "Never say or hint that you are an AI, bot, or language model.";
export const REQUIRED_JSON_ACTIONS = '"vote"|"unvote"|"speak"|"wait"';
export const MAX_PROMPT_CHARS = 6000;

const ADMIT = /\byou are an AI\b|\byou are a bot\b|\blanguage model\b|\bI am an AI\b|\bI'm an AI\b/i;

export function emptyScores() {
  return { wins: 0, losses: 0, draws: 0, byRole: {} };
}

export function defaultSeedPrompt(now = "2026-10-16T00:00:00.000Z") {
  return {
    id: "seed",
    text: SYSTEM_PROMPT,
    createdAt: now,
    parentId: null,
    scores: emptyScores(),
    gamesPlayed: 0,
    notes: "Seed is the engine SYSTEM_PROMPT.",
  };
}

export function validateEvolvedPrompt(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (s.length < 80) return { ok: false, reason: "prompt too short" };
  if (s.length > MAX_PROMPT_CHARS) return { ok: false, reason: "prompt too long" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) return { ok: false, reason: "prompt has control characters" };
  if (!s.includes(REQUIRED_NEVER_AI)) return { ok: false, reason: "missing never-admit-AI line" };
  if (!s.includes(REQUIRED_JSON_ACTIONS) || !/JSON/i.test(s)) return { ok: false, reason: "missing JSON action contract" };
  const rest = s.replaceAll(REQUIRED_NEVER_AI, "");
  if (ADMIT.test(rest)) return { ok: false, reason: "prompt admits being an AI" };
  return { ok: true, text: s };
}

export function winRate(prompt) {
  if (!prompt?.gamesPlayed) return 0.5;
  return prompt.scores.wins / prompt.gamesPlayed;
}

function softmaxIndex(rates, rng, temperature) {
  if (temperature === 0) {
    let best = 0;
    for (let i = 1; i < rates.length; i++) if (rates[i] > rates[best]) best = i;
    return best;
  }
  const t = temperature > 0 ? temperature : 1;
  const logits = rates.map((r) => r / t);
  const max = Math.max(...logits);
  const weights = logits.map((l) => Math.exp(l - max));
  const sum = weights.reduce((a, b) => a + b, 0);
  let x = rng() * sum;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x <= 0) return i;
  }
  return weights.length - 1;
}

/** n independent epsilon-greedy draws. New prompts use win rate 0.5 until they play. */
export function selectPrompts(store, n, { epsilon = 0.2, temperature = 0.5, rng = Math.random } = {}) {
  const prompts = [...(store?.prompts || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!prompts.length) throw new Error("prompt store is empty");
  if (!Number.isInteger(n) || n < 1) throw new Error("select count must be an integer >= 1");
  const out = [];
  for (let i = 0; i < n; i++) {
    if (rng() < epsilon) out.push(prompts[Math.min(prompts.length - 1, Math.floor(rng() * prompts.length))]);
    else out.push(prompts[softmaxIndex(prompts.map(winRate), rng, temperature)]);
  }
  return out;
}

export function outcomeForView(view) {
  if (!view?.finished) return null;
  const w = view.winners;
  if (w == null) return "draw";
  if (Array.isArray(w)) {
    if (!w.length) return "draw";
    return w.map(String).includes(String(view.selfId)) ? "win" : "loss";
  }
  const players = Array.isArray(w.players) ? w.players.map(String) : null;
  if (players) {
    if (!players.length && !(Array.isArray(w.groups) && w.groups.length)) return "draw";
    return players.includes(String(view.selfId)) ? "win" : "loss";
  }
  return "draw";
}

export function recordOutcomes(store, rows) {
  const next = structuredClone(store);
  for (const row of rows) {
    if (row.outcome !== "win" && row.outcome !== "loss" && row.outcome !== "draw")
      throw new Error(`bad outcome: ${row.outcome}`);
    const p = next.prompts.find((x) => x.id === row.promptId);
    if (!p) throw new Error(`unknown prompt ${row.promptId}`);
    p.scores[row.outcome === "win" ? "wins" : row.outcome === "loss" ? "losses" : "draws"]++;
    p.gamesPlayed++;
    const role = row.role || "unknown";
    p.scores.byRole[role] ??= { wins: 0, losses: 0, draws: 0 };
    p.scores.byRole[role][row.outcome === "win" ? "wins" : row.outcome === "loss" ? "losses" : "draws"]++;
  }
  return next;
}

function extractJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export function parseEvolveResponse(text) {
  const j = extractJson(text);
  if (!j || typeof j !== "object") return null;
  const system = j.system ?? j.prompt ?? j.text;
  if (typeof system !== "string") return null;
  const notes = typeof j.notes === "string" ? j.notes.slice(0, 500) : "";
  return { system, notes };
}

export function buildEvolveBriefing({ parent, summary }) {
  return [
    "IMPROVE THE SYSTEM PROMPT for a Mafia bot that already played.",
    "Return ONE JSON object and nothing else: {\"system\":\"<full replacement prompt>\",\"notes\":\"<one short sentence>\"}",
    "The system text MUST include these lines verbatim:",
    REQUIRED_NEVER_AI,
    `Reply with ONE JSON object and nothing else: {"action":${REQUIRED_JSON_ACTIONS}, ...}`,
    "Do not tell the bot to reveal that it is an AI, bot, or language model.",
    "Keep the untrusted-chat rule and the one-JSON-action rule.",
    `PARENT ${parent.id} winRate=${winRate(parent).toFixed(3)} games=${parent.gamesPlayed} wins=${parent.scores.wins} losses=${parent.scores.losses} draws=${parent.scores.draws}`,
    "GAME:",
    summary || "(no digest)",
    "PARENT PROMPT:",
    parent.text,
  ].join("\n");
}

/**
 * Ask complete() for a child prompt. Does not write the store.
 * @returns {Promise<{ok:true, prompt:object}|{ok:false, reason:string}>}
 */
export async function evolvePrompt({ complete, parent, summary = "", now = Date.now(), id = `p-${now.toString(36)}` }) {
  if (typeof complete !== "function") return { ok: false, reason: "no complete" };
  let raw;
  try {
    raw = await complete({
      system: "You edit system prompts for a game bot. Reply with one JSON object only.",
      user: buildEvolveBriefing({ parent, summary }),
    });
  } catch (e) {
    return { ok: false, reason: "model error" };
  }
  const parsed = parseEvolveResponse(raw);
  if (!parsed) return { ok: false, reason: "unparseable evolve reply" };
  const v = validateEvolvedPrompt(parsed.system);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (v.text === parent.text.trim()) return { ok: false, reason: "unchanged" };
  return {
    ok: true,
    prompt: {
      id,
      text: v.text,
      createdAt: new Date(now).toISOString(),
      parentId: parent.id,
      scores: emptyScores(),
      gamesPlayed: 0,
      notes: parsed.notes,
    },
  };
}

export function replayDigest(views, { limit = 5 } = {}) {
  const lines = [];
  for (const [accountId, view] of Object.entries(views || {})) {
    lines.push(`${accountId} role=${view?.role || "unknown"} outcome=${outcomeForView(view) || "unfinished"}`);
    for (const m of (view?.messages || []).slice(-limit)) {
      const who = m?.senderId ?? "?";
      const content = String(m?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      lines.push(`  ${who}: ${content}`);
    }
  }
  return lines.join("\n").slice(0, 4000);
}

/** Score the prompts that finished, then evolve each distinct prompt once. */
export async function finishGame({ store, results, complete, summary = "", now = Date.now(), idFor }) {
  let next = recordOutcomes(store, results);
  const children = [];
  const skipped = [];
  const seen = new Set();
  let n = 0;
  for (const row of results) {
    if (seen.has(row.promptId)) continue;
    seen.add(row.promptId);
    const parent = next.prompts.find((p) => p.id === row.promptId);
    const evolved = await evolvePrompt({
      complete, parent, summary, now,
      id: idFor ? idFor(parent, n) : `p-${now.toString(36)}-${n}`,
    });
    n++;
    if (!evolved.ok) { skipped.push({ promptId: row.promptId, reason: evolved.reason }); continue; }
    if (next.prompts.some((p) => p.id === evolved.prompt.id)) {
      skipped.push({ promptId: row.promptId, reason: "id collision" });
      continue;
    }
    next = { prompts: [...next.prompts, evolved.prompt] };
    children.push(evolved.prompt);
  }
  return { store: next, children, skipped };
}

export async function loadSeedPrompt() {
  const raw = await fs.readFile(PROMPT_SEED_URL, "utf8");
  const seed = JSON.parse(raw);
  const v = validateEvolvedPrompt(seed.text);
  if (!v.ok) throw new Error(`seed prompt rejected: ${v.reason}`);
  return seed;
}

export async function ensurePromptStore(dir) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "prompts.json");
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(data.prompts) || !data.prompts.length) throw new Error("prompt store has no prompts");
    return data;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const store = { prompts: [await loadSeedPrompt()] };
    await savePromptStore(dir, store);
    return store;
  }
}

export async function savePromptStore(dir, store) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "prompts.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n");
  await fs.rename(tmp, file);
}
