# Night 5 solo flags (10/20, offline)

Branch `night5-solo-flags-20261020`, cut from `night5-solo-eval-20261020` @ 9a1069a. All local. No model calls, no live or dev games.

Four flags, each **off by default**. A config key only exists when it is set to `"on"`.

| flag | createBotTable / config | selfplay.mjs | what it does |
|---|---|---|---|
| (a) vote hold | `voteHold: "on"` | `--vote-hold on` | A town seat on the rules arm holds its day ballot until it has a confident read. A confident read is one of: a lynch-level read; a confirmed-town lead to follow when its own read is weak; or a top read of at least 2 that is clear of the next by 1.5. Otherwise it votes at 60% of the day, or with a minute left, on its top suspect (any read above 0). With no read above 0 it uses the usual pick. The hard rules are unchanged: the hammer ask, stuck-vote switching, never the revealed Sheriff, no Day 1 no-lynch while the Sheriff lives, and the ballot net. |
| (b) solo counterclaim | `soloCounterclaim: "on"` | `--solo-cc on` | Views get `config.botSeats`. Only bot teammates count for the Night 5 mafia counterclaim, so a lone bot counterclaims the asked Cop/Journalist itself: once, 3–7 s later, never as Sheriff, and never naming the Sheriff. |
| (c) grounded speech | `groundedSpeech: "on"` | `--grounded-speech on` | The opener, the silence filler, the speech floor and canned filler say a grounded line, or nothing. A grounded line is a town counter-story, a confident read with a sayable reason, the vote tally once a wagon has 2 or more votes, living claims, or flips. |
| (d) vote-kick guard | `voteKickGuard: "on"` | `--kick-guard on` | The Sheriff's gun, along with its isLate, lastCall and shotDeadline checks, reacts to a Vote Kick only when the kick is aimed at him: his own `youAreBeingVoteKicked`, or a Vote Kick he may not vote in. |

`--solo-flags all` turns on all four.

## Tests

Engine: 431/431 (424 plus 7 in night5SoloFlags.test.js). Harness: 305/305 (299 plus 6 in soloFlags.test.js).

**Defaults are byte-identical:**
- All 34 committed fixture files rebuild byte for byte, and the solo-timeline hash is unchanged.
- State replay is unchanged: 1,643 events, 1,415 actions, 9 + 6 refusals.
- The default solo-eval for seed 7 matches 9a1069a (same aggregate, same surveys, same scored seats except the two new fields).
- Default self-play for seed 4 (50 games): `games.jsonl` and `records.jsonl` are byte-identical to the pre-change code.

## Results

### (1) Single-bot replay of L5–L10, seeds 1–5 and 7

There are 324 seat-runs per config: each seat of each table on the rules path, with the rest following the log. Vote Kick frames are dropped, as before.

| config | town ballot right, D1 | town ballot right, D2+ | all | filler share | counterclaim (bot sent / opportunities) | illegal | rules r1–r5 |
|---|---|---|---|---|---|---|---|
| base | 69.0% (120/174) | 56.1% (74/132) | 63.4% | 67.9% (1002/1476) | 6/18 | 0 | all pass |
| voteHold | **79.8%** (134/168) | **68.1%** (92/135) | **74.6%** | 67.9% | 6/18 | 0 | all pass |
| soloCounterclaim | 69.0% | 56.1% | 63.4% | 67.2% | **18/18** | 0 | all pass |
| groundedSpeech | 67.8% | 56.1% | 62.7% | **0%** (0/1225) | 6/18 | 0 | all pass |
| voteKickGuard | 69.0% | 56.1% | 63.4% | 67.9% | 6/18 | 0 | all pass |
| all four | 78.6% | 68.8% | 74.2% | 0% | 18/18 | 0 | all pass |
| *logged occupant* | *75.0%* | *83.3%* | | | | | |

**Notes on the replay table:**
- "Town ballot right" means the town seat's final Village ballot that day was on a mafia player.
- Filler means a canned floor line or a bare "watching x".
- Lines per seat-day go from 2.9 to 2.4 under grounded speech, so the bot is quieter rather than silent.
- **Town win rate is not measurable in the replay.** The other eight seats follow the log, so the outcome is the logged one in every config.

**Vote Kick kept in the stream** (builder timing: the Vote Kick opens at the start of the day):
- Default: the Sheriff shoots under 5 s in 12 of 36 shots, and makes **6 illegal sends**. These are a second gun vote, sent in the same entry as the gun-net shot, after the instant meeting was already used. This is an existing race in the default path, not something a flag caused.
- voteKickGuard: 0 shots under 5 s, 0 illegal sends.

