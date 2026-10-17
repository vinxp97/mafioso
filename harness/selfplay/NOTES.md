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

---

# Cop guilties and the Loyal Lawyer (branch `cop-guilty`, off `1d9b237`)

Command: `cd harness && npm run selfplay -- --games 50 --seed N --cop-rule vinman|wait`. Seed 4 is held out:
I did not look at it while changing code, and ran it only for the final tables.

## Server rules check: which way a litigated result flips

restartq `roles/cards/FlipAlignment.js` (the Lawyer's Litigate) sets the target's *investigate* appearance to
the opposite alignment: Mafia reads as Villager, Village reads as Mafioso. The FJ Lawyer is **Loyal**:
`Role.js` blocks an action when `modifier` includes "Loyal" and the target's alignment differs.
So in FJ, a Litigate only works on a teammate and only ever produces a false **Innocent**. A Cop's
**Guilty can never be faked.**

The simulator now models this (`--lawyer loyal`, the default). A Litigate on a town player is recorded as
`blocked` and has no effect. In practice the scum logic already litigated only teammates (101/101 on
seed 1), so this changed no game outcomes. It does make the rule explicit and tested: every Cop Guilty is
correct, and the only wrong Cop results are lawyered Innocents (10-14 per 50 games).

## 0. Cop rule as config

`copRule: 'vinman' | 'wait'`, with `vinman` as the default (restored).

- **vinman** (Vinman's rule): the Cop claims once a Sheriff has outed and is alive, or with a guilty, or
  when counterclaimed or called guilty.
- **wait**: the same, without the Sheriff-out trigger. This was the behaviour of `1d9b237`.

The rule reaches each seat as an engine `botConfig` frame (`view.config.copRule`). It is set with
`createBotTable(accounts, { copRule })` and `--cop-rule` on selfplay. The scorecard records it, and
non-default runs write `selfplay-seedN-n50-wait.*`. Tests cover both rules.

## Before / after

"Before" is the `1d9b237` town logic with the copRule switch and the Loyal-Lawyer simulator. With
`--cop-rule wait` it reproduces the `1d9b237` numbers exactly. "Guilty acted on" is the share of Cop Guilty
results whose target was lynched or shot the same day. The cop-alive column restricts that to days the Cop
survived into.

| Seed | copRule | Version | Town win | Guilty acted on (all) | Guilty acted on (Cop alive) | Lynch accuracy | No-lynch days | Town ballots on scum | Vegs | Illegal | Mean days |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | vinman | before | 44% | 25/37 (67.6%) | 21/26 | 71.2% | 40 | 83.5% | 0 | 0 | 3.50 |
| 1 | vinman | after | **92%** | 22/30 (**73.3%**) | 17/21 | **95.2%** | 33 | **96.4%** | 0 | 0 | 3.24 |
| 1 | wait | before | 56% | 24/38 (63.2%) | 22/28 | 76.9% | 40 | 86.8% | 0 | 0 | 3.46 |
| 1 | wait | after | **92%** | 23/30 (**76.7%**) | 20/25 | **95.2%** | 34 | **96.2%** | 0 | 0 | 3.26 |
| 2 | vinman | before | 32% | 14/32 (43.8%) | 11/18 | 68.9% | 48 | 81.5% | 0 | 0 | 3.54 |
| 2 | vinman | after | **88%** | 25/36 (**69.4%**) | 15/19 | **96.6%** | 34 | **96.5%** | 0 | 0 | 3.18 |
| 2 | wait | before | 46% | 18/41 (43.9%) | 14/24 | 76.6% | 45 | 85.3% | 0 | 0 | 3.40 |
| 2 | wait | after | **88%** | 23/38 (**60.5%**) | 16/23 | **96.7%** | 34 | **96.7%** | 0 | 0 | 3.20 |
| 3 | vinman | before | 38% | 18/49 (36.7%) | 12/25 | 69.8% | 47 | 84.3% | 0 | 0 | 3.42 |
| 3 | vinman | after | **86%** | 32/47 (**68.1%**) | 17/27 | **94.4%** | 28 | **96.3%** | 0 | 0 | 3.12 |
| 3 | wait | before | 46% | 21/51 (41.2%) | 16/32 | 75.5% | 52 | 86.7% | 0 | 0 | 3.50 |
| 3 | wait | after | **86%** | 35/51 (**68.6%**) | 23/35 | **94.4%** | 29 | **96.1%** | 0 | 0 | 3.14 |
| 4 (held out) | vinman | before | 44% | 20/37 (54.1%) | 16/24 | 73.5% | 48 | 85.3% | 0 | 0 | 3.48 |
| 4 (held out) | vinman | after | **88%** | 22/30 (**73.3%**) | 17/22 | **94.3%** | 31 | **95.8%** | 0 | 0 | 3.14 |
| 4 (held out) | wait | before | 48%* | 24/44 (54.5%) | 21/36 | 77.0% | 58 | 87.3% | 0 | 0 | 3.72 |
| 4 (held out) | wait | after | **88%** | 24/33 (**72.7%**) | 19/25 | **93.5%** | 30 | **95.0%** | 0 | 0 | 3.12 |

\* One seed-4 "before" game hit the 8-day cap with no winner.

Pooled over seeds 1-4:

| copRule | Guilty acted on, before → after | Cop alive, before → after | Town win, before → after |
|---|---|---|---|
| vinman | 77/155 (49.7%) → 101/143 (**70.6%**) | 60/93 (64.5%) → 66/89 (**74.2%**) | 39.5% → **88.5%** |
| wait | 87/174 (50.0%) → 105/152 (**69.1%**) | 73/120 (60.8%) → 78/108 (**72.2%**) | 49.0% → **88.5%** |

**Which Cop rule did better?** Before this change, `wait` was clearly better for town: 49% vs 39.5% wins,
and higher on every seed. An early Cop claim was a free night kill (Cops killed: 40 vs 28 on seed 1). After
this change the two rules tie on town wins (88.5% each, identical per seed), and `vinman` is slightly ahead
on Guilty acted on (70.6% vs 69.1%). Once town reads the public record properly, the early claim stops
costing anything: a Cop who dies after claiming flips Cop, which verifies his results and exposes the next
fake claimer. `vinman` stays the default.

Sheriff hits/shots did not change (seed 1: 25/39): all shots are on Day 1 (see Next weakness).

## What changed (town only; mafia logic untouched)

- **Reads under a Loyal Lawyer** (`townReads`):
  - My own Cop Innocent is -6 (`lawyerableInno`), not -20. It offsets one lynch-level read, no more.
  - A claimer whose innocent flips mafia gets +1 ("lawyered or lying"), not +8 as a proven liar.
- **A unique role has one holder:**
  - Claiming a role that a dead player already flipped is +8 (`roleFlipped`).
  - A claimer whose rival flipped mafia is credible (-4). This only counts if he claimed *before* the
    rival died; claiming a role after its fake has flipped is free.
  - A dead claimer who flipped his claimed role counts as verified, so his guilties still count (+7).
- **Same-day action on a credible Cop:**
  - A verified Cop settles the contest, so there is no blanket no-lynch.
  - Two lynch-level reads (each 6 or more) now lynch the stronger, instead of needing a 2-point margin.
  - Town never votes a verified-town player. This vetoes the old wagon-follow and belief fallbacks, which
    had voted a verified Cop.
- **Repeated results are one call:** "results: x guilty" repeated each day no longer stacks.
- **Cop:** at night it re-checks an Innocent who is still suspicious on the public evidence. Its public line
  is "x came back inno but a lawyer can fake that, still sus".
- **Journalist:** a visit that sees a Cop's Guilty report is relayed ("bea got a cop report, real cop, it
  said cal guilty"). Town counts the relay as a verified guilty, which matters when the Cop died that night.
- **Counter-story lines** (`townCounterLine`, at most one per town seat per day):
  - the lawyered-inno line above;
  - "dot claims cop but bea already flipped cop, dot is lying";
  - "lawyer cant fake a guilty, only an inno, so eli is mafia, vote eli";
  - "two cops and one is lying, no lynch on either guilty till one is tested".
- **Simulator:** Loyal Lawyer (`--lawyer loyal|plain`), `--cop-rule`, and a cop-alive split of the
  guilty-acted metric on the scorecard.

## Lessons

1. **Read the server before modelling a mechanic.** The engine treated a Cop Innocent on a later-mafia flip
   as a proven lie. Under the Loyal Lawyer that is exactly what Litigate produces, so the Lawyer was turning
   the *real* Cop into the "liar". Fixing the direction of that one rule mattered more than any weight.
2. **Most "ignored" guilties were not town failures.** After the change, about two thirds of the remaining
   misses are either a Cop killed the night of his guilty (only a Journalist relay can save it), or a day
   where town lynched a different scum.
3. **Deduplicate evidence.** Repeating a result was counted as new evidence, so a liar who repeated himself
   gained "credibility".
4. **Fallback paths need the same veto as the main path.** The evidence pick was right, but when it
   declined, the old wagon and belief rules could still vote a verified Cop.
5. **Mafia is now the weak side of the simulation.** The scum script fake-claims Cop every day, even after the
   real Cop has flipped Cop, so town wins ~88%. The numbers measure town logic against a static opponent,
   not against people. Treat them as regression signals, not as a win rate to expect live.

## Next weakness

**Sheriff Day-1 misfires.** Every Sheriff shot happens on Day 1 (44/44 on seed 2), and 20/44 hit a Villager.
Most are the "always shoot on Day 1, late with no read" rule. With the gun gone on Day 1, nobody can test a
Cop's guilty later, which is where most of the remaining contested-Cop no-lynch days come from. Next step:
keep the Day-1 threat shots (someone calls the Sheriff guilty or counterclaims), but hold the no-read shot
for a Cop guilty or a strong read. Measure the hit rate and how many guilties get acted on.
After that: the scorecard's `mafia-vote-timing` tell (scum cast the first vote 43-46% vs 32.5% random).

# Adaptive mafia (branch `adaptive-mafia`, off `8a265e3`)

Goal: make the mafia adapt (Vinman's FJ strategy from the mafia side) while keeping the old script selectable,
then bring town to a 45-65% win rate against it on seeds 1-4 (4 held out) with principled play only, while town
still beats the old script at about 88%. The Sheriff Day-1 always-shoot rule was left alone.

**Result: done criterion NOT met.** Seeds 1-3 land at 44 / 48 / 46%, but held-out seed 4 is 32%, and four
extra unseen seeds (5-8) are 34 / 30 / 26 / 36%. Seeds 1-3 were the ones I diagnosed games on (I also looked at
a few seed-4 games early on, before I stopped using it), so the honest out-of-sample estimate of town vs
adaptive mafia is about **32%**, not the band. I did not add handicaps to reach it. Everything below is principled
play on both sides, and the gap is reported rather than tuned away.

`--mafia adaptive|script`. Adaptive is the default for self-play and for `createBotTable` (live). The engine
itself keeps `script` unless `view.config.mafia === "adaptive"` (old views and tests).

## Results (50 games per seed, cop rule vinman, Loyal Lawyer)

| Seed | Mafia | Town win | Lynch accuracy | Town ballots on scum | No-lynch days | Mean days | Scum voted first (chance) | Vegs | Illegal |
|---|---|---|---|---|---|---|---|---|---|
| 1 | adaptive | **44%** (22/50) | 68.2% | 77.1% | 24 | 2.52 | 17.0% (35.2%) | 0 | 0 |
| 1 | script | **92%** (46/50) | 95.9% | 89.5% | 28 | 3.08 | 41.3% (34.3%) | 0 | 0 |
| 2 | adaptive | **48%** (24/50) | 62.5% | 71.1% | 17 | 2.50 | 11.5% (34.0%) | 0 | 0 |
| 2 | script | **86%** (43/50) | 95.7% | 88.2% | 27 | 2.98 | 38.0% (34.3%) | 0 | 0 |
| 3 | adaptive | **46%** (23/50) | 68.0% | 73.5% | 25 | 2.76 | 13.1% (33.8%) | 0 | 0 |
| 3 | script | **92%** (46/50) | 96.7% | 93.0% | 23 | 2.98 | 42.5% (34.6%) | 0 | 0 |
| 4 (held out) | adaptive | **32%** (16/50) | 54.8% | 67.3% | 27 | 2.48 | 12.6% (34.9%) | 0 | 0 |
| 4 (held out) | script | **88%** (44/50) | 99.1% | 91.1% | 28 | 2.96 | 38.0% (33.4%) | 0 | 0 |
| 5-8 (unseen) | adaptive | 34 / 30 / 26 / 36% | 55.8 / 48.7 / 48.6 / 60.5% | | | | | 0 | 0 |

Means for seeds 1-4: adaptive 42.5%, script 89.5% (8a265e3 had 88.5%).

How the town number moved against adaptive mafia (seed 1 / 2 / 3 / 4):

| Step | Town win |
|---|---|
| Adaptive mafia, town as in 8a265e3 (seed 1 only) | 16% |
| + vote company with flipped mafia | 32 / 38 / 44 / 38% |
| + flipped mafia's own votes clear their target | 32 / 42 / 46 / 36% |
| + verified-Cop innocents, cleaned claimer, votes on a revealed townie; mafia stops voting revealed townies | 34 / 50 / 54 / 36% |
| + stale kill-vote fix (mafia kills now land; affects both modes) | 32 / 44 / 48 / 32% |
| + own read over the crowd | 38 / 52 / 46 / 32% |
| + dead claimer's guilty no longer forces no-lynch; fake-guilty target counts as a scum push | **44 / 48 / 46 / 32%** |

Adaptive claim mix (seeds 1-4): the Janitor claims Cop 7-17 times per 50 games, Mafioso 3-7, Lawyer 0-4 (the
script claimed Cop from every mafia seat in ~45/50 games). Janitor cleans 21-27/50 (script 50/50). Buses 5-7/50.
No day had all three scum on one lynch short of the endgame (test).

## Adaptations (mafia, `engine/src/adaptiveMafia.js`)

- **Kill priority Cop > Sheriff > Journalist**, by public claim (or a public reveal). With no claim, the kill is
  among the three players the public reads trust most, picked by a state hash, so kills spread.
- **Information discipline.** Every mafia read goes through `observerView`, a town observer's view: no
  teammates, no checks, and only public reveals (dead players, or a Sheriff who shot). The only private input is
  the faction's own chat and the Janitor's own clean result.
- **Fake claims vary.** About half the nights, nobody claims. When somebody does, it is the Janitor half the
  time, else a hashed teammate. No fake Cop once a real Cop has flipped, claimed (alive or dead), or is verified.
  A fake Journalist ("X got no report, fake cop") only goes on a living Cop claimer, and never on tonight's
  kill. Never a Sheriff claim.
- **The Janitor saves its one clean** for a claimed power role (or night 3+). It then claims the role it
  cleaned (Cop or Journalist), but only if the cleaned player never claimed it in public and no outsider holds
  the claim.
- **Lawyer** covers the teammate town suspects most, since the Cop checks its top read.
- **Day votes blend in.** A scum seat joins a town wagon of 2+ votes, else the most publicly suspicious
  non-claimer. It puts at most two scum on one target unless the lynch wins the game, and never votes a revealed
  townie short of the endgame. A claimer stays consistent with its claim. Buses still come from `busPick`.
- **Not voting first.** Each scum seat waits for 0-2 outside votes (by seat and day), never past 85% of the
  day or the Vote Kick window. The 2-15s staggered copy delay is unchanged.
- **Chat stays natural language.** Examples: "kill dot tonight, no fake claims tmrw, lay low and lean eli,
  lawyer go on bea, save the clean" and "kill cal tonight, bea fake cop tmrw and push eli". `parsePlanLine`
  reads "no fake claims", a teammate named as claimer, and "save the clean". No PLAN or key=value lines (test).
- **Fixes that touch both modes:**
  - The selector now recognises the split "Mafia Kill" meeting as the faction kill.
  - A delayed kill vote picked before the plan existed is dropped once a different agreed kill exists
    (`staleKillVote`). Before this, the second mafia voter could split the kill and no one died.

## Town answers (`engine/src/townReads.js`, `harness/src/live.js`)

All from public play, ordered by evidence strength, same weights on every seed:

- **Vote company:** +1.5 per day for voting the same player as someone who later flipped mafia. -1.5 for voting
  the lynch that flipped mafia. -1 for being voted, or called guilty, by a flipped mafia. A flipped fake Cop's
  guilty counts as their vote that day.
- **Verified Cop's innocent:** -3, or -8 once the Lawyer has flipped (nothing else can fake an innocent).
- **Cleaned claimer:** a dead player with no role shown was killed by the mafia, so was town. Any other claimer
  of their unique role gets +6.
- **A standing vote on a living revealed townie** (the Sheriff after a shot): +2.
- **Own read over the crowd:** with a read of 2+ that is 1.5 above the wagon's target, vote the read instead of
  following the wagon.
- **A guilty from a claimer who has died** no longer forces the "guilty on a power role, no lynch" rule. On
  Day 1 a shot fake Cop used to hold the whole town on no-lynch.

## Lessons

- The old 88% was mostly town reading the script's tells. Every mafia seat fake-claimed Cop, and all three voted
  together. Without those tells, the town bots had little to go on: Day 1 is close to a coin flip, the claimed
  Cop dies on Night 2 in ~30/50 games, and the town Journalist never speaks offline.
- The Sheriff Day-1 rule costs town a lot against quiet mafia. With no fake claimer to shoot, the shot often
  lands on town. Night kill + town shot + mislynch is parity on Day 1. Left alone as asked.
- Vote history is the strongest evidence once something flips mafia. "Who voted with the flipped scum" took
  seed 1 from 16% to 32% on its own.
- Overfitting is easy at 50 games a seed (±7pp). Seeds 1-3 rose with each change while seeds 4-8 stayed near
  30%. Seed 4 and a fresh set of seeds are the honest gauge.
- A real mafia bug hid behind the script. The leader's delayed kill vote could override the agreed kill, so a
  third of kills failed when only two mafia were left.

## Next weakness

- **Mafia, a new tell:** adaptive scum now vote first only 11-17% of days, against ~35% by chance. Their mean
  vote position is 0.68 (town 0.40). Voting late is as readable as voting first. The wait should be sampled to
  match town timing, not 0-2 outside votes. Town does not exploit it yet, so fixing it will lower town's rate
  further.
- **Town, offline speech:** the town Journalist and other power roles never claim under a wagon in self-play.
  Only canned rules speak, and the LLM is not in the loop. Town loses LYLO games with a silent Journalist
  lynched. A rules "claim at L-1" for town power roles is the next principled town gain.
- **Town, Day 1 with no claims:** split votes with no lynch, and mislynches built on 2-scum wagons, decide many
  games. Both a shared tie-break for the first wagon and the own-read rule moved little.

# Pressure claims and matched scum vote timing (branch `pressure-claims`, off `ef51262`)

Two changes. Town power roles (and Villagers) claim under pressure. Adaptive mafia vote timing now matches
town's measured distribution instead of "wait for 0-2 town votes". All diagnosis and tuning used seeds 1-3
only. Seeds 4-8 were run once, at the end, for both `ef51262` and this branch. The Sheriff D1 rule is unchanged.

**Result: still not in the 45-65% band.** Out of sample (seeds 4-8), town beats adaptive mafia **37.2%**
(93/250), up from 31.6% (79/250) at `ef51262`. Scum voting first is now at chance (33.7% vs 35.2%; it was
12.1%). Town still beats the old script at 87.2%, unchanged.

## Out-of-sample results, seeds 4-8 (50 games each; cop rule vinman, Loyal Lawyer)

Against adaptive mafia:

| Seed | Town win before → after | Lynch accuracy before → after | Scum first vote before → after (chance) | Mean vote position scum/town before → after | Vegs | Illegal |
|---|---|---|---|---|---|---|
| 4 | 32% → 28% | 54.8% → 51.9% | 12.6% → 33.0% (36.3%) | 0.68/0.40 → 0.53/0.48 | 0 → 0 | 0 → 0 |
| 5 | 34% → 44% | 55.8% → 63.7% | 10.1% → 36.5% (34.8%) | 0.70/0.40 → 0.52/0.49 | 0 → 0 | 0 → 0 |
| 6 | 30% → 28% | 48.7% → 51.4% | 8.7% → 34.0% (35.9%) | 0.67/0.41 → 0.51/0.50 | 0 → 0 | 0 → 0 |
| 7 | 26% → 42% | 48.6% → 63.4% | 13.3% → 33.3% (34.9%) | 0.69/0.40 → 0.50/0.50 | 0 → 0 | 0 → 0 |
| 8 | 36% → 44% | 60.5% → 62.9% | 16.0% → 31.5% (34.2%) | 0.68/0.40 → 0.52/0.49 | 0 → 0 | 0 → 0 |
| **4-8** | **31.6% → 37.2%** | 53.7% → 58.7% | **12.1% → 33.7%** (35.2%) | | 0 | 0 |

Against the old script:

| Seed | 4 | 5 | 6 | 7 | 8 | 4-8 |
|---|---|---|---|---|---|---|
| Town win, before → after | 88 → 88% | 92 → 90% | 78 → 80% | 82 → 82% | 96 → 96% | **87.2% → 87.2%** |
| Lynch accuracy, after | 98.3% | 98.2% | 94.8% | 96.2% | 96.7% | |

Vegs and illegal actions are 0 in every run.

Tuning seeds 1-3 (adaptive), for reference only: 44 / 48 / 46% at `ef51262`, and 32 / 38 / 42% now. The
tuning seeds went down while the unseen seeds went up. Per-seed noise at 50 games is about ±7pp, so neither
3-seed average is a reliable target. The 250-game out-of-sample set is the number to trust.

Ablations on seeds 1-3 (town win per seed):

| Variant | Town win |
|---|---|
| Final | 32 / 38 / 42% |
| Old 0-2 vote wait instead of matched timing | 36 / 40 / 40% |
| No pressure claims at all | 30 / 34 / 38% |
| No scum pressure claims | 26 / 34 / 38% |
| No 3-scum split | 30 / 32 / 40% |
| Uncontested power claimers also trusted in town's fallback votes (dropped) | 30 / 34 / 42% |

## 1. Claims under pressure

- **Pressure** (`underPressure`) means either:
  - L-1, one vote short of a majority hammer (4 votes with 9 alive, 2 with 5), or
  - the leading wagon of 2+ votes, tied or ahead, from half the day on.
- **Town claims**, following Vinman's rule (no immediate claims; claim only under pressure or with real info):
  - The Cop keeps the fixed rule (a guilty, a counterclaim, or the vinman Sheriff-out trigger). Pressure is added.
  - The Journalist keeps the fixed rule (a guilty on it, or real report info; a rival claim alone is still no
    trigger). Pressure is added. Its line is "im journalist, nothing useful yet. not me", or its info, and it
    calls out a rival claimer if one exists.
  - Any other town role says "im {role}. not me". A Villager says "im just a villager, no power role. not me".
  - One claim per seat per game.
- **Scum under pressure** claim like a townie would: Journalist if that claim is open (nobody outside claims
  it, none flipped), about half the time, else Villager. Never Cop or Sheriff.
- **How town weighs a claim:**
  - A living rival claimer makes both claims contested.
  - Claiming a unique role that a dead player already flipped (even one who never claimed it) is +8. This
    was a gap: only flipped *claimers* counted before.
  - A cleaned dead claimer makes the other claimer a liar.
  - A sole uncontested power claim gets the existing -1, and a wagon on a power claimer is not followed.
  - A plain Villager claim costs nothing to fake, so it no longer protects a wagon (`claimedTown`).
- **Outcome on seeds 1-3:**
  - Scum who claimed under pressure were still lynched ~74% of the time (87/117).
  - Town Villagers who claimed were lynched 35% of the time (44/125).
  - Town Journalists who claimed were lynched 19% of the time (17/90).
- **Town fallback vote:** `beliefDayPick` now skips players the evidence trusts, instead of falling back to
  "no one".

## 2. Scum vote timing from town's distribution

- **Measurement:** self-play records, per seat and day, the delay from that seat's own vote gate opening to
  its first village vote (`stats.voteDelays`; scorecard `mafia.voteTiming.townDelayQuantilesMs` and
  `scumDelayQuantilesMs`).
- **What it shows:** on seeds 1-3, every town seat lets its first vote through on the tick its gate opens.
  The distribution is a point mass at 0 ms (all 11 quantiles are 0). The spread in landing times comes from the
  shared 2-15s first-vote stagger and the 5s tick. Scum go through the same gate and the same stagger.
- **What scum do:** each scum seat samples its hold from `TOWN_VOTE_DELAY_MS` by a per-seat, per-day hash
  (`scumVoteHoldMs`). That hold is 0 in self-play. The 2-15s stagger and the kill copy delay are unchanged.
  Live play, where the town is paced by the model, should measure its own table and pass it as
  `townVoteDelayMs`.
- **Bloc split:** with no wait, teammates can vote on the same tick without seeing each other. With three
  scum alive, one hashed seat per day never takes the team's main target, so there is still no 3-scum bloc
  short of the endgame (test). As a backstop, a delayed scum vote that would become the third scum vote on
  one target is re-picked when it is sent, never dropped (an earlier drop caused one veg on seed 3).

## Lessons

- The late-voting tell was helping town. Removing it is right (the mafia should not be readable by timing),
  but it costs town a few points on the tuning seeds.
- Pressure claims are close to neutral on win rate here. They save some town (Journalist and Villager
  claimers survive more often), but they out the Journalist to the night kill (kill priority Journalist), and
  scum claim back.
- Trusting any uncontested power claimer in town's fallback votes protected fake Cops. It was dropped.
- At 50 games per seed, a 3-seed tuning average moves ±5pp on noise. Out-of-sample totals over 250 games are
  the only number to report.

## Next weakness

Town loses mostly on Day 1-2, and largely without information:
- The claimed Cop dies on Night 2 in most games, and the D1 Sheriff shot often hits town.
- A D1 vote with no claims splits, and the 2-vote wagon wins on plurality.

The next principled lever is **the Journalist's night targeting and reporting**. Today it visits the Cop claimer from N2 on. It should also visit:
- the player who pushed hardest, or
- a pressure claimer, to catch the Janitor's report.

It should then share "X got no report" for claimed Journalists and Villagers as well as fake Cops. After that,
**multi-day vote-pattern reads** (who never voted with town consensus) are next.
