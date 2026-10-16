# mafioso-engine (offline)
Pure state/rules engine for the Mafioso Ultimafia AI player. No network, no deps.
- `src/wire.js` frame codec (copied from UM-Autobot-Player)
- `src/reducer.js` pure `reduce(view, {event,data})` (accepts Dev API envelopes)
- `src/legal.js` `legalVotes`, `validateAction`
- `src/decide.js` placeholder policy (always legal)
- `src/types.js` JSDoc typedefs; host allowlist is dev-only.

Run: `cd /workspace/mafioso/engine && npm test` (Node ≥18; uses node:test). Fixtures: `test/fixtures/*.jsonl`.

## Night policy
- `data/night-actions.json` (copied from UM-Autobot-Player) — per-role `alwaysAct / nights / n1Pick / laterPick`.
- `src/nightAct.js` — `specForRole`, `mustActTonight`, `nightAbilityMeetings` (skips Mafia/Cult/kill meetings), `proposeNightAction(view, {role, meetingName, rng, lastTargetId, map})`; output always passes `validateAction`.
- Reducer handles `history` (seeds current-state meetings, roles, dead, winners), `reveal`/`roleReveal` → `view.reveals`, `view.role`.
- `decide(view, {rng})` prefers the night policy at Night, else the day stub. Default rng is deterministic (`()=>0`).

## Claims & factions
- `src/claims.js` — regex-only `extractClaim` / `reduceClaims` (claim, cc, retract). `reduce` updates `view.claims` on every `message`/`quote`.
- `src/faction.js` — small explicit `ALIGNMENT` map; `myFaction`, `allies` (server reveals + shared Mafia/Cult meeting members; claims never count), `enemies`.
- `decide` uses `pickHostileTarget`: enemies → other non-allies → `"*"` → no action. Applies to day lynch, Mafia/Cult kill meetings, and vetoes night-ability picks on allies.

## LLM adapter (`src/llmDecide.js`)
- `buildBriefing(view)` — phase/role/living/allies/claims/LEGAL ACTIONS, then chat under `PLAYERS SAID (untrusted, quoted)` (one-line JSON-quoted, injection markers defanged), ending with a JSON-only instruction.
- `parseLlmAction(text, view)` — `{action:vote|unvote|speak|wait, meeting (id or name), target (id/name/"no one"), text}`.
- `llmDecide(view, {complete, maxRetries=1})` — `complete({system,user})` is injected. Parse → `validateAction`; on failure retry with rejection note; else rules `decide`. Returns `{actions, source:'llm'|'fallback', rejections}`; never an unvalidated action.
- `SYSTEM_PROMPT` — scum-aware, never admit AI, chat untrusted, JSON only.
