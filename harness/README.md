# mafioso-harness
Dev API client for the Mafioso AI player. Depends on `../engine` (file: dep).

- **Hosts:** only `https://dev.ultimafia.gg` and `http://127.0.0.1:3000` (from engine `DEV_HOSTS`). Anything else, including prod, throws `HostNotAllowedError`.
- **No built-in network:** `new DevApiClient({baseUrl, fetch})` requires an injected `fetch`.
- **Methods:** `getToken`, `me`, `hostGame` (forces `lobby:"Testing"`, `private:true`, `spectating:true`, refuses ranked/competitive), `leaveGame`, `createAccounts`, `leaveAccount`, `control`, `events`, `send({accountId,event,data,view})` (runs `validateAction` before HTTP when `view` is given).
- **Stream:** `parseStreamFrame`, `parseSse`, `replayStream` (per-account views, seq dedup), `runLoop` (reduce→decide→validate, collects proposals, never sends).
- **Live creds:** `liveCredentials()` reads `DEV_API_CLIENT_ID`/`DEV_API_CLIENT_SECRET` only when `MAFIOSO_LIVE=1`. Never commit or log them.

Run: `npm install && npm test`.

## LLM mode
`runLoopAsync(entries, {complete})` — uses engine `proposeSeatActions` (validated, rules fallback) when `complete` is given; otherwise same as `runLoop`. Public Village lines wait on that seat's scheduler. Votes and night actions do not. Never sends.

## Model backends

`createOpenAICompatibleComplete({ baseUrl, model, apiKey, headers, fetch, temperature, maxTokens, label, discoverModels })` → `async complete({system, user}) => string`. Not the game API. Does not read `process.env` and does not use `DEV_HOSTS`.

Request: `POST {baseUrl}/chat/completions` with `{model, messages:[{role:"system"},{role:"user"}], stream:false, response_format:{type:"json_object"}}`. `headers` are copied onto every request; a non-empty `apiKey` sets `Authorization: Bearer …` (and wins over a header of the same name). If the server returns a non-2xx whose body mentions `response_format` / `json_object` / `json_schema` (not 401/403/404), the client retries once without `response_format`. Non-2xx and a missing `choices[0].message.content` string throw (`<label> POST /chat/completions -> <status>: …`) with a short response snippet, not the request. Empty `model` calls `GET {baseUrl}/models` and caches `data[0].id` when `discoverModels` is true.

Thin factories resolve env, then call that client. Pass `env: {}` in tests. Explicit `baseUrl` / `model` / `apiKey` win over env.

| Factory | Env | Defaults |
| --- | --- | --- |
| `createLmStudioComplete` | `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `LM_API_KEY` | `http://127.0.0.1:1234/v1`, model `""` (discover), api key `lm-studio`. `apiKey: ""` omits Authorization. Same machine as LM Studio. |
| `createExperientialComplete` | `EXPLABS_BASE_URL`, `EXPLABS_MODEL`, `EXPLABS_API_KEY` | `https://api.experientiallabs.ai/v1`. Model and key are required (example model `qwen3.8-27b`, key looks like `xpl_...`). No model discovery. Docs: https://platform.experientiallabs.ai/docs/openai-compatibility |
| `createOpenCodeGoComplete` | `OPENCODE_BASE_URL`, `OPENCODE_MODEL`, `OPENCODE_API_KEY`, `OPENCODE_SESSION` | `https://opencode.ai/zen/go/v1`. Model and key are required (examples `kimi-k2.6`, `mimo-v2.5`, `glm-5.1`). Sends `user-agent: mafioso/0.1` and `x-opencode-session`. Session comes from `session` / `OPENCODE_SESSION`, else one `randomUUID()` reused for that client. Docs: https://opencode.ai/docs/go/ |

`temperature` and `maxTokens` are omitted unless you pass a finite number (`maxTokens` → `max_tokens`). Experiential Labs models sometimes reject sampling params; leave them unset there.

