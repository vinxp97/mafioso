// 10/19 quiet-table variants on the live path: off by default; keyFirst only re-paces key lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotTable, paceSpeech, SPEECH_PACE } from "../src/live.js";

const view = { selfId: "me", stateId: 4, phase: { phase: "Day" }, players: { me: { id: "me", name: "Fin" }, x: { id: "x", name: "Cora" } }, dead: {},
  meetings: { vil: { id: "vil", name: "Village", speech: true, amMember: true } }, messages: [] };
const line = (content) => ({ event: "speak", data: { meetingId: "vil", content } });
const busy = (table, now) => Object.assign(table, { lastSentAt: now - 1_500, lastTableLineAt: now - 500, lastPublicAt: now + 5_000 });

test("createBotTable carries no quietTable config unless asked (defaults unchanged)", () => {
  assert.equal("quietTable" in createBotTable([{ accountId: "a" }]).config, false);
  assert.deepEqual(createBotTable([{ accountId: "a" }], { quietTable: { keyFirst: true } }).config.quietTable, { keyFirst: true });
});

test("keyFirst: a Cop result skips queued table lines and the 2.5s gap (1s claim gap only); chatter still queues", () => {
  const now = 100_000;
  const off = busy(createBotTable([{ accountId: "me" }]), now);
  const on = busy(createBotTable([{ accountId: "me" }], { quietTable: { keyFirst: true } }), now);
  const result = line("results: cora inno");
  assert.equal(paceSpeech(off, "me", view, result, now, { source: "rules" }).wait, 5_000 + SPEECH_PACE.tableGapMs);
  assert.equal(paceSpeech(on, "me", view, result, now, { source: "rules" }).wait, 0);
  // A claim on the default path still waits the table gap behind a normal line; with keyFirst it does not.
  assert.equal(paceSpeech(off, "me", view, line("im cop"), now, { source: "claim-rule", claim: true }).wait, SPEECH_PACE.tableGapMs - 500);
  assert.equal(paceSpeech(on, "me", view, line("im cop"), now, { source: "claim-rule", claim: true }).wait, 0);
  // Not a key line: same pacing either way.
  assert.equal(paceSpeech(on, "me", view, line("watching the votes"), now, { source: "day-speech" }).wait, paceSpeech(off, "me", view, line("watching the votes"), now, { source: "day-speech" }).wait);
});
