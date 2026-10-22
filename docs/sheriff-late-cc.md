# Night 6 part 4: Sheriff late answers and mafia counterclaim coverage (offline, 10/21)

Branch `sheriff-late-cc-20261021` off `mixed-table-20261021` (4df3e4a). Local only, with the model stubbed. Every
number here comes from the mixed table (1 bot seat and 8 scripted human-like seats, `harness/src/mixedTable.js`) with
`simLatency: "live1018"`. The scripted humans are a model, so treat the numbers as relative.

## Flags (all off by default)

| flag | config / CLI | what it does |
|---|---|---|
| Sheriff late grace | `sheriffLateGrace: "on"` / `--late-grace on` | Once the Sheriff has asked a seat to claim, he waits `SHERIFF_ASK.lateGraceMs` (30 s) on top of `replyMs` (15 s) before silence counts as "no claim when asked" (`askReplyWindowMs`, used in `shotStatus`). The deadline paths are unchanged: the 10 s late reply window, the last call, and Day 1 always shoots. The ask and the 1–10 s claim delay are unchanged too. A Villager answer that lands inside the grace goes to the normal Villager hold. |
| team claim guard | `teamClaimGuard: "on"` / `--team-claim-guard on` | In `claimOptions`, a teammate's own public Cop or Journalist claim closes this seat's fake power claims (`teamPower`). The asked seat then says villager, and a plan claim is dropped. The Janitor's cleaned-role claim is untouched. |
| mixed teamReveal | `mixed.teamReveal: true` (harness only) | Live FJ reveals faction teammates to each other at game start (restartq WinWithFaction → revealToPlayer). On an all-bot table the harness roster does this; a lone bot seat on a mixed table never learned its scripted teammates. The counterclaim scenarios turn it on. Plain mixed-table runs keep it off, so earlier numbers still reproduce. |

## Step 1: Sheriff late answers

### Baseline measurement (flag off, seeds 6001–6100, Sheriff bot)
- 94 shots, 27 on town.
- 17 of the 27 town shots hit a seat whose scripted claim answer was already scheduled but not yet said. The answer
  was 5–37 s away, median 28 s.
- 0 town shots came within 10 s after an answer. 0 town shots were forced by the deadline.
- 36 scum shots also came before a pending answer.

### Choosing the window
- The answer delay is 4–54 s (358 answers): p50 31 s, p75 43 s, p80 44 s, p90 49 s, p95 52 s.
- I picked replyMs + 30 s = 45 s, which covers about p80.
- p90 would need +35 s. That pushes more shots into the deadline, and the deadline already takes over from 85% of
  the day.
- The window is bounded, and the deadline overrides it.

### Off vs on (fresh seeds 8001–8100, Sheriff bot, 100 games each)

| config | shots | on scum | on town | town shots before a pending answer | median shot | deadline-forced | bot win |
|---|---|---|---|---|---|---|---|
| base | 90 | 68 (75.6%, CI 65.8–83.3) | 22 | 14 | 135 s | 1 | 57% (47–66) |
| lateGrace | 90 | 79 (87.8%, CI 79.4–93.0) | 11 | 2 | 170 s | 14 | 58% (48–67) |
| all (solo flags + gunOnce + pass-through) | 89 | 66 (74.2%) | 23 | 15 | 135 s | 1 | 56% (46–65) |
| allGrace | 90 | 77 (85.6%) | 13 | 4 | 170 s | 14 | 60% (50–69) |

Paired by seed, as on − off with 95% CIs:

| pair | town shots /100 games | scum shots /100 games | shot time | deadline-forced /100 games | bot win |
|---|---|---|---|---|---|
| lateGrace − base | −11 [−17.8, −4.2] | +11 [+4.2, +17.8] | +40.6 s [+32.8, +48.4] | +13 [+6.4, +19.6] | +1.0 pts [−8.0, +10.0] (noise) |
| allGrace − all | −10 [−17.1, −2.9] | +11 [+3.7, +18.3] | +42.9 s [+34.2, +51.5] | +13 [+6.4, +19.6] | +4.0 pts [−5.2, +13.2] (noise) |

- The target changed in 13 of 90 games (14 of 89 with all).
- Only the Sheriff bot uses the flag. In every other role the mixed table's Sheriff is a scripted human, so I ran no
  other role.
- Tests: `engine/test/sheriffLateGrace.test.js` (5) and `harness/test/sheriffLateCc.test.js` (seed 8002, plus the
  Day 1 always-shoots check).

## Step 2: mafia counterclaim coverage

### Scenario
`cfg.scenario = { cc, power }`, with `scripts/cc-scenarios.mjs`. The bot is a Mafioso. Odd seeds ask the Cop, even
seeds the Journalist. On Day 1:
- The scripted Sheriff claims at 15–30 s.
- He asks the real power seat 15–25 s later, and it answers with a power claim 5–15 s after the ask.
- 70 s after that first ask, he asks the bot.
- 40 s after asking the bot, he shoots: one of two same-role power claimers at 50/50 if there are any, otherwise his
  top read outside the power claimers.
- The scripted Sheriff and the asked seat survive Night 1.

The three cases:
- (a) `lone`: the two scripted mafia seats leave at Day 1 start, with no reveal.
- (b) `team`: the scripted teammates play normally, but never fake a claim.
- (c) `teamCop`: a scripted teammate fakes Cop at 2–5 s, before anyone else claims.

Seeds 9001–9100, 100 games per case and config.

How the columns are counted:
- A counterclaim is a Day 1 line from a mafia seat that claims the asked role after the answer. In (c) the
  teammate's earlier Cop claim also counts.
