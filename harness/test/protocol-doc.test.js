// docs/PROTOCOL.md must document every message type the harness can see, with the same handled/ignored
// status as classifyEvent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyEvent, HANDLED_EVENTS, IGNORED_EVENTS } from "mafioso-engine";

const doc = fs.readFileSync(new URL("../../docs/PROTOCOL.md", import.meta.url), "utf8");
const dir = new URL("./fixtures/replays/", import.meta.url);
const fixtureTypes = new Set();
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")))
  for (const line of fs.readFileSync(new URL(f, dir), "utf8").trim().split("\n")) fixtureTypes.add(JSON.parse(line).event);

/** Rows of the "## 6. Message types" table: type -> {direction, fields, status, fixture, why}. */
function docRows() {
  const start = doc.indexOf("## 6. Message types");
  assert.ok(start >= 0, "section 6 missing");
  const rest = doc.slice(start + 1);
  const section = rest.slice(0, rest.search(/\n## /) >= 0 ? rest.search(/\n## /) : undefined);
  const rows = new Map();
  for (const line of section.split("\n")) {
    const m = /^\| `([^`]+)` \| ([^|]+) \| (.+) \| (handled|ignored|unknown) \| (yes|no) \| (.+) \|$/.exec(line);
    if (!m) continue;
    assert.ok(!rows.has(m[1]), `duplicate row ${m[1]}`);
    rows.set(m[1], { direction: m[2].trim(), fields: m[3].trim(), status: m[4], fixture: m[5] === "yes", why: m[6].trim() });
  }
  return rows;
}

test("PROTOCOL.md documents every fixture type and every classifyEvent type (0 undocumented)", () => {
  const rows = docRows();
  const want = new Set([...fixtureTypes, ...HANDLED_EVENTS, ...Object.keys(IGNORED_EVENTS)]);
  const missing = [...want].filter((t) => !rows.has(t));
  assert.deepEqual(missing, [], `undocumented: ${missing.join(", ")}`);
  assert.equal(fixtureTypes.size, 40, "fixture type count changed: update the doc");
});

test("each documented status matches classifyEvent, and the fixture column matches the fixtures", () => {
  for (const [type, row] of docRows()) {
    assert.equal(row.status, classifyEvent(type).kind, `${type}: doc says ${row.status}`);
    assert.equal(row.fixture, fixtureTypes.has(type), `${type}: fixture column`);
    assert.ok(row.direction && row.fields && row.why.length > 10, `${type}: direction, fields and reason`);
    if (row.direction === "local") assert.ok(!fixtureTypes.has(type), `${type} is local but seen on the stream`);
  }
});

test("PROTOCOL.md has the protocol sections and the real alert wording, and no secret values", () => {
  for (const h of ["Connection and auth", "Hosting and joining", "Receiving events", "State, chat, votes and actions", "Reconnect and buffered events", "Real alert wording"])
    assert.match(doc, new RegExp(`## \\d+\\. ${h}`), h);
  const alerts = JSON.parse(fs.readFileSync(new URL("../../engine/test/fixtures/real-alerts.json", import.meta.url), "utf8"));
  for (const tag of new Set(alerts.fixtures.map((f) => (/^:(\w+):/.exec(f.text) || [])[1]).filter(Boolean))) assert.ok(doc.includes(`:${tag}:`), tag);
  assert.doesNotMatch(doc, /(clientSecret|client-secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}/i, "no secret values");
  assert.doesNotMatch(doc, /eyJ[A-Za-z0-9_-]{10,}/, "no JWTs");
});
