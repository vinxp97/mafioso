# Self-play: vote-kick fix and town reads (branch `selfplay-improve`, off `afb97c1`)

Command, per seed: `cd harness && npm run selfplay -- --games 50 --seed N`. 9p Frontier Justice, offline,
no model, restartq server rules. "Before" is `afb97c1`, "after" is this branch. Seed 4 was never looked at
while tuning. It was run once at the end as a held-out check.

## Before / after

| Seed | Version | Mafia win | Lynch accuracy (scum / lynches) | No-lynch days | Town ballots on scum (random) | Vegs | Illegal | Mean days | Sheriff hits/shots |
|---|---|---|---|---|---|---|---|---|---|
| 1 | before | 90% | 13.8% (9/65) | 29 | 49.6% (42.8%) | 31 | 0 | 2.46 | 14/38 |
| 1 | after | **44%** | **76.9%** (93/121) | 40 | **86.8%** (40.7%) | **0** | 0 | 3.46 | 25/39 |
| 2 | before | 92% | 14.9% (10/67) | 38 | 52.8% (43.2%) | 37 | 1 | 2.66 | 16/42 |
| 2 | after | **54%** | **76.6%** (82/107) | 45 | **85.3%** (41.2%) | **0** | 0 | 3.40 | 24/44 |
| 3 | before | 90% | 17.5% (11/63) | 29 | 47.9% (42.6%) | 40 | 1 | 2.46 | 14/37 |
| 3 | after | **52%** | **75.5%** (80/106) | 52 | **86.7%** (42.2%) | **0** | 0 | 3.50 | 20/37 |
| 4 (held out) | before | 94% | 14.5% (8/55) | 41 | 49.3% (42.0%) | 35 | 1 | 2.52 | 15/37 |
| 4 (held out) | after | **50%** | **77.0%** (87/113) | 58 | **87.3%** (40.5%) | **0** | 0 | 3.72 | 24/39 |

The random-lynch rate is 36.9% (3 scum among 8 others at the first lynch). Lynch accuracy is now about
double that on every seed, and the held-out seed matches the tuned seeds. The gains are not seed-fitted.

The "illegal 1" on seeds 2 and 3 before were timing races, not bad decisions: a deferred vote from a seat that
died before it landed, and a vote on a target shot a moment earlier. The harness now stamps each proposal
when it is sent. One that was legal then and is overtaken by the time it lands counts as `stale`
(about 60 per 50 games, almost all re-votes as the day ends), not illegal. Every seed has 0 illegal actions.

### Intermediate steps (seed 1 / 2 / 3)

| Step | Mafia win | Lynch accuracy | Note |
|---|---|---|---|
| veg fixes only | 94 / 98 / 96% | 19.7 / 10.5 / 13.3% | Vegs 0. Mafia won *more*: the vegging fake-claimers had been killing themselves. |
| + town reads, no-lynch on contested Cop claims, Sheriff/Journalist/Cop targeting | 64 / 72 / 62% | 73.7 / 74.7 / 74.5% | Many no-lynch days (104 / 100 / 83). |
| + credibility transfer and liar call-outs | 58 / 64 / 62% | 72.6 / 74.2 / 69.5% | Fewer no-lynch days (60 / 81 / 49). |
| + "sole claim" credit only when nothing counts against the claimer, and contest points ignored when checking verification | 44 / 54 / 52% | 76.9 / 76.6 / 75.5% | Final. |

## What changed

### 1. Every living seat casts a legal day vote (vote-kick bug)

| Cause (before) | Fix | Test |
|---|---|---|
| A fake-claimer whose PLAN lynch target was shot: `dayScum` returned only a speak, never a vote. | `decide` falls back to `pickHostileTarget` for an unvoted Village meeting on any scum seat. | `engine/test/alwaysVote.test.js` |
| A vote cleared because its target died, or a deferred vote dropped at send time, was blocked by the 1+1 vote cap. | `voteMayRestart` in `live.js`: the count starts over after a death since this seat last voted, or when there is no standing vote, none pending, and none sent in the last `VOTE_GAP_MS`. | `harness/test/revote.test.js` (fails on `afb97c1`) |
| A Lawyer with no PLAN target and no living teammate skipped the must-vote Litigate. | The teammate rule first, then `*`. | `engine/test/alwaysVote.test.js` (fails on `afb97c1`) |
| A Village seat with no vote. | Covered by the two above, plus a check that the rules always vote. | `alwaysVote.test.js`, plus the self-play test now asserts no vegs in any game |

