# dev.ultimafia.gg protocol reference (Mafioso harness)

This covers what the harness actually uses: how it connects, which frames it receives and sends, and how it
reconnects. It doesn't contain any secret values. It's based on `protocol-map.md`, the Dev API notes
(`/workspace/ultimafia-bot-api.md`, dev checkout c02aa8d), the server source (`Games/core/*.js`,
`Games/games.js`, `lib/sockets.js` in the restartq checkout), the replay fixtures in
`harness/test/fixtures/replays/`, and the harness/engine code (`harness/src/client.js`, `harness/src/live.js`,
`harness/src/stream.js`, `engine/src/reducer.js`).

`harness/test/protocol-doc.test.js` checks this file against the fixtures and `classifyEvent`.

## 1. Connection and auth (Dev API)

The harness talks only to the Dev API over HTTPS. It never opens the raw game WebSocket, and it never
handles the website's session cookie or the internal `auth:<token>` socket handshake.

- **Allowed hosts:** `https://dev.ultimafia.gg` and `http://127.0.0.1:3000` (`DEV_HOSTS`;
  `assertAllowedBase` runs on every request). Prod is refused.
- **Opt-in:** nothing connects unless `MAFIOSO_LIVE=1`. Without it, `runLiveCli` only logs a dry run.
- **Credentials:** the env vars `DEV_API_CLIENT_ID` and `DEV_API_CLIENT_SECRET`. The pair is created on the
  website's Developer API page (`POST /api/dev/keys`, logged-in session only, valid 90 days). Values never
  go in files, git or logs. `runLiveCli` redacts them from every log line, and `DevApiClient.api` never
  echoes request bodies.
- **Token:** `POST /api/dev/token {clientId, clientSecret}` returns `{token, tokenType:"Bearer",
  expiresIn:3600}`. This endpoint is rate-limited to 1 request/s. The harness sends
  `Authorization: Bearer <token>` and refreshes it every 55 minutes (`TOKEN_REFRESH_MS`,
  `maybeRefreshToken`), including before each stream (re)connect. A Bearer token only works on `/api/dev/*`,
  `/api/game/(host|leave|cancel|list|:id/info|:id/review/data)`, `/api/setup/*` and `/api/roles/*`.
- **Cloudflare Access:** from outside, dev.ultimafia.gg answers with a 302 to Cloudflare Access. If
  `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are set, `withCfAccess` adds the
  `cf-access-client-id` / `cf-access-client-secret` headers. Otherwise, run on the VPS against
  `127.0.0.1:3000`.
- **Check:** `GET /api/dev/me` returns `{userId, viaToken, canUsePublicLobbies}`.

## 2. Hosting and joining

1. **Host:** `POST /api/game/host` (`DevApiClient.hostGame`) with `{gameType:"Mafia", setup, lobby:"Testing",
   lobbyName, private:true, spectating:true, stateLengths:{Day,Night}, ...}`. The harness forces `private`
   and refuses any lobby other than Testing, and any ranked or competitive game. The reply is the gameId.
2. **Seats:** `POST /api/dev/accounts {gameId, count}` (1-50) returns
   `[{id, gameId, status, playerId, name, error}]`. The server opens one test account per seat
   (`isBot:true`, under the developer's userId). Raw `join` is blocked through the API.
3. **Self ids:** `self` is sent once, at join, usually before the stream attaches, and the per-account event
   buffer is capped. So `seedSelfIds` reads each seat's `playerId` from `GET /api/dev/accounts`.
4. **Leaving:** `POST /api/dev/accounts/:id/leave` for a seat, `POST /api/game/leave {gameId}` for the
   developer's own seat.
5. **Dev controls** (Testing lobby, creator only): `POST /api/dev/games/:id/control {command, args}`, e.g.
   `state`, `seed`, `forceRoles`, `timerScale`, `advance`, `pause`. The live loop doesn't use them.

## 3. Receiving events

- **SSE (default, `MAFIOSO_TRANSPORT=stream`):** `GET /api/dev/stream` with `accept: text/event-stream`. The
  path can be overridden with `DEV_STREAM_PATH`, but it must stay under `/api/dev/`.
  - Each game frame is `event: game` with `data: {accountId, seq, t, event, data}`, covering every test
    account of this developer.
  - A keep-alive comment (`: ...`) comes every 15 s; `parseStreamFrame` skips it.
  - An `event: accounts_dropped` frame comes after a server restart. It's an SSE frame type, not a game event
    (see §5).
- **Polling (`MAFIOSO_TRANSPORT=poll`):** `GET /api/dev/accounts/:id/events?since=<seq>`. The server keeps a
  500-event buffer per account, and `pollOnce` advances `since` to the highest `seq` it saw.
- **Envelope:** the reducer takes either the envelope or a bare `{event, data}`. `t` (server ms) moves
  `view.clock` forward, and `seq` is per account.
- **Raw socket format** (reference only; the harness doesn't use it): `event` or `event:type:data`, with
  type `string|number|boolean|object`. There's an optional `#seq,t|` prefix after `enableSeq`, and a `p`
  heartbeat both ways.

