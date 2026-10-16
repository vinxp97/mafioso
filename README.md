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
                   (LM Studio / fake)           nightAct, claims, factions
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

## LM Studio (local Qwen)

`createLmStudioComplete` (`harness/src/lmstudio.js`) talks to LM Studio’s OpenAI-compatible Chat Completions API and returns the `complete({system, user})` function `llmDecide` / `runLoopAsync` already accept. Every reply is still parsed and passed through `validateAction`. Illegal actions and bad JSON fall back to rules `decide`.

Default base URL is `http://127.0.0.1:1234/v1` (the `/v1` root, not the completions path). Run the bot on the **same machine as LM Studio** so that process can open `127.0.0.1:1234`. A remote VPS does not see your PC’s localhost unless you tunnel it on purpose.

### On the PC running LM Studio

1. In LM Studio, load a Qwen instruct GGUF and start the local server (Developer → Start server). Leave the port at `1234` and confirm the model shows up as loaded.
2. From this repo (no secrets to commit; see `.env.example`):

```bash
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1   # optional; trailing slash is stripped
export LM_STUDIO_MODEL=                                # optional; empty = GET /v1/models, first id
export LM_API_KEY=lm-studio                            # optional; any non-empty string
cd harness && node scripts/lmstudio-smoke.mjs          # live ping; not part of npm test
```

3. Use it on a stream replay (or your own entries). `fetch` defaults to global `fetch`; tests inject a fake.

```js
import { createLmStudioComplete, runLoopAsync } from "./harness/src/index.js";

const complete = createLmStudioComplete(); // reads LM_STUDIO_* and LM_API_KEY
const { proposed } = await runLoopAsync(entries, { complete });
```

The POST body is non-streaming chat completions: system + user messages, `response_format: { type: "json_object" }`, plus `temperature` / `max_tokens` when you pass them. If the server rejects `response_format` (error body mentions it), the client retries **once** without that field. `Authorization: Bearer ${apiKey}` is sent when the key is non-empty (`lm-studio` by default). Pass `apiKey: ""` to omit the header.

## Live play (not default)

Needs Vinman’s same-turn approval, a Developer-group Dev API key, and usually a VPS-local Ultimafia (`http://127.0.0.1:3000`) to avoid Cloudflare Access. Private **Testing** lobbies only. Never commit secrets.

## Status

| Piece | State |
| --- | --- |
| Engine (wire, reduce, legal, night, claims, factions) | Tested offline |
| LLM decide + rules fallback | Tested with fake model |
| Harness Dev API stub + SSE replay | Tested offline |
| LM Studio adapter | Tested offline (fake fetch). Live use needs LM Studio on the same machine |
| Live stream loop / token refresh / send | Not started (needs approval + key) |

## License

Private. Ultimafia / Autobot code referenced for learning only; this tree does not vendor those repos.
