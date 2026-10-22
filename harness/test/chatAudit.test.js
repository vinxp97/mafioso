// chatAudit on real bot chat: every public line a bot seat sent in the g01-g16 live fixtures, audited in that
// seat's own view just before the line arrived. Pinned: the two g05 lines that leak prompt words; no contradictions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emptyView, reduce, chatAudit, isPublicSpeechMeeting } from "mafioso-engine";
import { runSelfplay } from "../src/selfplay.js";

const DIR = fileURLToPath(new URL("./fixtures/replays/", import.meta.url));

function auditFixtures() {
  let checked = 0; const flags = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".jsonl")).sort()) {
    const views = {};
    for (const line of readFileSync(DIR + f, "utf8").split("\n").filter(Boolean)) {
      const fr = JSON.parse(line);
      const v = views[fr.accountId] || emptyView();
      const m = fr.event === "message" ? v.meetings?.[fr.data?.meetingId] : null;
      if (m && fr.data.senderId === v.selfId && isPublicSpeechMeeting(m)) {
        checked += 1;
        for (const x of chatAudit(v, fr.data.content)) flags.push(`${f} ${x.kind} ${x.rule}`);
      }
      views[fr.accountId] = reduce(v, fr);
    }
  }
  return { checked, flags };
}

test("live bot chat in g01-g16: g05's two prompt-word leaks and g14's three self-by-handle lines are flagged", () => {
  const { checked, flags } = auditFixtures();
  assert.ok(checked > 300, `${checked} lines`);
  // g14: "player08, player07's silence is just vibes" from Player07, and two more like it (live2-fixes item 4).
  assert.deepEqual(flags, ["g05.jsonl LEAK public-leak", "g05.jsonl LEAK public-leak",
    // L6: the Cop's "vote player08" at the sole Sheriff claimer, no guilty on him.
    "g14.jsonl CONTRADICTION self-third-person", "g14.jsonl CONTRADICTION lynch-sheriff",
    // Night 5 rebuild: the Sheriff's Day 1 shot now lands where the log has it (early), so the Cop's later
    // "player08, why are you targeting me, you're sus." meets a gun-revealed Sheriff (the old fixture fired at day end).
    "g14.jsonl CONTRADICTION attacks-sheriff",
    "g14.jsonl CONTRADICTION self-third-person", "g14.jsonl CONTRADICTION self-third-person"]);
});

test("self-play reports the audit; measure mode audits without blocking, 0 illegal either way", async () => {
  for (const chatAudit of ["measure", "enforce"]) {
    const { scorecard } = await runSelfplay({ games: 2, seed: 4, chatAudit });
    assert.equal(scorecard.chatAudit.mode, chatAudit);
    assert.ok(scorecard.chatAudit.checked > 0);
    assert.equal(scorecard.illegalActions.total, 0);
  }
});
