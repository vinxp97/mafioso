# Defaults eval: the "recommended" preset vs all off (part 6, 10/21 ~5:20 AM ET). Local, stubbed model
- **Setup:** branch `defaults-eval-20261021`, preset `recommended` (every flag in (b); code defaults stay off).
  - Fresh seeds. Mixed table: 12001-12100 × 7 roles, team reveal on. Sheriff and Lawyer were extended to 200 seeds
    (12001-12200) because their 100-seed results looked bad.
  - Self-play: seeds 51-54 × 50 = 200 games per config, `--sim-latency live1018`.
- **Self-play columns:** "rec" leaves voteHold off (all-bot rule). "rec+VH" adds voteHold, on the same seeds.
- **Paired Δ:** in points or per 100 games, with the 95% interval. Errors 0 in every run.

| metric | all off | recommended | paired Δ [95%] | earlier evidence (parts 2–5) | worse? |
|---|---|---|---|---|---|
| Self-play village win | 51.0% | rec 57.0%, rec+VH **67.5%** | rec +6.0 [−0.9, +12.9]; rec+VH **+16.5 [+8.4, +24.6]** | p2 allPass +4.0 [−4.1, +12.1] | no |
| Mixed bot win: Sheriff (200) | 54.0% | 51.0% | −3.0 [−10.6, +4.6] | p4 lateGrace +1, allGrace +4; p5 n6→n6Wide −2.0 | watch (first 100: −10) |
| Mixed bot win: Cop / Journalist / Villager | 42 / 44 / 55 | 49 / 48 / 52 | +7.0 [−1, +15] / +4.0 [−4.3, +12.3] / −3.0 [−11.6, +5.6] | p3/p5: noise | no |
| Mixed bot win: Mafioso / Janitor | 70 / 73 | 69 / 74 | −1.0 [−3, +1] / +1.0 [−2.4, +4.4] | p5: 0 | no |
| Mixed bot win: Lawyer (200) | 77.5% | 75.0% | **−2.5 [−4.7, −0.3]** (5 games lost, 0 gained) | p3/p5: 0, noise | **yes, small** |
| Sheriff shots on scum / town (mixed, 200) | 147 / 43 of 190 | 164 / 25 of 189 | town −9.0 [−14.6, −3.4]; scum +8.5 [+2.8, +14.2] | p4 lateGrace town −11 [−17.8, −4.2] | no |
| Sheriff deadline-forced shots, median shot time | 2, 135 s | 21, 175 s | | p4: 1→14 (per 100), 135→170 s | same cost |
| Sheriff shots on scum / town (self-play, 9 bots) | 120 / 45 | rec 110 / 50; rec+VH 95 / 46 | | not measured before | mild (−4 pts accuracy) |
| Correct town ballots (self-play) | 58.7% | rec 62.8%, rec+VH 72.2% | | p2 allPass 72.8% (with voteHold) | no (gap is voteHold) |
| Correct town ballots (mixed: Sheriff / Cop / Journ. / Villager) | 54.5 / 79.4 / 66.5 / 73.4% | 64.5 / 82.7 / 72.8 / 69.2% | Villager: 182 correct both; 248→263 ballots | | no |
| Filler (self-play / mixed bot) | 11.6% / 0.6–6.9% | 0.1% / 0.0% | | p2: 12.3%→0% | no |
| Pass-through (self-play): stale replies, rejected lines, public lines | 433, 4296, 6190 | rec 138, 3486, 6474; rec+VH 55, 3447, 6191 | | p2 allPass 477→47, 4969→3929 | no (gap is voteHold) |
| Double mafia power claims (self-play games) | 43 | rec 8 (rec minus the part 4–5 flags: 40); rec+VH 5 | | p4 teamCop 37%→0%; p5 16%→0% | no |
| Double claims (mixed scum games) | 3 | 3 | | | no |
| Illegal actions / chat drops | 0 / 0–2 | 0 / 0 | | 0 | no |

- **Interactions:**
  - **Lawyer −2.5 [−4.7, −0.3] is the only significant loss.** Every earlier part had Lawyer at 0.
  - Sheriff −3 is noise at 200 seeds (−10 on the first 100, +4 on the next 100). It goes against part 4's +1/+4
    even though town shots fall 43 → 25. Watch it in the dev game.
  - In nine-bot self-play the part 4–5 flags cost the Sheriff a little: 5 more town shots than without them. That
    was never measured before.
- **New evidence on voteHold:** on these seeds, voteHold on an all-bot table is worth +16.5 [+8.4, +24.6] vs off,
  and +10.5 vs rec without it. That contradicts the −2.2 (noise) behind "off for all-bot".
  - Suggest voteHold on everywhere. It needs your yes.

## How to rerun
- Preset: `harness/src/presets.js` (`presetFlags("recommended", { solo })`). The mixed table config is
  `recommended`, and self-play takes `--preset recommended`, plus `--preset-solo` to add voteHold.
- Mixed: `node scripts/mixed-table.mjs --roles=<R> --seeds=12001-12100 --configs=base,recommended --team-reveal=on --out=<dir>`.
- Self-play: `node scripts/selfplay.mjs --games 50 --seed 51..54 --sim-latency live1018 [--preset recommended [--preset-solo]]`.
- New scorer field: `doubleDays` per scum game in mixedEval.js, summarized as `doubleClaimGames`.
- Artifacts (box only): /workspace/defaults-eval-runs/ (mt/, mt200/, sp/, table.py, table200.py, sptable.py, simsum.mjs).
