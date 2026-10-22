# Mixed-table mode and the Night 6 re-scrub (10/21). Local only

Branch `mixed-table-20261021`, off `chat-pass-eval-20261021` @ e82af3d. No games, no network, and the model is
stubbed (`--sim-latency live1018`). Every flag stays off by default.

## 1. Re-scrub of the Night 5 logs
- **Code:** `harness/src/rescrub.js` and `harness/scripts/rescrub.mjs`.
- **What it replaces**, in this order:
  - each seat's full handle → `SeatN`, and the same handle with digits and separators removed;
  - seat ids → `userN`;
  - account names → `acctN`;
  - every 3+ letter piece of a handle (split on separators and camelCase) → `NickN`.
- Matching ignores case. A token counts only when no letter sits on either side, though a plural `s` is allowed.
- JSON and JSONL files stay valid: only keys and string values change, and files without a hit are copied byte
  for byte.
- **Handle list:** read at run time from the box-only raw directory (`/workspace/live-night5-raw`). There are no
  handles in the repo, the tests or this doc. Only counts and line numbers are reported.
- **Copies** (the originals are only read):
  - `/workspace/restartq/live-night5-resanitized/`
  - `/workspace/chat-pass-runs-resanitized/`
  - `/workspace/chat-pass-eval-runs-resanitized/`

| Source | Files | Changed | Replaced | Lines (in the original) | Left after |
|---|---|---|---|---|---|
| restartq/live-night5 | 7 | 1 (g1 sanitized log) | 9 fragments | 47, 151, 245, 253, 327 | 0 |
| chat-pass-runs | 64 | 4 | 44 fragments | audit-before.json 44, 1032, 2196, 2358, 3225; fix/g01.rejects.jsonl 3, 53, 110, 117, 154; replay-base.json 1; replay-on.json 1 (both one-line JSON) | 0 |
| chat-pass-eval-runs | 75 | 0 | 0 | none | 0 |

- No full handle, id or account name was left in any source. `sanitize.py` had caught all of those, and only
  fragments got through.
- **Tests** (`harness/test/rescrub.test.js`):
  - Synthetic tests with invented handles cover fragments, camelCase, the digit-less form, plurals, JSON
    validity, untouched originals, and a planted fragment caught by the scan.
  - Box-only tests check every re-sanitized copy for zero hits. They also plant three real fragments, taken at
    run time from the list and never printed, and require each to be caught and then scrubbed.
  - If the raw directory is absent, the box tests skip with "box-only: raw handle list ... is absent".
  - Run against the original g1 log instead of the copy, the scan fails and shows file and line numbers only.

## 2. Mixed-table mode
- **Code:** `opts.mixed = { botRole, human }` in `selfplay.js`, with the seat scripts in `harness/src/mixedTable.js`.
  It is off unless set.
- **Seats:** one real bot seat in the requested role, plus eight scripted human-like seats.
- **What the scripted seats know:** only what a human would. That is public chat, votes, deaths and reveals,
  their own role and night results, and their mafia teammates.
- **How they speak:**
  - Four styles (terse, chatty, proper, quiet). The templates were adapted from phrasing in the re-sanitized
    Night 5 logs and the solo-timeline fixtures, and they name players only through placeholders.
  - Claims are villager or blue, never vt.
  - They answer a claim ask 80% of the time, 4–54 s later. Otherwise they claim late, and only when they have
    2+ votes on them (35%), or never claim.
  - A human Cop claims with a result on 55% of days.
  - A human Journalist answers an ask as journalist 60% of the time.
  - A human Sheriff claims on Day 1 half the time, then asks two reads to claim, and may shoot.
  - In 20% of games one scum human fakes Cop with a guilty.
- **How they vote:**
  - The town read is noisy: N(0,1) plus +1.0 on scum, plus public Cop results.
  - 30% move to the leading wagon late; 4% vote no one.
- **Night actions:** human mafia follow the bot's kill 85% of the time.
- **Calibration:** with a Villager bot, `readSignal` 1.0 gave 16/30 Village wins (seeds 7001–7030, earlier
  script). The final table runs a little lower, at 39–43%.
- **Eval:** `harness/scripts/mixed-table.mjs` with scoring in `harness/src/mixedEval.js`.
  - Bot seat only, 100 fresh seeds per role (6001–6100), all 7 FJ roles.
  - `base` (all flags off) against `all`: chatPassthrough, voteHold, soloCounterclaim, groundedSpeech,
    voteKickGuard and gunOnce.
  - Intervals are Wilson 95%. The win difference is paired on the same seed (same deal).

