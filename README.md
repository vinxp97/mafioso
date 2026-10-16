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

LM Studio serves OpenAI Chat Completions at `http://127.0.0.1:1234/v1` by default.

1. Load your Qwen GGUF in LM Studio and start the local server.
2. Point the harness at it (see `.env.example`):

```bash
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
export LM_STUDIO_MODEL=          # empty = first model from GET /v1/models
export LM_API_KEY=lm-studio      # LM Studio accepts any non-empty key
```

3. Pass the adapter’s `complete` into `runLoopAsync` (or the CLI once it lands). Every model reply still goes through `validateAction`.

The bot process must reach that host (same machine as LM Studio, or a tunnel). The box / VPS cannot see your PC’s localhost unless you expose it on purpose.

## Live play (not default)

Needs Vinman’s same-turn approval, a Developer-group Dev API key, and usually a VPS-local Ultimafia (`http://127.0.0.1:3000`) to avoid Cloudflare Access. Private **Testing** lobbies only. Never commit secrets.

## Status

| Piece | State |
| --- | --- |
| Engine (wire, reduce, legal, night, claims, factions) | Tested offline |
| LLM decide + rules fallback | Tested with fake model |
| Harness Dev API stub + SSE replay | Tested offline |
| LM Studio adapter | In progress |
| Live stream loop / token refresh / send | Not started (needs approval + key) |

## License

Private. Ultimafia / Autobot code referenced for learning only; this tree does not vendor those repos.
