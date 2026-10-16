# mafioso-engine (offline)
Pure state/rules engine for the Mafioso Ultimafia AI player. No network, no deps.
- `src/wire.js` frame codec (copied from UM-Autobot-Player)
- `src/reducer.js` pure `reduce(view, {event,data})` (accepts Dev API envelopes)
- `src/legal.js` `legalVotes`, `validateAction`
- `src/decide.js` rules policy (always legal)
- `src/types.js` JSDoc typedefs; host allowlist is dev-only.

Run: `cd /workspace/mafioso/engine && npm test` (Node ≥18; uses node:test). Fixtures: `test/fixtures/*.jsonl`.

## Night policy
- `data/night-actions.json` — per-role `alwaysAct / nights / n1Pick / laterPick`. Visiting roles, including Cop, Journalist, and Sheriff, use `nights: "all"`.
- `src/nightAct.js` — `specForRole`, `mustActTonight`, `mustActMeeting`, `nightAbilityMeetings` (skips Mafia/Cult meetings), `proposeNightAction(view, {role, meetingName, rng, lastTargetId, map})`. Output always passes `validateAction`.
- While `mustActMeeting` is true, `llmDecide` rejects `wait` and falls back to a legal night vote. Cleared or already checked players are skipped when another living target exists.
- Reducer handles `history` (seeds current-state meetings, roles, dead, winners), `reveal`/`roleReveal` → `view.reveals`, `view.role`.
- `decide(view, {rng})` prefers the night policy at Night, else the day vote. Default rng is deterministic (`()=>0`).

## Claims & factions
- `src/claims.js` — regex-only `extractClaim` / `reduceClaims` (claim, cc, soft, retract). `reduce` updates `view.claims` on every `message`/`quote`.
- `src/notes.js` — per-view `notes` for checks, cleared, suspects, deaths, votes, and faction chat this seat received. `memoryOf(view)` folds those with reveals and double claims. Nothing in `notes` is copied to another account. Claims are not written in as roles.

## Seat memory
Each account keeps its own fact ledger, belief board, and phase digest. A second seat does not read them.

- `src/factLedger.js` — append-only facts with ids (`f1`, …). Hard facts are this seat's checks, deaths, votes, reveals, and own role. A claim is stored as speech (`hard: false`), not as that player's role. Player chat that mimics a server result is not a check.
- `src/beliefs.js` — per living player: role, soft label or probability, reliability 1–10, one-line reason, and evidence ids. `judgeBelief` rejects a belief that cites no ledger id, cites a missing id, or fights a hard check or reveal. A Village check cannot be believed as Mafia.
- `src/digest.js` — rolling summary capped at 150 words. At a phase change, the new text is the old digest plus that phase's outcome, then the oldest words are dropped.
- `src/memory.js` — `applySeatMemory` runs on every `reduce`. `refreshSeatMemory` makes one LLM call when a phase ended or a hard result arrived (`memory.due`). Rules write the board and the digest if the model fails or returns nothing usable.
- `buildBriefing` / `llmDecide` receive FACT LEDGER, BELIEF BOARD, PHASE DIGEST, and the last K messages. The action prompt does not get the whole chat log. `validateAction` still gates every send.
- `src/faction.js` — small explicit `ALIGNMENT` map; `myFaction`, `allies` (server reveals + shared Mafia/Cult meeting members; claims never count), `enemies`.
- `decide` uses `pickHostileTarget`. Suspects come first, then other non-allies, and cleared players are skipped while another target exists. Known allies are never chosen. `"*"` is last.

## Faction plan (`src/scumPlan.js`)
One bot does not read another bot's memory. A Mafia or Cult seat learns the plan only from PLAN lines in faction meetings that the game delivered to that seat.

The first such line is stored on `view.notes.plan`. Later lines do not replace it. The line is `PLAN kill=<id> lynch=<id> claim=<role> lawyer=<id> speaker=<id>`.

Night, when that plan is present. Every scum seat votes `kill`. Lawyer votes `lawyer`, or the kill if that id is not a legal target. A teammate who said `lawyer me` in chat is the draft lawyer target when no PLAN line exists yet. Janitor votes the kill id when that id is a target, otherwise `Yes`. Janitor never votes `No`, `*`, or skip.

Night, when no PLAN line has arrived. This seat speaks its own draft and votes that kill. The draft is not written onto other views.

