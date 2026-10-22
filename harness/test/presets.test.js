import test from "node:test";
import assert from "node:assert/strict";
import { presetFlags, RECOMMENDED } from "../src/presets.js";
import { SOLO_CONFIGS } from "../src/soloFlagsEval.js";
import { MIXED_CONFIGS } from "../scripts/mixed-table.mjs";

const LISTED = ["soloCounterclaim", "groundedSpeech", "voteKickGuard", "gunOnce", "chatPassthrough", "sheriffLateGrace", "teamClaimGuard", "wideClaimParse"];

test("recommended preset: exactly the recommended flags; voteHold only on solo tables", () => {
  assert.deepEqual(Object.keys(RECOMMENDED).sort(), [...LISTED].sort());
  const solo = presetFlags("recommended", { solo: true });
  assert.deepEqual(Object.keys(solo).sort(), [...LISTED, "voteHold"].sort());
  assert.equal(solo.voteHold, "on");
  assert.equal(solo.chatPassthrough, true);
  assert.equal(presetFlags("recommended").voteHold, undefined);
  assert.deepEqual(presetFlags("off"), {});
  assert.throws(() => presetFlags("nope"), /unknown preset/);
});

test("code defaults stay off: base configs carry no flags; eval configs match the preset", () => {
  assert.deepEqual(MIXED_CONFIGS.base, {});
  assert.deepEqual(MIXED_CONFIGS.recommended, presetFlags("recommended", { solo: true }));
  assert.deepEqual(SOLO_CONFIGS.base, {});
  assert.deepEqual(SOLO_CONFIGS.recommended, presetFlags("recommended"));
});
