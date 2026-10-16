import { test } from "node:test";
import assert from "node:assert/strict";
import { copyDelay, COPY_VOTE, DAY_VOTE } from "../src/live.js";

test("copy-vote delay is random 2-15s, never above 15s, teammates >=2s apart", () => {
  assert.equal(COPY_VOTE.maxMs, 15000);
  assert.ok(DAY_VOTE.staggerMaxMs <= 15000);
  for (let g = 0; g < 200; g++) {
    const table = {};
    const waits = [0, 1, 2, 3].map(() => copyDelay(table, "kill|s1"));
    for (const w of waits) assert.ok(w >= 2000 && w <= 15000, `${w}`);
    for (let i = 0; i < waits.length; i++) for (let j = i + 1; j < waits.length; j++) assert.ok(Math.abs(waits[i] - waits[j]) >= 2000, `${waits}`);
  }
  // Even a degenerate rng stays inside the cap.
  assert.equal(copyDelay({}, "x", () => 0.9999999), 15000);
  assert.equal(copyDelay({}, "x", () => 0), 2000);
});
