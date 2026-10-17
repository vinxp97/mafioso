# Self-play scorecard: 50 games, seed 1

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)

| Metric | Value |
|---|---|
| Village win rate | 10.0% (5) |
| Mafia win rate | 90.0% (45) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 49.6% (187/377) |
| Random-vote baseline | 42.8% |
| Lift over random | 6.8 pts |
| Town abstains (no vote / no one) | 6 |
| Lynch accuracy | 13.8% (9/65), 29 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 2.46 days (min 1, max 6); 1 3, 2 29, 3 12, 4 5, 6 1 |
| Sheriff shots | 14/38 hit scum (36.8% vs 42.9% random) |
| Cop checks | 93, 26 Guilty, 8 flipped by Lawyer; Guilty acted on same day 2/17 |
| Public claims | 181 (Sheriff->sheriff 39, Janitor->cop 27, Cop->cop 44, Lawyer->cop 29, Journalist->journalist 22, Mafioso->cop 20) |
| Mafia kills | 99 (Villager 48, Cop 23, Journalist 16, Sheriff 12) |
| Janitor cleans / Lawyer litigates (on teammate) | 50 / 100 (100) |
| Buses (scum voting scum) | 0 |
| Mafia kill votes moved after the first vote | 76 |
| Scum first Village vote | 29/94 (30.9% vs 36.5% random) |
| Faction chat lines / public lines | 419 / 181 |
| Lynches on the mafia PLAN target | 38/65 (random lynch would hit scum 36.9%) |
| Veg kicks | 31 (Litigate: PLAN names no lawyer target; Lawyer never voted 4, Village: PLAN speaker whose PLAN lynch target died (shot) before the vote 21, Village: vote cleared when its target died; never re-voted 5, Village: never proposed a vote 1) |
| Stale proposals (phase over) | 0 |
| Harness onError calls | 0 |

## Top weakness

**Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch** (severity 0.612)

lynch accuracy 13.8% (9/65) vs 36.9% for a random lynch; 38/65 lynches hit the mafia PLAN's push target; on mislynches scum put 2.02 votes and town 1.07 on the lynched player; town spread over 2.95 targets a day; 43/51 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 49.6% vs random 42.8%; 29 no-lynch days

Example (first game where it shows):

```
game 2 (seed 1); roles: Ash=Villager, Bea=Journalist, Cal=Lawyer, Dot=Villager, Eli=Janitor, Fin=Villager, Gil=Mafioso, Hap=Cop, Ivo=Sheriff
Night 1 [Mafia] Cal: kill ash tonight, ill fake cop tmrw and push bea, lawyer go on gil
Night 1 [Mafia] Cal: bea is an easy wagon
Night 1 [Mafia] Eli: ok ash it is
Night 1 [Mafia] Gil: dont all vote the same guy first
Day 1 Ash (Villager) dies: killed by the Mafia [cleaned]
Day 1 Cal: im cop. bea is guilty, vote bea
Day 1 Ivo: im sheriff.
Day 1 Bea: cal is lying, im journalist
Day 1 Hap: cal is lying, im the real cop.
Day 1 Hap (Cop) dies: shot by the Sheriff
Day 1 votes: Eli <- Bea,Ivo; Bea <- Cal,Eli,Gil
Day 1 Bea (Journalist) dies: lynched
```

## All weaknesses, ranked

- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0.612 = shortfall 0.625 x coverage 0.98): lynch accuracy 13.8% (9/65) vs 36.9% for a random lynch; 38/65 lynches hit the mafia PLAN's push target; on mislynches scum put 2.02 votes and town 1.07 on the lynched player; town spread over 2.95 targets a day; 43/51 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 49.6% vs random 42.8%; 29 no-lynch days
- Seats veg (never cast a must-act vote) (severity 0.36 = shortfall 0.62 x coverage 0.58): 31 veg kicks in 29/50 games; causes: Litigate: PLAN names no lawyer target; Lawyer never voted 4, Village: PLAN speaker whose PLAN lynch target died (shot) before the vote 21, Village: vote cleared when its target died; never re-voted 5, Village: never proposed a vote 1
- Cop guilties are not acted on (severity 0.265 = shortfall 0.882 x coverage 0.3): 15/17 Guilty results not lynched or shot that day; 8/93 Cop results flipped by the Lawyer
- Sheriff shoots town at about (or worse than) random (severity 0.227 = shortfall 0.298 x coverage 0.76): 24/38 shots hit town (Cop 6, Villager 18); accuracy 36.8% vs 42.9% random; shots by day Day 1 38
- Town ballots barely beat a random voter (severity 0.1 = shortfall 0.1 x coverage 1): 187/377 final town ballots on scum (49.6%) vs random 42.8%; lift 6.8 pts
- Mafia vote timing is a tell (severity 0.06 = shortfall 0.06 x coverage 1): scum cast the first Village vote on 29/94 days (30.9% vs 36.5% if order were random); mean vote position scum 0.52 vs town 0.49 (0 = first)

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 5,
        "trials": 50,
        "rate": 0.1,
        "low": 0.04347512399157111,
        "high": 0.2136049033478839
      },
      "Mafia": {
        "successes": 45,
        "trials": 50,
        "rate": 0.9,
        "low": 0.7863950966521162,
        "high": 0.956524876008429
      }
    },
    "byRole": {
      "Mafioso": {
        "successes": 45,
        "trials": 50,
        "rate": 0.9,
        "low": 0.7863950966521162,
        "high": 0.956524876008429
      },
      "Villager": {
        "successes": 15,
        "trials": 150,
        "rate": 0.1,
        "low": 0.06154083683597323,
        "high": 0.15843607448060176
      },
      "Sheriff": {
        "successes": 5,
        "trials": 50,
        "rate": 0.1,
        "low": 0.04347512399157111,
        "high": 0.2136049033478839
      },
      "Journalist": {
        "successes": 5,
        "trials": 50,
        "rate": 0.1,
        "low": 0.04347512399157111,
        "high": 0.2136049033478839
      },
      "Janitor": {
        "successes": 45,
        "trials": 50,
        "rate": 0.9,
        "low": 0.7863950966521162,
        "high": 0.956524876008429
      },
      "Lawyer": {
        "successes": 45,
        "trials": 50,
        "rate": 0.9,
        "low": 0.7863950966521162,
        "high": 0.956524876008429
      },
      "Cop": {
        "successes": 5,
        "trials": 50,
        "rate": 0.1,
        "low": 0.04347512399157111,
        "high": 0.2136049033478839
      }
    }
  },
  "mislynchRate": {
    "successes": 56,
    "trials": 65,
    "rate": 0.8615384615384616,
    "low": 0.7573167852534054,
    "high": 0.9254099381231576
  },
  "townVoteAccuracy": {
    "successes": 187,
    "trials": 377,
    "rate": 0.4960212201591512,
    "low": 0.44584556769101763,
    "high": 0.546277141592842
  },
  "nightActionUsage": {
    "successes": 640,
    "trials": 644,
    "rate": 0.9937888198757764,
    "low": 0.9841393984405056,
    "high": 0.9975820593973364
  },
  "checkUsefulness": {
    "cop": {
      "successes": 26,
      "trials": 93,
      "rate": 0.27956989247311825,
      "low": 0.19850210044898137,
      "high": 0.3781261254374145
    },
    "journalist": {
      "successes": 19,
      "trials": 101,
      "rate": 0.18811881188118812,
      "low": 0.12387028698950667,
      "high": 0.2752232026176721
    }
  },
  "killPriorityAdherence": {
    "successes": 24,
    "trials": 98,
    "rate": 0.24489795918367346,
    "low": 0.1704485358593521,
    "high": 0.3385929560260857
  },
  "illegal": {
    "proposed": 0,
    "blocked": 0,
    "blockRate": {
      "successes": 0,
      "trials": 0,
      "rate": null,
      "low": null,
      "high": null
    }
  },
  "fallback": {
    "candidate": 77,
    "llm": 0,
    "rules": 1698,
    "rate": 0.9566197183098591,
    "successes": 1698,
    "trials": 1775,
    "low": 0.946115575618555,
    "high": 0.9651516220903361
  },
  "messageRate": {
    "mean": 0.2964074074074074,
    "low": 0.2588751326215829,
    "high": 0.3339396821932319,
    "n": 450
  },
  "speechAllowed": 181
}
```
