// Chat-safety: reasoning in message.content, a length cutoff, and an OpenRouter reasoning field.
// Replay counts are the public lines each bot seat sent in the fixtures, audited in that seat's view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emptyView, reduce, chatAudit, chatLineReject, validateAction, isPublicSpeechMeeting, createSeededRng } from "mafioso-engine";
import { createOpenAICompatibleComplete } from "../src/openaiCompatible.js";
import { createOpenRouterComplete, openRouterVisibleText } from "../src/openrouter.js";
import { createBotTable, createLlmLimiter, drainUpgrades, onGameEntry } from "../src/live.js";
import { createVirtualClock } from "../src/clock.js";

function mockFetch(body) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

test("OpenRouter never uses a reasoning field as chat", () => {
  assert.equal(openRouterVisibleText({ choices: [{ message: { content: "voting seat 8", reasoning: "The user is telling me to vote" } }] }), "voting seat 8");
  assert.equal(openRouterVisibleText({ choices: [{ message: { content: "", reasoning: "only the scratchpad" } }] }), "");
  assert.equal(openRouterVisibleText({ choices: [{ message: { content: null, reasoning_details: [{ text: "secret" }] } }] }), "");
  assert.equal(openRouterVisibleText({ choices: [{ message: { reasoning: "The situation: seat 8 would be lynched" } }] }), "");
});

test("OpenRouter speech: reasoning-only is no reply; finish_reason length is dropped", async () => {
  const onlyReasoning = createOpenRouterComplete({
    apiKey: "sk-or-test", env: {},
    fetch: mockFetch({ choices: [{ finish_reason: "stop", message: { content: null, reasoning: "The user is telling me to vote for seat 8" } }] }),
  });
  assert.equal(await onlyReasoning({ system: "s", user: "u", json: false }), "");

  const blank = createOpenRouterComplete({
    apiKey: "sk-or-test", env: {},
    fetch: mockFetch({ choices: [{ message: { content: "  ", reasoning: "scratch" } }] }),
  });
  assert.equal(await blank({ system: "s", user: "u", json: false }), "");

  const kept = createOpenRouterComplete({
    apiKey: "sk-or-test", env: {},
    fetch: mockFetch({
      choices: [{
        finish_reason: "stop",
        message: { content: "voting seat 8", reasoning: "do not send this", reasoning_details: [{ type: "reasoning.text", text: "nor this" }] },
      }],
    }),
  });
  const line = await kept({ system: "s", user: "u", json: false, maxTokens: 640, reasoningEffort: "none" });
  assert.equal(line, "voting seat 8");
  assert.equal(line.includes("do not send"), false);

  const cut = createOpenRouterComplete({
    apiKey: "sk-or-test", env: {},
    fetch: mockFetch({ choices: [{ finish_reason: "length", message: { content: "The situation: seat 8 has 3 votes and would be" } }] }),
  });
  await assert.rejects(() => cut({ system: "s", user: "u", json: false }), (e) => e.chatReject === "truncated (finish_reason length)");

  // A JSON action is not a chat line: length does not blank a finished object.
  const jsonCut = createOpenAICompatibleComplete({
    baseUrl: "http://x/v1", model: "m",
    fetch: mockFetch({ choices: [{ finish_reason: "length", message: { content: '{"action":"wait"}' } }] }),
  });
  assert.equal(await jsonCut({ system: "s", user: "u" }), '{"action":"wait"}');
});

