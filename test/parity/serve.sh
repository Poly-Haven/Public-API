#!/usr/bin/env bash
# Start an app through the write guard.
#   serve.sh <appdir> <port> <writelog>
# Runs in the foreground; the guard (guard.js) is preloaded so no Firestore write or mutating HTTP call can escape.
# Start two of these in the background (&) on different ports, e.g. 3001 (old) and 3002 (new).
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo "usage: serve.sh <appdir> <port> <writelog>" >&2
  exit 2
fi
APPDIR=$1
PORT=$2
LOG=$3
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guard.js"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
cd "$APPDIR"
# The Fastify app starts from server.js; the Express baseline from app.js.
ENTRY=server.js
[ -f server.js ] || ENTRY=app.js
# The Patreon hook posts to a Discord webhook. The Express baseline did that through hookcord/snekfetch, which opens
# raw TLS sockets the guard cannot see (it would have reached the real channel), so both apps get a dead address
# here instead of the real URL from .env (a variable already in the environment wins over .env).
export DISCORD_PATRON_HOOK="${PARITY_DISCORD_HOOK:-http://127.0.0.1:9/parity-discord-hook}"
# NODE_ENV=production so the app's dev-only behaviour (request logging, /tmp route) is off.
NODE_ENV=production PORT="$PORT" PARITY_WRITE_LOG="$LOG" exec node -r "$GUARD" "$ENTRY"