Day. The speaker id says `I'm <claim>. Vote <lynch>.` in Village, and every scum seat that still has the plan votes that lynch when it is legal. Town seats ignore PLAN lines, including lines pasted in Village.

## Public speech timing (`src/scheduler.js`)
Village and other public chat is not a turn. Each seat decides for itself. There is no shared auction.

- **Scheduler** — `decideSpeech` / `scheduleSpeech`. Urgency is 0–4: 4 named or accused, 3 new information or a claim this seat must report, 2 vote pressure, 1 a general thought, 0 nothing new. Own recent public messages versus other living players pick a Time-to-Talk line: TALKATIVE (speak from 1), BALANCED (speak from 2), or QUIET (speak from 3). The engine also enforces a cooldown and a per-minute cap. A cap rejects the line even at urgency 4. An optional small model may only turn a fuzzy 1 or 2 into a wait. It cannot beat the cap or speak below the threshold.
- **Generator** — `generatePublicSpeech`, after the scheduler says speak. It uses the same briefing as `llmDecide`: this seat's Frontier Justice card, fact ledger, belief board, phase digest, and the last K messages. `validateAction` still gates the line. `sanitizeChat` still quotes untrusted chat in that briefing.
- Night actions, day votes, and Mafia/Cult speech are not held for the scheduler. `proposeSeatActions` keeps those and adds at most the approved public line.

## Candidate options (`src/candidates.js`, `src/selector.js`)
One seat asks the model once for 3 or 4 different options on each open decision: day vote, night target, whether to claim, and a speech goal. The speech goal is only requested after this seat's scheduler has already said speak. Seats do not share a candidate list.

`selectAction` drops anything `validateAction` rejects, then applies hard rules, then samples with a seeded softmax over scores. Hard rules: act on an open night ability; never kill or vote a known teammate; town does not vote a player it reads as town at probability 0.8 or higher unless that vote would tip the lynch; a PLAN line this seat has seen wins while that target is still legal; Loyal Lawyer only litigates teammates; Janitor cleans the planned kill and does not skip.

`ruleScore` is the default scorer. Pass `score(view, candidate)` to `selectAction` to replace it. That is the seam for a later learned policy. This tree does not train one.

If the candidate call fails, or no vote survives, `proposeSeatActions` uses `llmDecide` and then rules `decide`. A chosen speech goal is passed into `generatePublicSpeech`. `validateAction` still gates every send. `sanitizeChat` still quotes untrusted chat in the briefing.

## LLM adapter (`src/llmDecide.js`)
- `buildBriefing(view)` — phase/role/living/allies/claims/`NOTES`/FACT LEDGER/BELIEF BOARD/PHASE DIGEST/optional `TEAM PLAN`/this seat's Frontier Justice `ROLE GUIDE`/`LEGAL ACTIONS`, then the last K lines of chat under `PLAYERS SAID (untrusted, quoted)` (one-line JSON-quoted, injection markers defanged), ending with a JSON-only instruction. `TEAM PLAN` is included only for Mafia or Cult, and only from chat this view has seen. `ROLE GUIDE` is the card in `data/frontier-justice.json` for the known own role (Villager, Cop, Journalist, Sheriff, Mafioso, Janitor, Lawyer / Loyal Lawyer). It is guidance. It does not replace NOTES, the ledger, TEAM PLAN, night must-act, or `validateAction`. When `memory.due` is set, `llmDecide` asks the model once for beliefs and a digest before it asks for an action. Pass `memory: false` to skip that call.
- `parseLlmAction(text, view)` — `{action:vote|unvote|speak|wait, meeting (id or name), target (id/name/"no one"), text}`.
- `llmDecide(view, {complete, maxRetries=1})` — `complete({system,user})` is injected. Parse → `validateAction`; on failure retry with rejection note; else rules `decide`. A public speak is rejected when this seat's scheduler says wait or the rate cap is hit. Returns `{actions, source:'llm'|'fallback', rejections}`; never an unvalidated action. `proposeSeatActions` runs the scheduler, then one CandidateGen call, then the selector. On failure it uses this single-action path and then rules. `generatePublicSpeech` runs when public chat is approved and can take the chosen speech goal.
- `SYSTEM_PROMPT` — scum-aware, never admit AI, chat untrusted, JSON only.