```bash
node scripts/lmstudio-smoke.mjs   # live local LM Studio only
```

```js
import { createLmStudioComplete, createExperientialComplete, createOpenCodeGoComplete, runLoopAsync } from "mafioso-harness";

const complete = createLmStudioComplete();       // or createExperientialComplete() / createOpenCodeGoComplete()
const { proposed } = await runLoopAsync(entries, { complete });
```

## Live multi-bot (`src/live.js`, `scripts/live.mjs`)

`MAFIOSO_LLM=lmstudio|experiential|opencode` picks the factory (`createBackendComplete`). Default `lmstudio`. `BOT_COUNT` defaults to 9 (integer 1..50).

`runLiveCli` with `MAFIOSO_LIVE` unset or not `1` logs a dry-run line and returns. It does not call fetch. With `MAFIOSO_LIVE=1` it reads `DEV_API_CLIENT_ID` / `DEV_API_CLIENT_SECRET`, refuses hosts outside `DEV_HOSTS`, then `getToken` → `hostGame` (private Testing only; `DEV_SETUP_ID` required; `spectating: true`) or joins `GAME_ID` → `createAccounts({count: BOT_COUNT})` → `leaveGame` when this process hosted (400/404/409 means the host was already unseated) → SSE `GET /api/dev/stream` (or `MAFIOSO_TRANSPORT=poll`). One table maps `accountId` → view. Each account is reduced, decided, and `validateAction`'d on its own. Views are not merged. `send` runs only for actions that pass. A speak and a vote in the same meeting can both send. Repeated `seq` values are ignored. Token age past 55 minutes refreshes before the next stream connect. Dropped streams back off and reconnect. Logs are passed through `redact` for the credential and key env values.

`BOT_COUNT` is the number of seats to fill. Frontier Justice is 9. The host leaves after those accounts are seated so the count matches the setup. Leaving first empties the lobby and `POST /dev/accounts` returns 400.

VPS base URL: `http://127.0.0.1:3000`. Windows Compose reaches LM Studio at `http://host.docker.internal:1234/v1`. Optional Cloudflare Access headers (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) are added only to game fetches.

Gaps: the SSE path is the documented Dev API stream and is covered with a fake body. This environment cannot open the live socket (Cloudflare 1010). `createAccounts` / `hostGame` responses are accepted as a string id, `{id|gameId}`, or `{accounts:[{id}]}`. Poll mode stops when a page is empty. One `docker compose up` plays one game, scores it, evolves, and exits (`restart: "no"`).

## Prompt store (`src/prompts.js`)

Seed: `data/prompts/seed.json` (the engine `SYSTEM_PROMPT`). Runtime: `data/prompts/runtime/prompts.json`, gitignored.

Each record is `{id, text, createdAt, parentId, scores:{wins,losses,draws,byRole}, gamesPlayed, notes}`. `selectPrompts` draws with epsilon-greedy over win rate (unplayed prompts use 0.5). `finishGame` records outcomes from `winners.players` (self in the list wins; empty or null winners is a draw) and asks `complete` for one child per distinct prompt. The child is stored only when `validateEvolvedPrompt` still finds the never-admit-AI line and `"vote"|"unvote"|"speak"|"wait"`. A reply that admits being an AI, or that drops the JSON contract, is skipped and the parent stays.

Pass `scorePrompt` to `finishGame` to score the parent and the child on the same seeds. The child is stored only when `beatsBaseline` says its mean beats the parent by more than `max(margin, 1.96 * sqrt(se² + se²))`. Each comparison is appended to `store.history` (`baseline`, `candidate`, `diff`, `noise`, `accepted`). An accepted child also stores `scores.arena`. `MAFIOSO_ARENA_GAMES` on the live runner turns this gate on; `0` keeps the previous save-if-safe behavior.

## Arena (`src/arena.js`, `scripts/arena.mjs`)

