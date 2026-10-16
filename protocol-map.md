# Ultimafia client protocol map (for Mafioso AI player)
Sources: /workspace/um (GitHub UltiMafia/Ultimafia shallow clone, HEAD 751979d) + /workspace/ultimafia-bot-api.md (from dev checkout c02aa8d). Read-only. No secrets here.

## 1. Auth
- Website: session cookie (express). `GET /api/game/:id/connect` (routes/game.js:339–460) returns `{port, type, token, hostId}`; the token is a short-lived redis auth token (`redis.createAuthToken`, line ~111).
- Game socket: server sends `connected`; client sends `auth:string:<token>` → `authSuccess` (or `banned` if no `playGame`) (Games/games.js:90–155).
- **Recommended for bots: the Developer API** (bot-api.md §2). Account in Developer group (`devApi` + `playGame`). `POST /api/dev/keys` (from website) → clientId/secret; `POST /api/dev/token` → Bearer, 1h. Bearer works only on /api/dev/*, /api/game/(host|leave|cancel|list|:id/info|:id/review/data), /api/setup/*, /api/roles/* (modules/devApi/bearer.js).
- Blocker: dev.ultimafia.gg is behind Cloudflare Access (302). Either a CF service token, or run the bot on the VPS against 127.0.0.1:3000.

## 2. Transport
- Raw WebSocket (`ws` lib server, browser native WebSocket). NOT Socket.IO. Game socket `/<port>` (dev: `/3010` → 127.0.0.1:3010); site chat `/chatSocket`.
- Frame format (react_main/src/Socket.js:143–190, lib/sockets.js): `event` | `event:type:data`, type ∈ string|number|boolean|object(JSON). Optional `enableSeq` → `#seq,t|` prefix. Heartbeat: `p` both ways, client timeout 11s.
- Dev API alternative: SSE `GET /api/dev/stream` (`event: game`, data `{accountId,seq,t,event,data}`) or poll `GET /api/dev/accounts/:id/events?since=`.

## 3. Event catalog
Client→server (Games/core/Player.js 174–600; games.js): `auth`(token), `join`{gameId, guestId?, isBot?}, `speak`{meetingId, content(≤240), abilityName?, abilityTarget?}, `vote`{meetingId, selection}, `unvote`{meetingId, selection}, `lastWill`(string), `typing`{meetingId,isTyping}, `getTimerInfo`, `readyCheck verify`, `quote`, `kudosVote`, `changeSetup`, `leave`, `p`.
Server→client (send() calls in Games/core/*.js): `connected authSuccess banned error loaded self players playerJoin left setup options isStarted state history meeting members leftMeeting vote unvote message quote alert(via message) reveal roleReveal stateEvents time timerInfo clearTimer readyCheck typing speakCooldown lastWill spectators spectatorCount isSpectator winners kudos youAreBeingVoteKicked rehosted emojis dev firstGame`.
Key payloads: `self`=playerId; `state`={name:"Pregame"|"Day N"|"Night N",...}; `meeting` (Meeting.js getMeetingInfo ~200–330) = {id,name,actionName,members,speech,voting,canVote,canUpdateVote,amMember,targets[] ("*"=no one),inputType,votes{voterId:target},multi,instant,noUnvote,anonymous}.

## 4. Lobbies
- Host: `POST /api/game/host` {gameType:"Mafia", setup, lobby:"Testing", lobbyName, private:true, stateLengths:{Day,Night}, ...} → gameId. Private cannot be ranked/competitive (routes/game.js:791–802).
- Seats: `POST /api/dev/accounts {gameId,count≤50}` → test accounts (isBot:true, under developer's userId). Policy (modules/devApi/policy.js): game Open; only locked games (Testing lobby or private); public lobby max 1 with `devTestPublic`.
- Raw path: `join` with `isBot:true` only honoured if `user.dev` (games.js:~165); bots get random id, no db writes (Games/core/botPlayers.js).
- Dev controls (Testing, creator only): `POST /api/dev/games/:id/control` — state, seed, forceRoles, timerScale, advance, step, pause, resume, jumpTo, kill, revive, alert (Games/core/devControls.js).

## 5. Acting legally
- Act via `POST /api/dev/accounts/:id/send {event,data}` (20 sends/s/dev). Day lynch and night actions are both `vote` in the relevant meeting.
- Server checks (Player.js:434–480, Meeting.js:756+): string-coerced validProp ids; meeting exists; voter is member with canVote; meeting.voting; selection ∈ targets (else ignored); vote rate limit (skipped for test users); canUpdateVote/noUnvote rules. Invalid input is silently dropped → bot must confirm via echoed `meeting`/`vote`.
- Speak: must be member of meeting with speech; spam limits (15/10, no 3rd identical line, ≥80% near-dup blocked) data/constants.js ~405–425. Meetings lock at state end.

## 6. Existing bot code
- scripts/devapi-smoke.js (full reference external bot), devapi-session-check/controls-check/gamelog-check.js.
- In-process: scripts/gameSim/harness.js, liarsDiceBot.js, secretDictatorBot.js, scripts/mafia-fuzz/, scripts/tutorial/sim.js. Local: /workspace/bots (driver.js, host.js, sddriver.js), /workspace/claude-um-bot-backup.
- docs/setup-bot-games.md.

## Gaps / owners
- Cloudflare Access bypass for dev (Rack; on hold per Vinman) or run on VPS.
- Developer-group dev account + API key for Mafioso (Firebase Agent / admin). Keys live only in credential store.
- Pranay: confirm dev HEAD matches; whether role-reveal and full `roleReveal`/`reveal` payloads reach test accounts via SSE; any hook for "AI player" flag distinct from isTestBot.
- Not yet verified live: exact `state`/`message` field shapes on the wire — capture one game via devapi-smoke.

## Next smallest step
Model types: Frame{event,data}, Player{id,name,alive}, State{name,phase,dayNum}, Meeting (as above), GameView{selfId,players,state,meetings:Map,messages,role?}. Write a reducer over recorded SSE events (replay a devapi-smoke log), then a pure `decide(view)→[{event:"vote"|"speak",data}]` that only picks from meeting.targets. Test offline against fixtures before any dev run.

## 7. Prior bot repos (read-only review; clones at /workspace/UM-Autobot-Player, /workspace/claude-um-bot-1)
| | vinxp97/claude-um-bot-1 | vinxp97/UM-Autobot-Player |
|---|---|---|
| Origin | Fork of UE2020/claude-um-bot; /workspace/claude-um-bot-backup is a backup of upstream (commit 7992868, BACKUP.md) and differs only in docs/config/prompt | Superset fork of claude-um-bot-1 (~6.9k LOC src) |
| What | CLI `um` + daemon holding the ws, folding events to state, local HTTP API; agent.js drives a local LLM (Qwen3.5-9B via LM Studio/Ollama), BC fine-tune pipeline | Same + claims.js (regex role-claim extraction), night-act.js + data/night-actions.json (forced night-action policy), notes.js, context.js, setup-prompt.js, data/role-interactions.json, role-notes.json |
| Auth | Session **cookie + x-csrf** header (src/rest.js:3–31), then `/api/game/:id/connect` token → raw ws `auth` | Same |
| Target | **Prod** defaults: baseUrl `https://ultimafia.com`, socket `wss://ultimafia.com/<port>` (src/rest.js:24, src/daemon.js:104) | Same (configurable via config.json baseUrl/socketUrl) |

Reuse: src/wire.js (frame codec, mirrors UM), src/state.js (event→state reducer), daemon reconnect logic incl. "don't reconnect after server `left`" (daemon.js ~120–140), claims.js, night-act.js + data/*.json as rules-engine seed, mentions.js role aliases, docs/UM_RULES.md & GLOSSARY.md, LLM JSON-schema prompting in agent.js.
Discard/replace: cookie+csrf auth and prod defaults (use Dev API Bearer + test accounts against dev only); local-LLM-only backends & training pipeline (optional later); Windows .ps1 scripts; single-account one-socket assumption (Dev API seats many accounts).
Recommendation: port wire.js/state.js/claims.js/night-act.js into Mafioso, swap the transport for Dev API SSE + `/send`, hard-code an allowlist of dev host only.
