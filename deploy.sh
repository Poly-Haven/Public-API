#!/bin/bash
# Run on an api node from ~/api by the Deploy workflow, after `git pull`. Safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")"

# `npm ci` deletes node_modules before reinstalling, and the running worker still lazy-requires modules
# (firebase-admin among them), so installing in place breaks live requests with MODULE_NOT_FOUND for as
# long as the install takes. Install into a staging dir instead and swap it in with two renames, and skip
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

pm2 reload ecosystem.config.js --update-env
