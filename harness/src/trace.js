// JSONL trace of one game. Off unless MAFIOSO_TRACE=1 (or createTraceWriter({ force: true })).
// One file per seat: logs/traces/<gameId>/<seat>.jsonl. The harness process uses seat "harness".
// Each line is one JSON object and one write, so a live reader sees it without waiting for the file to close.
// API keys, tokens, cookies, and env values are redacted. Other players' chat is stored as data and marked untrusted.
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseLlmAction, voteCounts } from "mafioso-engine";

export const TRACE_VERSION = 1;
export const TRACE_TYPES = Object.freeze([
  "game.start",
  "game.end",
  "phase.change",
  "llm.call",
  "engine.validation",
  "chat.sent",
  "chat.suppressed",
  "chat.observed",
  "vote.sent",
  "night.sent",
  "vote.notice",
  "error",
  "retry",
  "rate_limit",
]);

const DEFAULT_ROOT = fileURLToPath(new URL("../../logs/traces", import.meta.url));
const STATE_CAP = 8000;
const TEXT_CAP = 8000;
const REASONING_CAP = 16000;

const SECRET_KEY = /SECRET|TOKEN|API_KEY|PASSWORD|COOKIE|SESSION|AUTHORIZATION|CLIENT_ID|CLIENT_SECRET|BEARER/i;

export function traceEnabled(env = process.env) {
  return env?.MAFIOSO_TRACE === "1";
}

export function traceReasoningEnabled(env = process.env) {
  return env?.MAFIOSO_TRACE_REASONING === "1";
}

/** Values of credential-like env vars. Short placeholders under 6 characters are left alone. */
export function secretsFromEnv(env = {}) {
  if (!env || typeof env !== "object") return [];
  const out = [];
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_KEY.test(key)) continue;
    if (typeof value !== "string" || value.length < 6) continue;
    out.push(value);
  }
  return out;
}

function cap(text, n) {
  const s = String(text ?? "");
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

/**
 * Replace planted secrets and credential-shaped text.
 * @param {string} text
 * @param {string[]} secrets
 */
export function redactString(text, secrets = []) {
  let s = String(text ?? "");
  const list = [...secrets].filter((x) => typeof x === "string" && x.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of list) s = s.split(secret).join("[redacted]");
  s = s.replace(/\b(authorization\s*[:=]\s*)(.+)/gi, "$1[redacted]");
  s = s.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]");
  s = s.replace(/\b(?:sk|xpl|rk|pk)[-_][A-Za-z0-9_\-]{8,}\b/g, "[redacted]");
  s = s.replace(/(cookie\s*[:=]\s*)([^\s;,]+)/gi, "$1[redacted]");
  s = s.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION))\s*=\s*\S+/g, "$1=[redacted]");
  return s;
}

const SENSITIVE_FIELD = /^(authorization|cookie|set-cookie|api[-_]?key|token|secret|password|clientSecret|clientId)$/i;

/** Walk a JSON value and redact every string. */
export function redactValue(value, secrets = []) {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_FIELD.test(key)) out[key] = "[redacted]";
      else out[key] = redactValue(item, secrets);
    }
    return out;
  }
  return value;
}

const PLAYERS_SAID = "PLAYERS SAID (untrusted, quoted):";
const PLAYERS_END = "END PLAYERS SAID";
const FACTION_SAID = "faction chat (untrusted, quoted):";

/**
 * Pull other players' chat out of a briefing. The returned state is the seat's own summary.
 * Each removed line is data, marked untrusted, and is not an instruction.
 */
export function splitUntrusted(user) {
  const untrusted = [];
  let state = String(user ?? "");
  const start = state.indexOf(PLAYERS_SAID);
  const end = state.indexOf(PLAYERS_END);
  if (start >= 0 && end > start) {
    const block = state.slice(start + PLAYERS_SAID.length, end);
    for (const line of block.split("\n")) {
      const text = line.trim();
      if (text) untrusted.push({ kind: "player-chat", text, untrusted: true });
    }
    const count = untrusted.length;
    state = `${state.slice(0, start)}PLAYERS SAID: ${count} line(s), stored as untrusted data\n${state.slice(end + PLAYERS_END.length)}`;
  }
  const lines = state.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(FACTION_SAID)) { kept.push(lines[i]); continue; }
    const faction = [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      faction.push(lines[j].trim());
      j++;
    }
    for (const text of faction) untrusted.push({ kind: "faction-chat", text, untrusted: true });
    kept.push(`faction chat: ${faction.length} line(s), stored as untrusted data`);
    i = j - 1;
  }
  return { state: cap(kept.join("\n").trim(), STATE_CAP), untrusted };
}