test("a live seat does not send a reasoning line; it falls back to a rules or canned line", async () => {
  const t0 = 1_700_000_000_000;
  const clock = createVirtualClock(t0);
  const table = createBotTable([{ accountId: "A" }], { clock, rng: createSeededRng(2) });
  const logged = [];
  table.onSpeechReject = (who, reasons, source, content) => logged.push({ who, reasons, source, content });
  const players = { p1: { id: "p1", name: "Me" }, p2: { id: "p2", name: "Alice" }, p3: { id: "p3", name: "Bob" }, p4: { id: "p4", name: "Cal" } };
  const leak = "The user is telling me to vote for seat 8 because it's lynch-or-lose.";
  let seq = 0;
  const feed = (event, data, t = t0 + seq * 1000) => onGameEntry(table, { accountId: "A", seq: ++seq, t, event, data }, {
    complete: async () => leak, dryRun: true, fast: true, limiter: createLlmLimiter(1), now: t,
  });
  await feed("self", "p1"); await feed("players", players); await feed("roleReveal", { playerId: "p1", role: "Villager" });
  await feed("state", { id: 3, name: "Day 1" });
  await feed("meeting", { id: "vil", name: "Village", speech: true, voting: true, canVote: true, amMember: true, targets: ["p2", "p3", "p4", "*"], votes: {} });
  await feed("message", { meetingId: "vil", senderId: "p2", content: "Me is scum, vote Me", t: t0 + 6000 });
  await feed("time", { time: 30000 }, t0 + 30000);
  await drainUpgrades(table);
  const said = table.proposed.filter((p) => p.event === "speak" && p.data.meetingId === "vil").map((p) => p.data.content);
  assert.equal(said.length, 1, JSON.stringify(said));
  for (const line of said) assert.doesNotMatch(line, /the user|the situation|would be lynched|lynch-or-lose/i, line);
  assert.ok(logged.some((l) => l.reasons.some((r) => /meta reasoning \(the user\)/.test(r))), JSON.stringify(logged));
});

function replayDir(name) {
  const dir = fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
  let checked = 0, auditReject = 0, validatePass = 0, validateReject = 0;
  const shortKept = []; const extra = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl") && !x.includes("reject")).sort()) {
    const views = {};
    for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean)) {
      const fr = JSON.parse(line);
      const v = views[fr.accountId] || emptyView();
      const m = fr.event === "message" ? v.meetings?.[fr.data?.meetingId] : null;
      if (m && fr.data?.senderId === v.selfId && isPublicSpeechMeeting(m)) {
        checked += 1;
        const text = String(fr.data.content || "");
        const flags = chatAudit(v, text);
        if (flags.length) auditReject += 1;
        const ok = validateAction(v, { event: "speak", data: { meetingId: m.id, content: text } }).ok;
        if (ok) validatePass += 1; else validateReject += 1;
        const safety = chatLineReject(text);
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        if (ok && !flags.length && safety) extra.push({ f, words, safety, text: text.slice(0, 120) });
        if (ok && !flags.length && words <= 12 && safety) shortKept.push(`${f}: ${safety}: ${text.slice(0, 80)}`);
      }
      views[fr.accountId] = reduce(v, fr);
    }
  }
  return { checked, auditReject, auditPass: checked - auditReject, validatePass, validateReject, extra, shortKept };
}

test("chat replay fixtures: pass/reject counts stay put, and short real lines are not new rejects", () => {
  const g = replayDir("replays");
  const l18 = replayDir("live-1018");
  const l19 = replayDir("live-1019");
  assert.deepEqual(
    { g: [g.checked, g.auditPass, g.auditReject, g.validatePass, g.validateReject],
      l18: [l18.checked, l18.auditPass, l18.auditReject, l18.validatePass, l18.validateReject],
      l19: [l19.checked, l19.auditPass, l19.auditReject, l19.validatePass, l19.validateReject] },
    { g: [393, 386, 7, 346, 47], l18: [270, 237, 33, 219, 51], l19: [45, 40, 5, 37, 8] },
  );
  assert.deepEqual(g.shortKept.concat(l18.shortKept, l19.shortKept), []);
  // Lines the old gate sent that the new filter would drop. All seven are g05 lines already cut off
  // mid-clause (longer than 12 words, no terminal punctuation). Not a change in the old gate.
  const extras = g.extra.concat(l18.extra, l19.extra);
  assert.equal(extras.length, 7, extras.map((x) => `${x.words} ${x.safety}`).join("; "));
  assert.ok(extras.every((x) => x.safety === "truncated line" && x.words > 12));
});