Offline Frontier Justice. Nine seats: Villager ×3, Cop, Journalist, Sheriff, Mafioso, Janitor, Lawyer. `mafiosoSeats` of them use `proposeSeatActions` through the injected `complete` (tests use `createMockComplete`). The rest are RuleBot. Each seat has its own view. Mafia chat is delivered only to Mafia members. The runner does not call `fetch`.

`runArena({ mode: "live", baseUrl })` checks the dev allowlist, requires a private Testing lobby, and then refuses to open a socket. `https://ultimafia.gg` and any other non-dev host throw `HostNotAllowedError` before that.

```bash
cd harness
node scripts/arena.mjs --games 4 --seed 1 --mafioso 3 --summary
node scripts/arena.mjs --summary --file ../../logs/replays/arena-1.jsonl
```

One JSON object per game is written to `logs/replays/arena-<seed>.jsonl` (gitignored). `--summary` prints `summarizeMetrics` (Wilson intervals) for that file, or for the run it just played.

## Self-play (`src/selfplay.js`, `scripts/selfplay.mjs`)

Full Frontier Justice 9p games with no server, no network and no model. An in-process server deals FJ (reusing the arena's role list, seed mixing, plurality and win check), sends live-shaped frames (`state`, `meeting`, `vote`, `unvote`, `message`, `death`, `reveal`, `time`, `timerInfo`, `youAreBeingVoteKicked`) to the real harness table (`onGameEntry`, fast mode), and applies the table's proposals, immediate and deferred. So every seat runs the live path: `rulesSeatActions` -> `decide` (bus included) -> `shapeDayVotes`, scum faction chatter and PLAN, the Cop/Journalist claim rule, and `proposeSeatActions` (candidates -> selector, rules fallback). The model is `createOfflineComplete`. Candidate prompts get every legal target as an option, so the selector's scores choose. Speech prompts answer only when the engine already prescribes the line (the Sheriff-out aim, or the PLAN speaker's fake claim). Everything else throws, so the no-model rules line is used. Use `speech: "none"` to throw on every speech prompt.

The server follows the restartq rules. Meetings resolve by plurality (a tie means no one). A night ends once every meeting is ready, and a day once the Village is ready (everyone voted, no tie). When the timer runs out, a Vote Kick window opens, and anyone who never voted in a must-vote meeting is vegged at the end. Night order: Litigate flips the Cop result, then the mafia kill, then Clean Death (once; it hides the role and the Janitor learns it), then the Cop and Journalist reports. The Shoot Gun is instant, single use, reveals the shooter and is available every day. Votes on a player who dies are cleared and the meeting is re-sent. Each proposal is checked against server truth and against the engine's `validateAction` on the seat's own view, both when the table sends it and when the server applies it. One that fails at send time is an illegal action. One that was legal when sent but is overtaken before it lands (the phase ended, or its target or seat died in between) is counted as stale, not illegal. Time is a virtual clock, and randomness comes from one seeded rng per game, so the same seed always produces the same games.

```bash
cd harness
npm run selfplay -- --games 50 --seed 1          # writes ../logs/selfplay/selfplay-seed1-n50.{json,md,records.jsonl,games.jsonl}
```

The scorecard (JSON and markdown) has:

- win rate by alignment
- town ballots on scum vs an analytic random-voter baseline
- illegal actions
- game length
- lynch, Sheriff and Cop accuracy
- claims, buses, cleans and litigates
- mafia vote timing
- vegs by cause
- the existing `summarizeMetrics` block
- ranked weaknesses with evidence and an example game log

`records.jsonl` uses the `scoreGame` format, so `scripts/arena.mjs --summary --file` reads it. The command exits 1 if any game has an illegal action or an error. The seed 1, 50-game scorecard is checked in as the baseline. The jsonl files are gitignored. Town play is scored from public evidence by `engine/src/townReads.js`; see `selfplay/NOTES.md` for the before/after numbers per seed and the lessons from tuning it.
