# Chat pass-through (Night 6, 10/20): `config.chatPassthrough`, off by default

Branch `chat-passthrough-20261020` (local only, off `sheriff-target-20261020` @ 55a9c87), worktree /workspace/chat-pass.
Selfplay flag: `--chat-pass on`. Table option: `createBotTable(..., { chatPassthrough: true })`. Seat views get it
through the usual `botConfig` frame. The live CLI doesn't expose it yet.

## Why
In the Night 5 live games (g1 xYGzM63iO, g2 4SnTMVJyP, g3 So2OKZ3td), only 11 model lines went out against 333 model
rejects (2.5-4.2% yield). Source: the sanitized logs in /workspace/restartq/live-night5, rebuilt into replay
fixtures with `scripts/build-replays.mjs` and labelled with `scripts/audit-rejects.mjs`.

### Reject breakdown (411 `speech-reject` lines; a reject is filed under its chat-audit rule when it has one)
| rule | g1 | g2 | g3 | total | text logged | blocked good lines? |
|---|---|---|---|---|---|---|
| too-similar | 53 | 30 | 34 | 117 | 73 | **Yes, for the 73 claim-rule rejects.** They are 4 distinct liar call-outs ("Player08 is lying") from a claimed power role, blocked because another seat had just said the same words, then retried on every frame (45 times in g1). The 44 model rejects have no text logged. |
| early-claim | 33 | 24 | 25 | 82 | 1 | **No, as far as the logs show.** The one logged line is a real early Villager claim ("Player01 im villager, that Player09 vote looks sus"), and the gate is policy. |
| stale reply | 34 | 22 | 19 | 75 | 75 | **Mostly yes.** All 75 still pass every validator in the latest state. They were dropped only by the 30s reply window, while model replies came 30-302s after the line they answered. |
| model stale | 16 | 28 | 21 | 65 | 29 | **No.** The line was written for an earlier phase (a Night 1 line after Day 1 started, or a Day line in Postgame). |
| dead-sus | 5 | 30 | 0 | 35 | 3 | **No for the 3 logged** (the target was shot during the pacing hold). **Unknown for 30** (g2 Day 3, two seats, no text). |
| accuses-sheriff | 15 | 0 | 1 | 16 | 2 | **No.** These are scum mistakes ("voting Player03, suspiciously quiet" from a mafia seat, about the Sheriff). |
| lynch-sheriff | 4 | 1 | 0 | 5 | 1 | **No.** |
| self-third-person / defense phrasing / misquote / flip / result-not-received / cop one line | 4 / 4 / 1 / 1 / 1 / 1 | | | 12 | 0 | **No** (by the rule; no text logged). |
| vote-dead | 1 | 1 | 0 | 2 | 2 | **No.** It urged a vote on a dead player. |
| owes the Sheriff an answer first | 0 | 2 | 0 | 2 | 2 | **No** (by the rule). |
| length (PUBLIC_MAX) | 0 | 0 | 0 | 0 | 0 | None in these games. |

Sanitized samples (fixture names):
- **stale reply:**
  - "Player09, suspicious silence warrants scrutiny" (30s)
  - "Player08 is deflecting, vote her now." (80s)
  - "Player07 is a fake cop, vote them out" (270s)
