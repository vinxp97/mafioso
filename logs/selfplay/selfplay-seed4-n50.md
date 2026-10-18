# Self-play scorecard: 50 games, seed 4

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)
Cop rule: vinman; Lawyer: loyal; Mafia: adaptive

| Metric | Value |
|---|---|
| Village win rate | 46.0% (23) |
| Mafia win rate | 54.0% (27) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 76.4% (295/386) |
| Random-vote baseline | 42.9% |
| Lift over random | 33.6 pts |
| Town abstains (no vote / no one) | 17 |
| Lynch accuracy | 68.5% (63/92), 15 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 2.40 days (min 1, max 4); 1 8, 2 18, 3 20, 4 4 |
| Sheriff shots | 18/39 hit scum (46.2% vs 42.9% random) |
| Cop checks | 81, 25 Guilty, 18 flipped by Lawyer; Guilty acted on same day 17/24 (Cop alive that day: 8/9) |
| Public claims | 231 (Cop->cop 33, Sheriff->sheriff 43, Janitor->journalist 9, Lawyer->journalist 4, Villager->villager 43, Mafioso->villager 10, Journalist->journalist 32, Janitor->cop 18, Mafioso->journalist 5, Lawyer->villager 14, Mafioso->cop 10, Lawyer->cop 5, Janitor->villager 5) |
| Mafia kills | 120 (Journalist 19, Sheriff 30, Villager 31, Cop 40) |
| Janitor cleans / Lawyer litigates (on teammate) | 50 / 92 (92) |
| Buses (scum voting scum) | 0 |
| Mafia kill votes moved after the first vote | 0 |
| First-vote delay after own gate, ms (0/50/90/100%) | town 0/0/0/0, scum 0/0/0/0 |
| Scum first Village vote | 42/107 (39.3% vs 35.7% random) |
| Faction chat lines / public lines | 399 / 689 |
| Lynches on the mafia PLAN target | 4/35 (random lynch would hit scum 35.6%) |
| Veg kicks | 0 (none) |
| Stale proposals (phase over) | 196 |
| Harness onError calls | 0 |

## Top weakness

**Cop guilties are not acted on** (severity 0.111)

7/24 Guilty results not lynched or shot that day; 18/81 Cop results flipped by the Lawyer

## All weaknesses, ranked

- Cop guilties are not acted on (severity 0.111 = shortfall 0.292 x coverage 0.38): 7/24 Guilty results not lynched or shot that day; 18/81 Cop results flipped by the Lawyer
- Sheriff shoots town at about (or worse than) random (severity 0.105 = shortfall 0.135 x coverage 0.78): 21/39 shots hit town (Cop 5, Villager 14, Journalist 2); accuracy 46.2% vs 42.9% random; shots by day Day 1 39
- Mafia vote timing is a tell (severity 0.069 = shortfall 0.069 x coverage 1): scum cast the first Village vote on 42/107 days (39.3% vs 35.7% if order were random); mean vote position scum 0.49 vs town 0.51 (0 = first)
- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0 = shortfall 0 x coverage 0.94): lynch accuracy 68.5% (63/92) vs 35.6% for a random lynch; 4/35 lynches hit the mafia PLAN's push target; on mislynches scum put 1.66 votes and town 1.55 on the lynched player; town spread over 1.94 targets a day; 9/60 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 76.4% vs random 42.9%; 15 no-lynch days
- Town ballots barely beat a random voter (severity 0 = shortfall 0 x coverage 1): 295/386 final town ballots on scum (76.4%) vs random 42.9%; lift 33.6 pts

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 23,
        "trials": 50,
        "rate": 0.46,
        "low": 0.3296943460178263,
        "high": 0.5960136567161192
      },
      "Mafia": {
        "successes": 27,
        "trials": 50,
        "rate": 0.54,
        "low": 0.40398634328388083,
        "high": 0.6703056539821737
      }
    },
    "byRole": {
      "Journalist": {
        "successes": 23,
        "trials": 50,
        "rate": 0.46,
        "low": 0.3296943460178263,
        "high": 0.5960136567161192
      },
      "Cop": {
        "successes": 23,
        "trials": 50,
        "rate": 0.46,
        "low": 0.3296943460178263,
        "high": 0.5960136567161192
      },
      "Lawyer": {
        "successes": 27,
        "trials": 50,
        "rate": 0.54,
        "low": 0.40398634328388083,
        "high": 0.6703056539821737
      },
      "Janitor": {
        "successes": 27,
        "trials": 50,
        "rate": 0.54,
        "low": 0.40398634328388083,
        "high": 0.6703056539821737
      },
      "Mafioso": {
        "successes": 27,
        "trials": 50,
        "rate": 0.54,
        "low": 0.40398634328388083,
        "high": 0.6703056539821737
      },
      "Sheriff": {
        "successes": 23,
        "trials": 50,
        "rate": 0.46,
        "low": 0.3296943460178263,
        "high": 0.5960136567161192
      },
      "Villager": {
        "successes": 69,
        "trials": 150,
        "rate": 0.46,
        "low": 0.38223445858630034,
        "high": 0.5397632325453572
      }
    }
  },
  "mislynchRate": {
    "successes": 29,
    "trials": 92,
    "rate": 0.31521739130434784,
    "low": 0.2293129742179435,
    "high": 0.41593501830304946
  },
  "townVoteAccuracy": {
    "successes": 295,
    "trials": 386,
    "rate": 0.7642487046632125,
    "low": 0.7194280465338955,
    "high": 0.8038614125694944
  },
  "nightActionUsage": {
    "successes": 611,
    "trials": 620,
    "rate": 0.9854838709677419,
    "low": 0.9726438919615426,
    "high": 0.9923446564135578
  },
  "checkUsefulness": {
    "cop": {
      "successes": 25,
      "trials": 81,
      "rate": 0.30864197530864196,
      "low": 0.2186306293369854,
      "high": 0.41598257927765636
    },
    "journalist": {
      "successes": 23,
      "trials": 109,
      "rate": 0.21100917431192662,
      "low": 0.14492255462317266,
      "high": 0.29677270669889294
    }
  },
  "killPriorityAdherence": {
    "successes": 71,
    "trials": 116,
    "rate": 0.6120689655172413,
    "low": 0.5211597659068572,
    "high": 0.6957932787787944
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
    "candidate": 39,
    "llm": 43,
    "rules": 1797,
    "rate": 0.9792442788717403,
    "successes": 1840,
    "trials": 1879,
    "low": 0.971752983630599,
    "high": 0.9847799504197216
  },
  "messageRate": {
    "mean": 1.0022222222222221,
    "low": 0.9231219238917885,
    "high": 1.0813225205526558,
    "n": 450
  },
  "speechAllowed": 689
}
```
