# Sheriff target selection (Vinman 10/20, 12:29pm ET)

> "It's fine if mafia is claiming cop early — but sheriff should not be just targeting 1 person and shooting
> them without considering anyone else. If there are multiple cop claims, sheriff should shoot in them."

Branches: `sheriff-target-20261020` (off `night5-claims-20261020` 0cbb98f) and the Mac
port `sheriff-target-pr17-20261020` (off `night5-claims-pr17-20261020` 1f25b11). Code: `engine/src/sheriffGate.js`.

## What changed
1. **Re-rank before shooting a Villager answer** (`sheriffReconsider`, `sheriffSuspicion`). The Night 5 hold
   stays the same (12s and 4 lines, at most 30s). After it, the asked player is shot only if he is still
   *clearly* the most suspicious living, non-cleared player: he must lead everyone else by `clearMargin` = 1.
   Suspicion is:
   - the town reads (claims, counterclaims, liar calls, Journalist reports, vote history, wagons),
   - plus 0.5 for each distinct player who calls him sus or votes him in chat (up to 1.5),
   - plus 0.5 if he was quiet while the table talked,
   - plus the Sheriff's own belief board and suspects.

   If the asked player is not clearly on top, the Sheriff goes through the comparable players, most suspicious
   first:
   - he shoots a stronger case: a refusal, no answer, or a contested claim;
   - he waits on a fresh answer only from someone who reads worse than the asked player;
   - he asks an unasked player, up to 3 asks;
   - when nobody is left to ask, he shoots the most suspicious open player. Ties break by seed, not by who he
     asked first.

   At the deadline, if he already has a Villager answer, the same ranking runs with no asks.
2. **Two or more living Cop claimers: shoot one of them** (`multiCopTarget`). This overrides the other
   targeting; only `sheriffThreat` (a Sheriff counterclaim, or a fake guilty on him) comes first. It fires once
   he is outed and the second claim is out, with no discussion gate, the same as the old contested-claim shot.
   - **Weakest claimer:** town-read score, +1 for each place later in the claim order, +3 if their guilty
     named a likely townie (revealed or verified town, a sole power-role claim, or the Sheriff), and +2 if
     their guilty named a rival who only claimed Cop afterwards. Ties break by seed.
   - **Never shot:** a revealed-town or verified Cop claimer.
   - **Vote leader:** with 3+ claimers, if the weakest one leads the village vote he takes the next one. With
     2 claimers he holds the gun, and the usual targeting continues.
3. **Contested claims:** a contested claim whose rival leads the village vote is left to the lynch in the new
   paths. Shooting the other claimer killed the real one whenever the leader was the liar (selfplay seed 14,
   game 0).
4. **Kept as they were:**
   - Day 1 always shoots.
   - A sole, uncontested power-role claim is never shot (`protected`).
   - The 1–10s claim delay and the Villager hold are unchanged.
   - Mafia's early Cop claims are left alone.

### How this meets the mafia `no plan claim (cop)` fallback
Unchanged. When the Sheriff asks a mafia seat and a teammate has already fake-claimed Cop, the fallback still
answers "im cop". That is the double mafia Cop claim from live game `4SnTMVJyP`. It now hands the Sheriff two
living Cop claimers, so `multiCopTarget` shoots one of them, and both were mafia there. A real Cop who answers
a fake-Cop opener's guilty on him is protected by the +2 "framed a later claimer" term.

## Tests (each one fails on 0cbb98f, checked with the same file against the old engine: 0/8 pass)
`engine/test/sheriffTarget.test.js`:
- (a) **xYGzM63iO** (sanitized). The old code shot s8, the asked Villager claimer, at 315s.
  - New: he asks s9, whom 3 players called sus/quiet, then shoots s9 when s9 doesn't answer.
  - At the deadline he never takes s8 by default.
- (a) **So2OKZ3td** (sanitized). The old code shot s6, the asked Villager claimer, at 35s.
  - New: he holds on s1's fresh Villager claim (s1 was called a liar and suspicious), then shoots s1, the
    real Mafioso.
  - The sole Cop claim (s8) and the sole Journalist claim (s4) are never shot.
- (b) 2 Cop claimers:
  - he shoots the later claimer at once;
  - a guilty on the sole Journalist claim marks the earlier claimer;
  - an opener who framed the rival before the rival claimed is shot;
  - the override beats a pending Villager ask.
