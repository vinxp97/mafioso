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

`DEV_HOSTS` is `https://dev.ultimafia.gg` and `http://127.0.0.1:3000`. Any other origin throws `HostNotAllowedError`. `hostGame` forces a private Testing lobby.

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

Optional base overrides: `LM_STUDIO_BASE_URL`, `EXPLABS_BASE_URL`, `OPENCODE_BASE_URL`, `OPENROUTER_BASE_URL`. OpenCode Go also reads `OPENCODE_SESSION` and sends `user-agent: mafioso/0.1`. OpenRouter sends `HTTP-Referer` and `X-Title` only when `OPENROUTER_HTTP_REFERER` and `OPENROUTER_TITLE` are set. `EXPLABS_ZDR=1` adds `provider.zdr` on that backend.

Names only. Defaults in parentheses come from the code.

**Game connection**

`MAFIOSO_LIVE` (connect only when `1`), `DEV_API_BASE_URL`, `DEV_API_CLIENT_ID`, `DEV_API_CLIENT_SECRET`, `DEV_SETUP_ID`, `GAME_ID`, `BOT_COUNT` (`9`), `LOBBY_NAME` (`mafioso-bots`), `MAFIOSO_TRANSPORT` (`stream` or `poll`), `DEV_STREAM_PATH`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

**Model and prompts**

`MAFIOSO_LLM` (`lmstudio`), `MAFIOSO_LLM_CONCURRENCY`, `MAFIOSO_REASONING`, `MAFIOSO_EVOLVE` (off when `0`), `MAFIOSO_PROMPT_DIR`, `PROMPT_EPSILON` (`0.2`), `PROMPT_TEMPERATURE` (`0.5`), `MAFIOSO_ARENA_GAMES` (`0`), `MAFIOSO_ARENA_SEED` (`1`), `MAFIOSO_ARENA_MARGIN` (`0`).

**Seat strategy for one live process**

`MAFIOSO_TOWN` (`rules`, `suspicion`, or `random`), `MAFIOSO_HAMMER` (off when `0`, `off`, `false`, or `no`).

**Model backends**

`LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `LM_API_KEY`, `EXPLABS_BASE_URL`, `EXPLABS_MODEL`, `EXPLABS_API_KEY`, `EXPLABS_ZDR`, `OPENCODE_BASE_URL`, `OPENCODE_MODEL`, `OPENCODE_API_KEY`, `OPENCODE_SESSION`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_TITLE`.

## CLI flags

`live.mjs` and `lmstudio-smoke.mjs` take no flags. They read the environment.

`arena.mjs`: `--games`, `--seed`, `--mafioso`, `--days`, `--file`, `--summary`, `--quiet`, `--live`, `--base`, `--lobby`, `--private`. `--live` checks the dev allowlist and a private Testing lobby, then refuses to open a socket.

`selfplay.mjs`: `--games`, `--seed`, `--days`, `--out`, `--quiet`, `--cop-rule` (`vinman` or `wait`), `--sheriff-rule` (`vinman` or `evidence`), `--lawyer` (`loyal` or `plain`), `--mafia` (`adaptive` or `script`), `--town` (`rules`, `suspicion`, or `random`), `--chat-audit` (`enforce` or `measure`), `--audit-tight` (`on` or `off`), `--stale-votes` (`clear` or `server`), `--hammer` (`on` or `off`), `--hammer-gate`, `--qt-filler`, `--qt-repair`, `--qt-keyfirst`, `--claim-pressure`, `--plant-audit`, `--sim-latency`, `--stale-recheck`, `--stale-cancel`, `--stale-fallback`.

`build-replays.mjs` takes an output directory and log paths. `audit-rejects.mjs` takes a fixture directory and optional `--json`, `--engine`. `sheriff-eval.mjs` takes one directory per arm. `stale-latency.mjs` takes log paths and optional `--json`, `--dist`.

## Docker

`Dockerfile` and `docker-compose.yml` run the live script.

- `docker compose up --build` builds the `bots` service. Compose defaults `MAFIOSO_LIVE` to `0`, so the container dry-runs until `.env` turns it on. LM Studio is reached at `host.docker.internal` from Docker Desktop.
- `docker compose up --build vps` is the host-network service (`profiles: ["vps"]`). Its default base URL is `http://127.0.0.1:3000`, for a Dev API already listening on that machine. The profile keeps a plain `up` from starting host networking.

The image copies `engine/` and `harness/`, installs production dependencies, and runs `node scripts/live.mjs`. Prompt history is mounted at `harness/data/prompts/runtime`. The image does not copy `.env`; Compose reads it via `env_file`.

This repository has no Apple container config.