| Role | Config | Bot win | Paired Δ | Town ballots on scum | Filler | Lines/game | Stale rejects | Rechecked | Illegal | vt |
|---|---|---|---|---|---|---|---|---|---|---|
| Sheriff | base | 49% [39, 59] | | 58.8% [50.7, 66.4] | 2.9% | 13.6 | 286 | 0 | 0 | 0 |
| Sheriff | all | 52% [42, 62] | +3 [−4.1, +10.1] | 55.2% [47.0, 63.0] | 0% | 13.6 | 70 | 244 | 0 | 0 |
| Cop | base | 41% [32, 51] | | 76.5% [69.5, 82.3] | 0.5% | 16.2 | 85 | 0 | 0 | 0 |
| Cop | all | 44% [35, 54] | +3 [−3.5, +9.5] | 79.5% [72.6, 85.0] | 0% | 15.6 | 36 | 143 | 0 | 0 |
| Journalist | base | 42% [33, 52] | | 60.5% [53.6, 67.0] | 1.4% | 17.7 | 97 | 0 | 0 | 0 |
| Journalist | all | 40% [31, 50] | −2 [−8.8, +4.8] | 64.7% [58.1, 70.7] | 0% | 19.3 | 13 | 52 | 0 | 0 |
| Villager | base | 39% [30, 49] | | 64.1% [57.6, 70.1] | 2.1% | 17.6 | 170 | 0 | 0 | 0 |
| Villager | all | 43% [34, 53] | +4 [−2.2, +10.2] | 66.5% [60.3, 72.2] | 0% | 19.2 | 53 | 108 | 0 | 0 |
| Mafioso | base | 72% [63, 80] | | n/a | 3.8% | 13.8 | 14 | 0 | 0 | 0 |
| Mafioso | all | 73% [64, 81] | +1 [−1, +3] | n/a | 0% | 13.4 | 10 | 8 | 0 | 0 |
| Janitor | base | 76% [67, 83] | | n/a | 4.1% | 12.7 | 6 | 0 | 0 | 0 |
| Janitor | all | 76% [67, 83] | 0 | n/a | 0% | 12.3 | 2 | 4 | 0 | 0 |
| Lawyer | base | 73% [64, 81] | | n/a | 5.7% | 11.9 | 15 | 0 | 0 | 0 |
| Lawyer | all | 72% [63, 80] | −1 [−3, +1] | n/a | 0% | 11.4 | 3 | 15 | 0 | 0 |

- For a town bot, the bot win is the Village win; for a scum bot it is 100 − Village.
- No run had an illegal action from the bot or a scripted seat, and none used vt.
- Errors: 0, apart from two 8-day draws, both in an earlier, superseded run.

**Sheriff bot** (base → all)
- Claims in 94% of games, median 10 s into Day 1.
- It asks 106 → 108 times, and 71% of the asks go to scum.
- Shots: 94 → 90, on scum 71.3% [61.4, 79.4] → 74.4% [64.6, 82.3].
- Shots on town: 27 → 23 (some shots are on Day 2+; the counts are per shot). The median shot comes at 135 s.
- In the one town shot I inspected (seed 6002), the bot asked a human Journalist and shot it before it answered. Human answers come 4–54 s later, or never. I did not count how often this happens.

**Cop bot** (base → all)
- Claims in 87% → 85% of games, with one claim line per day (87/87 and 85/85).
- Each claim carries its result on the same line (100%), with 0 extra "results:" lines.
- The median Day 1 claim comes 35 s in.

**Scum bot, counterclaims**
- A true human Cop or Journalist claim gets a counterclaim 0/44 (Mafioso), 2/44 (Janitor) and 0/31–32 (Lawyer).
  That is the same with and without soloCounterclaim.
- The engine's rule fires only on a claimed Sheriff's asked target, and that case came up in only 0–1 games per
  role. So this mode barely exercises the counterclaim.

## Tests
Engine 454/454; harness 321/321 (+5 rescrub, +6 mixed-table).

## Risks
- The scripted seats are a model of humans, not humans. Their read quality, answer delays and chattiness set
  the win rate and the Sheriff's town shots. Treat absolute numbers as relative to this script.
- Fragment matching is conservative. A fragment that is also an ordinary word is replaced everywhere in the
  copies; none of the 54 fragments is on a short common-word list. Misspelled or leetspeak forms of a handle
  are not caught.
- The re-scrub covers the three listed directories only. Commit 0b1cd5f, an ancestor of this branch, still
  holds three fragments in a test and needs squashing before any push. That is a history rewrite and needs
  approval.