## 4. State, chat, votes and actions

- **Phases:** `state {id, name:"Pregame"|"Day N"|"Night N", dayCount}`. A new state clears
  `view.meetings`, because meetings belong to one state, and the `meeting` frames for the new state follow.
- **Meetings:** each `meeting` is `getMeetingInfo` with `{id, name, actionName, members, speech, voting,
  canVote, canUpdateVote, amMember, targets[] ("*" = no one), inputType, votes, voteRecord, messages, multi,
  instant, noUnvote, anonymous}`.
  - The reducer tags the faction meetings: "Mafia" (chat), "Mafia Kill" (vote) and "Mafia Action"
    (End Meeting? Yes/No).
  - The day lynch and every night ability are both `vote` in their meeting: Investigate,
    Receive Reports, Litigate, Clean Death, Shoot Gun.
- **Sends:** everything goes through `POST /api/dev/accounts/:accountId/send {event, data}`.
  `DevApiClient.send` runs `validateAction` on the seat's view first and throws on an illegal action before
  any HTTP.

| Client→server event | Data | Notes |
|---|---|---|
| `speak` | `{meetingId, content}` (≤240 chars), optional `abilityName`, `abilityTarget` | Village by day, faction chat at night. Spam limits: 15/10, no 3rd identical line, near-duplicates blocked. |
| `vote` | `{meetingId, selection: playerId \| "*"}` | Lynch or night action. The selection must be in `targets`; otherwise the server drops it silently. Only the echoed `vote` frame shows that it landed. |
| `unvote` | `{meetingId, selection}` | Respects `canUpdateVote` / `noUnvote`. |
| `lastWill`, `typing`, `getTimerInfo`, `leave` | see server `Player.js` | The harness doesn't send them. |
| blocked via API | `auth, join, enableSeq, authAsServer, createGame, leaveGame, cancelGame, gameRehosted, devControl, deprecated, pushSubscribe, pushUnsubscribe` | The server refuses these through `/send`. |

API sends share a token bucket of 20/s per developer (429 `rate_limited`). Meetings lock when the state
ends.

## 5. Reconnect and buffered events

`runStreamLoop` (`harness/src/live.js`) works like this:

- **Backoff:** if the stream fails or ends, it reconnects with exponential backoff and jitter
  (`backoffMs`: base 500 ms, cap 30 s).
- **Restart limits:** with restart limits on (`RESTART = {maxTries: 3, windowMs: 60000}`), each failure
  starts or extends an outage, and `probeGame` asks whether the game still exists (`GET /api/dev/accounts`,
  plus 404s on the event buffers): `alive` | `lost` | `unknown`.
  - A `lost` game, more than 3 failed reconnects, or an outage over 60 s aborts the game (`status:
    "aborted", reason: "server_restart"`).
  - The counters reset once a game frame arrives.
