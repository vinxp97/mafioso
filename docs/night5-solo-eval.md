# Night 5 single-bot eval (offline, 2026-10-20)

Branch `night5-solo-eval-20261020` (off `night5-fixtures-20261020` @ 385fe71). This eval makes no model calls and plays no live or dev games.
Code: `harness/src/soloEval.js`, `harness/scripts/solo-eval.mjs`, tests in `harness/test/soloEval.test.js`.
Run it with `node harness/scripts/solo-eval.mjs [--seed=N] [--vote-kick=keep] [--json=out.json]`.

## Bottom line first: no fixture has a human in it

All 25 fixtures (g01-g16, L2-L10) are tables of **9 harness bot seats**: an LLM for speech plus the rules path. Every fixture has **0 human seats and 0 human lines**. That is 761 public lines in total, and every one is from a harness seat. The logs are the harness's own, so every account at every table was ours.

The closest substitute for a human table is **L5-L10**. They have an exact seat binding (seatmap), roles taken from the meeting lines, and real `t=` timestamps. L2-L4 have no timestamps, and g01-g16 have guessed or partial seat bindings.

**Caveat on every number below:** the "players" around the bot are LLM bots from the same harness. They write like bots, answer the Sheriff in bot style, and follow bot conventions. This is a counterfactual of Mafioso's rules path against LLM bots, not against people.

## Survey

The public lines below are what the logs recorded (the sends and chat lines the harness logged), each line counted once. Every seat's copy is folded into one. g13 has no players frame.

| fixture | source | seats | bot seats | human seats | public lines | human lines | days | lines/seat/day | words/line | roles trusted |
|---|---|---|---|---|---|---|---|---|---|---|
| g01 | live, pre-10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g02 | live, pre-10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g03 | live, pre-10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g04 | live, pre-10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g05 | live, pre-10/16 | 9 | 9 | 0 | 117 | 0 | 2 | 6.5 | 17.2 | no |
| g06 | live, pre-10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g07 | qwen 10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g08 | qwen 10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g09 | qwen 10/16 | 9 | 9 | 0 | 11 | 0 | 1 | 1.2 | 17.3 | no |
| g10 | qwen 10/16 | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g11 | qwen 10/16 | 9 | 9 | 0 | 15 | 0 | 1 | 1.7 | 6.1 | no |
| g12 | qwen 10/16 | 9 | 9 | 0 | 20 | 0 | 1 | 2.2 | 6.6 | no |
| g13 | qwen 10/16 | 0 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | no |
| g14 | qwen 10/16 | 9 | 9 | 0 | 253 | 0 | 2 | 14.1 | 6.9 | no |
| g15 | muse 10/17 | 9 | 9 | 0 | 6 | 0 | 1 | 0.7 | 4.2 | no |
| g16 | qwen 10/17 | 9 | 9 | 0 | 24 | 0 | 2 | 1.3 | 6.8 | no |
| l02 | live L2 | 9 | 9 | 0 | 64 | 0 | 4 | 1.8 | 6.8 | yes |
| l03 | live L3 | 9 | 9 | 0 | 34 | 0 | 2 | 1.9 | 6.4 | yes |
| l04 | live L4 | 9 | 9 | 0 | 86 | 0 | 1 | 9.6 | 7.5 | yes |
| l05 | live L5 | 9 | 9 | 0 | 37 | 0 | 2 | 2.1 | 6.1 | yes |
| l06 | live L6 | 9 | 9 | 0 | 17 | 0 | 1 | 1.9 | 5.2 | yes |
| l07 | live L7 | 9 | 9 | 0 | 14 | 0 | 2 | 0.8 | 4.7 | yes |
| l08 | live L8 | 9 | 9 | 0 | 18 | 0 | 3 | 0.7 | 5.9 | yes |
| l09 | live L9 | 9 | 9 | 0 | 30 | 0 | 3 | 1.1 | 4.5 | yes |
| l10 | live L10 | 9 | 9 | 0 | 15 | 0 | 3 | 0.6 | 6.3 | yes |

## Method

- **Real time.** A new builder option, `--timeline=log` (off by default; a test proves the golden hash and byte-identity hold), stamps frames with the log's own `t=` times. It also sends a phase's lines, ballots and the shot as one stream in log order.
  - The log has no phase-start time, so a phase starts 2 s before its first timed line.
  - `test/fixtures/solo-timeline/l05-l10` are those builds. They have the same chat line for line as `live-1018/1019`, and a test checks that.
- **One seat on the rules path.** The table holds **one** account, as it would in a real lobby. It runs the live harness in fast mode with no `complete`:
  - rules ballots and night picks;
  - claim, ask and counterclaim lines;
  - day-speech, floor and hammer lines;
  - the Night 5 send guard.
