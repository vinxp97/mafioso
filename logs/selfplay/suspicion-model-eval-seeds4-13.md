# Suspicion model eval: seeds 4-13, 50 games each (2026-10-18)

Setup: Frontier Justice 9p, adaptive mafia, vinman cop rule, Loyal lawyer, `--days 8`. Only the Village day vote of
town seats differs between arms; night actions, Sheriff, claims and speech are the same rule path.

- **random**: one uniform pick per seat per day among `legalActions(...).allowed` for the Village meeting (incl. `*`).
- **head**: the rule bot at legal-actions HEAD d7c54ad (separate worktree, unchanged code).
- **rules**: the same rule path on this branch (it shares townReads, which gained the wagon-start term).
- **suspicion**: `townVote` (engine/src/townVote.js): townReads as the only scorer, over the seat's legalActions picks.

Command: `node scripts/selfplay.mjs --games 50 --seed N --town random|rules|suspicion --quiet` (head: same without `--town`
in the d7c54ad worktree). No tuning: the model's weights are the existing TOWN_READS ones plus two new constants
(votedVerified 1.5, wagon 1); one seed-1 sanity run was made and nothing was changed after it. Seeds 4-13 were run once.

| Arm | seeds | Town win % mean ± sd | min / max | Lynch accuracy (scum/lynches) | Town ballots on scum | No-lynch days | Mean days | Illegal |
|---|---|---|---|---|---|---|---|---|
| random legal vote (allowed) | 10 | 1.0 ± 1.4 | 0 / 4 | 6.3% (32/509) | 36.2% (1047/2893) | 250 | 2.03 | 0 |
| rule bot, legal-actions HEAD d7c54ad | 10 | 42.8 ± 7.4 | 34 / 54 | 67.1% (592/882) | 76.3% (3084/4044) | 215 | 2.52 | 2 |
| rule bot on this branch (shared townReads) | 10 | 44.2 ± 6.6 | 38 / 56 | 68.3% (605/886) | 76.8% (3116/4056) | 214 | 2.51 | 0 |
| suspicion model (townVote) | 10 | 48.2 ± 8.1 | 40 / 62 | 90.9% (660/726) | 94.3% (2879/3054) | 556 | 2.98 | 0 |

| Seed | random | head | rules | suspicion |
|---|---|---|---|---|
| 4 | 0 | 54 | 54 | 62 |
| 5 | 0 | 34 | 38 | 46 |
| 6 | 0 | 46 | 48 | 40 |
| 7 | 0 | 38 | 40 | 42 |
| 8 | 0 | 40 | 40 | 44 |
| 9 | 2 | 48 | 46 | 56 |
| 10 | 4 | 54 | 56 | 52 |
| 11 | 2 | 34 | 38 | 40 |
| 12 | 2 | 38 | 40 | 42 |
| 13 | 0 | 42 | 42 | 58 |

Paired per-seed difference in town win %, suspicion minus head: +5.4 ± 6.3 pts (t = 2.70, 9 df; 8 of 10 seeds up).
Pooled: 241/500 vs 214/500 town wins. With 50 games a seed, one seed's win % has a sampling sd of about 7 pts, so the
spread across seeds is mostly noise; read the gain as real but modest. Suspicion minus branch rules: +4.0 ± 6.9 (t = 1.83).

How it wins: it lynches less (726 lynches vs 882, 556 no-lynch days vs 215) but far more accurately (90.9% vs 67.1%). It
never joins a wagon on a player it trusts and only adds wagon weight from voters it does not suspect, so the mafia bloc
rarely picks the lynch. The cost is longer games (2.98 vs 2.52 days) and more night kills.

Random legal voting is a floor, not a baseline the bot is near: 1% town wins, worse than the analytic random-ballot
share (36% of ballots on scum vs ~43% expected) because the mafia bloc and fake claims steer a split town.

Illegal actions: 0 in every branch arm. HEAD shows 2 (seeds 9 and 13): both a Day 1 `accused-rule` reply from a seat that
the Sheriff had just shot, sent before its death frame reached it. The server drops that line; on this branch the self-play
stamp counts it as a stale race (`stale:died before it knew`) instead of illegal. Outcomes are unchanged by that
(re-ran seeds 5, 8, 13 random and 9, 13 rules: identical win rates, 0 illegal).

Per-seed metrics: `suspicion-model-eval-seeds4-13.json`.
