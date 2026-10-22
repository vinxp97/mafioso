# Night 5: g05, g14 and g16 rebuilt with the current fixture builder

Branch `night5-fixtures-20261020`, cut from `night5-claims-20261020` @ `0cbb98f`. Local only.

The Night 4 notes flagged that the committed g05, g14 and g16 differ from what the current builder rebuilds out of
the same logs. This is the per-event account of why, and whose fault each difference is.

## How it was checked

1. All 16 replay logs rebuilt together (the scrubber learns every real name across them), with the builder at
   `0cbb98f`, default options: 13 fixtures are byte-identical to the committed ones; g05, g14 and g16 are not.
2. Rebuilt again with `--alert-roles --vote-order=log` (Night 4) and `--nick-variants` (new, below): still only
   g05, g14 and g16 change. Those three are now committed from that build (`buildOptions` in the manifest).
3. Each old/new pair compared with `scripts/fixture-diff.mjs` (multiset of events with the build counters `t`, `seq`,
   message ids and times dropped). A **content** row is a payload only one side has; a **delivery** row is a payload
   both sides have, sent to a different set of seats (a seat that dies earlier gets fewer frames).
4. Every fixture replayed through the state model (`scripts/state-replay.mjs`) before and after.
5. Defaults: with the new option off, the builder's output for all 25 fixtures (g01-g16 and L2-L10, `.rejects`
   sidecars included) is byte-identical to the `0cbb98f` builder's. `test/replayBuildDefaults.test.js` pins the
   default build of a synthetic log by sha256, taken from the `0cbb98f` builder before any change.

## Summary

| fixture | events old → new | differences | fault | refusals (state model) before → after |
|---|---|---|---|---|
| g05 | 1834 → 1830 | gun shot at its log position (gun line, "was shot", no exorcise); three hyphenated words no longer scrubbed to `x03`-`x05` | old fixture (both) | 6 → 6, all pinned guessed-phase gaps |
| g14 | 2785 → 2557 | gun shot at its log position, early in Day 1 (the shot Mafioso stops receiving 226 lines); seven lines' first-name variants of a dev handle now `player07` | old fixture (shot); **builder** (variants, also in the old fixture) | 2 → 2, the pinned server stale-vote bug |
| g16 | 1120 → 1123 | gun shot at its log position, after five ballots; the victim stops receiving four ballots | old fixture | 0 → 0 |

