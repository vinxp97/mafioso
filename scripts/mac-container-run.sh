#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${MAFIOSO_ENV_FILE:-$ROOT/.env}"
IMAGE="${MAFIOSO_IMAGE:-mafioso-mac:openrouter}"
NAME="${MAFIOSO_CONTAINER_NAME:-mafioso-mac}"
HOST_GW="${MAFIOSO_HOST_GATEWAY:-192.168.64.1}"
LOG_OUT="${MAFIOSO_LOG:-}"

if [[ ! -f "$ENV_FILE" ]]; then echo "missing $ENV_FILE" >&2; exit 1; fi
if ! grep -q '^OPENROUTER_API_KEY=.\+' "$ENV_FILE"; then echo "OPENROUTER_API_KEY empty" >&2; exit 1; fi

echo "build: container build -t $IMAGE"
container build -t "$IMAGE" -f Dockerfile .

container stop "$NAME" >/dev/null 2>&1 || true
container delete "$NAME" >/dev/null 2>&1 || true

RUNTIME="$(mktemp -t mafioso-runtime.XXXXXX)"
chmod 600 "$RUNTIME"
awk -v gw="$HOST_GW" '
  BEGIN{done=0}
  /^DEV_API_BASE_URL=/ { print "DEV_API_BASE_URL=http://" gw ":3000"; done=1; next }
  {print}
  END{ if(!done) print "DEV_API_BASE_URL=http://" gw ":3000" }
' "$ENV_FILE" > "$RUNTIME"

mkdir -p "$ROOT/harness/data/prompts/runtime" "$ROOT/logs"

echo "run: $NAME LIVE=$(grep '^MAFIOSO_LIVE=' "$RUNTIME" | cut -d= -f2-) model=$(grep '^OPENROUTER_MODEL=' "$RUNTIME" | cut -d= -f2-)"
set +e
if [[ -n "$LOG_OUT" ]]; then
  container run --name "$NAME" --rm \
    --env-file "$RUNTIME" \
    -e "DEV_API_BASE_URL=http://${HOST_GW}:3000" \
    --mount "type=bind,source=$ROOT/harness/data/prompts/runtime,target=/app/harness/data/prompts/runtime" \
    --mount "type=bind,source=$ROOT/logs,target=/app/logs" \
    "$IMAGE" "$@" >"$LOG_OUT" 2>&1
  STATUS=$?
else
  container run --name "$NAME" --rm \
    --env-file "$RUNTIME" \
    -e "DEV_API_BASE_URL=http://${HOST_GW}:3000" \
    --mount "type=bind,source=$ROOT/harness/data/prompts/runtime,target=/app/harness/data/prompts/runtime" \
    --mount "type=bind,source=$ROOT/logs,target=/app/logs" \
    "$IMAGE" "$@"
  STATUS=$?
fi
rm -f "$RUNTIME"
exit $STATUS
