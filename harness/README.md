# mafioso-harness
Dev API client for the Mafioso AI player. Depends on `../engine` (file: dep).

- **Hosts:** only `https://dev.ultimafia.gg` and `http://127.0.0.1:3000` (from engine `DEV_HOSTS`). Anything else, including prod, throws `HostNotAllowedError`.
- **No built-in network:** `new DevApiClient({baseUrl, fetch})` requires an injected `fetch`.
- **Methods:** `getToken`, `me`, `hostGame` (forces `lobby:"Testing"`, `private:true`, refuses ranked/competitive), `createAccounts`, `leaveAccount`, `control`, `events`, `send({accountId,event,data,view})` (runs `validateAction` before HTTP when `view` is given).
- **Stream:** `parseStreamFrame`, `parseSse`, `replayStream` (per-account views, seq dedup), `runLoop` (reduce→decide→validate, collects proposals, never sends).
- **Live creds:** `liveCredentials()` reads `DEV_API_CLIENT_ID`/`DEV_API_CLIENT_SECRET` only when `MAFIOSO_LIVE=1`. Never commit or log them.

Run: `npm install && npm test`.

## LLM mode
`runLoopAsync(entries, {complete})` — uses engine `llmDecide` (validated, rules fallback) when `complete` is given; otherwise same as `runLoop`. Only consults the model when an unvoted legal vote exists. Never sends.

## LM Studio (`src/lmstudio.js`)

`createLmStudioComplete(opts)` → `async complete({system, user}) => string` for a local OpenAI-compatible server (Qwen in LM Studio). This client is not the game API and does not use `DEV_HOSTS`.

Run the process on the same machine as LM Studio. `http://127.0.0.1:1234` is that machine’s loopback; a VPS cannot open your PC’s localhost unless you tunnel it.

| Option | Env | Default |
| --- | --- | --- |
| `baseUrl` | `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` (trailing slash stripped; must be the `/v1` root) |
| `model` | `LM_STUDIO_MODEL` | empty → `GET {baseUrl}/models`, use `data[0].id`, then cache it |
| `apiKey` | `LM_API_KEY` | `lm-studio` (any non-empty string). Sent as `Authorization: Bearer …`. `apiKey: ""` omits the header |
| `fetch` | — | global `fetch`. Inject one in tests |
| `temperature`, `maxTokens` | — | omitted from the body unless you pass a finite number (`maxTokens` → `max_tokens`) |

Request: `POST {baseUrl}/chat/completions` with `{model, messages:[{role:"system"},{role:"user"}], stream:false, response_format:{type:"json_object"}}`. If the server returns a non-2xx whose body mentions `response_format` / `json_object` / `json_schema` (not 401/403/404), the client retries once without `response_format`. Non-2xx and a missing `choices[0].message.content` string throw an `Error` (`LM Studio POST /chat/completions -> <status>: …`). The message includes a short response snippet, not the request.

Explicit `model` / `apiKey` / `baseUrl` win over env, including `model: null` or `""` (that forces discovery even when `LM_STUDIO_MODEL` is set). `lmStudioConfigFromEnv(env)` reads the three variables and does not call the network. Pass `env: {}` in tests.

```bash
node scripts/lmstudio-smoke.mjs   # live local server only
```

```js
import { createLmStudioComplete, runLoopAsync } from "mafioso-harness";

const complete = createLmStudioComplete();
const { proposed } = await runLoopAsync(entries, { complete });
```
