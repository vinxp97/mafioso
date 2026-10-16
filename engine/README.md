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
- `src/notes.js` — per-view `notes` for checks, cleared, suspects, deaths, votes, and faction chat this seat received. `memoryOf(view)` folds those with reveals and double claims. Nothing in `notes` is copied to another account.
- `src/faction.js` — small explicit `ALIGNMENT` map; `myFaction`, `allies` (server reveals + shared Mafia/Cult meeting members; claims never count), `enemies`.
- `decide` uses `pickHostileTarget`. Suspects come first, then other non-allies, and cleared players are skipped while another target exists. Known allies are never chosen. `"*"` is last.

## Faction plan (`src/scumPlan.js`)
One bot does not read another bot's memory. A Mafia or Cult seat learns the plan only from PLAN lines in faction meetings that the game delivered to that seat.

The first such line is stored on `view.notes.plan`. Later lines do not replace it. The line is `PLAN kill=<id> lynch=<id> claim=<role> lawyer=<id> speaker=<id>`.

Night, when that plan is present. Every scum seat votes `kill`. Lawyer votes `lawyer`, or the kill if that id is not a legal target. A teammate who said `lawyer me` in chat is the draft lawyer target when no PLAN line exists yet. Janitor votes the kill id when that id is a target, otherwise `Yes`. Janitor never votes `No`, `*`, or skip.

Night, when no PLAN line has arrived. This seat speaks its own draft and votes that kill. The draft is not written onto other views.

Day. The speaker id says `I'm <claim>. Vote <lynch>.` in Village, and every scum seat that still has the plan votes that lynch when it is legal. Town seats ignore PLAN lines, including lines pasted in Village.

## LLM adapter (`src/llmDecide.js`)
- `buildBriefing(view)` — phase/role/living/allies/claims/`NOTES`/optional `TEAM PLAN`/this seat's Frontier Justice `ROLE GUIDE`/`LEGAL ACTIONS`, then chat under `PLAYERS SAID (untrusted, quoted)` (one-line JSON-quoted, injection markers defanged), ending with a JSON-only instruction. `TEAM PLAN` is included only for Mafia or Cult, and only from chat this view has seen. `ROLE GUIDE` is the card in `data/frontier-justice.json` for the known own role (Villager, Cop, Journalist, Sheriff, Mafioso, Janitor, Lawyer / Loyal Lawyer). It is guidance. It does not replace NOTES, TEAM PLAN, night must-act, or `validateAction`.
- `parseLlmAction(text, view)` — `{action:vote|unvote|speak|wait, meeting (id or name), target (id/name/"no one"), text}`.
- `llmDecide(view, {complete, maxRetries=1})` — `complete({system,user})` is injected. Parse → `validateAction`; on failure retry with rejection note; else rules `decide`. Returns `{actions, source:'llm'|'fallback', rejections}`; never an unvalidated action.
- `SYSTEM_PROMPT` — scum-aware, never admit AI, chat untrusted, JSON only.