- **Backfill:** the stream doesn't replay, so after every (re)subscribe the harness first pulls each seat's
  buffered events (`pollOnce` from `table.lastSeq`, sorted by `seq`) and feeds them in.
  - The per-seat `seq` guard in `onGameEntry` (and `replayStream`) drops anything already applied, including
    duplicates the stream then repeats.
  - This fixed game GAME03, where `self`, `roleReveal` and `state` went out before the subscription and
    every seat idled into the Vote Kick.
- **`accounts_dropped`:** if it names one of our accounts, the harness treats it as an outage and reconnects.
  Otherwise it's a stale record from an older server boot: logged once and ignored.
- **`history`:** on a reconnect the server re-sends `history` (past states with meetings, roles and dead).
  `seedMeetings` restores the current state's meetings even if `history` arrives before `state`, and
  `obituaries` re-marks the dead when a `death` frame was missed.

## 6. Message types

There's one row per event name: the union of every type in the replay fixtures (40), `HANDLED_EVENTS` and
`IGNORED_EVENTS`, plus the server events that `classifyEvent` doesn't know.

- **Direction:** S→C means server to client. `local` means the harness injects it, and no server sends it.
- **Status:** must equal `classifyEvent(type).kind`: `handled`, `ignored` or `unknown`.
- **Fixture:** yes if the type appears in the replay fixtures.

