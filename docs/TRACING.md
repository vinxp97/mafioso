# Tracing

A live JSONL stream of one game, for the macOS viewer in `apps/mafioso-trace/`. Tracing is off unless `MAFIOSO_TRACE=1`. With it unset, the harness does not open a trace file and does not change requests or replies.

The [quickstart](QUICKSTART.md) lists the other environment variables. This page is the trace schema and the viewer.

## Turn it on

```bash
MAFIOSO_TRACE=1
MAFIOSO_TRACE_DIR=          # optional. Default is logs/traces at the repo root.
MAFIOSO_TRACE_REASONING=1   # optional. OpenRouter only. See below.
```

`runLiveCli` writes a game when `MAFIOSO_LIVE=1` as well. Self-play writes one when `MAFIOSO_TRACE=1`. Both use the same files. `MAFIOSO_TRACE_DIR` is the logs root the macOS app reads. Point it at `~/mafioso-mac/logs` if you want the app's default folder.

```bash
mkdir -p ~/mafioso-mac/logs
MAFIOSO_TRACE=1 MAFIOSO_TRACE_DIR="$HOME/mafioso-mac/logs" node scripts/live.mjs
```

Run that from `harness/`.

## Files

One file per seat, not one file per game:

```text
logs/traces/<gameId>/<seat>.jsonl
```

`<seat>` is the account id, or `harness` for process events (the game opening, a stream error, the game ending). `<gameId>` and `<seat>` are path-safe: anything that is not a letter, digit, `.`, `_`, or `-` becomes `_`.

Each line is one JSON object followed by a newline. The writer `write`s that line and `fsync`s before it returns, so a reader that tails the file sees the line without waiting for the process to exit. Seats do not share a file, so two seats cannot tear a line in half.

`logs/traces/` is gitignored except a `.gitkeep`. Do not commit a live trace. It can hold chat.

## Record

```json
{"v":1,"seq":4,"ts":"2026-10-22T11:00:00.000Z","gameId":"g-day","seat":"seat-ada","phase":"Day 1","type":"llm.call","data":{}}
```

| Field | Meaning |
| --- | --- |
| `v` | Schema version. This document is version 1. |
| `seq` | Write order for the whole game, starting at 1. A seat file can have gaps, because other seats take numbers too. |
| `ts` | ISO-8601 time from the harness clock. |
| `gameId` | Directory name. |
| `seat` | File name, without `.jsonl`. |
| `phase` | `state.name` for that seat when the event was written (`Day 1`, `Night 2`). Empty before the first state. |
| `type` | One of the names below. |
| `data` | Type-specific object. Strings inside it have been through redaction. |

The viewer sorts a merged seat by `seq`.

## Event types

`game.start`  
Once per seat, when that seat first knows its own role. `data.self` is `{playerId, name, role}`. `data.seats` is `{playerId, name}` for players this seat has seen. `data.rolesKnown` is only what that seat knows: its own role, and teammates the harness has handed it. Other seats' secret roles are not copied in. `data.setup` is the setup id when the view has one. The harness file gets its own `game.start` with `gameId`, `setupId`, `botCount`, and `{accountId, promptId}` per seat. Prompt text is not stored.

`game.end`  
`data.winners` from the seat's view, or on the harness file `data.status` of `finished`, `aborted`, or `stopped`.

`phase.change`  
`data.from` and `data.to`. `from` may be empty when the first phase arrives after `game.start`.

`llm.call`  
One model call.

| `data` field | Meaning |
| --- | --- |
| `callId` | Id of this call, `c1`, `c2`, and so on, for the whole game. The matching `engine.validation` copies it. |
| `model` | Model id sent on the request. |
| `purpose` | `action`, `speech`, `candidates`, `memory`, `scheduler`, or empty. |
| `latencyMs` | Time from the request start to the response. |
| `usage` | Numeric token counts from the provider (`prompt_tokens`, `completion_tokens`, `total_tokens`, and nested details such as `reasoning_tokens`). Strings in a usage object are dropped. |
| `reasoning` | Chain-of-thought, or null. Set only when `MAFIOSO_TRACE_REASONING=1` and the provider returned `message.reasoning`. |
| `reasoningDetails` | `message.reasoning_details`, or null. Same flag. |
| `raw` | The assistant `content` string. This is the proposal. Capped at 8000 characters. |
| `parsed` | `parseLlmAction` of `raw`, or null when the reply is a chat line or not one action object. |
| `prompt` | Summary of what the seat handed the model. See below. |

`prompt.systemChars` is the system-text length. The system text itself is not copied. `prompt.state` is the user briefing with other players' chat removed, capped at 8000 characters. `prompt.untrusted` is that chat, each item `{kind, text, untrusted: true}`. `kind` is `player-chat` (the `PLAYERS SAID` block) or `faction-chat`.

`engine.validation`  
One `validateAction` result on a line that reached send. `data.ok`, `data.reason` (empty when accepted), `data.action`, `data.meetingId`, `data.selection`, `data.content` for speech, `data.source`. `data.callId` is set when `source` is `llm` or `model` and the action matches an `llm.call` from that seat (the parsed vote, or the speech call). A rules action leaves `callId` off. The viewer puts that parsed proposal next to this verdict.

`chat.sent`  
A speak that was handed to send, or queued for send. `data.content`, `data.meetingId`, `data.meetingName`, `data.source`, `data.dryRun`, and `data.deferred` when the line waited on pacing.

`chat.suppressed`  
A public line that did not go out. `data.reason` is the filter (validation, chat audit, cooldown, duplicate, pace, send guard, and the others in `emitActions`). `data.filter` is a short tag. `data.content` is the line that was dropped.

