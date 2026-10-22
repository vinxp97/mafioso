# Night 5: Sheriff gun fix + fresh seeds (10/20, ~06:00 AM ET, local only)

Branch `night5-gunfix-20261020`, cut from `night5-solo-flags-20261020` @ 0fd3858.

## The bug
The Sheriff's gun can vote again after it fired. `emitActions` resets `voteCount` for every gun action, and the
gun net sends outside `emitActions`, so a second gun vote (rules path after the gun net, or the reverse) can go
out before the server's echo closes the instant meeting. The server refuses it ("instant meeting already used").

## The fix: `config.gunOnce` (off by default)
`createBotTable(..., { gunOnce: "on" })` (selfplay `--gun-once on`). When the shot goes out (rules path, deferred
vote, or gun net) the seat's gun is marked used, and every later gun vote from that seat is dropped. With the flag
off nothing changes: the config has no `gunOnce` key, and `table.gunSends` is bookkeeping only.
Selfplay `--count-gun` writes `gun.jsonl` (gun sends per game) and changes nothing else (outputs byte-identical).

Regression test `harness/test/gunOnce.test.js` (3 tests): L6 with the Vote Kick kept, the Sheriff seat. Default:
2 gun votes, 1 illegal (kept as is). gunOnce: 1 gun vote (the first one), 0 illegal. Checked that it fails with
the guard disabled (test 2 fails, 1 and 3 pass).

## How often it happens
| sample | flag off | gunOnce on |
|---|---|---|
| fixtures replay L5-L10, seeds 1-5,7, Vote Kick dropped (default) | 0 re-votes / 30 shots | 0 |
| fixtures replay, Vote Kick kept | 6 re-votes / 36 shots, all illegal: L6 Sheriff, every seed | 0 (0 illegal) |
| unused live log 10/18 09:07 (g0907), both modes | 0 (no bot shot) | 0 |
| selfplay seeds 14-23 x 50 (500 games, 414 with a shot) | 1 game (s19 g34: rules then gun net), server sim calls it stale, not illegal | 0 |

Only that one selfplay game changes with gunOnce (same winner). voteKickGuard also stops the L6 case (it delays
the shot), but gunOnce is the direct fix and also covers the selfplay case.

## Fresh seeds 14-23 x 50 games (selfplay, all-bot)
Village win with Wilson 95% CI; paired delta vs base on the same deals (better/worse games); town ballots on scum
D1 / D2+; filler share of public lines; mafia counterclaims on asked Cop/Journalist answers; lynch on scum.

| config | Village win | paired vs base | ballots on scum D1 / D2+ | filler | counterclaims | lynch on scum | illegal | gun re-votes |
|---|---|---|---|---|---|---|---|---|
| base | 56.2% [51.8, 60.5] | - | 61.8 / 54.6% | 16.5% | 15/21 | 67.7% | 0 | 1 |
| voteHold | 56.8% [52.4, 61.1] | +0.6 [-3.7, +4.9] (62/59) | 60.7 / 61.3% | 14.7% | 16/23 | 72.5% | 0 | - |
| soloCounterclaim | 56.2% [51.8, 60.5] | 0 (identical games) | 61.8 / 54.6% | 16.5% | 15/21 | 67.7% | 0 | - |
| groundedSpeech | 59.2% [54.8, 63.4] | +3.0 [+0.1, +5.9] (35/20) | 64.8 / 55.2% | 0.1% | 15/21 | 70.5% | 0 | - |
| voteKickGuard | 56.2% [51.8, 60.5] | 0 (identical games) | 61.8 / 54.6% | 16.5% | 15/21 | 67.7% | 0 | - |
| gunOnce | 56.2% [51.8, 60.5] | 0 (1 game differs, same winner) | 61.9 / 54.6% | 16.6% | 15/21 | 67.7% | 0 | 0 |
| all four + gunOnce | 58.4% [54.0, 62.6] | +2.2 [-2.4, +6.8] (75/64) | 63.1 / 62.3% | 0.1% | 16/23 | 73.6% | 0 | 0 |

Base gun re-votes counted on a `--count-gun` copy of base (games and records byte-identical to base).
Pooled with seeds 4-13 (1000 games): base 58.2% [55.1, 61.2]; voteHold -0.8 [-3.8, +2.2]; groundedSpeech
+1.7 [-0.5, +3.9]; soloCounterclaim and voteKickGuard identical to base. Selfplay is nine bots, so
soloCounterclaim (bot mates exist) and voteKickGuard (no Vote Kick in the sim) can't move it.

## Single-bot replay on fresh seeds 14-23 (L5-L10)
| config | seat-runs | town ballots right D1 / D2+ / all | filler | counterclaims sent | gun re-votes | illegal |
|---|---|---|---|---|---|---|
| base | 540 | 69.0 / 58.9 / 64.6% | 67.9% | 10/30 | 0 | 0 |
| voteHold | 540 | 82.1 / 64.9 / 74.4% | 67.9% | 10/30 | 0 | 0 |
| soloCounterclaim | 540 | 69.0 / 58.9 / 64.6% | 67.2% | 30/30 | 0 | 0 |
| groundedSpeech | 540 | 68.3 / 59.1 / 64.3% | 0% | 10/30 | 0 | 0 |
| all four + gunOnce | 540 | 81.4 / 65.1 / 74.1% | 0% | 30/30 | 0 | 0 |

Earlier seeds 1-5,7: base 63.4%, voteHold 74.6%, counterclaims 6/18 -> 18/18, filler 68% -> 0%. New seeds give
the same picture. The counterclaim chances are still all in L8 (one game, new seeds only reshuffle the bot).

Unused live logs: one, `raw-logs/live-20261018/qwen-20261018-0907.log.err` (9 bots, 10/18 09:07 ET, never made a
fixture). Rebuilt to /tmp only (not committed) and replayed, seeds 1-5,7, 54 seat-runs per config: only 4
bot ballots (the log has 28 timed lines), base 4/4 right, voteHold 1/4; filler 0% everywhere; no counterclaim
chance, no bot shot, 0 illegal. Too thin to count for or against anything. No other live logs are on the box:
the Mac copies (live-20261019, openrouter-*-mac) are both already fixtures L9/L10.

## Verdict per flag
- **voteHold:** replay gain holds (63.4 -> 74.6% before, 64.6 -> 74.4% on new seeds; the gain is mostly D1).
  Selfplay: D2+ ballots up again (54.6 -> 61.3%), win rate flat (+0.6; pooled -0.8). Keep for solo live games.
- **soloCounterclaim:** holds on new seeds (10/30 -> 30/30) but it is still one game (L8). No new evidence.
- **groundedSpeech:** filler 68% -> 0% holds. Selfplay +3.0 [+0.1, +5.9] on the new seeds, +1.7 [-0.5, +3.9]
  pooled: not beyond noise overall.
- **voteKickGuard:** no new sample (no Vote Kick in the sim); fixtures as before.
- **gunOnce:** fixes the double gun vote everywhere it shows up; changes nothing else. Recommend on (could be default).
- **all + gunOnce:** +2.2 [-2.4, +6.8], 0 illegal.

## Tests and defaults
Engine 431/431, harness 308/308 (+3). Defaults byte-identical: 34 fixtures rebuild the same, state replay
1643/1415, solo-eval seed 7 unchanged, base selfplay seeds 14-23 identical with and without --count-gun.
