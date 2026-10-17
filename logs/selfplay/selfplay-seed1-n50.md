# Self-play scorecard: 50 games, seed 1

Setup: Frontier Justice 9p (3 Villager, Cop, Journalist, Sheriff | Mafioso, Janitor, Lawyer)
Decision path: harness onGameEntry fast mode: rules -> decide (bus) -> shapeDayVotes; scum chatter; claim rule; candidates -> selector (offline enumerator, no model)

| Metric | Value |
|---|---|
| Village win rate | 56.0% (28) |
| Mafia win rate | 44.0% (22) |
| Draw / error | 0 / 0 |
| Town ballots on scum | 86.8% (400/461) |
| Random-vote baseline | 40.7% |
| Lift over random | 46.0 pts |
| Town abstains (no vote / no one) | 157 |
| Lynch accuracy | 76.9% (93/121), 40 no-lynch days |
| Illegal actions | 0 |
| Game length | mean 3.46 days (min 2, max 6); 2 3, 3 25, 4 19, 5 2, 6 1 |
| Sheriff shots | 25/39 hit scum (64.1% vs 42.9% random) |
| Cop checks | 131, 39 Guilty, 14 flipped by Lawyer; Guilty acted on same day 24/38 |
| Public claims | 252 (Sheriff->sheriff 39, Janitor->cop 45, Cop->cop 44, Mafioso->cop 47, Lawyer->cop 45, Journalist->journalist 32) |
| Mafia kills | 147 (Villager 70, Journalist 38, Cop 28, Sheriff 11) |
| Janitor cleans / Lawyer litigates (on teammate) | 50 / 116 (101) |
| Buses (scum voting scum) | 0 |
| Mafia kill votes moved after the first vote | 76 |
| Scum first Village vote | 79/161 (49.1% vs 32.6% random) |
| Faction chat lines / public lines | 523 / 420 |
| Lynches on the mafia PLAN target | 27/121 (random lynch would hit scum 32.9%) |
| Veg kicks | 0 (none) |
| Stale proposals (phase over) | 193 |
| Harness onError calls | 0 |

## Top weakness

**Cop guilties are not acted on** (severity 0.214)

14/38 Guilty results not lynched or shot that day; 14/131 Cop results flipped by the Lawyer

## All weaknesses, ranked

- Cop guilties are not acted on (severity 0.214 = shortfall 0.368 x coverage 0.58): 14/38 Guilty results not lynched or shot that day; 14/131 Cop results flipped by the Lawyer
- Mafia vote timing is a tell (severity 0.199 = shortfall 0.199 x coverage 1): scum cast the first Village vote on 79/161 days (49.1% vs 32.6% if order were random); mean vote position scum 0.49 vs town 0.51 (0 = first)
- Sheriff shoots town at about (or worse than) random (severity 0.07 = shortfall 0.09 x coverage 0.78): 14/39 shots hit town (Villager 14); accuracy 64.1% vs 42.9% random; shots by day Day 1 39
- Town lynches land on town far below random: the mafia vote bloc and fake-Cop claim pick the lynch (severity 0 = shortfall 0 x coverage 0.98): lynch accuracy 76.9% (93/121) vs 32.9% for a random lynch; 27/121 lynches hit the mafia PLAN's push target; on mislynches scum put 1.36 votes and town 1.79 on the lynched player; town spread over 1.14 targets a day; 27/97 lynch days with a scum fake claim ended in a mislynch; town ballots on scum 86.8% vs random 40.7%; 40 no-lynch days
- Town ballots barely beat a random voter (severity 0 = shortfall 0 x coverage 1): 400/461 final town ballots on scum (86.8%) vs random 40.7%; lift 46.0 pts

## Existing metrics (summarizeMetrics)

```json
{
  "games": 50,
  "winRate": {
    "byAlignment": {
      "Village": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      },
      "Mafia": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      }
    },
    "byRole": {
      "Mafioso": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      },
      "Villager": {
        "successes": 84,
        "trials": 150,
        "rate": 0.56,
        "low": 0.48004707281221837,
        "high": 0.6369563904902955
      },
      "Sheriff": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      },
      "Journalist": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      },
      "Janitor": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      },
      "Lawyer": {
        "successes": 22,
        "trials": 50,
        "rate": 0.44,
        "low": 0.3116198721023535,
        "high": 0.5769421319985648
      },
      "Cop": {
        "successes": 28,
        "trials": 50,
        "rate": 0.56,
        "low": 0.4230578680014353,
        "high": 0.6883801278976466
      }
    }
  },
  "mislynchRate": {
    "successes": 28,
    "trials": 121,
    "rate": 0.23140495867768596,
    "low": 0.1652303183259919,
    "high": 0.3141099016006992
  },
  "townVoteAccuracy": {
    "successes": 400,
    "trials": 461,
    "rate": 0.8676789587852495,
    "low": 0.8336875088401564,
    "high": 0.8955931751605871
  },
  "nightActionUsage": {
    "successes": 775,
    "trials": 790,
    "rate": 0.9810126582278481,
    "low": 0.9689095248940045,
    "high": 0.9884603080802312
  },
  "checkUsefulness": {
    "cop": {
      "successes": 39,
      "trials": 131,
      "rate": 0.29770992366412213,
      "low": 0.22607925218167127,
      "high": 0.3808669721289272
    },
    "journalist": {
      "successes": 35,
      "trials": 143,
      "rate": 0.24475524475524477,
      "low": 0.18157189677413066,
      "high": 0.3212937761686867
    }
  },
  "killPriorityAdherence": {
    "successes": 32,
    "trials": 147,
    "rate": 0.21768707482993196,
    "low": 0.15862862420913557,
    "high": 0.2911252898304928
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
    "candidate": 78,
    "llm": 0,
    "rules": 2576,
    "rate": 0.9706103993971364,
    "successes": 2576,
    "trials": 2654,
    "low": 0.9634731380603779,
    "high": 0.9763872358610778
  },
  "messageRate": {
    "mean": 0.43388888888888916,
    "low": 0.3839697047632366,
    "high": 0.4838080730145417,
    "n": 450
  },
  "speechAllowed": 420
}
```