### 2. Town logic (mafia untouched)

`engine/src/townReads.js` (new) turns public play into a suspicion score per living player for Village seats.
All weights are in `TOWN_READS`, and they only order the evidence: hard check > proven lie > report > contested claim > vote history.

- Claims: someone claiming *my* unique role (+10). Two living claimers of a unique role are both contested (+1.5).
- Guilty/innocent calls checked against flips: a guilty that flips town, or an innocent that flips mafia, marks a proven liar (+8). So does calling me guilty. A guilty that flips mafia makes the caller credible (-4).
- Journalist reports: "X got no report" on a Cop claimer (+7), "real cop" (-6, and +4 on the rival claimer), Janitor (+8).
- Vote history: everyone who voted a Day death that flipped town (+2, +1 more for the first two voters).
- Liar accusations: +1.5 per distinct accuser, max 3. An accuser of someone who flips mafia becomes credible.
- Trust transfer: a verified claimer (score at most -3) makes rival claimers of that role +6, and his guilty puts +7 on the target. The guilty of the only Cop claimer is +2: worth a test, not a lynch.

How town uses it (FJ strategy):

- **Day vote** (`townDayPick`, ahead of the old wagon rules): vote a read of at least 6 with a 2-point lead. Otherwise, if Cop claims are contested or today's guilty names a living power-role claimer, vote no-lynch (`*`): never blindly lynch either claimant's target. Otherwise use the old rules (`townFollow`/`beliefDayPick`), now weighted by the reads.
- **Sheriff**: outs D1 with `im sheriff`. Shoots anyone who calls him guilty or claims Sheriff (existing threat rule). Otherwise shoots the read target (at least 4 with a 2-point lead), then a Cop claimer's guilty target unless that player claims a power role. The late shot prefers a positive read over the biggest wagon.
- **Cop**: claims only on a guilty or when counterclaimed or called guilty (a Sheriff out alone no longer triggers it). Once claimed, it posts only new results and calls out a later fake (`ivo is lying`). At night it checks its top unchecked read.
- **Journalist**: from N2 visits the unvisited Cop claimer with the highest read, and claims with "X got no report, fake cop" or "X got a cop report, real cop".

## Lessons

1. **Fix measurement before strategy.** The vegs were the scorecard's loudest problem, but fixing them made town *worse* (Mafia 90% → 94-98%). The vegging seats were mostly fake-claimers killing themselves. A metric can hide a gift to one side.
2. **The lynch was decided by the bloc plus a fake claim because town had no memory.** The biggest single gain came from treating flips as evidence (proven liars, lynch pushers) and two Cop claims as "trust neither yet". It took lynch accuracy from ~15% to ~74% before any tuning.
3. **No-lynch is a tool, not a goal.** Defaulting to `*` on a contest stopped mislynches but stalled games: 100+ no-lynch days per 50 games. Credibility transfer (a claimer whose call-out flipped mafia is believed, and his rival is not) turned many of those into correct lynches.
4. **Default bonuses must not cancel evidence.** "-1 sole Cop claim" quietly pulled a proven liar (+8) under the lynch bar. Likewise "+1.5 contested" kept a verified Cop from counting as verified. Apply credit only when nothing counts against the player, and do not count contest points against a player who has independent proof. Each fix was found by a unit test written from the strategy, not by watching a seed's numbers.
5. **Check overfitting with seeds you never looked at.** Seed 4 was run once at the end: 94% → 50% Mafia, 14.5% → 77.0% lynch accuracy, in line with seeds 1-3.
6. **Next weakness:** `cop-guilty-ignored`. About 14/38 Cop guilties on seed 1 are not lynched or shot that day, and 14/131 Cop results are flipped by the Lawyer. A Lawyer-aware Cop (a guilty on a claimed power role is likely litigated) and a Sheriff that tests sooner after a sole-Cop guilty are the next places to look. Sheriff accuracy rose (seed 1: 14/38 → 25/39) but has stayed flat across the last three steps. The read-based shot mostly fires on Day 2+, and many shots are still D1 threat shots.