- "Double" is two mafia seats claiming the same power role, or the bot claiming twice.
- Timing is measured from the answer to the bot's counterclaim line, on the harness's 5 s tick, so 3–7 s engine
  delays show as 5 or 10 s.

| case | config | exactly one | zero | double | bot cc delay min/med/max (same second) | Sheriff shot: bot/mate/power/town | D1 lynch: bot/mate/power/town/none | bot win | paired vs base |
|---|---|---|---|---|---|---|---|---|---|
| lone | base | 97% [92,99] | 3% | 0% | 5/10/20 s (0) | 42/0/43/15 | 44/0/1/6/49 | 4% | |
| lone | all | 97% | 3% | 0% | 5/10/20 s (0) | 40/0/44/16 | 46/0/1/5/48 | 4% | +0 |
| team | base | 44% [35,54] | 56% | 0% | 5/10/40 s (0) | 18/46/21/15 | 26/36/9/18/11 | 45% | |
| team | all (soloCounterclaim) | 98% [93,99] | 2% | 0% | 5/5/20 s (0) | 34/15/46/5 | 16/38/9/23/14 | 57% | +12 [+3,+21] |
| teamCop | base | 49% | 50% | 37% [28,47] | none | 17/50/17/16 | 18/28/11/32/11 | 58% | |
| teamCop | guard | 50% | 50% | 0% [0,4] | none | 18/44/16/22 | 16/25/15/31/13 | 63% | +5 [−1,+11] |
| teamCop | allGuard | 50% | 50% | 0% | none | 18/44/16/22 | 16/25/15/31/13 | 64% | +6 [−1,+13] vs base |

`guard` is identical to base in (a) and (b), because no teammate claims there. The full table, including all four
configs per case, is in `/workspace/sheriff-late-cc-runs/table2.md` (box only).

### Findings
1. **Bug fixed (teamClaimGuard).**
   - In (c), when the Journalist was asked (50 games), the bot answered the Sheriff's ask with "im cop, no guilty yet"
     in 36 games, plus 1 game when the Cop was asked. That puts two mafia Cop claims on the board. The cause is the
     "no plan claim (cop)" fallback: `claimOptions` skips the team when it counts holders.
   - When the Cop was asked, the bot added a second fake power role ("im journalist, nothing useful yet") in 40 of 50
     games.
   - With the guard on, double claims go from 37% to 0% and second fake power roles go from 40 to 0. The bot answers
     villager. Bot win is +5 pts, within noise.
   - The Sheriff's contested shots drop from 64 to 37, because the doubled claim no longer hands him a contested
     pair that contains a scum.
2. **(b) counterclaimer pick.**
   - With base flags, a scripted (human) teammate is often designated as the counterclaimer, and humans don't follow
     the plan, so 56% of answers go uncontested.
   - soloCounterclaim (in `all`) fixes this: 98% are now countered, and bot win is +12 [+3,+21] paired. This supports
     turning on soloCounterclaim for single-bot tables (Night 5 already recommended it).
3. **(c) Journalist asked: zero counterclaims, by design.**
   - `mafiaCounterclaim` fires at most once per team: a teammate's public Cop/Journalist claim blocks it. So after
     the teammate's fake Cop, nobody counters the real Journalist.
   - The guard makes the asked-seat answer follow the same rule. Whether a second fake power claim is ever worth it
     is a strategy question for you.
4. **(a) lone.**
   - 97% get exactly one counterclaim, 5–20 s after the answer, never in the same second.
   - 3 games had zero counterclaims. I inspected seed 9015: the Cop called the bot guilty, a real Journalist claimed
     in the same second, and the bot countered the Journalist. I didn't inspect the other two (9040, 9043).
   - Bot win is 4%: a lone Mafioso against 5–6 town is a stress setup, not a balance number.
5. **Parser gap, not fixed.**
   - `claimedRoleIn` misses 3 of the 22 scripted power-claim wordings: "cop {X} {R}", "journalist lol, no reports to
     share" and "Journalist, nothing to report yet.".
   - In those cases the bot does not see the claim at all. The scenario swaps in a plain wording when this happens,
     to test the rule.
   - Ordinary mixed-table games still use the original wording. The live frequency of these phrasings is unknown.
6. **Harness gap fixed behind an option (teamReveal).**
   - Without it, a mixed-table mafia bot never knew its scripted teammates. That also means the earlier part 3 scum
     numbers were measured without teammate knowledge.

## Reproduce
```
node harness/scripts/mixed-table.mjs --roles=Sheriff --seeds=8001-8100 --configs=base,lateGrace --out=<dir>
node harness/scripts/mixed-table.mjs --roles=Sheriff --seeds=8001-8100 --configs=all,allGrace --out=<dir>
node harness/scripts/cc-scenarios.mjs --cases=lone,team,teamCop --seeds=9001-9100 --configs=base,all,guard,allGuard --out=<dir>
```

## Risks
- The answer-delay distribution belongs to the script (uniform 4–54 s). Real humans' late-answer timing is unmeasured,
  so the 30 s grace may be too long or too short live.
- The grace moves the median shot 35–45 s later and makes deadline-forced shots 13× more frequent (1 → 14). A Sheriff
  killed or lynched in that window doesn't shoot. In these runs total shots didn't change (90 vs 90).
- The scenarios force the setup: early Sheriff claim, guaranteed asks, and power seats protected on Night 1. Use
  them for coverage and relative effects, not win rates.
- The team claim guard also suppresses an exposed or guilty-called seat's counterclaim when a teammate already made
  a power claim. It answers villager instead. This wasn't measured outside (c).
- Counterclaim timing has 5 s resolution (the harness tick).
