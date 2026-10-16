import test from "node:test";
import assert from "node:assert/strict";
import { probeGame, runStreamLoop } from "../src/live.js";

const sse = (obj, type = "game") => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test("socket drop mid-game reconnects, resumes via backfill, and seq dedupe keeps one copy", async () => {
  const c = clock(); let n = 0; const seen = []; const lastSeq = {};
  const onFrame = async ({ entry }) => {
    if (entry.seq <= (lastSeq[entry.accountId] ?? 0)) return false; // per-seat seq guard
    lastSeq[entry.accountId] = entry.seq; seen.push(entry.seq);
    return entry.event === "winners";
  };
  const out = await runStreamLoop({
    sleep: c.sleep, backoff: () => 1000, ourIds: ["A"], onFrame,
    restart: { now: c.now, checkGame: async () => "alive" },
    fetchStream: async () => {
      n++;
      if (n === 1) return (async function* () { yield sse({ accountId: "A", seq: 1, event: "state" }); throw new Error("socket hang up"); })();
      if (n === 2) throw new Error("ECONNREFUSED"); // server still booting
      return [sse({ accountId: "A", seq: 2, event: "state" }), sse({ accountId: "A", seq: 3, event: "winners" })];
    },
    backfill: async () => (n >= 3 ? [{ accountId: "A", seq: 1, event: "state" }, { accountId: "A", seq: 2, event: "state" }] : []),
  });
  assert.deepEqual(out, { status: "finished" });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(n, 3);
});

test("drop that never recovers aborts within the try/time limit instead of hanging", async () => {
  const c = clock(); let n = 0; const info = [];
  const out = await runStreamLoop({
    sleep: c.sleep, backoff: () => 5000, ourIds: ["A"], onInfo: (m) => info.push(m),
    restart: { now: c.now, checkGame: async () => "unknown", maxTries: 3, windowMs: 60_000 },
    fetchStream: async () => { n++; throw new Error("ECONNREFUSED"); },
    onFrame: async () => false,
  });
  assert.equal(out.status, "aborted");
  assert.equal(out.reason, "server_restart");
  assert.equal(n, 4); // first try + 3 reconnects
  assert.ok(c.now() <= 60_000);
  assert.ok(info.some((m) => /giving up/.test(m)));
});

test("outage longer than the window aborts even before maxTries", async () => {
  const c = clock(); let n = 0;
  const out = await runStreamLoop({
    sleep: c.sleep, backoff: () => 40_000, ourIds: ["A"],
    restart: { now: c.now, checkGame: async () => "unknown", maxTries: 10, windowMs: 60_000 },
    fetchStream: async () => { n++; await c.sleep(1); throw new Error("timeout"); },
    onFrame: async () => false,
  });
  assert.equal(out.status, "aborted");
  assert.ok(n <= 3);
});

test("reconnect that succeeds but the server forgot the game aborts", async () => {
  const c = clock(); let n = 0; let probes = 0;
  const out = await runStreamLoop({
    sleep: c.sleep, backoff: () => 1000, ourIds: ["A"],
    restart: { now: c.now, checkGame: async () => (++probes === 1 ? "unknown" : "lost") },
    fetchStream: async () => { n++; if (n === 1) throw new Error("socket hang up"); return [sse({ ping: 1 }, "ping")]; },
    onFrame: async () => false,
  });
  assert.equal(out.status, "aborted");
  assert.match(out.detail, /no longer known/);
});

test("accounts_dropped storm for our seats is a restart only when the game is actually lost", async () => {
  const storm = () => [1, 2, 3].map(() => sse({ accounts: [{ id: "A", gameId: "g1" }] }, "accounts_dropped"));
  // Game still alive: reconnect and keep playing to the end.
  { const c = clock(); let n = 0;
    const out = await runStreamLoop({
      sleep: c.sleep, backoff: () => 100, ourIds: ["A"],
      restart: { now: c.now, checkGame: async () => "alive" },
      fetchStream: async () => (++n === 1 ? storm() : [sse({ accountId: "A", seq: 9, event: "winners" })]),
      onFrame: async ({ entry }) => entry?.event === "winners",
    });
    assert.deepEqual(out, { status: "finished" }); assert.equal(n, 2); }
  // Game gone: abort at once.
  { const c = clock(); let n = 0;
    const out = await runStreamLoop({
      sleep: c.sleep, backoff: () => 100, ourIds: ["A"],
      restart: { now: c.now, checkGame: async () => "lost" },
      fetchStream: async () => { n++; return storm(); },
      onFrame: async () => false,
    });
    assert.equal(out.status, "aborted"); assert.equal(n, 1); }
  // Storm about other boots' accounts: ignored, no reconnect, no probe.
  { let probes = 0;
    const out = await runStreamLoop({
      ourIds: ["A"], restart: { checkGame: async () => { probes++; return "lost"; } },
      fetchStream: async () => [sse({ accounts: [{ id: "Z", gameId: "old" }] }, "accounts_dropped"), sse({ accountId: "A", seq: 1, event: "winners" })],
      onFrame: async ({ entry }) => entry?.event === "winners",
    });
    assert.deepEqual(out, { status: "finished" }); assert.equal(probes, 0); }
});