`chat.observed`  
A chat line from another player, after it was reduced into this seat's view. `data.text`, `data.senderId`, `data.name`, `data.meetingId`, `data.kind` of `player-chat`, `data.untrusted: true`. It is data. It is not an instruction to the viewer or to a later model call. The model still sees the briefing the engine builds; the trace copy is marked.

`vote.sent`  
A day vote or the Sheriff's gun, including a deferred vote (`data.deferred: true`). `data.selection`, `data.meetingId`, `data.meetingName`, `data.source`, `data.dryRun`.

`night.sent`  
A night meeting vote (Cop, Mafia kill, and the other night actions). Same fields as `vote.sent`.

`vote.notice`  
The harness's tally after a `vote` or `unvote` frame. `data.counts` is the village ballot from this seat's view (`voteCounts`). `data.leader`, `data.tied`, `data.voterId`, `data.target`. `data.untrusted` is true: the ballots are what other players did.

`error`  
A model error, a send error, or a stream error. `data.message`, `data.where`, `data.status` when the provider sent one. The message is redacted and capped.

`retry`  
The OpenAI-compatible client retried without `response_format` after the server rejected that field. `data.reason` is `response_format`. One retry, then the successful `llm.call` or an `error`.

`rate_limit`  
HTTP 429 from the model provider. `data.status` is 429. The call still throws, the same as before tracing.

## Reasoning

OpenRouter still sends `reasoning: { effort, exclude: true }` by default (`OPENROUTER_REASONING`, default `low`). `exclude: true` asks the provider not to return chain-of-thought.

`MAFIOSO_TRACE_REASONING=1` sets `exclude` to false on that object, so the provider may return `message.reasoning` and `message.reasoning_details`. The harness records those on `llm.call` and nowhere else. `complete()` still returns `message.content` only. Game chat is that content, after the engine parses and validates it. Reasoning is not concatenated onto the reply, not sent as speech, and not written into the prompt store.

The flag does nothing when reasoning is turned off (`OPENROUTER_REASONING=off` or an explicit `reasoning: null`). There is no reasoning object to flip. With the flag unset, a provider that returns reasoning anyway does not get those fields copied into the trace.

## Redaction

Before a line is written, every string is passed through `redactString`:

- planted secrets handed to the writer, and values of env vars whose names look like credentials (`SECRET`, `TOKEN`, `API_KEY`, `PASSWORD`, `COOKIE`, `SESSION`, `AUTHORIZATION`, `CLIENT_ID`, `CLIENT_SECRET`), when the value is at least 6 characters
- `Bearer` tokens
- JWTs (`eyJ….….…`)
- key-shaped tokens (`sk-`, `xpl_`, `rk_`, `pk_`)
- `Cookie:` / `cookie=` values
- `Authorization:` values
- assignments such as `OPENROUTER_API_KEY=…`

The writer does not dump `process.env`. Request headers, including `Authorization`, are not fields on `llm.call`. A trace bug is swallowed so a failed write does not change the game.

## Viewer

`apps/mafioso-trace/` is a SwiftUI app for macOS 14 and later. It does not build on Linux. The parser and the file tail live in the `MafiosoTraceCore` package, which does.

```bash
cd apps/mafioso-trace/MafiosoTraceCore && swift test
bash scripts/build-trace-app.sh
```

`scripts/build-trace-app.sh` runs `xcodegen` (so `MafiosoTrace.xcodeproj` is not in git) and then the Debug `xcodebuild` with ad-hoc signing. App Sandbox is off. The app reads local log files.

Launch the built app with a sample game:

```bash
apps/mafioso-trace/build/Build/Products/Debug/MafiosoTrace.app/Contents/MacOS/MafiosoTrace \
  -fixture apps/mafioso-trace/Fixtures/sample-game.jsonl
```

The fixture is synthetic. The names are Ada, Bea, Cal, Dee, and Eli. Cmd-R reloads. The default logs root is `~/mafioso-mac/logs`, and Settings can point it at `logs/traces` or `MAFIOSO_TRACE_DIR`.

The sidebar is one row per game directory. A game whose files changed in the last 15 seconds is marked live. The app opens with seat `All` and phase `All`. Choosing a timeline row does not change those filters, and choosing `All` stays put when more seats appear. The detail column is a timeline and the selected event. The scrubber and the `n / N` counter follow the selected row, and moving the scrubber selects that row. Reasoning is monospaced text you can select; it is not highlighted on its own. An `llm.call` opens with Proposal vs Verdict: the parsed proposal beside the `engine.validation` that carries the same `callId`. A line with no `callId` still pairs with the next validation for that seat, or the previous model call. The Phase column shows `—` before the first phase. The sidebar path shortens at a directory boundary, down to the file name when the column is narrow. The toolbar path is cut in the middle. The full path is the tooltip, and Reveal in Finder is on the path's menu. Follow-live scrolls to the new line until you pick an older row or turn Follow off. A finished game can be scrubbed with the slider when the filtered timeline has more than one event. Zero or one event shows the position label only.

The app tails files. It does not read a whole file into view state. New bytes are parsed a line at a time.

## Tests

`harness/test/trace.test.js` covers the record shape, a line showing up on disk before `close`, redaction of a planted secret, untrusted chat split out of the briefing, reasoning capture against a mocked OpenRouter response (the returned string is only `content`), a 429, the `response_format` retry, a dry-run table that writes `game.start`, `phase.change`, `engine.validation`, `night.sent`, `vote.notice`, and `chat.observed`, and a model vote whose `llm.call` and `engine.validation` share a `callId`.
