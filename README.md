# Mafioso

Hybrid AI player for [Ultimafia](https://github.com/UltiMafia/Ultimafia) (dev only).

A deterministic **rules engine** owns roles, phases, votes, night actions, claims, and win-facing legality. An optional **LLM layer** (chat + deduction) proposes actions; the engine **validates every action** before anything can be sent. If the model fails or proposes something illegal, the bot falls back to the rules policy.

**Guardrails:** targets `dev.ultimafia.gg` or `http://127.0.0.1:3000` only. No prod, no public lobbies by default. Credentials stay in env vars (`MAFIOSO_LIVE=1`).

## Layout

```
engine/     Pure state + rules (no network). Offline tests.
harness/    Dev API client + stream replay. Injectable fetch + LLM.
protocol-map.md   Client/server events learned from Ultimafia + prior bots
prior-bots.md     Notes on UM-Autobot-Player and claude-um-bot-1
```

## How it works

```
  Dev API SSE stream ──▶ harness replay/reduce ──▶ engine View
                                                      │
                         ┌────────────────────────────┤
                         ▼                            ▼
                   llmDecide(view)              decide(view)   # rules
                   (model backend / fake)       nightAct, claims, factions
                         │                            │
                         └──────── validateAction ────┘
                                      │
                         proposals only (send is opt-in + gated)
```

1. **Wire + reduce** — Dev API envelopes (or Autobot-style frames) update a pure `View`: players, meetings, votes, messages, role reveals, claims.
2. **Legal actions** — `legalVotes` / `validateAction` know what this account may vote or say right now.
3. **Rules decide** — day lynch and night picks prefer known enemies / non-allies; never allies on kills. Night roles use `data/night-actions.json`.
4. **LLM decide** — builds a briefing (status + LEGAL ACTIONS + quoted untrusted chat), calls an injected `complete({system,user})`, parses one JSON action, validates, retries once on rejection, else falls back to rules.
5. **Harness** — `runLoop` / `runLoopAsync` collect validated proposals from fixtures. Live send needs `MAFIOSO_LIVE=1` and a Developer API key; hosts outside the allowlist throw.

## Quick start (offline)

```bash
cd engine && npm test
cd ../harness && npm install && npm test
```

Node ≥ 18. No API keys required for tests (fake model + fixture SSE).

## Model backend

Pick one factory. Each returns `complete({system, user})` for `llmDecide` / `runLoopAsync`. Every reply is still parsed and passed through `validateAction`. Illegal actions and bad JSON fall back to rules `decide`.

They share `createOpenAICompatibleComplete` (`harness/src/openaiCompatible.js`): `POST {baseUrl}/chat/completions` with system + user messages, `stream: false`, and `response_format: { type: "json_object" }`. If the server rejects `response_format`, it retries once without that field. `temperature` / `max_tokens` are sent only when you pass finite numbers. This client is not the game API and does not use `DEV_HOSTS`.

| Backend | Factory | Base URL | Key | Model |
| --- | --- | --- | --- | --- |
| LM Studio (local Qwen) | `createLmStudioComplete` | `http://127.0.0.1:1234/v1` | `LM_API_KEY` (default `lm-studio`, any non-empty string) | `LM_STUDIO_MODEL` (empty = first id from `GET /v1/models`) |
| [Experiential Labs](https://platform.experientiallabs.ai/docs/openai-compatibility) | `createExperientialComplete` | `https://api.experientiallabs.ai/v1` | `EXPLABS_API_KEY` (`xpl_...`) | `EXPLABS_MODEL` (example `qwen3.8-27b`) |
| [OpenCode Go](https://opencode.ai/docs/go/) | `createOpenCodeGoComplete` | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` | `OPENCODE_MODEL` (examples `kimi-k2.6`, `mimo-v2.5`, `glm-5.1`) |

Optional base overrides: `LM_STUDIO_BASE_URL`, `EXPLABS_BASE_URL`, `OPENCODE_BASE_URL`. Placeholders only in `.env.example`. Do not commit keys.

```js
import { createLmStudioComplete, createExperientialComplete, createOpenCodeGoComplete, runLoopAsync } from "./harness/src/index.js";

// Local Qwen. Run this process on the same machine as LM Studio.
const complete = createLmStudioComplete();

// Hosted Qwen on Experiential Labs. Leave temperature unset unless that model accepts it.
// const complete = createExperientialComplete();

// OpenCode Go. Sends Authorization plus a stable x-opencode-session for this client.
// const complete = createOpenCodeGoComplete();

const { proposed } = await runLoopAsync(entries, { complete });
```

LM Studio only: `127.0.0.1:1234` is that PC’s loopback. A remote VPS does not see it unless you tunnel it. Smoke (live, not part of `npm test`):

```bash
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
export LM_STUDIO_MODEL=          # empty = first loaded model
export LM_API_KEY=lm-studio
cd harness && node scripts/lmstudio-smoke.mjs
```

OpenCode Go also sends `user-agent: mafioso/0.1`. Set `OPENCODE_SESSION` to pin the session id, or leave it unset and the factory generates one id and reuses it for every call on that client.

## Live play (not default)

Needs Vinman’s same-turn approval, a Developer-group Dev API key, and usually a VPS-local Ultimafia (`http://127.0.0.1:3000`) to avoid Cloudflare Access. Private **Testing** lobbies only. Never commit secrets.

## Status

| Piece | State |
| --- | --- |
| Engine (wire, reduce, legal, night, claims, factions) | Tested offline |
| LLM decide + rules fallback | Tested with fake model |
| Harness Dev API stub + SSE replay | Tested offline |
| Model backends (LM Studio, Experiential Labs, OpenCode Go) | Tested offline (fake fetch). Live keys stay in env |
| Live stream loop / token refresh / send | Not started (needs approval + key) |

## License

Private. Ultimafia / Autobot code referenced for learning only; this tree does not vendor those repos.