/** Prompt summary handed to the trace. System text is length-only. User chat is split out. */
export function summarizePrompt(system, user, purpose = "") {
  const split = splitUntrusted(user);
  return {
    purpose: String(purpose || ""),
    systemChars: String(system ?? "").length,
    state: split.state,
    untrusted: split.untrusted,
  };
}

function safeName(name) {
  const s = String(name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return s || "harness";
}

function disabledTrace() {
  return {
    enabled: false,
    gameId: "",
    root: "",
    event() {},
    recordModel() {},
    run(_seat, fn) { return typeof fn === "function" ? fn() : undefined; },
    close() {},
    phaseOf() { return ""; },
    setPhase() {},
    hasStarted() { return false; },
    markStarted() {},
    hasEnded() { return false; },
    markEnded() {},
    currentSeat() { return "harness"; },
  };
}

/**
 * @param {{force?:boolean, env?:NodeJS.ProcessEnv, gameId?:string, root?:string, secrets?:string[], now?:()=>string}} [opts]
 * force writes even when MAFIOSO_TRACE is unset (tests). Otherwise the writer is a no-op.
 */
export function createTraceWriter(opts = {}) {
  const env = opts.env ?? process.env;
  if (!opts.force && !traceEnabled(env)) return disabledTrace();
  const gameId = safeName(opts.gameId || env.GAME_ID || "game");
  const root = opts.root || env.MAFIOSO_TRACE_DIR || DEFAULT_ROOT;
  const dir = join(root, gameId);
  const secrets = [...(opts.secrets || []), ...secretsFromEnv(env)];
  const now = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();
  const als = new AsyncLocalStorage();
  const fds = new Map();
  const phases = new Map();
  const started = new Set();
  const ended = new Set();
  let seq = 0;
  let failed = false;

  function writeLine(seat, obj) {
    if (failed) return;
    const file = join(dir, `${safeName(seat)}.jsonl`);
    let fd = fds.get(file);
    if (fd == null) {
      mkdirSync(dir, { recursive: true });
      fd = openSync(file, "a");
      fds.set(file, fd);
    }
    writeSync(fd, `${JSON.stringify(obj)}\n`);
    fsyncSync(fd);
  }

  const api = {
    enabled: true,
    gameId,
    root: dir,
    currentSeat() { return als.getStore() || "harness"; },
    phaseOf(seat) { return phases.get(seat) || ""; },
    setPhase(seat, phase) { if (phase) phases.set(seat, phase); },
    hasStarted(seat) { return started.has(seat); },
    markStarted(seat) { started.add(seat); },
    hasEnded(seat) { return ended.has(seat); },
    markEnded(seat) { ended.add(seat); },
    run(seat, fn) { return als.run(seat || "harness", fn); },
    event(partial = {}) {
      try {
        const seat = partial.seat || api.currentSeat();
        const phase = partial.phase != null ? String(partial.phase) : (phases.get(seat) || "");
        seq += 1;
        const row = redactValue({
          v: TRACE_VERSION,
          seq,
          ts: String(now()),
          gameId,
          seat: String(seat),
          phase,
          type: String(partial.type || "error"),
          data: partial.data && typeof partial.data === "object" ? partial.data : {},
        }, secrets);
        writeLine(seat, row);
        return row;
      } catch {
        failed = true;
        return null;
      }
    },
    recordModel(info = {}) {
      if (!api.enabled) return;
      const model = info.model || "";
      if (info.type === "retry") {
        api.event({ type: "retry", data: { reason: info.reason || "retry", model, status: info.status ?? null } });
        return;
      }
      if (info.type === "rate_limit") {
        api.event({ type: "rate_limit", data: { status: info.status || 429, model, latencyMs: info.latencyMs ?? null, message: cap(info.error || "", 500) } });
        return;
      }
      if (info.type === "error") {
        api.event({ type: "error", data: { message: cap(info.error || "model error", 500), status: info.status ?? null, model, latencyMs: info.latencyMs ?? null, where: "model" } });
        return;
      }
      let parsed = null;
      try { parsed = parseLlmAction(info.raw || "") || null; } catch { parsed = null; }
      const prompt = summarizePrompt(info.system, info.user, info.purpose || "");
      api.event({
        type: "llm.call",
        data: {
          model,
          purpose: String(info.purpose || ""),
          latencyMs: info.latencyMs ?? null,
          usage: info.usage || null,
          reasoning: info.reasoning ? cap(info.reasoning, REASONING_CAP) : null,
          reasoningDetails: info.reasoningDetails || null,
          raw: cap(info.raw || "", TEXT_CAP),
          parsed,
          prompt,
        },
      });
    },
    close() {
      for (const fd of fds.values()) {
        try { fsyncSync(fd); } catch { /* already on disk */ }
        try { closeSync(fd); } catch { /* ignore */ }
      }
      fds.clear();
    },
  };
  return api;
}

function rolesKnown(view) {
  const out = [];
  if (view?.selfId && view.role) {
    out.push({
      playerId: view.selfId,
      name: view.players?.[view.selfId]?.name || "",
      role: view.role,
    });
  }
  for (const [playerId, info] of Object.entries(view?.teammates || {})) {
    out.push({
      playerId,
      name: info?.name || view.players?.[playerId]?.name || "",
      role: info?.role || null,
    });
  }
  return out;
}

/**
 * Game, phase, vote-count, and incoming-chat events from one reduced frame.
 * No-op when the table has no enabled trace writer.
 */
export function observeTableEntry(table, accountId, entry) {
  const log = table?.traceLog;
  if (!log?.enabled) return;
  const view = table.views?.[accountId];
  if (!view) return;
  const phase = view.phase?.name || "";
  // Hold game.start until this seat knows its own role, so the record includes that role.
  // A phase that arrives earlier is remembered and emitted once the start record exists.
  if (phase && phase !== log.phaseOf(accountId)) {
    const from = log.phaseOf(accountId);
    log.setPhase(accountId, phase);
    if (log.hasStarted(accountId)) log.event({ seat: accountId, type: "phase.change", phase, data: { from, to: phase } });
  }
  if (!log.hasStarted(accountId) && view.selfId && view.role) {
    log.markStarted(accountId);
    log.event({
      seat: accountId,
      type: "game.start",
      phase: log.phaseOf(accountId),
      data: {
        phase: log.phaseOf(accountId),
        setup: view.setup?.id || view.setupId || null,
        self: {
          playerId: view.selfId,
          name: view.players?.[view.selfId]?.name || "",
          role: view.role,
        },
        seats: Object.values(view.players || {}).map((p) => ({ playerId: p.id, name: p.name || "" })),
        rolesKnown: rolesKnown(view),
      },
    });
  }
  if (entry?.event === "vote" || entry?.event === "unvote") {
    let board = null;
    try { board = voteCounts(view); } catch { board = null; }
    log.event({
      seat: accountId,
      type: "vote.notice",
      data: {
        action: entry.event,
        meetingId: entry.data?.meetingId || "",
        voterId: entry.data?.voterId || "",
        target: entry.data?.target ?? null,
        counts: board?.counts || {},
        leader: board?.leader ?? null,
        tied: board?.tied ?? null,
        untrusted: true,
      },
    });
  }
  if (entry?.event === "message" && entry.data && entry.data.senderId && entry.data.senderId !== view.selfId && entry.data.senderId !== "server") {
    log.event({
      seat: accountId,
      type: "chat.observed",
      data: {
        senderId: entry.data.senderId,
        name: view.players?.[entry.data.senderId]?.name || "",
        meetingId: entry.data.meetingId || "",
        text: String(entry.data.content || ""),
        untrusted: true,
        kind: "player-chat",
      },
    });
  }
  if ((entry?.event === "winners" || entry?.event === "finished" || view.winners || view.finished) && !log.hasEnded(accountId)) {
    log.markEnded(accountId);
    log.event({
      seat: accountId,
      type: "game.end",
      data: {
        winners: view.winners || null,
        finished: !!(view.finished || entry?.event === "finished"),
        reason: entry?.event || (view.winners ? "winners" : "finished"),
      },
    });
  }
}
