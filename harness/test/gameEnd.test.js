import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gameFinished, runLiveCli } from "../src/live.js";

const table = (views) => ({ views });

test("game ends when one seat has the winners result, even if kicked seats never get it (pr9 / live-final)", () => {
  const ids = ["A", "B", "C"];
  assert.equal(gameFinished(table({ A: {}, B: {}, C: {} }), ids), false);
  assert.equal(gameFinished(table({ A: { finished: true, winners: { groups: ["Mafia"] } }, B: {}, C: { leftGame: true } }), ids), true);
});

test("game ends when every seat is finished or gone; not while one seat still plays", () => {
  const ids = ["A", "B"];
  assert.equal(gameFinished(table({ A: { finished: true }, B: { leftGame: true } }), ids), true);
  assert.equal(gameFinished(table({ A: { finished: true }, B: {} }), ids), false);
  assert.equal(gameFinished(table({}), []), false);
});

const res = (status, body, stream) => ({ ok: status < 300, status, headers: {}, body: stream, text: async () => JSON.stringify(body ?? {}) });
const env = (dir) => ({ MAFIOSO_LIVE: "1", DEV_API_BASE_URL: "http://127.0.0.1:3000", DEV_API_CLIENT_ID: "c", DEV_API_CLIENT_SECRET: "s",
  DEV_SETUP_ID: "x", BOT_COUNT: "2", MAFIOSO_LLM: "lmstudio", LM_STUDIO_BASE_URL: "http://host.docker.internal:1234/v1", LM_STUDIO_MODEL: "q", MAFIOSO_PROMPT_DIR: dir, MAFIOSO_EVOLVE: "0" });
const tmp = async () => { const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path"); return fs.mkdtemp(path.join(os.tmpdir(), "mafioso-end-")); };

for (const withLeft of [true, false]) test(`live cli: winners reaching only the seat still in the game ends the run (kicked seat never gets it; left frame ${withLeft ? "seen" : "missed"})`, async () => {
  const lines = []; let streams = 0;
  const frames = [
    { accountId: "A", seq: 1, event: "self", data: "p1" },
    { accountId: "B", seq: 1, event: "self", data: "p2" },
    { accountId: "A", seq: 2, event: "state", data: { id: 1, name: "Day 1" } },
    { accountId: "B", seq: 2, event: "state", data: { id: 1, name: "Day 1" } },
    { accountId: "B", seq: 3, event: "left", data: {} },
    { accountId: "A", seq: 3, event: "winners", data: { groups: ["Village"], players: ["p1"] } },
  ].filter((e) => withLeft || e.event !== "left").map((e) => `event: game\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const fetch = async (url, init = {}) => {
    if (url.endsWith("/dev/token")) return res(200, { token: "t" });
    if (url.endsWith("/game/host")) return res(200, "g-end");
    if (url.endsWith("/dev/accounts") && init.method === "POST") return res(200, [{ id: "A" }, { id: "B" }]);
    if (url.endsWith("/dev/accounts")) return res(200, [{ id: "A", gameId: "g-end" }, { id: "B", gameId: "g-end" }]);
    if (url.endsWith("/game/leave")) return res(200, {});
    if (url.includes("/events")) return res(200, []);
    if (url.endsWith("/dev/stream")) { streams++; return res(200, {}, [frames]); }
    if (url.includes("/send")) return res(200, {});
    if (url.includes("/chat/completions")) return res(200, { choices: [{ message: { content: "{}" } }] });
    return res(404, {});
  };
  let t = 1_700_000_000_000;
  const code = await runLiveCli({ fetch, log: (m) => lines.push(m), sleep: async (ms) => { t += ms; }, now: () => t, rng: () => 0.5, env: env(await tmp()) });
  assert.equal(code, 0);
  if (withLeft) assert.equal(streams, 1); else assert.ok(streams < 60, `streams=${streams}`);
  assert.deepEqual(lines.filter((l) => l.startsWith("game_end")), ["game_end status=finished game=g-end winner=Village"]);
});

test("live cli: Ctrl+C logs one game_end status=stopped line", async () => {
  const lines = []; const sig = new EventEmitter(); let code = null;
  let release; const hang = new Promise((r) => { release = r; });
  const fetch = async (url, init = {}) => {
    if (url.endsWith("/dev/token")) return res(200, { token: "t" });
    if (url.endsWith("/game/host")) return res(200, "g-sig");
    if (url.endsWith("/dev/accounts") && init.method === "POST") return res(200, [{ id: "A" }, { id: "B" }]);
    if (url.endsWith("/dev/accounts")) return res(200, []);
    if (url.endsWith("/game/leave")) return res(200, {});
    if (url.includes("/events")) return res(200, []);
    if (url.endsWith("/dev/stream")) {
      setImmediate(() => sig.emit("SIGINT"));
      return res(200, {}, (async function* () { await hang; })());
    }
    return res(404, {});
  };
  const run = runLiveCli({ fetch, log: (m) => lines.push(m), sleep: async () => {}, rng: () => 0.5, env: env(await tmp()), signals: sig,
    exit: (c) => { code = c; release(); } });
  await hang;
  assert.equal(code, 130);
  assert.deepEqual(lines.filter((l) => l.startsWith("game_end")), ["game_end status=stopped reason=sigint game=g-sig"]);
  await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, 200))]);
});

test("after the first winners, other seats get a grace window before the run stops", () => {
  let t = 0; const tb = table({ A: { finished: true, winners: { groups: ["Mafia"] } }, B: {} });
  const opts = { now: () => t, graceMs: 10_000 };
  assert.equal(gameFinished(tb, ["A", "B"], opts), false);
  t = 9_999; assert.equal(gameFinished(tb, ["A", "B"], opts), false);
  t = 10_000; assert.equal(gameFinished(tb, ["A", "B"], opts), true);
});
