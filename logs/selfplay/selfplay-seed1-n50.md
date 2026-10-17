# Self-play scorecard: 50 games, seed 1

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)
Cop rule: vinman; Lawyer: loyal; Mafia: adaptive

| Metric | Value |
|---|---|
| Village win rate | 32.0% (16) |
| Mafia win rate | 68.0% (34) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 74.9% (287/383) |
| Random-vote baseline | 43.7% |
| Lift over random | 31.2 pts |
| Town abstains (no vote / no one) | 10 |
| Lynch accuracy | 66.7% (48/72), 32 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 2.54 days (min 1, max 4); 1 7, 2 15, 3 22, 4 6 |
| Sheriff shots | 15/38 hit scum (39.5% vs 42.9% random) |
| Cop checks | 92, 26 Guilty, 17 flipped by Lawyer; Guilty acted on same day 17/21 (Cop alive that day: 6/7) |
| Public claims | 216 (Sheriff->sheriff 40, Villager->villager 44, Janitor->cop 15, Cop->cop 41, Journalist->journalist 22, Lawyer->villager 13, Mafioso->villager 12, Mafioso->journalist 7, Lawyer->journalist 5, Mafioso->cop 5, Janitor->villager 6, Janitor->journalist 4, Lawyer->cop 2) |
| Mafia kills | 127 (Cop 40, Sheriff 35, Villager 38, Journalist 14) |
| Janitor cleans / Lawyer litigates (on teammate) | 24 / 103 (103) |
| Buses (scum voting scum) | 0 |
| Mafia kill votes moved after the first vote | 0 |
| First-vote delay after own gate, ms (0/50/90/100%) | town 0/0/0/0, scum 0/0/0/0 |
| Scum first Village vote | 46/104 (44.2% vs 36.5% random) |
| Faction chat lines / public lines | 430 / 311 |
| Lynches on the mafia PLAN target | 3/21 (random lynch would hit scum 36.3%) |
| Veg kicks | 0 (none) |
| Stale proposals (phase over) | 158 |
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
- Mafia vote timing is a tell (severity 0.161 = shortfall 0.161 x coverage 1): scum cast the first Village vote on 46/104 days (44.2% vs 36.5% if order were random); mean vote position scum 0.47 vs town 0.52 (0 = first)
- Cop guilties are not acted on (severity 0.076 = shortfall 0.19 x coverage 0.4): 4/21 Guilty results not lynched or shot that day; 17/92 Cop results flipped by the Lawyer
- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0 = shortfall 0 x coverage 0.84): lynch accuracy 66.7% (48/72) vs 36.3% for a random lynch; 3/21 lynches hit the mafia PLAN's push target; on mislynches scum put 1.67 votes and town 1.58 on the lynched player; town spread over 2.06 targets a day; 8/47 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 74.9% vs random 43.7%; 32 no-lynch days
- Town ballots barely beat a random voter (severity 0 = shortfall 0 x coverage 1): 287/383 final town ballots on scum (74.9%) vs random 43.7%; lift 31.2 pts

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 16,
        "trials": 50,
        "rate": 0.32,
        "low": 0.20758044093999403,
        "high": 0.45810557136276076
      },
      "Mafia": {
        "successes": 34,
        "trials": 50,
        "rate": 0.68,
        "low": 0.5418944286372394,
        "high": 0.792419559060006
      }
    },
    "byRole": {
      "Mafioso": {
        "successes": 34,
        "trials": 50,
        "rate": 0.68,
        "low": 0.5418944286372394,
        "high": 0.792419559060006
      },
      "Villager": {
        "successes": 48,
        "trials": 150,
        "rate": 0.32,
        "low": 0.25064412359702404,
        "high": 0.39834548649543466
      },
      "Sheriff": {
        "successes": 16,
        "trials": 50,
        "rate": 0.32,
        "low": 0.20758044093999403,
        "high": 0.45810557136276076
      },
      "Journalist": {
        "successes": 16,
        "trials": 50,
        "rate": 0.32,
        "low": 0.20758044093999403,
        "high": 0.45810557136276076
      },
      "Janitor": {
        "successes": 34,
        "trials": 50,
        "rate": 0.68,
        "low": 0.5418944286372394,
        "high": 0.792419559060006
      },
      "Lawyer": {
        "successes": 34,
        "trials": 50,
        "rate": 0.68,
        "low": 0.5418944286372394,
        "high": 0.792419559060006
      },
      "Cop": {
        "successes": 16,
        "trials": 50,
        "rate": 0.32,
        "low": 0.20758044093999403,
        "high": 0.45810557136276076
      }
    }
  },
  "mislynchRate": {
    "successes": 24,
    "trials": 72,
    "rate": 0.3333333333333333,
    "low": 0.2353448606571184,
    "high": 0.4482061192800137
  },
  "townVoteAccuracy": {
    "successes": 287,
    "trials": 383,
    "rate": 0.7493472584856397,
    "low": 0.7036117273594277,
    "high": 0.7901304141269067
  },
  "nightActionUsage": {
    "successes": 630,
    "trials": 689,
    "rate": 0.9143686502177069,
    "low": 0.8911087228874948,
    "high": 0.9330334764261725
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
      "successes": 29,
      "trials": 108,
      "rate": 0.26851851851851855,
      "low": 0.19394781819614243,
      "high": 0.3589913386113424
    }
  },
  "killPriorityAdherence": {
    "successes": 68,
    "trials": 124,
    "rate": 0.5483870967741935,
    "low": 0.4606534174133777,
    "high": 0.6332127419588452
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
    "candidate": 10,
    "llm": 0,
    "rules": 1895,
    "rate": 0.994750656167979,
    "successes": 1895,
    "trials": 1905,
    "low": 0.990363728702267,
    "high": 0.9971461830683063
  },
  "messageRate": {
    "mean": 0.4922222222222223,
    "low": 0.43507062229398513,
    "high": 0.5493738221504595,
    "n": 450
  },
  "speechAllowed": 311
}
```
