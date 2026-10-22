# Night 5 Mac test plan (written, not run by the box agent)

Branch for the Mac: `night5-claims-pr17-20261020` (the Night 5 commits on PR #17, `6f61576`), because the Mac
container runs the PR #17 code (OpenRouter reasoning, `scripts/mac-container-run.sh`).
Private Testing lobbies on dev only, through the host gateway the script already uses. No public or prod games.
The OpenRouter key stays in the Mac's `.env`; nothing below prints it or writes it anywhere else.

## 0. Approval
Vinman OK'd live private Testing-lobby games on dev from the Mac container for the night of 10/20 (relayed
by the parent). That covers the games below: private Testing lobby, model `minimax/minimax-m3.1-flash:free`,
reasoning low. It doesn't cover prod or public games, pushes or merges, or a paid model; each of those needs
its own yes from Vinman.

## 1. Code on the Mac (no push needed if the branch is copied as a bundle)
```bash
# on the box (already done when the parent asks for it): git bundle of the branch
#   cd /workspace/night5-pr17 && git bundle create /workspace/night5-pr17.bundle 6f61576..night5-claims-pr17-20261020
# on the Mac, in the mafioso checkout that is on mac/openrouter-reasoning-low (6f61576):
git fetch /path/to/night5-pr17.bundle night5-claims-pr17-20261020:night5-claims-pr17-20261020
git switch night5-claims-pr17-20261020
git log --oneline -7          # tip should be the box's night5-claims-pr17 sha
(cd engine && npm test) && (cd harness && npm install && npm test)   # engine 411/411, harness all pass
```

## 2. A run env file for this night (the real .env is not edited)
```bash
cd ~/mafioso   # repo root on the Mac
grep -v -E '^(OPENROUTER_MODEL|OPENROUTER_REASONING|MAFIOSO_LLM|MAFIOSO_LIVE|BOT_COUNT|GAME_ID|LOBBY_NAME)=' .env > .env.night5
cat >> .env.night5 <<'ENV'
MAFIOSO_LLM=openrouter
OPENROUTER_MODEL=minimax/minimax-m3.1-flash:free
OPENROUTER_REASONING=low
MAFIOSO_LIVE=1
BOT_COUNT=9
LOBBY_NAME=mafioso-bots
ENV
chmod 600 .env.night5
grep -c '^OPENROUTER_API_KEY=.\+' .env.night5   # must print 1 (the key is copied, never echoed)
```
`.env.night5` holds the key. `.gitignore` (`.env.*`) and `.dockerignore` (`**/.env.*`) both exclude it, so it is
neither committed nor copied into the image; the script passes it to `container run --env-file` only. Delete it
after the runs. Game logs (`*.log`, `*.log.err`) are gitignored. Do not commit them (they hold account ids
and names); sanitize into fixtures first.

## 3. Rebuild the container and run N games
`mac-container-run.sh` rebuilds the image (`container build -t mafioso-mac:openrouter -f Dockerfile .`) on
every call, then runs one hosted private Testing game and exits. One call = one game.
```bash
N=3   # whatever Vinman approved
for i in $(seq 1 "$N"); do
  ts=$(date +%m%d-%H%M)
  MAFIOSO_ENV_FILE="$PWD/.env.night5" MAFIOSO_LOG="logs/night5-minimax-low-$ts.log.err" \
    scripts/mac-container-run.sh || echo "game $i exit $?"
done
```
Stop early if a game shows illegal actions, a public lobby, or a burst of 4xx from OpenRouter.

## 4. Score each game (on the Mac or after copying the logs to the box)
```bash
node harness/scripts/night5-eval.mjs logs/night5-minimax-low-*.log.err
node harness/scripts/night5-eval.mjs logs/night5-minimax-low-*.log.err --json > logs/night5-eval.json
```
What to look for, against the L10 baseline (LLM 2/211 sent, Sheriff claim ~0.3s after day start):
- LLM lines sent / attempts, and the chat-checker rejects by reason.
- Rule 1: every villager/blue answer to the Sheriff is followed by >=12s and >=4 lines before any shot at
  that player; the D1 shot still happens.
- Rule 2: an asked Cop/Journalist claim (by town) gets exactly one mafia CC, 3-7s after it; never the Janitor
  on the Sheriff, never "sheriff is sus".
- Rule 3: one Cop line per seat per day, with the report in it.
- Rule 4: `sheriff-claim-delay ... ms=` between 1000 and 10000, different across games.
- Rule 5: 0 sent lines with "vt".
- 0 illegal or refused actions (seat errors).

## 5. Single bot among humans (the end goal), once 9-bot games are clean
Same commands with `BOT_COUNT=1` in `.env.night5`, in a private Testing lobby that humans join. This also
needs its own OK.
