# Self-play scorecard: 50 games, seed 1

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)
Cop rule: vinman; Lawyer: loyal; Mafia: adaptive

| Metric | Value |
|---|---|
| Village win rate | 44.0% (22) |
| Mafia win rate | 56.0% (28) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 77.1% (313/406) |
| Random-vote baseline | 42.2% |
| Lift over random | 34.9 pts |
| Town abstains (no vote / no one) | 17 |
| Lynch accuracy | 68.2% (60/88), 24 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 2.52 days (min 1, max 4); 1 7, 2 16, 3 21, 4 6 |
| Sheriff shots | 20/39 hit scum (51.3% vs 42.9% random) |
| Cop checks | 95, 25 Guilty, 15 flipped by Lawyer; Guilty acted on same day 15/23 (Cop alive that day: 5/7) |
| Public claims | 120 (Sheriff->sheriff 40, Janitor->cop 17, Cop->cop 42, Journalist->journalist 13, Mafioso->cop 6, Lawyer->cop 2) |
| Mafia kills | 126 (Cop 42, Sheriff 31, Villager 39, Journalist 14) |
| Janitor cleans / Lawyer litigates (on teammate) | 21 / 97 (97) |
| Buses (scum voting scum) | 6 |
| Mafia kill votes moved after the first vote | 0 |
| Scum first Village vote | 19/112 (17.0% vs 35.2% random) |
| Faction chat lines / public lines | 415 / 204 |
| Lynches on the mafia PLAN target | 4/20 (random lynch would hit scum 35.1%) |
| Veg kicks | 0 (none) |
| Stale proposals (phase over) | 197 |
| Harness onError calls | 0 |

## Top weakness

**Mafia vote timing is a tell** (severity 0.586)

scum cast the first Village vote on 19/112 days (17.0% vs 35.2% if order were random); mean vote position scum 0.69 vs town 0.39 (0 = first)

## All weaknesses, ranked

- Mafia vote timing is a tell (severity 0.586 = shortfall 0.586 x coverage 1): scum cast the first Village vote on 19/112 days (17.0% vs 35.2% if order were random); mean vote position scum 0.69 vs town 0.39 (0 = first)
- Cop guilties are not acted on (severity 0.16 = shortfall 0.348 x coverage 0.46): 8/23 Guilty results not lynched or shot that day; 15/95 Cop results flipped by the Lawyer
- Sheriff shoots town at about (or worse than) random (severity 0.095 = shortfall 0.122 x coverage 0.78): 19/39 shots hit town (Villager 17, Journalist 2); accuracy 51.3% vs 42.9% random; shots by day Day 1 39
- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0 = shortfall 0 x coverage 0.9): lynch accuracy 68.2% (60/88) vs 35.1% for a random lynch; 4/20 lynches hit the mafia PLAN's push target; on mislynches scum put 1.86 votes and town 1.50 on the lynched player; town spread over 1.95 targets a day; 4/16 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 77.1% vs random 42.2%; 24 no-lynch days
- Town ballots barely beat a random voter (severity 0 = shortfall 0 x coverage 1): 313/406 final town ballots on scum (77.1%) vs random 42.2%; lift 34.9 pts

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      },
      "Mafia": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      }
    },
    "byRole": {
      "Mafioso": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      },
      "Villager": {
        "successes": 66,
        "trials": 150,
        "rate": 0.44,
        "low": 0.3630436095097045,
        "high": 0.5199529271877817
      },
      "Sheriff": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      },
      "Journalist": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      },
      "Janitor": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      },
      "Lawyer": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      },
      "Cop": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      }
    }
  },
  "mislynchRate": {
    "successes": 28,
    "trials": 88,
    "rate": 0.3181818181818182,
    "low": 0.23022439863763888,
    "high": 0.4213496157523544
  },
  "townVoteAccuracy": {
    "successes": 313,
    "trials": 406,
    "rate": 0.770935960591133,
    "low": 0.7276320659187996,
    "high": 0.8091606852318889
  },
  "nightActionUsage": {
    "successes": 616,
    "trials": 682,
    "rate": 0.9032258064516129,
    "low": 0.8787252695931983,
    "high": 0.9232091712456193
  },
  "checkUsefulness": {
    "cop": {
      "successes": 25,
      "trials": 95,
      "rate": 0.2631578947368421,
      "low": 0.18506401390488098,
      "high": 0.3596620933212263
    },
    "journalist": {
      "successes": 32,
      "trials": 114,
      "rate": 0.2807017543859649,
      "low": 0.20640600067746484,
      "high": 0.3692956191240314
    }
  },
  "killPriorityAdherence": {
    "successes": 67,
    "trials": 124,
    "rate": 0.5403225806451613,
    "low": 0.4527104848592219,
    "high": 0.6255113146176308
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
    "candidate": 3,
    "llm": 0,
    "rules": 2006,
    "rate": 0.9985067197610752,
    "successes": 2006,
    "trials": 2009,
    "low": 0.9956185618170185,
    "high": 0.9994920320816768
  },
  "messageRate": {
    "mean": 0.3379629629629629,
    "low": 0.2822816658761663,
    "high": 0.3936442600497595,
    "n": 450
  },
  "speechAllowed": 204
}
```
