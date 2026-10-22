#!/usr/bin/env bash
# Generate MafiosoTrace.xcodeproj and build a Debug app with ad-hoc signing.
# macOS only. The generated project is not committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/mafioso-trace"
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is not on PATH. Install it with: brew install xcodegen" >&2
  exit 1
fi
xcodegen generate
xcodebuild -project MafiosoTrace.xcodeproj -scheme MafiosoTrace -destination 'platform=macOS' -configuration Debug -derivedDataPath ./build build CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO
echo "built $ROOT/apps/mafioso-trace/build/Build/Products/Debug/MafiosoTrace.app"