A default-options rebuild (no flags) would add 6 refusals: g14 Day 1 ×2 and g16 Day 1 ×3 "target is dead" (ballots
on the shot player sent after his death), and g16 ×1 "voter is dead" (the victim's own earlier ballot). That is the
Night 4 builder bug 2 (`--vote-order=log`), so the three are rebuilt with it on.

## Per fixture

### g05 (`live-pr9.log.err`, untagged log, guessed binding and phases)

- **Gun shot (old fixture fault).** The old builder fired the Sheriff's shot at the end of the day with the generic
  death frames: `obituaries "was found dead"` and `exorcised p06`. The log has the gun vote mid-day; the current
  builder places it there with the server's gun line (`:gun: Player09 pulls a gun and shoots at Player06!`, Gun.js),
  `obituaries "was shot"`, and no `exorcised` (Game.js broadcasts it only from `exorcisePlayer`: veg, leaving,
  and a few role abilities; the Mafia Gun item never calls it). After the shot, p06 no longer receives the day's last two lines,
  the vote-kick frame and the end-of-day `clearTimer`.
- **Hyphenated words (old fixture fault).** An older scrubber took any 9-12 character hyphenated word for an id:
  `scum-driven`, `non-player` and `flip-flopped` became `x03`, `x04`, `x05`. The current scrubber only does that for
  a raw id the log saw. No real text comes back: every id-shaped token in g05's chat is a placeholder, checked by
  `fixtureRebuild.test.js` for all of g01-g16. The real seat-id prefixes the very first g05 had (574b889) are not
  present in the old or the new fixture.
- **Kept gap.** The binding is guessed, so one line from the dead Journalist's account ("Dead Journalist here —")
  lands on p06 after p06 is shot. That's the guessed binding, not the shot: pinned in `fixtureRebuild.test.js`.
  The 6 state-model refusals (Day 1 → Night 3 → Day 4) are the pinned guessed-phase gaps, unchanged.

### g14 (`qwen-20261016-0435.log.err`)

- **Gun shot (old fixture fault).** The Sheriff (p08) shot the Mafioso (p03) after five Day 1 ballots, early in the
  day. The old fixture fired it after every ballot at the end of the day, so p03 kept receiving 226 chat lines and 2
  ballots as if alive. Rebuilt: ballots, gun line, death, then the rest of the day.
- **First-name variants (builder fault, `--nick-variants`).** Seven distinct lines (49 deliveries) addressed a dev
  by the plural or the "ck" spelling of a 3-letter first name. The nickname matcher only guesses at 5+ letters, so
  both slipped through, in the old fixture and in a default rebuild. With `--nick-variants` they map to the
  handle's placeholder (`player07`), like the bare first name already did. The words are not repeated here.
- **Server bug, pinned not fixed.** Two ballots on p03 were cast before the shot. The server's Meeting.js
  `generateTargets` kept them after p03 died, so the tally was p03 2, p06 2: a tie, nobody condemned (its Night 2
  meetings count 7 living). The builder, like the engine, clears ballots on the shot player and condemns p06, so
  the mafia's Night 2 kill votes on p06 hit a "dead" target: the 2 pinned refusals. `fixtureRebuild.test.js` pins
  the ballots, both tallies (`*` kept, `p06` cleared), the fixture's condemn and the two refusals.
- chatAudit on the rebuilt fixture: one more flag, `attacks-sheriff`. The Cop's "player08, why are you targeting
  me, you're sus." now lands after the Sheriff was revealed by his shot. That is the right call on the true order.

### g16 (`qwen-20261017-1101.log.err`)

- **Gun shot (old fixture fault).** The Sheriff (p02) shot p01 after five ballots, one of them p01's own. The old
  fixture fired at the end of the day with "was found dead", and p01 kept receiving four later ballots. Rebuilt with
  `--vote-order=log`: the five ballots, the gun, the death, then the four later ballots to the living only. The
  replay refuses nothing, before or after. `replayOutcomes.test.js` still matches the live server record.

## The new option

`--nick-variants` (`nickVariants`, off by default, `BUILD_DEFAULTS.nickVariants === false`): a word that is a short
(3-4 letter) first-name part plus "s", or its "ck" spelling, is scrubbed like the name. Longer parts were already
covered by the run-on and one-edit rules. On the real logs it changes g14 only (7 lines); on L2-L10 and the other 15
replays it changes nothing. Ordinary words stay ("stock", "lock", "toss", "tokens", "talks" in the synthetic test).

## Not done

- The rebuild also writes `g15.rejects.jsonl` and `g16.rejects.jsonl` sidecars. They are left out: the replays dir
  has never carried sidecars, and `protocol-doc.test.js` and `chatAudit.test.js` read every `*.jsonl` there.
- The old g14 (in git history: 574b889, c72e414) still holds the first-name variants. Rewriting history isn't
  part of this.

## Old vs new, per event (`scripts/fixture-diff.mjs --md`; first-name variants masked)

**old-g05.jsonl: 1834 events old, 1830 new; 81 of 1645 distinct shared events change order**

| kind | phase / event | n |
|---|---|---|
| content, old only | Night 3 · message from p08 · p06 has 2 votes with no case stated. That's a x03 pile, not  | 6 |
| content, old only | Day 4 · message from p06 · Journalist here, now dead. My only report was on a x04 (Gues | 8 |
| content, old only | Day 4 · message from p02 · Three Cop claims: p06, p05, p04 - and p06 x05 to Journalist. | 8 |
| content, old only | Day 4 · exorcised "p06" | 8 |
| content, old only | Day 4 · obituaries p06 was found dead | 8 |
| content, new only | Night 3 · message from p08 · p06 has 2 votes with no case stated. That's a scum-driven pi | 6 |
| content, new only | Day 4 · message from p06 · Journalist here, now dead. My only report was on a non-playe | 8 |
| content, new only | Day 4 · message from p02 · Three Cop claims: p06, p05, p04 - and p06 flip-flopped to Jo | 8 |
| content, new only | Day 4 · message from server · :gun: Player09 pulls a gun and shoots at Player06! | 8 |
| content, new only | Day 4 · obituaries p06 was shot | 8 |
| delivery, old only | Night 1 · clearTimer to acc06 | 1 |
| delivery, old only | Day 4 · message to acc06 | 2 |
| delivery, old only | Day 4 · youAreBeingVoteKicked to acc06 | 1 |

**old-g14.jsonl: 2785 events old, 2557 new; 1667 of 2366 distinct shared events change order**

| kind | phase / event | n |
|---|---|---|
| content, old only | Day 1 · message from p06 · player07 ‹variant›, shut up, i'm voting player04. | 8 |
| content, old only | Day 1 · message from p06 · player07 you're stalling ‹variant›, stop it | 8 |
| content, old only | Day 1 · message from p01 · shut up, ‹variant›, i don't need your help. | 8 |
| content, old only | Day 1 · message from p09 · ‹variant›, are you actually listening to anyone? | 8 |
| content, old only | Day 1 · message from p01 · ‹variant›, stop dodging questions and actually speak up | 8 |
| content, old only | Day 1 · message from p06 · ‹variant›, stop dodging and pick a name right now | 8 |
| content, old only | Day 1 · message from p09 · ‹variant›, pick a real suspect or i'm voting you | 8 |
| content, old only | Day 1 · obituaries p03 was found dead | 8 |
| content, new only | Day 1 · message from server · :gun: Player08 pulls a gun and shoots at Player03! | 8 |
| content, new only | Day 1 · obituaries p03 was shot | 8 |
| content, new only | Day 1 · message from p06 · player07 player07, shut up, i'm voting player04. | 7 |
| content, new only | Day 1 · message from p06 · player07 you're stalling player07, stop it | 7 |
| content, new only | Day 1 · message from p01 · shut up, player07, i don't need your help. | 7 |
| content, new only | Day 1 · message from p09 · player07, are you actually listening to anyone? | 7 |
| content, new only | Day 1 · message from p01 · player07, stop dodging questions and actually speak up | 7 |
| content, new only | Day 1 · message from p06 · player07, stop dodging and pick a name right now | 7 |
| content, new only | Day 1 · message from p09 · player07, pick a real suspect or i'm voting you | 7 |
| delivery, old only | Night 1 · clearTimer to acc05 | 1 |
| delivery, old only | Day 1 · message to acc05 | 226 |
| delivery, old only | Day 1 · vote to acc05 | 2 |

**old-g16.jsonl: 1120 events old, 1123 new; 51 of 940 distinct shared events change order**

| kind | phase / event | n |
|---|---|---|
| content, old only | Day 1 · obituaries p01 was found dead | 8 |
| content, new only | Day 1 · message from server · :gun: Player02 pulls a gun and shoots at Player01! | 8 |
| content, new only | Day 1 · obituaries p01 was shot | 8 |
| delivery, old only | Night 1 · clearTimer to acc02 | 1 |
| delivery, old only | Day 1 · vote to acc02 | 4 |