- **too-similar:** "Player08 is lying" (claim-rule, echoing another seat's identical line)
- **model stale:** "Player02, too quiet" (a Night 1 call that returned in Day 1)
- **dead-sus (held):** "vote Player08, she was oddly accusatory" (Player08 was shot while the line was held)
- **vote-dead:** "voting Player08, she called me a liar"
- **accuses-sheriff:** "lynch Player05, quiet reads suspicious" (mafia seat; Player05 is the Sheriff)
- **owes the Sheriff an answer first:** "sheriff claim is loud, but Player09 is getting railroaded lol"

## What the flag changes
Each change is limited to `config.chatPassthrough` and is a no-op without it.
1. **Stale-reply window** (`harness/src/live.js` paceSpeech). A reply up to `CHAT_PASS.staleMaxMs` (120s) after the
   line it answers is re-validated in the latest state (validateAction, publicLeak, machineLeak). If it still
   passes, it goes out as a plain line with no reply beat. Older replies, or replies that are invalid now, are
   dropped as before. This is the same path as the earlier `staleFix.recheck`, with an age cap.
2. **Repeat check** (`repeatBlock`). Other seats' recent lines block only near-echoes, at similarity 0.8 or
   above. My own lines keep the 0.6 threshold.
3. **Echo rewrite** (`passEchoRewrite`, used by `sendClaim`). A rule call-out that echoes another seat's recent
   line is sent as "agree with <exact name>, <line>", instead of being blocked and retried every frame. My own
   echo is never rewritten.
4. **Early-claim parse** (`earlyClaimBlock`, via `withoutNarrativeRoles`). A role named in the third person is
   not a self-claim: "as the journalist reported, ...", "as a villager would ...". A comma or a first-person
   word after the role still makes it a claim: "as the cop, ash is guilty" and "as a villager i think" are both
   claims. Only the early-claim gate uses this parse; every other claim reader is unchanged.
5. **Dead-player rule** (chatAudit `dead-sus`). These segments are now allowed:
   - a past action of the dead ("the way dan voted is sus");
   - a living player named first ("cal voting with dan is sus");
   - the dead named with their public reveal ("the mafioso dan is sus").

   Still blocked: "dan is sus" with Dan dead, `vote-dead`, and a cleaned body with no reveal.

**Not loosened:** vt / v/t wording (vtLeft), false or early role claims (who may claim is unchanged), publicLeak /
machineLeak / injection text, PUBLIC_MAX, exact player names, the Cop one-line rule, chatAudit LEAK and every
other fact check, model-stale drops, "owes the Sheriff an answer", and the scum-mistake rules.

## Tests (each fails without the change; checked against 55a9c87 with the same files, 0/6 and 0/2 pass)
- `engine/test/chatPassthrough.test.js` (6 tests):
  - flag off by default;
  - narrative role mentions pass, while real, comma and first-person claims stay blocked;
  - agreeing with another seat passes, while near-echoes and my own repeats stay blocked;
  - echo rewrite;
  - dead-player past tense, living subject and reveal pass, while the dead called sus now, vote-dead and a
    cleaned body stay blocked;
  - with the flag on, an agreeing line passes while vt, injection and machine text, over-length lines and a fake
    "as the cop," claim stay blocked.
- `harness/test/chatPassthrough.test.js` (2 tests):
  - the table flag reaches the config;
  - a 60s-late reply goes out, while a 130s-late one, or one invalid now (a false flip, vt, an early claim,
    injection), is dropped.

## Measurements
### Replay of the 3 live games
Every logged rejected line was re-fed through the filter in the speaker's rebuilt view
(`/workspace/chat-pass-runs/scripts/replay-pass.mjs`).

| | flag off | flag on |
|---|---|---|
| rejects that now pass | 0 / 411 | **108 / 411** |
| …distinct lines (of 118 with text) | 0 | **39** |
| stale reply | 0 / 75 | 35 / 75 |
| too-similar (claim-rule call-outs) | 0 / 73 | 73 / 73 (4 lines, each sent once) |
| unsafe passes (vt, leak, over length, early self-claim) | 0 | **0** |
| lines sent live, still passing (rebuilt view) | 38 / 39 | 38 / 39 (same line both ways, a fixture artifact) |

With a 180s cap, 57 of the 75 stale replies would pass. Without a cap, all 75 would.

### Self-play, 200 games (seeds 31-34 × 50), `--sim-latency live1018` (stubbed model, logged latency, no network)
| | flag off | flag on |
|---|---|---|
| public lines | 6122 | **6546 (+6.9%)** |
| stale-reply drops | 370 | **131** |
| late replies re-validated and sent | 0 | 290 |
| other speech rejects (validator / chat-audit) | 3984 | 3369 |
| model-stale drops | 4199 | 4333 |
| held lines invalid at send | 675 | 556 |
| claim-guard blocks (vt, Cop split, send guard) | 20 | 37 (more lines reach the guard; all still blocked) |
| illegal actions | **0** | **0** |
| chat-audit leaks / contradictions in sent lines | 0 / 0 | 0 / 0 |
| Village wins | 123 (61.5%) | 121 (60.5%) |

## Risks
- **Latency:** a 120s-late line can read as off-topic even when it is still valid. The validator checks facts,
  not whether the conversation has moved on.
- **Echo rewrite:** "agree with X, ..." credits X. If X is scum, a town call-out now sounds aligned with them.
- **Dead-player rule:** "cal voting with dan is sus" is allowed on the assumption that the first-named living
  player is the subject. Odd word orders can slip through.
- **Unknown cases:** 223 of the 411 rejects logged no text (early-claim 81, model too-similar 44, model stale 36,
  dead-sus 32, and others), so the flag's effect on them is unknown. Logging `line=` on every reject would settle that.
- **Self-play:** the stub's lines are short replies. Self-play measures stale and legality effects, not
  real-model phrasing.
- **Not tested live:** no live or dev game has been run with the flag.
