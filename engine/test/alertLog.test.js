// Live parsing must be checkable from the log: every real Cop / Journalist / Janitor alert in the archive fixtures
// yields exactly one alertResult with the right kind and target; player lines and non-results yield none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { alertResult } from "../src/index.js";
import { players } from "./realAlerts.helper.js";

const FIXTURES = createRequire(import.meta.url)("./fixtures/real-alerts.json");
const list = Array.isArray(FIXTURES) ? FIXTURES : FIXTURES.alerts || FIXTURES.fixtures;
const view = { selfId: "me", players, messages: [], dead: {} };
const KIND = (cat) => (cat === "janitor" ? "janitor" : /^journalist/.test(cat) ? "journalist" : "cop");

test("every real alert result parses to one log record of the right kind and target", () => {
  let n = 0;
  for (const fx of list) {
    const r = alertResult(view, { senderId: fx.sender === "player" ? "ash" : "server", content: fx.text });
    if (fx.expected === null || fx.sender === "player") { assert.equal(r, null, fx.text); continue; }
    assert.ok(r, `no record: ${fx.text}`);
    assert.equal(r.kind, KIND(fx.category), fx.text);
    assert.equal(r.targetId, fx.expected.target.toLowerCase(), fx.text);
    n += 1;
  }
  assert.ok(n >= 40, `only ${n} results`);
});

test("the record carries the result itself", () => {
  assert.deepEqual(alertResult(view, { senderId: "server", content: ":invest: After investigating, you learn that Bea is Mafia!" }), { kind: "cop", targetId: "bea", target: "Bea", result: "Mafia" });
  assert.deepEqual(alertResult(view, { senderId: "server", content: ":mop: You discover Cal's role is Cop." }), { kind: "janitor", targetId: "cal", target: "Cal", result: "Cop" });
  assert.equal(alertResult(view, { senderId: "server", content: ":journ: You learn that Dot received no reports." }).result, "no reports");
  assert.equal(alertResult(view, { senderId: "server", content: "Bea was lynched." }), null);
});
