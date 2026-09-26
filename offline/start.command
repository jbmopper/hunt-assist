#!/bin/zsh
set -euo pipefail

APP_DIR="${0:A:h}"
APP_PORT="4317"
APP_URL="http://127.0.0.1:${APP_PORT}/#bear-targets"

cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Hunt Assist needs Node.js 22 or newer on this Mac."
  echo "Install Node before leaving connectivity, then double-click start.command again."
  read -r "?Press Return to close."
  exit 1
fi

export HUNT_ASSIST_OFFLINE=1
export HOST=127.0.0.1
export PORT="$APP_PORT"

node server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

for _ in {1..40}; do
  if curl --silent --fail "http://127.0.0.1:${APP_PORT}/api/runtime" >/dev/null; then
    open "$APP_URL"
    echo "Hunt Assist is running offline at $APP_URL"
    echo "Keep this window open. Press Control-C to stop the server."
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.25
done

echo "Hunt Assist did not start. Port ${APP_PORT} may already be in use."
wait "$SERVER_PID"