- (c) 3 Cop claimers: the latest claimer is shot; when he leads the vote, another Cop claimer is shot.
- (d) Sole Cop claimer: he is never shot, not even at the deadline, and the asked Villager claimer isn't shot
  by default either.

Two older tests asserted the old behaviour ("no stronger case, shoot the asked Villager claimer"), and I
updated them:
- `live5.test.js` L5 #2: with no reads he now asks the next player. Once two players call the asked player
  sus, he still shoots him.
- `replayFixes1018.test.js`: added two "cal is sus" lines, so the per-target legality check still applies.

Test counts:
- Main branch: engine 432 (was 424), harness 271.
- Mac port: engine 419 (was 411), harness 266.
- All passing.

## Self-play, seeds 14–23 × 50 games (500 per side, 9 bots, defaults)
| | before (0cbb98f) | after (21eb7bb) |
|---|---|---|
| Village wins | 281/500 (56.2%) | 302/500 (60.4%) |
| Sheriff shots | 414 (414/414 Day 1 with the gun) | 414 (414/414) |
| Shots that hit scum | 294 (71.0%) | 302 (72.9%) |
| **Shots on true town** | **120** | **112** |
| …Villager / Journalist / Cop | 99 / 20 / 1 | 62 / 34 / 16 |
| Illegal actions | 0 | 0 |
| Harness errors | 0 | 0 |

The first version of the change (ef9ef9b) got 60.0% Village wins, with town shots 120 split 60 / 41 / 19.
That led to the two fixes in 21eb7bb.

Seeds 14–16 broken down by why the Sheriff shot (150 games):
- 2+ Cop claimers: 36/39 shots hit scum (3 were the real Cop).
- Re-ranked after a Villager answer: 30/46.
- Other evidence paths: 23/38.

## Follow-up (Vinman 10/20, 2:02pm ET): fewer real Cops and Journalists shot
c307e09 shot 16 real Cops and 34 Journalists in self-play (base: 1 and 20). Both came from a near coin flip
between two claimers of one role. Code: `claimEvidence`, `pairDecide`, `contestedDecide` (replaces
`contestedPick`) and `lynchPairFramed` in `engine/src/sheriffGate.js`.

### Why the real Cop was shot
The fake Cop opens with a guilty and the real Cop answers second, often with an inno on the night kill. The
old rule shot the later claimer as soon as the second claim was out (selfplay 15/13, 17/5).

