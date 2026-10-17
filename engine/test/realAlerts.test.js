// Real role-result alerts (sanitized, from the Ultimafia game archive) through the real engine parsers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseServerInfo, cleanedRoles, journalistInfo, reduceAll, memoryOf } from "../src/index.js";
import { checkFixture, players } from "./realAlerts.helper.js";

const data = JSON.parse(fs.readFileSync(new URL("./fixtures/real-alerts.json", import.meta.url), "utf8"));

test("fixture file: every role-result category is present and names are sanitized", () => {
  const cats = new Set(data.fixtures.map((f) => f.category));
  for (const c of ["cop-alignment", "cop-role", "journalist-none", "journalist-reports", "janitor"]) assert.ok(cats.has(c), c);
  const fake = new Set(Object.values(players).map((p) => p.name));
  for (const f of data.fixtures) if (f.expected?.target) assert.ok(fake.has(f.expected.target), f.text);
});

for (const fx of data.fixtures) {
  test(`real alert [${fx.category}] ${fx.text.slice(0, 90)}`, () => {
    const { ok, got } = checkFixture(fx, { parseServerInfo, cleanedRoles });
    assert.ok(ok, `expected ${JSON.stringify(fx.expected)}, got ${JSON.stringify(got)}`);
  });
}

test("a Journalist seat that receives a real report remembers it, and only a :mop: report names the Janitor", () => {
  const seat = (content) => reduceAll([
    { event: "self", data: "me" }, { event: "players", data: players },
    { event: "roleReveal", data: { playerId: "me", role: "Journalist" } },
    { event: "state", data: { id: 3, name: "Day 2" } },
    { event: "message", data: { senderId: "server", content } },
  ]);
  for (const fx of data.fixtures.filter((f) => /^journalist/.test(f.category))) {
    const v = seat(fx.text);
    const id = fx.expected.target.toLowerCase();
    assert.ok(memoryOf(v).checks[id], `check stored: ${fx.text}`);
    const info = journalistInfo(v);
    assert.equal(info?.kind === "janitor" && info.target === id, fx.expected.janitor, fx.text);
  }
});

test("a role Cop's report inside a Journalist report is not a Janitor call (real false positive, fixed)", () => {
  const v = { selfId: "me", players, messages: [], dead: {} };
  const r = parseServerInfo(v, { senderId: "server", content: ":journ: You received all reports that Bea received: :invest: You Learn that Ash's Role is Journalist.." });
  assert.equal(r.role, null);
});

test("':invest: You learn that X is Guilty.' (a real variant seen inside a report) parses on its own", () => {
  const v = { selfId: "me", players, messages: [], dead: {} };
  const r = parseServerInfo(v, { senderId: "server", content: ":invest: You learn that Gil is Guilty.." });
  assert.equal(r.playerId, "gil");
  assert.equal(r.align, "Mafia");
  assert.equal(parseServerInfo(v, { senderId: "server", content: ":track: You learn that Gil is Guilty." }), null, "only the investigator tag");
});
