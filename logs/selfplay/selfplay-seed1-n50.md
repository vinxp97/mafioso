# Self-play scorecard: 50 games, seed 1

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)
Cop rule: vinman; Lawyer: loyal

| Metric | Value |
|---|---|
| Village win rate | 92.0% (46) |
| Mafia win rate | 8.0% (4) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 96.4% (456/473) |
| Random-vote baseline | 40.4% |
| Lift over random | 56.0 pts |
| Town abstains (no vote / no one) | 142 |
| Lynch accuracy | 95.2% (120/126), 33 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 3.24 days (min 2, max 4); 2 3, 3 32, 4 15 |
| Sheriff shots | 25/39 hit scum (64.1% vs 42.9% random) |
| Cop checks | 126, 30 Guilty, 19 flipped by Lawyer; Guilty acted on same day 22/30 (Cop alive that day: 17/21) |
| Public claims | 269 (Sheriff->sheriff 39, Janitor->cop 49, Cop->cop 44, Journalist->journalist 40, Mafioso->cop 48, Lawyer->cop 49) |
| Mafia kills | 140 (Villager 64, Cop 41, Journalist 23, Sheriff 12) |
| Janitor cleans / Lawyer litigates (on teammate) | 50 / 95 (95) |
| Buses (scum voting scum) | 0 |
| Mafia kill votes moved after the first vote | 71 |
| Scum first Village vote | 69/159 (43.4% vs 32.5% random) |
| Faction chat lines / public lines | 494 / 562 |
| Lynches on the mafia PLAN target | 6/126 (random lynch would hit scum 32.8%) |
| Veg kicks | 0 (none) |
| Stale proposals (phase over) | 380 |
| Harness onError calls | 0 |

## Top weakness

**Mafia vote timing is a tell** (severity 0.194)

scum cast the first Village vote on 69/159 days (43.4% vs 32.5% if order were random); mean vote position scum 0.47 vs town 0.52 (0 = first)

## All weaknesses, ranked

- Mafia vote timing is a tell (severity 0.194 = shortfall 0.194 x coverage 1): scum cast the first Village vote on 69/159 days (43.4% vs 32.5% if order were random); mean vote position scum 0.47 vs town 0.52 (0 = first)
- Cop guilties are not acted on (severity 0.133 = shortfall 0.267 x coverage 0.5): 8/30 Guilty results not lynched or shot that day; 19/126 Cop results flipped by the Lawyer
- Sheriff shoots town at about (or worse than) random (severity 0.07 = shortfall 0.09 x coverage 0.78): 14/39 shots hit town (Villager 14); accuracy 64.1% vs 42.9% random; shots by day Day 1 39
- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0 = shortfall 0 x coverage 1): lynch accuracy 95.2% (120/126) vs 32.8% for a random lynch; 6/126 lynches hit the mafia PLAN's push target; on mislynches scum put 1.50 votes and town 1.83 on the lynched player; town spread over 0.96 targets a day; 6/113 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 96.4% vs random 40.4%; 33 no-lynch days
- Town ballots barely beat a random voter (severity 0 = shortfall 0 x coverage 1): 456/473 final town ballots on scum (96.4%) vs random 40.4%; lift 56.0 pts

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 46,
        "trials": 50,
        "rate": 0.92,
        "low": 0.8116149745493629,
        "high": 0.9684509967442093
      },
      "Mafia": {
        "successes": 4,
        "trials": 50,
        "rate": 0.08,
        "low": 0.031549003255790686,
        "high": 0.18838502545063704
      }
    },
    "byRole": {
      "Mafioso": {
        "successes": 4,
        "trials": 50,
        "rate": 0.08,
        "low": 0.031549003255790686,
        "high": 0.18838502545063704
      },
      "Villager": {
        "successes": 138,
        "trials": 150,
        "rate": 0.92,
        "low": 0.8653774250568131,
        "high": 0.9536468180607831
      },
      "Sheriff": {
        "successes": 46,
        "trials": 50,
        "rate": 0.92,
        "low": 0.8116149745493629,
        "high": 0.9684509967442093
      },
      "Journalist": {
        "successes": 46,
        "trials": 50,
        "rate": 0.92,
        "low": 0.8116149745493629,
        "high": 0.9684509967442093
      },
      "Janitor": {
        "successes": 4,
        "trials": 50,
        "rate": 0.08,
        "low": 0.031549003255790686,
        "high": 0.18838502545063704
      },
      "Lawyer": {
        "successes": 4,
        "trials": 50,
        "rate": 0.08,
        "low": 0.031549003255790686,
        "high": 0.18838502545063704
      },
      "Cop": {
        "successes": 46,
        "trials": 50,
        "rate": 0.92,
        "low": 0.8116149745493629,
        "high": 0.9684509967442093
      }
    }
  },
  "mislynchRate": {
    "successes": 6,
    "trials": 126,
    "rate": 0.047619047619047616,
    "low": 0.022004188389251493,
    "high": 0.10000293413542474
  },
  "townVoteAccuracy": {
    "successes": 456,
    "trials": 473,
    "rate": 0.9640591966173362,
    "low": 0.9431997685585243,
    "high": 0.9774413835557207
  },
  "nightActionUsage": {
    "successes": 740,
    "trials": 754,
    "rate": 0.9814323607427056,
    "low": 0.9690757682218696,
    "high": 0.9889080637556835
  },
  "checkUsefulness": {
    "cop": {
      "successes": 30,
      "trials": 126,
      "rate": 0.23809523809523808,
      "low": 0.1721741635445131,
      "high": 0.31951417054872056
    },
    "journalist": {
      "successes": 37,
      "trials": 137,
      "rate": 0.27007299270072993,
      "low": 0.20274861096279786,
      "high": 0.34994036729362643
    }
  },
  "killPriorityAdherence": {
    "successes": 44,
    "trials": 139,
    "rate": 0.31654676258992803,
    "low": 0.2450426950943528,
    "high": 0.3979184590792211
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
    "candidate": 72,
    "llm": 0,
    "rules": 2510,
    "rate": 0.9721146398140976,
    "successes": 2510,
    "trials": 2582,
    "low": 0.9650285825368599,
    "high": 0.9777979231547496
  },
  "messageRate": {
    "mean": 0.5964814814814821,
    "low": 0.5442402372746871,
    "high": 0.648722725688277,
    "n": 450
  },
  "speechAllowed": 562
}
```
