#!/usr/bin/env bash
# Apple container live run.
# Default: read .env (MAFIOSO_ENV_FILE) and pass it to the container through a temporary env file.
# MAFIOSO_ENV_FROM_PROCESS=1: take the same variables from this process. Values are not
# written to a file and are not placed on the container argv (`-e NAME` only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${MAFIOSO_ENV_FILE:-$ROOT/.env}"
IMAGE="${MAFIOSO_IMAGE:-mafioso-mac:openrouter}"
NAME="${MAFIOSO_CONTAINER_NAME:-mafioso-mac}"
HOST_GW="${MAFIOSO_HOST_GATEWAY:-192.168.64.1}"
LOG_OUT="${MAFIOSO_LOG:-}"
CONTAINER="${CONTAINER_BIN:-container}"
FROM_PROCESS="${MAFIOSO_ENV_FROM_PROCESS:-}"

child=0
cleanup() {
  if [[ "$child" != 0 ]]; then
    kill "$child" >/dev/null 2>&1 || true
  fi
  "$CONTAINER" stop "$NAME" >/dev/null 2>&1 || true
}
trap 'cleanup; exit 143' TERM INT

if [[ "$FROM_PROCESS" == "1" ]]; then
  node --input-type=module -e '
    import { assertProcessContainerEnv } from "./harness/src/containerEnv.js";
    assertProcessContainerEnv(process.env);
  '
  # Keep a base URL the caller already put in the environment (the app sends the gateway and API port).
  if [[ -z "${DEV_API_BASE_URL:-}" ]]; then
    export DEV_API_BASE_URL="http://${HOST_GW}:3000"
  fi
  export MAFIOSO_HOST_GATEWAY="$HOST_GW"
else
  if [[ ! -f "$ENV_FILE" ]]; then echo "missing $ENV_FILE" >&2; exit 1; fi
  if ! grep -q '^OPENROUTER_API_KEY=.\+' "$ENV_FILE"; then echo "OPENROUTER_API_KEY empty" >&2; exit 1; fi
fi

if [[ "${MAFIOSO_CONTAINER_SKIP_BUILD:-}" != "1" ]]; then
  echo "build: container build -t $IMAGE"
  "$CONTAINER" build -t "$IMAGE" -f Dockerfile .
fi

"$CONTAINER" stop "$NAME" >/dev/null 2>&1 || true
"$CONTAINER" delete "$NAME" >/dev/null 2>&1 || true

mkdir -p "$ROOT/harness/data/prompts/runtime" "$ROOT/logs"

if [[ "$FROM_PROCESS" == "1" && -n "${MAFIOSO_TRACE_MOUNT:-}" ]]; then
  MOUNT_SRC="$MAFIOSO_TRACE_MOUNT"
  MOUNT_DST="/app/logs/traces"
  mkdir -p "$MOUNT_SRC"
else
  MOUNT_SRC="$ROOT/logs"
  MOUNT_DST="/app/logs"
fi

run_container() {
  if [[ "$FROM_PROCESS" == "1" ]]; then
    args=()
    while IFS= read -r key; do
      [[ -n "$key" ]] || continue
      args+=(-e "$key")
    done < <(node --input-type=module -e '
      import { processContainerEnvNames } from "./harness/src/containerEnv.js";
      for (const name of processContainerEnvNames(process.env)) console.log(name);
    ')
    echo "run: $NAME from process environment llm=${MAFIOSO_LLM:-lmstudio} base=$DEV_API_BASE_URL"
    set +e
    if [[ -n "$LOG_OUT" ]]; then
      "$CONTAINER" run --name "$NAME" --rm \
        "${args[@]}" \
        --mount "type=bind,source=$ROOT/harness/data/prompts/runtime,target=/app/harness/data/prompts/runtime" \
        --mount "type=bind,source=$MOUNT_SRC,target=$MOUNT_DST" \
        "$IMAGE" "$@" >"$LOG_OUT" 2>&1 &
    else
      "$CONTAINER" run --name "$NAME" --rm \
        "${args[@]}" \
        --mount "type=bind,source=$ROOT/harness/data/prompts/runtime,target=/app/harness/data/prompts/runtime" \
        --mount "type=bind,source=$MOUNT_SRC,target=$MOUNT_DST" \
        "$IMAGE" "$@" &
    fi
    child=$!
    wait "$child"
    STATUS=$?
    child=0
    set -e
    return 0
  fi

  RUNTIME="$(mktemp -t mafioso-runtime.XXXXXX)"
  chmod 600 "$RUNTIME"
  awk -v gw="$HOST_GW" '
    BEGIN{done=0}
    /^DEV_API_BASE_URL=/ { print "DEV_API_BASE_URL=http://" gw ":3000"; done=1; next }
    {print}
    END{ if(!done) print "DEV_API_BASE_URL=http://" gw ":3000" }
  ' "$ENV_FILE" > "$RUNTIME"

  echo "run: $NAME LIVE=$(grep '^MAFIOSO_LIVE=' "$RUNTIME" | cut -d= -f2-) model=$(grep '^OPENROUTER_MODEL=' "$RUNTIME" | cut -d= -f2-)"
  set +e
  if [[ -n "$LOG_OUT" ]]; then
    "$CONTAINER" run --name "$NAME" --rm \
      --env-file "$RUNTIME" \
      -e "DEV_API_BASE_URL=http://${HOST_GW}:3000" \
      --mount "type=bind,source=$ROOT/harness/data/prompts/runtime,target=/app/harness/data/prompts/runtime" \
      --mount "type=bind,source=$MOUNT_SRC,target=$MOUNT_DST" \
      "$IMAGE" "$@" >"$LOG_OUT" 2>&1 &
  else
    "$CONTAINER" run --name "$NAME" --rm \
      --env-file "$RUNTIME" \
      -e "DEV_API_BASE_URL=http://${HOST_GW}:3000" \
      --mount "type=bind,source=$ROOT/harness/data/prompts/runtime,target=/app/harness/data/prompts/runtime" \
      --mount "type=bind,source=$MOUNT_SRC,target=$MOUNT_DST" \
      "$IMAGE" "$@" &
  fi
  child=$!
  wait "$child"
  STATUS=$?
  child=0
  rm -f "$RUNTIME"
  set -e
}

run_container "$@"
exit "$STATUS"