- **Wake-ups.** A neutral tick every 2.5 s wakes the seat, as the server's timer frames do.
- **The occupant's own actions.** The logged occupant's own ballots and lines are taken out of the seat's stream. The bot's own sends are echoed back to it, so its view holds what *it* did.
- **Runs.** Each of the 54 seats is run once per seed. Seeds 1-5 and 7 were run; the tables use seed 7.
- **Scoring:**
  - day ballots and night picks against the true roles;
  - claims (timing and wording);
  - the Sheriff's claim delay, shots and the shot status at fire time;
  - reads (pairwise: of each mafia/town pair, how often mafia scores higher in `townReads`);
  - the five Night 5 rules.

  All of it is set beside what the logged occupant did.
- **What the counterfactual cannot do.** Nobody reacts to the bot:
  - Nobody answers its asks, believes its claims, or follows its ballot.
  - Deaths, lynches, night results (a Cop's report is the logged Cop's pick), and the end all follow the log.
  - Nights close when the logged votes were in. Live, a night waits for the bot. That is why the bot's 4.5-6.5 s kill-vote delay often "misses" the night here (an artifact).
  - The builder opens a logged Vote Kick meeting at the start of its phase (the log has no time for it), so those meetings are dropped by default. `--vote-kick=keep` replays them as built.

## Results by role (seed 7, 54 seat-runs)

Day ballot "correct" means a town seat voted mafia, or a mafia seat voted town. The endgame self-votes (an "everyone self-vote" line, which the bot and the occupant both played) count as not correct.