### Why the real Journalist was shot
The Sheriff asks a seat, the real Journalist answers, and a mafia counterclaims ("X is lying, im the real
journalist"). The old `contestedPick` shot the asked one (selfplay 14/7, 15/0, 16/5).

### Pair evidence (`claimEvidence`, higher means less credible)
- Base: the town reads.
- **Cop pair:**
  - +4 for a guilty on a night-killed townie, which a real Cop can't get.
  - +3 for a guilty on a likely townie.
  - −1.5 for an inno on a night-killed townie, which is consistent with the deaths.
  - +2 for calling the rival guilty before the rival claimed.
  - +0.5 for opening with a guilty while the rival gave an inno.
  - The rival's "liar" call is discounted (−1.5), because both Cop claimers call each other liars.
- **Any pair:**
  - −1 if the claim answered my claim request.
  - +1 if he claimed unprompted after the rival. For a Journalist this only counts when the rival was the one
    who answered my request.
- **Journalist pair, nobody asked:** +0.5 for volunteering the claim first, then being countered. In
  self-play the volunteer was fake 35 of 35 times, and the liar call usually comes from the real one (66 of
  96), so here it stays as evidence.

### Decision (`pairDecide`)
1. **Verified claimer:** if one claimer is verified, the other one is shot.
2. **Clear gap:** a gap of `pairMargin` = 2 or more shoots the weaker claim. If that claimer leads the
   village vote, the lynch takes him instead.
3. **Weak gap:**
   - He waits `pairSettleMs` (15s) after the later claim, for reads and reports.
   - Then, if the village vote is on one of the pair, the pair goes to the lynch. The gun goes elsewhere.
   - With no vote on either claimer, he keeps waiting. Only at the deadline does he shoot the weaker claim
     (ties break by seed). This keeps Vinman's "multiple cop claims → shoot in them" when the town hasn't
     picked.
4. **Lynched pair (`lynchPairFramed`):** while a Cop pair is left to the lynch, the guilty targets named by
   the vote-leading claimer are not shot. Before this, those shots were 0 for 19: if the vote is right, he
   is the fake, and the fake's guilty names a townie.

**Trade-off.** On weak evidence there were two ways to avoid a coin flip:
- Leave the pair to the lynch. I chose this.
- Shoot the one the vote isn't on. That kills both claimers, so it kills the real Cop whenever the vote is
  right.

The cost of my choice is that the gun goes to the ordinary ranking, which hits about 59%. Some Cop-pair
shots (about 87% scum under c307e09) become Villager shots.

I also tested never shooting a weak Journalist pair at the deadline (variant "5b" below). It cut Journalist
shots to 3, but Villager shots rose to 106, so it is not in the code.

### New tests (`engine/test/sheriffTarget.test.js`; all fail on c307e09)
- **selfplay 14/7:** the asked Journalist answers and a mafia counterclaims unprompted. There is no instant
  shot on the Journalist. At the deadline, with no vote, the counterclaimer is shot.
- **selfplay 15/13:** a fake Cop opens with a guilty and the real Cop answers with an inno on the night kill.
  The real Cop is not shot. Once the Journalist answers the guilty, the opener is shot.
- **selfplay 18/28:** a weak Cop pair. He waits for the vote. When the village votes one of them, neither is
  shot.
- **(b) weak pair:** a weak Cop pair waits for reads and votes, then shoots one at the deadline.

Updated to wait-then-deadline:
- `sheriff.test.js` (evidence rule pair);
- `night5Sheriff.test.js` (a Journalist pair during the hold: the volunteer is shot);
- `night5MafiaCC.test.js` #2;
- `sheriffAsk.test.js` rule 1.

### Self-play, seeds 14–23 × 50 (500 games each)
| | base 0cbb98f | c307e09 | **new** | variant 5b (not used) |
|---|---|---|---|---|
| Village wins | 281 (56.2%) | 302 (60.4%) | **312 (62.4%)** | 310 (62.0%) |
| Shots / Day 1 with gun | 414 / 414 | 414 / 414 | **414 / 414** | 414 / 414 |
| Shots that hit scum | 294 (71.0%) | 302 (72.9%) | **307 (74.2%)** | 304 (73.4%) |
| Shots on true town | 120 | 112 | **107** | 110 |
| …Villager | 99 | 62 | **83** | 106 |
| …Journalist | 20 | 34 | **23** | 3 |
| …Cop | 1 | 16 | **1** | 1 |
| Illegal actions | 0 | 0 | **0** | 0 |
| Median shot time | 120s | 120s | 185s | 185s |

Breakdown of the new code's shots by path:
- Cop-pair shots: 85 of 86 hit scum.
- Journalist pairs decided on evidence: 71 of 71 hit scum.
- Weak Journalist pairs shot at the deadline: 25 of 45 hit scum. This is where the 20 Journalist shots come
  from.
- All other targeting: 126 of 212 hit scum.

## Risks
- **Follow-up (2:02pm):**
  - Journalist shots are 23, still 3 over base. They come from weak pairs at the deadline, which are a coin
    flip in self-play.
  - Villager shots are 83: better than base (99), but above c307e09 (62). That is the cost of leaving weak
    Cop pairs to the lynch.
  - The answered-ask and volunteered-first terms fit how the bots behave. Humans may claim differently, for
    example a real Journalist who volunteers.
  - The shot comes later (median 185s against 120s). On short live days the deadline path decides more
    often.
- **Noise:** +4.2 points of Village wins on 500 games is inside noise (±~6 points for the difference, at 95%).
  The cleaner signal is 8 fewer shots on town.
- **More power roles shot:** shots on power roles rose (Journalist 20→34, Cop 1→16), even though Villager
  shots fell by 37.
  - The Cop shots come from double-Cop days where the real Cop claimed second without being framed.
  - The Journalist shots come mostly from the older evidence path in `askWalk`, not the new code. That path
    is now reached more often, because the Sheriff no longer fires early at the first Villager answer.
- **Later shots:** re-ranking can use up to 3 asks before the shot. On short live days the deadline path fires
  the gun, ranked by suspicion.
- **Chat heuristic:** the free-chat sus score is a regex: "vote X", "X sus", "X suspicious" and the like. It is
  weak (0.5 per player, at most 1.5) and could be gamed by a mafia bloc.
- **Untested live:** this has not been run in a live game.