### (2) Self-play, seeds 4–13 × 50 games (500 per config, all nine seats are bots)

| config | Village win (Wilson 95%) | paired vs base (pts, 95%) | town ballots on scum D1 / D2+ | lynch on scum | filler | mafia CC on asked Cop/Jour. | illegal |
|---|---|---|---|---|---|---|---|
| base | 60.2% [55.8, 64.4] | | 62.0% / 58.3% | 70.3% | 17.3% | 12/19 | 0 |
| voteHold | 58.0% [53.6, 62.2] | −2.2 [−6.4, +2.0], **noise** | 56.9% / 63.0% | 70.9% | 14.5% | 13/19 | 0 |
| soloCounterclaim | 60.2% | 0 (identical games) | 62.0% / 58.3% | 70.3% | 17.3% | 12/19 | 0 |
| groundedSpeech | 60.6% [56.3, 64.8] | +0.4 [−2.8, +3.6], **noise** | 63.1% / 57.4% | 71.0% | 0.1% | 12/18 | 0 |
| voteKickGuard | 60.2% | 0 (identical games) | 62.0% / 58.3% | 70.3% | 17.3% | 12/19 | 0 |
| all four | 59.4% [55.0, 63.6] | −0.8 [−5.6, +4.0], **noise** | 58.1% / 62.6% | 71.5% | 0.1% | 13/19 | 0 |

No config changes the town win rate beyond noise. Every paired interval includes 0, and 0 errors and 0 vote kicks were recorded.

**What self-play can and can't show:**
- Self-play is a nine-bot table, so two flags are no-ops by construction:
  - soloCounterclaim changes nothing because every teammate is already a bot.
  - voteKickGuard changes nothing because the simulator sends the Vote Kick only to non-voters, so a kick is always aimed at the Sheriff.
- In self-play, voteHold makes all six town seats hold at once. Day 1 ballots get worse (62.0 → 56.9) and Day 2+ ballots get better (58.3 → 63.0). Neither win rate nor lynch accuracy moves. That is a different regime from one bot among humans.

## Recommendations (one bot among humans, real lobby)

- **(a) voteHold: turn it on for solo live games.** In the regime that matters (one bot, the rest of the table fixed), town ballot accuracy goes from 63.4% to 74.6%: +10.8 pts on Day 1 and +12 pts on Day 2+. The bot now matches the logged LLM seat on Day 1 (79.8% vs 75%), but is still below it on Day 2+ (68% vs 83%). In nine-bot self-play it is neutral (−2.2 pts, within noise). Do not turn it on for all-bot tables.
  - **Caveat:** the replay can't move the day's end. A logged day that closed early (L5) still closes, so a held ballot can't delay it. Live, the server waits for the vote or opens a Vote Kick, and the ballot net still covers that.
- **(b) soloCounterclaim: turn it on.** It fixes the single-bot gap: 18 of 18 opportunities are now counterclaimed, against 6 of 18, in 3–7 s, with rule 2 passing 18/18. It changes nothing when the teammates are bots.
  - **Caveat:** all 18 opportunities are the same L8 Day 1 situation across 3 seats × 6 seeds, so the sample is small.
  - **Live risk:** if a human teammate also counterclaims, there would be two counterclaims. The once-per-game check only sees claims already made.
- **(c) groundedSpeech: turn it on.** Filler goes from 68% to 0%. The bot says about 0.5 fewer lines per day and the rest are facts or reads. Ballots and win rate are unchanged (within noise).
  - **Caveat:** the fact lines ("claims so far: …", "votes so far: x 2") are factual but can read as robotic, and humans may still find a bot that restates the board odd. It needs a live look.
- **(d) voteKickGuard: turn it on.** It removes the instant unasked shot when a kick on someone else opens, and the duplicate gun vote that comes with it (6 → 0 illegal sends). It is a no-op otherwise.
  - **Caveat:** in the real server, a Vote Kick opens only once everyone else has voted, so it is usually aimed at the Sheriff anyway. The benefit is mostly robustness.
  - The default-path gun double-vote race should get its own fix: mark the gun used locally when gun-net fires.

## Blockers and limits

- The replay can't produce a town win rate, show how humans react, show human text, or show human teammates counterclaiming on their own.
- The counterclaim sample is tiny (one game).
- The vote hold's effect on day length and Vote Kick risk can only be seen live.
- Live validation needs the Mac ssh-agent unlock and the tunnel. Neither was attempted.

**Reproduce:**
- `node harness/scripts/solo-flags-eval.mjs [--vote-kick=keep]`
- `scripts/selfplay.mjs --games 50 --seed N [flag]`, then `scripts/solo-flags-selfplay.mjs <runsDir>`