test("probeGame: lost when the server no longer lists our seats or 404s their buffers", async () => {
  const mk = (accounts, eventsErr) => ({
    api: async () => { if (accounts instanceof Error) throw accounts; return accounts; },
    events: async () => { if (eventsErr) throw eventsErr; return []; },
  });
  const ids = { gameId: "g1", accountIds: ["A", "B"] };
  assert.equal(await probeGame(mk([{ id: "A", gameId: "g1" }]), ids), "alive");
  assert.equal(await probeGame(mk([]), ids), "lost");
  assert.equal(await probeGame(mk([{ id: "A", gameId: "g2" }]), ids), "lost");
  assert.equal(await probeGame(mk(new Error("fetch failed")), ids), "unknown");
  assert.equal(await probeGame(mk(new Error("GET /dev/accounts -> 404"), new Error("GET /dev/accounts/A/events?since=0 -> 404")), ids), "lost");
});

test("a server that accepts the stream but drops it at once (flapping) still aborts", async () => {
  const c = clock(); let n = 0;
  const out = await runStreamLoop({
    sleep: c.sleep, backoff: () => 1000, ourIds: ["A"],
    restart: { now: c.now, checkGame: async () => "alive", maxTries: 3 },
    fetchStream: async () => { n++; return (async function* () { throw new Error("socket hang up"); })(); },
    backfill: async () => [], onFrame: async () => false,
  });
  assert.equal(out.status, "aborted");
  assert.equal(n, 4);
});

test("live cli: server restart mid-game ends with one game_end aborted line and no further sends", async () => {
  const { runLiveCli } = await import("../src/live.js");
  const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mafioso-restart-"));
  let streams = 0; let restarted = false; const lines = []; let t = 1_700_000_000_000;
  const dayA = [
    { accountId: "A", seq: 1, event: "self", data: "p1" },
    { accountId: "A", seq: 2, event: "state", data: { id: 1, name: "Day 1" } },
  ].map((e) => `event: game\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const res = (status, body, stream) => ({ ok: status < 300, status, headers: {}, body: stream, text: async () => JSON.stringify(body ?? {}) });
  const fetch = async (url, init = {}) => {
    if (url.endsWith("/dev/token")) return res(200, { token: "tok" });
    if (url.endsWith("/game/host")) return res(200, "g-r");
    if (url.endsWith("/dev/accounts") && init.method === "POST") return res(200, [{ id: "A" }, { id: "B" }]);
    if (url.endsWith("/dev/accounts")) return res(200, restarted ? [] : [{ id: "A", gameId: "g-r" }, { id: "B", gameId: "g-r" }]);
    if (url.endsWith("/game/leave")) return res(200, { ok: true });
    if (url.includes("/events")) return res(restarted ? 404 : 200, []);
    if (url.endsWith("/dev/stream")) {
      streams++;
      if (streams === 1) return res(200, {}, (async function* () { yield dayA; restarted = true; throw new Error("socket hang up"); })());
      return res(502, {});
    }
    if (url.includes("/send")) throw new Error("must not send after restart");
    return res(404, {});
  };
  const code = await runLiveCli({
    fetch, log: (m) => lines.push(m), sleep: async (ms) => { t += ms; }, now: () => t, rng: () => 0.5,
    env: { MAFIOSO_LIVE: "1", DEV_API_BASE_URL: "http://127.0.0.1:3000", DEV_API_CLIENT_ID: "c", DEV_API_CLIENT_SECRET: "s",
      DEV_SETUP_ID: "x", BOT_COUNT: "2", MAFIOSO_LLM: "lmstudio", LM_STUDIO_BASE_URL: "http://host.docker.internal:1234/v1",
      LM_STUDIO_MODEL: "q", MAFIOSO_PROMPT_DIR: dir, MAFIOSO_EVOLVE: "0" },
  });
  assert.equal(code, 0);
  const ends = lines.filter((l) => l.startsWith("game_end"));
  assert.deepEqual(ends, ["game_end status=aborted reason=server_restart game=g-r"]);
  assert.ok(streams <= 4);
});

// Replays of two patterns from Vinman's dev logs (ids replaced).
// qwen-20261016-0141: one accounts_dropped at connect ("The server restarted...", an older bootId) that
// named our seat, yet the game lived on and reached winners. Must resume, not abort.
// live-0d5ad9b-r2: 163 accounts_dropped stream-errors in a row and the game never progressed. Must abort.
const droppedFrame = (ids) => `event: accounts_dropped\ndata: ${JSON.stringify({ accounts: ids.map((id, i) => ({ id, gameId: i ? "old-game" : "g-now", status: "dropped", lastSeq: 17, bootId: "oldBoot", error: "The server restarted and this connection was lost." })) })}\n\n`;
test("replay 0141: startup accounts_dropped from an older boot while our game is alive resumes and finishes", async () => {
  let n = 0; let t = 0;
  const out = await runStreamLoop({
    sleep: async (ms) => { t += ms; }, backoff: () => 500, ourIds: ["SEAT1", "SEAT2"],
    restart: { now: () => t, checkGame: async () => "alive" },
    fetchStream: async () => (++n === 1 ? [droppedFrame(["SEAT1", "X9"])] : [sse({ accountId: "SEAT1", seq: 5, event: "winners" })]),
    backfill: async () => [], onFrame: async ({ entry }) => entry?.event === "winners",
  });
  assert.deepEqual(out, { status: "finished" });
});
test("replay r2: endless accounts_dropped storm with the game gone ends in a few tries instead of 163", async () => {
  let n = 0; let t = 0;
  const out = await runStreamLoop({
    sleep: async (ms) => { t += ms; }, backoff: () => 500, ourIds: ["SEAT1"],
    restart: { now: () => t, checkGame: async () => (n < 2 ? "unknown" : "lost") },
    fetchStream: async () => { n++; return [droppedFrame(["SEAT1"])]; },
    backfill: async () => [], onFrame: async () => false,
  });
  assert.equal(out.status, "aborted");
  assert.ok(n <= 4, `connects=${n}`);
});