| role | seats | town/mafia-correct day ballot: bot | logged | same ballot | night pick on target side: bot | logged | first claim bot (median s) | logged | lines/day bot | logged | bot filler % | read acc (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cop | 6 | 67% (6) | 83% (6) | 50% (6) | 56% (9) | 27% (11) | 10 (6/6, cop) | 5 (6/6, cop) | 5 | 2 | 57 | 100 |
| Journalist | 6 | 55% (11) | 75% (12) | 50% (12) | 43% (14) | 27% (15) | 132 (5/6, journalist) | 313 (4/6, journalist) | 3.3 | 1.5 | 50 | 100 |
| Sheriff | 6 | 75% (8) | 89% (9) | 11% (9) | - | - | 9 (5/6, sheriff) | 3 (5/6, sheriff) | 4 | 2.5 | 38 | 100 |
| Villager | 18 | 74% (27) | 76% (25) | 48% (27) | - | - | 274 (5/18, villager) | 277 (5/18, villager) | 2 | 1.3 | 50 | 100 |
| mafia:Janitor | 6 | 56% (9) | 78% (9) | 33% (9) | 100% (7) | 100% (10) | 225 (3/6, villager/journalist) | 367 (4/6, journalist/villager/cop) | 3 | 2 | 44 | - |
| mafia:Lawyer | 6 | 90% (10) | 90% (10) | 40% (10) | 100% (10) | 100% (12) | 95 (5/6, villager) | 363 (4/6, villager) | 3 | 1.3 | 57 | - |
| mafia:Mafioso | 6 | 89% (9) | 89% (9) | 60% (10) | 100% (7) | 100% (13) | 130 (4/6, journalist/villager) | 66 (4/6, journalist/villager) | 2.7 | 1 | 50 | - |

Across seeds 1-5 and 7, the town's non-self day ballots were right **28-36 of 46-48 times (61-77%)**. The logged LLM occupants were right **41/48 (85%)**. The Sheriff's shots and every rule result were the same on every seed. The Sheriff claim delay varied with the seed: 2.3, 4.9, 4.0, 2.6, 4.8 and 8.8 s.

## The five Night 5 rules (every seed)

| rule | seats it applied to | pass |
|---|---|---|
| 1 Sheriff holds a villager/blue answer | 6 Sheriff runs (no shot while `pending-vt`) | 6/6 |
| 2 mafia counterclaim on an asked Cop/Journalist | 3 (L8: the Journalist answered the ask) | 3/3 *(see the single-bot gap below)* |
| 3 Cop claim is one line | 6 Cop runs | 6/6 |
| 4 Sheriff claim 1-10 s after day start | 5 (L9's Sheriff died Night 1) | 5/5 |
| 5 never vt | 54 | 54/54 |

All 33 of the bot's claim lines say a role, or "villager" or "blue" ("im a vanilla villager" counts as villager). The logged occupants, running the old code, said "im vt", "vt here" and "im just vt" in 5 claim lines.

## Where the bot diverges from the logged occupant

1. **Ballots are weaker, and the early ones are worst.** The rules path votes early (the final ballot came at a median of 190 s into the day, against 258 s for the occupant), and mostly it doesn't move it afterwards.
   - The early `rules` ballots were right 12/21 times. The late `ballot-net` ballots were right 21/22.
   - The bot's own top read was mafia in 28 of 41 ballots, but it voted that top read only 14 times.
2. **Too much filler.** The bot says 2-5 lines a day; the occupant said 1-2.5. About half the bot's lines are the four floor lines: "watching the votes", "not sure yet", "need more here", "still looking". 185 of its 246 lines came from day-speech.
3. **Claim timing differs.**
   - The Cop claims about 10 s into the day, against 5 s (the 5 s report wait).
   - The Journalist claims earlier: 132 s against 313 s.
   - Mafia fake claims come much earlier: the Lawyer's "villager" at 95 s against 363 s, and the Janitor's fake "journalist" at 225 s against 367 s.
4. **The Sheriff shoots earlier:** 53-157 s, against 74-277 s.
   - 4 of his 5 shots followed an ask the logged table never heard, so nobody could answer it. Those shots are artifacts: an asked human might have answered.
   - The one shot the log could answer (L10) matched the occupant's shot: the Cop-accused Mafioso, `contested`.
   - On the artifact shots, he hit 2 mafia and 2 town. The occupants shot 1 mafia and 2 town (plus L10).
5. **The mafia counterclaim breaks with one bot.** The rule picks the counterclaimer by a hash over the living mafia (non-Janitor first).
   - When the bot was the pick (L8, Mafioso), it counterclaimed 3.0 s after the Journalist's answer. That is correct.
   - When the bot was the Janitor or the Lawyer, the hash picked the Mafioso. At an all-bot table he answers; in a lobby where he is a person, **nobody counterclaims**. The rule passes on paper, but it does nothing in 2 of the 3 mafia seats.
6. **A Vote Kick meeting fires the gun.** The ballot net treats "vote kick open" as the day's deadline and overrides every hold. In L6 with the kick kept, the Sheriff shot **1 s into Day 1, with no ask and no read**. That target happened to be mafia; the default run shot town at 121 s.
7. **A bug, now fixed.** On a table with one bot seat, a first vote of the game that is the Sheriff's gun threw an error (`table.voteCount` was never created), and the shot was lost on every try. At an all-bot table, some other seat's ballot always made it first. Fixed in `live.js`, with a regression test (`singleSeatGun.test.js`).
8. **Night picks** (Cop and Journalist) landed on mafia more often than the occupant's did: 56% and 43%, against 27%. The reports the bot then receives are still the logged occupant's, so this doesn't feed into anything.

## The 3 changes most likely to help in a real lobby

1. **Hold the rules ballot until it means something, then vote the read.** The first village ballot shouldn't go in at 2-15 s with the rules pick. Wait for a confident read, or until about 60% of the day (the occupants' median was 258 s), and then vote the top read. Let a later confident read move the ballot.
   - Measured here: early rules ballots were right 57% of the time; the bot's top read at that moment was mafia 71% of the time (15/21); late ballots were right 95%.
2. **A single-bot fallback for the mafia counterclaim.**
   - If no living teammate is one of our bot seats (the table roster only has us), the bot is the counterclaimer.
   - Or else, if the picked teammate hasn't counterclaimed by `MAFIA_CC.maxMs`, the bot does.
   - As things stand, rule 2 is silent in 2 of the 3 mafia seats in a human lobby.
3. **Replace the floor lines with grounded lines, or say nothing.** "watching the votes" and the other floor lines are half of what the bot says, and humans spot them at once. Use one short line naming the top read and its reason (the `townReads` reasons are already there), or stay quiet.

Also worth doing: only let a Vote Kick fire the gun when the kick is aimed at us (`voteKickWarning`). A kick on some other AFK player should not fire the Sheriff's gun.

## Gaps only a live single-bot game can test

- **How people answer and react:** the Sheriff's asks (format, delay, refusals), the bot's claims, its counterclaims, and its "everyone self-vote" endgame call.
- **Human text:** reading claims from real typing (typos, nicknames, "vanilla", "blue"), and chat-audit false positives on it.
- **A bot ballot or shot that changes the outcome.** Here the lynch, the deaths and the end are fixed by the log.
- **Real timers:** phase starts (approximated here), nights that wait for the bot's kill vote, and the server's rate limits.
- **When Vote Kicks open**, and whether the bot itself gets AFK-kicked.
- **Human mafia teammates:** whether the bot's plan lines ("kill X tonight") and its kill vote work with people, and the counterclaim pick.
- **Night results from the bot's own picks.** The Cop reports here are the logged Cop's.
- **The LLM path.** Nothing here calls a model.
