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
