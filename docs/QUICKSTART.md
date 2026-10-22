# Quickstart

How to install Mafioso, run the tests, and start a private dev game. The [README](../README.md) explains the engine and the harness. This page is the operator notes.

The [Frontier Justice](https://ultimafia.com/learn/setup/1T55KrrbY) link is the public setup page. The client does not fetch it. A live process talks only to the Dev API hosts in `DEV_HOSTS`.

Node 18 or newer. The Docker image is Node 22. Tests use `node:test` and a fake model. They do not need API keys.

## Install and test

```bash
cd engine && npm test
cd ../harness && npm install && npm test
```

`harness` must be installed once so `mafioso-engine` resolves. `engine` has no dependencies.

## Fixtures and replays

- Engine fixtures: `engine/test/fixtures/` (`*.jsonl`, `claims.json`, `real-alerts.json`).
- Protocol replays: `harness/test/fixtures/replays/` (`g01`–`g16` plus `manifest.json`). Ids and names in those fixtures are replacements, not the raw logs.
- Live-shaped fixtures: `harness/test/fixtures/live-1018/`.
- A sample SSE body: `harness/test/fixtures/stream.sse`.
- Rebuild fixtures from a live log (offline): `node scripts/build-replays.mjs <out-dir> <log>...` from `harness/`. The builder replaces ids and names and throws if a raw id or name remains.

## Self-play and arena

Both stay on this machine. They do not open a socket and do not call Ultimafia.

```bash
cd harness
npm run selfplay -- --games 50 --seed 1
npm run arena -- --games 4 --seed 1 --mafioso 3 --summary
node scripts/arena.mjs --summary --file ../logs/replays/arena-1.jsonl
```

Self-play writes `logs/selfplay/selfplay-seed<seed>-n<games>...` as `.json`, `.md`, `.records.jsonl`, and `.games.jsonl`. The arena writes `logs/replays/arena-<seed>.jsonl`. Those directories are gitignored apart from a `.gitkeep`. The process exits 1 when a self-play game records an illegal action or an error.

`harness/selfplay/NOTES.md` is a historical tuning note. It is not a fresh scorecard.

## Live dev run

From `harness/`:

```bash
node scripts/live.mjs
```

With `MAFIOSO_LIVE` unset, that prints a dry run and exits. A real session needs `MAFIOSO_LIVE=1`, a base URL on `DEV_HOSTS`, `DEV_API_CLIENT_ID`, `DEV_API_CLIENT_SECRET`, and `DEV_SETUP_ID` (or `GAME_ID`). Put those in `.env`. Do not commit it.

`DEV_HOSTS` is `https://dev.ultimafia.gg`, `http://127.0.0.1:3000`, and the Apple container host gateway listed in `engine/src/types.js`. Any other origin throws `HostNotAllowedError`. `hostGame` forces a private Testing lobby.

Local LM Studio smoke (talks to the model, not to Ultimafia):

```bash
cd harness && node scripts/lmstudio-smoke.mjs
```

## Environment variables

Secrets stay in the environment. `.env.example` lists placeholders. Copy it to `.env` locally. `.env` and `.env.*` are gitignored, except `.env.example`.

`MAFIOSO_LLM` selects the factory: `lmstudio` (default), `experiential`, `opencode`, or `openrouter`. Aliases `lm-studio`, `explabs`, `opencode-go` are accepted. Every backend returns `complete({system, user})`. The reply is still parsed and passed through `validateAction`.

They share `createOpenAICompatibleComplete`: `POST {baseUrl}/chat/completions`, `stream: false`, and `response_format: { type: "json_object" }`. If the server rejects `response_format`, the client retries once without it. `temperature` and `max_tokens` are sent only when you pass finite numbers. This client does not use `DEV_HOSTS`.

| Backend | Factory | Base URL default | Key variable | Model variable |
| --- | --- | --- | --- | --- |
| LM Studio | `createLmStudioComplete` | `http://127.0.0.1:1234/v1` | `LM_API_KEY` (default placeholder `lm-studio`) | `LM_STUDIO_MODEL` (empty discovers the first id) |
| Experiential Labs | `createExperientialComplete` | `https://api.experientiallabs.ai/v1` | `EXPLABS_API_KEY` | `EXPLABS_MODEL` |
| OpenCode Go | `createOpenCodeGoComplete` | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` | `OPENCODE_MODEL` |
| OpenRouter | `createOpenRouterComplete` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` (default `minimax/minimax-m3.1-flash`) |

`OPENROUTER_REASONING` defaults to `low`. Unset, empty, `on`, `true`, `1`, `yes`, or `enabled` sends `{ effort: "low", exclude: true }`. `off`, `none`, `0`, `false`, `no`, or `disabled` omits the field. `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` sets that effort, still with `exclude: true`, so chain-of-thought stays out of `message.content`. Speech still asks for `reasoning_effort: "none"`; when the OpenRouter `reasoning` object is present, that `none` is dropped. A model name matching `minimax` counts as a reasoning model, so public speech uses the 640-token budget (`SPEECH_TOKENS.reasoning` in `engine/src/llmDecide.js`). When reasoning is on and the caller does not pass `maxTokens`, this client sends `max_tokens: 1024`.

Optional base overrides: `LM_STUDIO_BASE_URL`, `EXPLABS_BASE_URL`, `OPENCODE_BASE_URL`, `OPENROUTER_BASE_URL`. OpenCode Go also reads `OPENCODE_SESSION` and sends `user-agent: mafioso/0.1`. OpenRouter sends `HTTP-Referer` and `X-Title` only when `OPENROUTER_HTTP_REFERER` and `OPENROUTER_TITLE` are set. `EXPLABS_ZDR=1` adds `provider.zdr` on that backend.

Names only. Defaults in parentheses come from the code.

**Game connection**

`MAFIOSO_LIVE` (connect only when `1`), `DEV_API_BASE_URL`, `DEV_API_CLIENT_ID`, `DEV_API_CLIENT_SECRET`, `DEV_SETUP_ID`, `GAME_ID`, `BOT_COUNT` (`9`), `LOBBY_NAME` (`mafioso-bots`), `MAFIOSO_TRANSPORT` (`stream` or `poll`), `DEV_STREAM_PATH`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

**Model and prompts**

`MAFIOSO_LLM` (`lmstudio`), `MAFIOSO_LLM_CONCURRENCY`, `MAFIOSO_REASONING`, `MAFIOSO_EVOLVE` (off when `0`), `MAFIOSO_PROMPT_DIR`, `PROMPT_EPSILON` (`0.2`), `PROMPT_TEMPERATURE` (`0.5`), `MAFIOSO_ARENA_GAMES` (`0`), `MAFIOSO_ARENA_SEED` (`1`), `MAFIOSO_ARENA_MARGIN` (`0`).

**Seat strategy for one live process**

`MAFIOSO_TOWN` (`rules`, `suspicion`, or `random`), `MAFIOSO_HAMMER` (off when `0`, `off`, `false`, or `no`).

**Model backends**

`LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `LM_API_KEY`, `EXPLABS_BASE_URL`, `EXPLABS_MODEL`, `EXPLABS_API_KEY`, `EXPLABS_ZDR`, `OPENCODE_BASE_URL`, `OPENCODE_MODEL`, `OPENCODE_API_KEY`, `OPENCODE_SESSION`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_TITLE`, `OPENROUTER_REASONING` (`low`).

## CLI flags

`live.mjs` and `lmstudio-smoke.mjs` take no flags. They read the environment.

`arena.mjs`: `--games`, `--seed`, `--mafioso`, `--days`, `--file`, `--summary`, `--quiet`, `--live`, `--base`, `--lobby`, `--private`. `--live` checks the dev allowlist and a private Testing lobby, then refuses to open a socket.

`selfplay.mjs`: `--games`, `--seed`, `--days`, `--out`, `--quiet`, `--cop-rule` (`vinman` or `wait`), `--sheriff-rule` (`vinman` or `evidence`), `--lawyer` (`loyal` or `plain`), `--mafia` (`adaptive` or `script`), `--town` (`rules`, `suspicion`, or `random`), `--chat-audit` (`enforce` or `measure`), `--audit-tight` (`on` or `off`), `--stale-votes` (`clear` or `server`), `--hammer` (`on` or `off`), `--hammer-gate`, `--qt-filler`, `--qt-repair`, `--qt-keyfirst`, `--claim-pressure`, `--plant-audit`, `--sim-latency`, `--stale-recheck`, `--stale-cancel`, `--stale-fallback`.

Night 5–6 flags, all off by default. They are `createBotTable` options. `selfplay.mjs` is the CLI. `scripts/live.mjs` has no switch for them yet, so a live dev game that needs one still takes a small wiring change in the runner.

| Config key | CLI | What it does |
| --- | --- | --- |
| `voteHold` | `--vote-hold on` | A town ballot waits for a confident read, or 60% of the day |
| `soloCounterclaim` | `--solo-cc on` | A lone mafia bot counterclaims the Sheriff's asked Cop or Journalist, once |
| `groundedSpeech` | `--grounded-speech on` | Drops filler lines |
| `voteKickGuard` | `--kick-guard on` | Stops duplicate Vote Kick (gun) sends |
| (the four above) | `--solo-flags all` | Turns those four on together |
| `gunOnce` | `--gun-once on` | Marks the Sheriff's gun as used when the shot goes out |
| `chatPassthrough` | `--chat-pass on` | Loosens speech rules that blocked good lines, and adds guards for unsafe ones |
| `sheriffLateGrace` | `--late-grace on` | +30 s for an asked seat's late answer before the Sheriff shoots |
| `teamClaimGuard` | `--team-claim-guard on` | At most one fake power claim per mafia team |
| `wideClaimParse` | `--wide-claims on` | Parses "cop X guilty", "journalist lol, …" and "Journalist, nothing to report yet." as claims |

`mixed.teamReveal` is harness-eval only (`mixed-table.mjs --team-reveal=on`). It is on by default in `cc-scenarios.mjs` and off everywhere else. A mafia bot then learns its scripted teammates.

### `recommended` preset

`harness/src/presets.js` only names flags. Code defaults stay off. `recommended` turns on `soloCounterclaim`, `groundedSpeech`, `voteKickGuard`, `gunOnce`, `chatPassthrough`, `sheriffLateGrace`, `teamClaimGuard`, and `wideClaimParse`. `voteHold` is added for a single-bot table only.

```bash
cd harness
node scripts/selfplay.mjs --preset recommended
node scripts/selfplay.mjs --preset recommended --preset-solo
node scripts/mixed-table.mjs --configs=base,recommended
```

`--preset-solo` adds `voteHold` on self-play. Mixed-table config `recommended` adds `voteHold` on its own, because that table is one bot. Explicit flag CLIs add on top of the preset.

The numbers behind that preset are local self-play and mixed-table runs with a stubbed model and scripted seats (self-play seeds 51–54 × 50 = 200 games per config; mixed table seeds 12001–12100 × 7 roles, Sheriff and Lawyer extended to 12001–12200). They are simulated results, not games against human players. Self-play village win was 51.0% with every flag off, 57.0% on `recommended` (paired Δ +6.0 [−0.9, +12.9]), and 67.5% on `recommended` plus `voteHold` (paired Δ +16.5 [+8.4, +24.6]). The same runs are tabulated in the [README](../README.md).

### Eval scripts

Offline unless noted. Run them from `harness/`.

| Script | What it does |
| --- | --- |
| `node scripts/night5-eval.mjs <log...> [--json]` | Read-only score of a live log: speech success, rejects, timing, five claim checks |
| `node scripts/solo-eval.mjs` | One-seat counterfactual replay of the timed fixtures on the rules path |
| `node scripts/solo-flags-eval.mjs` | The same replay for each flag config |
| `node scripts/solo-flags-selfplay.mjs <runsDir>` | Summarize self-play runs per config, with Wilson CIs and paired differences |
| `node scripts/mixed-table.mjs --roles= --seeds= --configs=` | One bot and eight scripted human-like seats |
| `node scripts/cc-scenarios.mjs --cases=lone,team,teamCop` | Counterclaim scenarios |
| `node scripts/fixture-diff.mjs` | Per-event diff of two fixture builds |
| `node scripts/state-replay.mjs` | Replay fixtures through the state model |
| `node scripts/rescrub.mjs <src> <dst> [--raw=…]` | Re-scrub sanitized logs. Prints counts only |

`build-replays.mjs` takes an output directory and log paths. Optional, all off by default: `--timeline=log`, `--nick-variants`, `--alert-roles`, `--vote-order=log`. `audit-rejects.mjs` takes a fixture directory and optional `--json`, `--engine`. `sheriff-eval.mjs` takes one directory per arm. `stale-latency.mjs` takes log paths and optional `--json`, `--dist`.

## Docker

`Dockerfile` and `docker-compose.yml` run the live script.

- `docker compose up --build` builds the `bots` service. Compose defaults `MAFIOSO_LIVE` to `0`, so the container dry-runs until `.env` turns it on. LM Studio is reached at `host.docker.internal` from Docker Desktop.
- `docker compose up --build vps` is the host-network service (`profiles: ["vps"]`). Its default base URL is `http://127.0.0.1:3000`, for a Dev API already listening on that machine. The profile keeps a plain `up` from starting host networking.

The image copies `engine/` and `harness/`, installs production dependencies, and runs `node scripts/live.mjs`. Prompt history is mounted at `harness/data/prompts/runtime`. The image does not copy `.env`; Compose reads it via `env_file`.

`scripts/mac-container-run.sh` builds and runs the image with Apple's `container` CLI. It sets `DEV_API_BASE_URL` to the host gateway on `DEV_HOSTS`. `MAFIOSO_HOST_GATEWAY` overrides that address. The script reads `.env` and exits when `OPENROUTER_API_KEY` is empty. Do not commit `.env`.
