# chatPassthrough evaluation (Night 6, 10/21). Local only

Branch `chat-pass-eval-20261021` off `chat-passthrough-20261020` @ 2ae3b75, with `night5-gunfix-20261020` @ 002a220
merged in (e8c7eb4). Every flag stays off by default. The model is stubbed (`--sim-latency live1018`), so there is
no API spend.

## 1. Positive control (engine/test/chatPassControl.test.js)
- 41 planted unsafe lines go through `validateAction`, with the flag off and on. They cover:
  - vt (5);
  - illegal claims (4) and early claims (6);
  - the dead: sus calls and votes (6);
  - leaks: teammate names, private reports, kill admissions (7);
  - injection (7), including a `<think>` tag;
  - non-exact or invented names (6).
- **Flag on:** 0/41 get through.
- **Flag off:** 10/41 get through. These are pre-existing gaps in the default rules, not caused by the flag. They
  are listed in `OFF_GAPS` and the test pins exactly that set. Defaults are unchanged.
- An echo rewrite ("agree with X, ...") of an unsafe line is still blocked, because the harness re-validates every
  send (emitActions, paceSpeech).
- **Fixed behind the flag** (`passGuard` in chatAudit.js, active only with `config.chatPassthrough`):
  - `dead`: the Night 6 reveal exemption accepted any role word, so "dan is mafia, he flipped red" passed for a dead
    Villager. It now needs the role the player actually flipped.
  - `false-town-claim`: a town seat may claim only its own role, or villager. Mafia fake claims stay allowed.
  - `unseen-report`: "<name> got no/a report" from a town non-Journalist is blocked unless another seat already said
    it in public. A scum fake Journalist counterclaim is exempt.
  - `admits-kill`: a scum seat saying "we killed / our kill".
  - `reasoning-tag`: raw `<think>`, `<thinking>` or `<reasoning>` markup.
  - `unknown-name`: a name-like token is checked when it follows vote/lynch/hang/hammer/@, comes before "'s push"
    or similar, or comes before "is sus" / "sus". It must be an exact player name or a known nickname, unless it
    is a stopword or role word.
- **False-positive scan:**
  - 6227 public lines from 200 base self-play games: 0 new flags.
  - 159 Night 5 live model lines (sanitized): 5 new flags. One is an invented name. One is a misattributed report
    (a true positive). Three are report relays that would pass once the Journalist's public line is in context.
  - The earlier "self-vote pls" and "vote feels forced" false positives were fixed in 3ed72c7.

## 2. Combined scoring, fresh seeds
**Configs:**
- `base`: all flags off.
- `allGun`: voteHold, soloCounterclaim, groundedSpeech, voteKickGuard and gunOnce on.
- `allPass`: allGun plus chatPassthrough.

### Single-bot replay (solo-timeline L5-L10, seeds 51-56, 324 seat runs)
Rules path, so there are no model lines and pass-through is not exercised.

| | base | chatPass | allGun | allPass |
|---|---|---|---|---|
| Town ballots on scum | 207/308 = 67.2% [61.8, 72.2] | 67.2% | 231/299 = 77.3% [72.2, 81.6] | 77.3% |
| Filler | 67.9% | 66.9% | 0% | 0% |
| No ballot | 16 | 16 | 25 | 25 |
| Mafia counterclaim | 6/18 | 6/18 | 18/18 | 18/18 |
| Illegal / errors / vt | 0 / 0 / 324 of 324 clean | same | same | same |

- allPass − base on ballots: +10.0 pts, 95% CI [+3.0, +17.1].
- There is no win rate here, because the outcome is fixed by the log.
- The Night 5 live fixtures (g01-g03) carry too few ballots to read (42% → 55%, n = 33/64).

### Self-play: 200 games per config, seeds 41-44 × 50, stubbed model

| | base | allGun | allPass |
|---|---|---|---|
| Village win | 62.5% [55.6, 68.9] | 67.5% [60.7, 73.6] | 66.5% [59.7, 72.7] |
| Paired vs base | | +5.0 [−3.2, +13.2] | +4.0 [−4.1, +12.1] (noise) |
| Town ballots on scum | 60.7% (1087/1791) | 71.6% | 72.8% (1353/1859) |
| Lynch on scum | 66.1% | 75.5% | 75.9% |
| Filler share | 12.3% | 0.1% | 0.0% |
| Public lines | 6227 | 5242 | 5909 |
| Stale-reply rejects | 477 | 170 | 47 |
| Rechecked late replies | 0 | 0 | 158 |
| Illegal actions / errors | 0 / 0 | 0 / 0 | 0 / 0 |

- Ballots: allPass − base = +12.1 pts [+9.1, +15.1].
- The ballot CIs treat ballots as independent. They are clustered by game, so the real interval is wider.
- The solo flags carry the vote and filler gains.
- chatPassthrough on top of them adds +12.7% public lines (5242 → 5909) and cuts stale rejects by 72%.
- The win rate moves by −1 pt between allGun and allPass, which is within noise.

## Notes
- **Merge:**
  - The l10 soloReplay test expected the Night 5 contested gun on p07. Under the merged sheriff-target rule
    (4f4d269), a weak contested pair waits for the vote, so the bot asks p07 and holds. The test was updated to
    match (0e69e66).
  - `--count-gun` crashed 2 of 4 allPass runs. A post-game timer reads the table after `--count-gun` nulls it.
    This is a measurement-only harness bug from 002a220. Runs were redone without `--count-gun`.
- **Name-like tokens** in the sanitized Night 5 logs are fragments of real seat handles. See the morning review.
  The tests use invented names.
