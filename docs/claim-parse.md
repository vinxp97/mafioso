# Night 6 part 5: wide claim parse (offline, 10/21)

Branch `claim-parse-20261021` off `sheriff-late-cc-20261021` (6ff4b6a). Local only, with the model stubbed.

## Flag
`config.wideClaimParse: "on"` / `--wide-claims on`. It is off by default, so with it off nothing changes.

**New claim shapes.** They are added to `claimToken` / `claimedRoleIn(text, opts)` in `engine/src/chatStyle.js`:

| shape | example |
|---|---|
| power role, a name, a result | "cop bea guilty", "cop: bea inno" |
| any role word, then a filler word (lol/tbh/ngl/…), unless the rest addresses someone ("you", "where", "who", "claim", "pls") | "journalist lol, no reports to share" |
| any role word, a comma, then a no-result or first-person clause | "Journalist, nothing to report yet.", "Blue, nothing to report." |

**Negatives.** With the flag, these are never claims, in any shape (the old ones included):
- Hypotheticals: "if im cop", "if i were cop", "i could be cop".
- Reports about another role: "cop said bea is guilty", "the cop is lying", "cop flipped".
- Dead claimers: "cop is dead", "rip cop", "dead cop said …".
- Questions, for the new shapes: "cop?", "cop bea guilty?", "journalist, who did you check?".

**Call sites.** Every view-reading call site passes `claimOpts(view)`:
- the public record (`townReads`),
- the Sheriff's reply parse and its bare-word path,
- the Sheriff gate,
- the mafia counterclaim and claim options,
- `exposedTeam`, `nightAct`, and `chatAudit`'s Sheriff/claim lookups.

With the flag, the public record's claim-board fallback uses only the line's own extracted claim, and never a
negative. That way an "if im cop" line can't re-enter through the board.

The bot's own outgoing-line gates keep the default parse, because its wording is canonical.

## Parser metrics
The scripted lines are from 700 mixed-table games: seeds 10001–10100, all 7 roles, config n6. That gives 40,736
public scripted lines with their true claim role (`stats.spoken`). One defend template ("bro im town lol stop") is
re-labelled a town claim.

| set | parse | claims | TP | FN | FP | precision | recall |
|---|---|---|---|---|---|---|---|
| scripted, power roles | off | 829 | 676 | 153 | 0 | 1.000 | 0.815 |
| scripted, power roles | on | 829 | 829 | 0 | 0 | 1.000 | 1.000 |
| scripted, town (villager/blue) | off | 2081 | 1744 | 337 | 0 | 1.000 | 0.838 |
| scripted, town | on | 2081 | 1887 | 194 | 0 | 1.000 | 0.907 |
| hard set (28 negatives + 6 positives, written for the tests) | off | 6 | 0 | 6 | 2 | 0.00 | 0.00 |
| hard set | on | 6 | 6 | 0 | 0 | 1.00 | 1.00 |

- **Power misses with the flag off:** "cop {X} inno/guilty" 130, "journalist lol, …" 14, "Journalist, nothing to
  report yet." 9.
- **Town misses left with the flag on:** "villager, look elsewhere" 102 and "just blue, nothing to show" 92. These are
  out of scope, not fixed.
- **Off-parse false positives on the hard set:** "if im cop ill tell you" and "even if im journalist …".
- **Scripted precision is 1.0 either way.** Scripted non-claim lines rarely contain role words, so the hard set is the
  real negative test. It is self-written: treat it as a regression check, not an unbiased precision estimate.
- **Independent check:**
  - The re-sanitized Night 5 live logs give 134 chat lines, with 0 changes between off and on.
  - The engine/harness fixtures give 1,079 distinct lines, with 1 change ("Villager, no info. …" becomes villager,
    which is correct).

## Game metrics (fresh seeds, n6 = every Night 6 flag: all + lateGrace + teamClaimGuard; n6Wide = n6 + wideClaimParse)

**Mixed table.** 100 seeds per role, 10001–10100, `--team-reveal=on`. The scum scorer uses the wide parse in both
configs.

| role | n6 bot win | n6Wide bot win | paired pts | illegal (both) | other |
|---|---|---|---|---|---|
| Sheriff | 56% | 54% | −2.0 [−4.8, +0.8] | 0 | shots scum/town 72/15 → 73/14; town shots −1/100 [−3, +1] |
| Cop | 54% | 54% | 0 | 0 | |
| Journalist | 47% | 47% | 0 [−2.8, +2.8] | 0 | |
| Villager | 41% | 39% | −2.0 [−5.9, +1.9] | 0 | |
| Mafioso | 70% | 70% | 0 | 0 | counterclaims 3/57 → 3/58 (asked 3/5 → 3/5) |
| Janitor | 71% | 71% | 0 | 0 | 3/40 → 3/39 (asked 2/3) |
| Lawyer | 73% | 73% | 0 | 0 | 2/47 → 2/46 (asked 2/3) |

**Counterclaim scenarios.** 100 seeds each, 11001–11100, with `--raw-answers`: the asked seat and the teamCop faker
speak in their own style, even when the default parse misses it.

| case | config | exactly one | zero | double | bot cc | Sheriff contested shots | bot win | paired |
|---|---|---|---|---|---|---|---|---|
| lone | n6 | 94% | 6% | 0% | 89 | 63 | 10% | |
| lone | n6Wide | 94% | 6% | 0% | 89 | 63 | 8% | −2 [−5, +1] |
| team | n6 | 95% | 5% | 0% | 91 | 63 | 54% | |
| team | n6Wide | 95% | 5% | 0% | 91 | 63 | 53% | −1 [−5, +3] |
| teamCop | n6 | 49% | 36% | 16% [10, 24] | 29 | 32 | 50% | |
| teamCop | n6Wide | 50% | 50% | 0% [0, 4] | 0 | 16 | 57% | +7 [+1, +13] |

Counterclaim timing is unchanged: 5–15 s after the answer, never in the same second.

**Main effect.** The team claim guard and the once-per-team counterclaim rule only see a teammate's claim the parser
reads. With the default parse, a teammate's terse "cop dot guilty" is invisible, so the bot still claims Cop or
counters (16% double claims). The wide parse closes that: 0% doubles, and bot win +7 [+1, +13].

Elsewhere the effect is within noise. Sheriff and Villager are −2: both CIs include 0.

## Reproduce
```
node harness/scripts/mixed-table.mjs --roles=Sheriff,Cop,Journalist,Villager,Mafioso,Janitor,Lawyer --seeds=10001-10100 --configs=n6,n6Wide --team-reveal=on --dump-spoken --out=<dir>
node harness/scripts/cc-scenarios.mjs --cases=lone,team,teamCop --seeds=11001-11100 --configs=n6,n6Wide --raw-answers --out=<dir>
node /workspace/claim-parse-runs/parse-pr.mjs <repo> <dir>/*-n6.spoken.jsonl   (box-only script)
```

## Risks
- The new shapes come from the script's own templates. Real human phrasing is wider: "cop here bea's guilty",
  "j, no report".
- The negatives are hand-written and likely incomplete.
- The filler and comma shapes accept any role word. "blue, vote bea" would read as a town claim, which is probably
  right but untested.
- Questions block only the new shapes. "im cop, who should i check?" stays a claim, on purpose.
- The scum scorers switched to the wide parse. Part 4 / part 3 numbers aren't directly comparable for the scum
  opportunity counts.
