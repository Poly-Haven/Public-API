#!/bin/bash
# Run on an api node from ~/api by the Deploy workflow, after `git pull`. Safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")"

# `npm ci` deletes node_modules before reinstalling, and the running worker can still load modules on demand
# (dynamic import(), e.g. the legacy JSON routes), so installing in place breaks live requests with
# ERR_MODULE_NOT_FOUND for as long as the install takes. Install into a staging dir instead and swap it in with two renames, and skip
# it entirely when the lockfile is unchanged since the last install.
if ! cmp -s package-lock.json node_modules/.deployed-lock 2>/dev/null; then
  stage="$HOME/.api_deps_staging"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp package.json package-lock.json "$stage/"
  (cd "$stage" && npm ci --no-audit --no-fund)
  cp package-lock.json "$stage/node_modules/.deployed-lock"
  rm -rf node_modules.old
  [ -d node_modules ] && mv node_modules node_modules.old
  mv "$stage/node_modules" node_modules
  rm -rf node_modules.old "$stage"
else
  echo "package-lock.json unchanged, skipping npm ci"
fi

pm2 reload ecosystem.config.cjs --update-env

# Health gate. `pm2 reload` returns once the new worker has said it is ready, but a worker can be up and still be
# the wrong one (a reload that fell back to the old process, a crash loop that PM2 is masking). Require /ping to
# answer from the commit just checked out, and fail the script (and so the workflow, before it touches the next
# node) if that does not happen. /ping's `commit` is "<sha> <subject>", read once when the worker started.
expected="$(git rev-parse HEAD)"
for _ in $(seq 1 30); do
  reported="$(curl -fsS --max-time 3 http://127.0.0.1:3000/ping 2>/dev/null | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\).*/\1/p')" || true
  if [ "$reported" = "$expected" ]; then
    echo "healthy: /ping reports ${expected:0:7}"
    exit 0
  fi
  sleep 1
done
echo "deploy FAILED: /ping did not report ${expected:0:7} within 30s (reported: ${reported:-nothing})" >&2
exit 1
