# Self-play scorecard: 50 games, seed 1

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)
Cop rule: vinman; Lawyer: loyal; Mafia: adaptive

| Metric | Value |
|---|---|
| Village win rate | 34.0% (17) |
| Mafia win rate | 66.0% (33) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 74.7% (289/387) |
| Random-vote baseline | 43.7% |
| Lift over random | 31.0 pts |
| Town abstains (no vote / no one) | 9 |
| Lynch accuracy | 66.7% (52/78), 27 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 2.52 days (min 1, max 4); 1 7, 2 15, 3 23, 4 5 |
| Sheriff shots | 15/38 hit scum (39.5% vs 42.9% random) |
| Cop checks | 92, 26 Guilty, 17 flipped by Lawyer; Guilty acted on same day 19/21 (Cop alive that day: 8/8) |
| Public claims | 219 (Sheriff->sheriff 40, Villager->villager 41, Janitor->cop 15, Cop->cop 41, Journalist->journalist 24, Lawyer->villager 17, Mafioso->villager 13, Mafioso->journalist 6, Lawyer->journalist 5, Mafioso->cop 5, Janitor->villager 6, Janitor->journalist 4, Lawyer->cop 2) |
| Mafia kills | 126 (Cop 39, Sheriff 35, Villager 36, Journalist 16) |
| Janitor cleans / Lawyer litigates (on teammate) | 23 / 100 (100) |
| Buses (scum voting scum) | 0 |
| Mafia kill votes moved after the first vote | 0 |
| First-vote delay after own gate, ms (0/50/90/100%) | town 0/0/0/0, scum 0/0/0/0 |
| Scum first Village vote | 37/105 (35.2% vs 36.4% random) |
| Faction chat lines / public lines | 424 / 327 |
| Lynches on the mafia PLAN target | 3/21 (random lynch would hit scum 36.1%) |
| Veg kicks | 0 (none) |
| Stale proposals (phase over) | 167 |
| Harness onError calls | 0 |

## Top weakness

**Sheriff shoots town at about (or worse than) random** (severity 0.175)

23/38 shots hit town (Villager 21, Journalist 2); accuracy 39.5% vs 42.9% random; shots by day Day 1 38

Example (first game where it shows):

```
game 0 (seed 1); roles: Ash=Mafioso, Bea=Villager, Cal=Sheriff, Dot=Journalist, Eli=Janitor, Fin=Villager, Gil=Lawyer, Hap=Villager, Ivo=Cop
Night 1 [Mafia] Eli: kill ivo tonight, no fake claims tmrw, lay low and lean fin, lawyer go on ash, save the clean
Night 1 [Mafia] Eli: sounds good
Night 1 [Mafia] Ash: ok im in
Night 1 [Mafia] Gil: if pressed i fakeclaim villager
Day 1 Ivo (Cop) dies: killed by the Mafia
Day 1 Cal: im sheriff
Day 1 Hap (Villager) dies: shot by the Sheriff
```

## All weaknesses, ranked

- Sheriff shoots town at about (or worse than) random (severity 0.175 = shortfall 0.23 x coverage 0.76): 23/38 shots hit town (Villager 21, Journalist 2); accuracy 39.5% vs 42.9% random; shots by day Day 1 38
- Cop guilties are not acted on (severity 0.038 = shortfall 0.095 x coverage 0.4): 2/21 Guilty results not lynched or shot that day; 17/92 Cop results flipped by the Lawyer
- Mafia vote timing is a tell (severity 0.036 = shortfall 0.036 x coverage 1): scum cast the first Village vote on 37/105 days (35.2% vs 36.4% if order were random); mean vote position scum 0.51 vs town 0.49 (0 = first)
- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0 = shortfall 0 x coverage 0.86): lynch accuracy 66.7% (52/78) vs 36.1% for a random lynch; 3/21 lynches hit the mafia PLAN's push target; on mislynches scum put 1.65 votes and town 1.54 on the lynched player; town spread over 2.03 targets a day; 9/51 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 74.7% vs random 43.7%; 27 no-lynch days
- Town ballots barely beat a random voter (severity 0 = shortfall 0 x coverage 1): 289/387 final town ballots on scum (74.7%) vs random 43.7%; lift 31.0 pts

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 17,
        "trials": 50,
        "rate": 0.34,
        "low": 0.2243676963506106,
        "high": 0.47846431458517147
      },
      "Mafia": {
        "successes": 33,
        "trials": 50,
        "rate": 0.66,
        "low": 0.5215356854148285,
        "high": 0.7756323036493895
      }
    },
    "byRole": {
      "Mafioso": {
        "successes": 33,
        "trials": 50,
        "rate": 0.66,
        "low": 0.5215356854148285,
        "high": 0.7756323036493895
      },
      "Villager": {
        "successes": 51,
        "trials": 150,
        "rate": 0.34,
        "low": 0.2690321465825542,
        "high": 0.4189586179440758
      },
      "Sheriff": {
        "successes": 17,
        "trials": 50,
        "rate": 0.34,
        "low": 0.2243676963506106,
        "high": 0.47846431458517147
      },
      "Journalist": {
        "successes": 17,
        "trials": 50,
        "rate": 0.34,
        "low": 0.2243676963506106,
        "high": 0.47846431458517147
      },
      "Janitor": {
        "successes": 33,
        "trials": 50,
        "rate": 0.66,
        "low": 0.5215356854148285,
        "high": 0.7756323036493895
      },
      "Lawyer": {
        "successes": 33,
        "trials": 50,
        "rate": 0.66,
        "low": 0.5215356854148285,
        "high": 0.7756323036493895
      },
      "Cop": {
        "successes": 17,
        "trials": 50,
        "rate": 0.34,
        "low": 0.2243676963506106,
        "high": 0.47846431458517147
      }
    }
  },
  "mislynchRate": {
    "successes": 26,
    "trials": 78,
    "rate": 0.3333333333333333,
    "low": 0.23872517005631883,
    "high": 0.4435879812017211
  },
  "townVoteAccuracy": {
    "successes": 289,
    "trials": 387,
    "rate": 0.7467700258397932,
    "low": 0.701163492392542,
    "high": 0.7875255314984664
  },
  "nightActionUsage": {
    "successes": 620,
    "trials": 680,
    "rate": 0.9117647058823529,
    "low": 0.8880671654755277,
    "high": 0.9308359255326824
  },
  "checkUsefulness": {
    "cop": {
      "successes": 26,
      "trials": 92,
      "rate": 0.2826086956521739,
      "low": 0.20075548814347022,
      "high": 0.38188920894005085
    },
    "journalist": {
      "successes": 30,
      "trials": 107,
      "rate": 0.2803738317757009,
      "low": 0.2040167905416766,
      "high": 0.3719546858715112
    }
  },
  "killPriorityAdherence": {
    "successes": 68,
    "trials": 123,
    "rate": 0.5528455284552846,
    "low": 0.4647023677965987,
    "high": 0.6377876670184777
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
    "candidate": 11,
    "llm": 0,
    "rules": 1900,
    "rate": 0.9942438513867086,
    "successes": 1900,
    "trials": 1911,
    "low": 0.9897217289918345,
    "high": 0.9967828466346822
  },
  "messageRate": {
    "mean": 0.505925925925926,
    "low": 0.448371856894632,
    "high": 0.56347999495722,
    "n": 450
  },
  "speechAllowed": 327
}
```
