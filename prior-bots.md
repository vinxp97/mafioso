# Prior bots (Vinman repos, 2026-09-04)

## Relationship
- `claude-um-bot-1` — earlier private LLM agent CLI (cookie + raw WS to ultimafia.com).
- `UM-Autobot-Player` — same lineage, evolved: local Qwen/LM Studio agent, claims/notes/night-act/setup-prompt, more tests and docs. **Use this as the code base of record.**
- Local `/workspace/claude-um-bot-backup` matches this family.

## Auth / transport (both)
- `connect.sid` cookie + `x-csrf` → REST + raw WebSocket (`event:type:payload`, not socket.io).
- Default host: **ultimafia.com** (prod). Daemon holds one WS; CLI talks HTTP to daemon.
- Join: fetch short-lived socket auth token, `auth` then `join`, or `join` directly.

## Autobot extras vs claude-um-bot-1
New/heavier: `claims.js`, `context.js`, `night-act.js`, `notes.js`, `setup-prompt.js`, `docs/AGENT_PLAYER.md`, LM Studio/Ollama docs, night-actions + role-interactions data, denser tests.

## Fit for Mafioso hybrid
Keep: `state.js` event fold, `wire.js`, legal-action validation in `agent.js`, briefing/`render.js`, mentions/claims/notes heuristics, `docs/UM_RULES.md`, tests.
Replace: cookie/prod socket with **Dev API** on `dev.ultimafia.gg` only (Bearer + SSE/`send`, Testing/private lobbies). Engine validates; LLM proposes.
Do not: seat on prod or public games without Vinman same-turn yes.