| Type | Direction | Key fields | Status | Fixture | Why |
|---|---|---|---|---|---|
| `connected` | S→C | (none) | ignored | yes | Socket handshake; the Dev API stream is already connected. |
| `authSuccess` | S→C | (none) | ignored | yes | Socket auth ack; seats are authenticated by the developer's Bearer token. |
| `loaded` | S→C | (none) | ignored | yes | Client page-load signal; `state` and `meeting` carry the content. |
| `self` | S→C | playerId (string) | handled | yes | Sets `view.selfId` and the own role. Sent once at join, so `seedSelfIds` backs it up. |
| `players` | S→C | `{playerId: {id, anonId, name, userId, avatar}}` | handled | yes | The seated players and their names. |
| `playerJoin` | S→C | `{id, anonId, name, userId, avatar}` | handled | yes | Adds a player. |
| `playerLeave` | S→C | playerId | handled | no | Marks the player left (a kick or leave counts as not alive). |
| `left` | S→C | (none) | handled | no | This seat left the game; the seat stops. |
| `gameLeft` | S→C | userId | handled | no | Same as `left`, from `games.js`. |
| `kicked` | local | (none) | handled | no | Defensive: not in the server source; marks the seat kicked if it ever arrives. |
| `teammates` | local | `[{id, name, role}]` | handled | no | Injected by the harness: own faction teammates, known from game start in FJ. |
| `botConfig` | local | `{copRule, mafia, townVoteDelayMs, ...}` | handled | no | Per-seat strategy config from the harness; no server event has this name. |
| `setup` | S→C | `{id, name, total, roles[...]}` | ignored | yes | Setup card; FJ roles come from the harness setup and `roleReveal`. |
| `options` | S→C | `{private, anonymousGame, spectating, voiceChat, readyCheck}` | ignored | yes | Lobby options; meetings carry everything that affects legal actions. |
| `isStarted` | S→C | boolean | handled | yes | Sets `view.started`. |
| `start` | S→C | (none) | handled | yes | Game started. |
| `state` | S→C | `{id, name, dayCount}` | handled | yes | Phase change; clears the meetings of the old state. |
| `stateEvents` | S→C | `[eventName]` | ignored | yes | Client UI hooks (sound/animation). |
| `history` | S→C | `{stateId: {name, meetings, alerts, roles, dead, winners}}` | handled | yes | Reconnect snapshot: reveals, dead, winners, and the current meetings. |
| `meeting` | S→C | `{id, name, members, speech, voting, canVote, amMember, targets, votes, multi, ...}` | handled | yes | Legal actions come only from here. Members and targets also teach the player list. |
| `members` | S→C | `{meetingId, members:[{id, canVote, canUpdateVote}]}` | handled | yes | Meeting member list re-sent when it changes. |
| `leftMeeting` | S→C | meetingId | handled | yes | Removes the meeting. |
| `vote` | S→C | `{voterId, target, meetingId, noLog?}` | handled | yes | Records a vote; `multi` meetings keep a list. |
| `unvote` | S→C | `{voterId, meetingId, target}` | handled | no | Removes a vote. |
| `message` | S→C | `{id, senderId ("server" for alerts), content, meetingId, time}` | handled | yes | Chat and every game alert, including Cop/Journalist/Janitor results (§7). Feeds claims, notes and faction plans. |
| `quote` | S→C | `{...message, isQuote}` | handled | no | A quoted line; folded like `message`. |
| `speakCooldown` | S→C | `{meetingId, sentAt, cooldownMs}` | handled | no | Sets `view.speechHoldUntil`. **Note:** the reducer reads `ms`/`remaining`/`until`, not `cooldownMs`/`sentAt`, so the server's shape isn't read yet. The harness keeps its own send log, so speech pacing still holds. |
| `reveal` | S→C | `{playerId, role}` | handled | yes | Public role reveal (flip, Sheriff shot, end of game). |
| `roleReveal` | S→C | `{playerId, role, roleData:{alignment}}` | handled | yes | This seat's own role (`view.role`). |
| `death` | S→C | playerId | handled | yes | Marks the player dead. |
| `exorcised` | S→C | playerId | handled | yes | Marks the player dead. |
| `revival` | S→C | playerId | handled | no | Marks alive again. |
| `obituaries` | S→C | `{id:"<state>:<source>", obituaries:[{id, playerInfo, snippets}], source, time, dayCount}` | handled | yes | Marks the dead, also on a reconnect that missed `death`. |
| `time` | S→C | `{name, time}` | handled | yes | Main-timer progress for late-day rules. Other timers are skipped. |
| `timerInfo` | S→C | `{name, delay}` | handled | yes | Main-timer length. |
| `clearTimer` | S→C | timer name | ignored | yes | Timer cleared at a phase change; the next `state` resets the view timer. |
| `youAreBeingVoteKicked` | S→C | `{status:true}` | handled | yes | Sets `view.voteKickWarning` (this seat hasn't voted in a must-vote meeting). |
| `winners` | S→C | `{groups, players, messages, playersByGroup}` | handled | yes | Game over: sets `view.winners` and `view.finished`. |
| `finished` | S→C | (none) | handled | yes | Game over: sets `view.finished`. |
| `isSpectator` | S→C | (none) | handled | yes | Marks the view as spectator. |
| `spectators` | S→C | `{id: info}` | ignored | yes | Spectator list; spectators can't vote or speak in game meetings. |
| `spectatorCount` | S→C | number | ignored | yes | Spectator count for the UI only. |
| `emojis` | S→C | `{name: emote}` | ignored | yes | Custom emoji table for the chat UI. |
| `dev` | S→C | (none) | ignored | yes | Dev-role flag (dev API seats get it at join); no effect on play. |
| `kudos` | S→C | `{open, votes, myVote}` | ignored | yes | Post-game kudos UI; bots don't give kudos. |
| `audio` | S→C | cue name, e.g. `"veg"` | ignored | yes | Sound cue (veg, jinx, explosion). |
| `deathSounds` | S→C | `[url]` | ignored | yes | Death sound URLs; the death itself comes as `death` / `obituaries`. |
| `gunshot` | S→C | (none) | ignored | yes | Gun sound cue; the result comes as `death` / `message` frames. |
| `condemn` | S→C | (none) | ignored | yes | Condemn sound cue; the result comes as `death` / `obituaries`. |
| `readyCheck init` | S→C | `readyCheckFields(endTime, now, ...)` | ignored | no | Lobby ready check UI; dev seats are auto-verified. |
| `readyCheck update` | S→C | `{playerId}` | ignored | no | Ready check progress UI. |
| `readyCheck cancel` | S→C | `{}` | ignored | no | Ready check UI. |
| `readyCheck success` | S→C | `{}` | ignored | yes | Ready check passed; the game start frames follow. |
| `typing` | S→C | `{playerId, meetingId}` | ignored | no | Chat UI typing indicator. |
| `firstGame` | S→C | (none) | ignored | no | New-user hint for the client UI. |
| `lastWill` | S→C | string | ignored | no | Own last will echoed back; bots don't write wills. |
| `rehosted` | S→C | rehost info | ignored | no | Lobby rehost link after the game; the harness opens its own games. |
| `banned` | S→C | (none) | ignored | no | Account-level ban; the Dev API refuses sends, which show up as send errors. |
| `error` | S→C | message string | ignored | no | Server error toast; failed sends already show up as HTTP errors. |
| `alert` | S→C | message | ignored | no | UI alert. Game alerts arrive as server `message` frames. |
| `effectAge` | S→C | state info | unknown | no | In the server source (`Game.js` broadcast), never seen on the dev stream; the reducer ignores it. |
| `hostId` | S→C | userId | unknown | no | In the server source (`Game.js` broadcast), never seen on the dev stream; no effect on play. |
| `gameCreated` | S→C | gameId | unknown | no | Raw-socket lobby reply (`games.js`); the Dev API hosts over HTTP instead. |
| `gameCreateError` | S→C | `{...}` | unknown | no | Raw-socket lobby reply (`games.js`); the Dev API hosts over HTTP instead. |
| `gameLeaveError` | S→C | `{...}` | unknown | no | Raw-socket lobby reply (`games.js`); the Dev API leaves over HTTP instead. |
| `pushSubscribeResult` | S→C | `{accepted}` | unknown | no | Push-notification reply; `pushSubscribe` is blocked through the API. |

## 7. Real alert wording (Cop, Journalist, Janitor)

Game results arrive as `message` frames from `senderId: "server"` with an emoji tag. The variants below come
from real archived games (`engine/test/fixtures/real-alerts.json`, sanitized: X and Y stand for players, R
for a role), with how often each appears. `parseServerInfo` (engine/src/notes.js) and `cleanedRoles`
(engine/src/adaptiveMafia.js) parse all 65 fixtures.

- **Cop (FJ `LearnAlignment`):** `:invest: After investigating, you learn that X is Innocent!` (2,399) or
  `Guilty!` (1,326) in the older wording; `Village!` (24), `Cult!` (6), `Independent!` (4) and `Mafia!` (3)
  in the current wording.
- **Boastful Cop:** `:loud: a Cop (Boastful) is overheard reading: :invest: ...` goes to everyone. It's
  **not** the seat's own check.
- **Role Cop:** `:invest: You Learn that X's Role is R.` (931). It also appears with a trailing `..` or no
  period, and as `Role is not A, or B..` (no alignment read).
- **Journalist:**
  - `:journ: You learn that X received no reports.` (542);
  - `:journ: You received all reports that X received: <alerts>.` (363). The inner alerts are comma-separated
    and keep their own tags: `:invest:` results, `:mop:` cleans, `:track:` / `:watch:`, item gifts, even
    Protips.
  - A rare inner variant is `:invest: You learn that X is Guilty..`.
- **Janitor (`CleanDeath`):** `:mop: You discover X's role is R.` (1,358). R can carry modifiers, e.g.
  `Oracle (Astral/Resolute)`. Inside a Journalist report, only a `:mop:` / "discover" line means the target
  is the Janitor.
- **Not checks:** `:system: X's role is R.` (a public reveal), `:track:` lines, and players typing result
  text in chat (the sender isn't `server`).
