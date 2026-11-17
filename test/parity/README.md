# Parity harness

Proves the Fastify port is behaviour-identical to the Express app. It runs the old app and the new app side by side against the same production Firestore, replays real production requests (plus hand-written write cases) against both, and diffs status, headers and bodies, and the Firestore writes each app would have made.

## Safety

Both apps are always started through `guard.js` (`node -r guard.js app.js`, which `serve.sh` does for you). The guard

- replaces every Firestore write (`set/update/create/delete`, `add`, batches, transactions, bulk writer) with a record in the file named by `PARITY_WRITE_LOG`, and refuses the raw write RPCs as a second line of defence;
- records and fakes (200 `{}`) every outbound POST/PUT/PATCH/DELETE except Cloudflare GraphQL / Workers AI (`api.cloudflare.com` `/graphql`, `/ai/run/`) and Google's OAuth token exchange (needed to authenticate Firestore reads);
- throws at startup if it cannot prove it patched the Firestore SDK, so an unguarded app cannot start.

Prove it before the first run, from the old app's directory:

```
cd <old app dir>
PARITY_WRITE_LOG=<scratch>/selftest.log node -r <repo>/test/parity/guard.js <repo>/test/parity/guard.selftest.js
```

It must print `15 checks passed` (it does a real read of the throwaway doc `parity_guard_selftest/x` and asserts it does not exist).

Reads are real and cost money per document. Each app caches collections in memory, so a full run is fine; use `--only <prefix>` while iterating, not repeated full runs.

Generated files contain real user search queries and live keys: keep them out of the repo (use a scratch folder). The report redacts every value from `--env`.

## Procedure

Variables used below (adjust):

```
REPO='C:/Poly Haven/api'                  # new app (branch fastify), harness lives in $REPO/test/parity
OLD=<worktree of master with deps and .env>
SCRATCH=<scratch>/parity                  # never committed
```

Pick two free ports (3000-3002 are often taken by dev servers: check `netstat -ano | findstr LISTENING | findstr :3`). Examples use 3101 (old) and 3102 (new).

1. One-off, from `$OLD`: look up live values the logs cannot give (an early-access API key, an existing patron id). Reads about 110 documents, writes `context.json` outside the repo, prints nothing secret.

   ```
   cd $OLD && PARITY_WRITE_LOG=$SCRATCH/ctx.log node -r $REPO/test/parity/guard.js $REPO/test/parity/find-context.js $SCRATCH/context.json
   ```

2. Build the corpus from the production nginx counts (`count METHOD URL` per line). Deterministic; prints the size per group and writes `corpus.stats.txt`.

   ```
   node $REPO/test/parity/build-corpus.js <counted.txt> $SCRATCH/corpus.json
   ```

3. Start both apps, in the background:

   ```
   bash $REPO/test/parity/serve.sh $OLD  3101 $SCRATCH/old.writes.log > $SCRATCH/old.server.log 2>&1 &
   bash $REPO/test/parity/serve.sh $REPO 3102 $SCRATCH/new.writes.log > $SCRATCH/new.server.log 2>&1 &
   ```

   Wait until `curl localhost:3101/ping` and `curl localhost:3102/ping` answer (the first start takes a few seconds). The write logs must stay empty until the cases run.

4. Run the diff (corpus, then write cases, then the rate-limit check). The run takes a few minutes: several write cases deliberately hang the Express app (unhandled async throw) and wait out their timeout.

   ```
   cd $REPO && node test/parity/diff.js \
     --old http://127.0.0.1:3101 --new http://127.0.0.1:3102 \
     --corpus $SCRATCH/corpus.json --cases test/parity/cases --out $SCRATCH/run1 \
     --env $OLD/.env --ctx $SCRATCH/context.json \
     --old-log $SCRATCH/old.writes.log --new-log $SCRATCH/new.writes.log
   ```

   (Git Bash on Windows rewrites an argument like `/info` into a filesystem path: prefix the command with `MSYS_NO_PATHCONV=1`.)

   Options: `--only /info` (corpus entries and cases under that prefix), `--skip-corpus`, `--skip-cases`, `--skip-ratelimit`, `--limit N`, `--concurrency 6`.

   Output in `--out`: `summary.txt` (counts per route prefix, distinct mismatch signatures with an example each) and `report.json` (every mismatch with the aspects that differ and the detail).

5. Stop both servers. Find them with `netstat -ano | findstr LISTENING | findstr :310` and `taskkill /PID <pid> /F` (Windows) or `kill`.

The new app can be started from any directory that has its own deps and `.env`. `serve.sh` runs `server.js` when the directory has one (the TypeScript app) and `app.js` otherwise (the Express baseline). The harness itself is CommonJS (the repo is ESM, so `package.json` here says `"type": "commonjs"`); `guard.js` is preloaded into the app with `-r` and patches the `@google-cloud/firestore` module that `firebase-admin` resolves, which the ESM app shares with it. The startup line it prints names the modules it patched: check it when upgrading `firebase-admin`.

## Calibration

Run the old app on both ports (same directory, different port and write log) and run the same diff. Any difference is non-determinism in the app, not a porting error, and belongs in `normalize.js` with a justification. Re-run this whenever normalisation rules change.

## What is compared

- status; headers `content-type`, `cache-control`, `access-control-*`, `terms-of-service`, `location`, `vary`, `x-ph-early-access`, `retry-after` (plus `allow`, `content-encoding`, `content-disposition`, `last-modified`); presence (not value) of `etag`; a 304 round trip with each server's own etag on a sample of 200s.
- body: JSON deep-compare (first 5 differing paths) and JSON key order, otherwise exact text.
- write cases: the recorded Firestore writes / blocked HTTP calls for each case, as a multiset and in order.
- the per-IP search rate limiter (`/search`, 160 requests from one client IP: same threshold, same 429 response). Corpus requests each carry a distinct `cf-connecting-ip` so the limiter does not interfere with them.

`x-powered-by` is deliberately not compared (Express sets it; Fastify does not).

## Case files

`cases/*.json`: arrays of `{name, method, path, headers, body | bodyRaw, contentType, timeoutMs, last}`. Strings may contain `{{env:NAME}}`, `{{ctx:name}}` (from `context.json`), `{{hmac:ENVNAME:text}}` (HMAC-SHA256 hex, as `/patron_info` verifies) and, in headers, `{{md5sig:ENVNAME}}` (HMAC-MD5 over the raw body, as `/patreon_hook` verifies). A case whose placeholder cannot be resolved is skipped and listed in the summary. `timeoutMs` marks a case known to hang the Express app; two timeouts count as identical. `last: true` runs after everything else (`/clear_cache` empties the caches).

## Files

| file | purpose |
| --- | --- |
| `guard.js` | write guard, preloaded with `node -r` |
| `guard.selftest.js` | proves the guard |
| `find-context.js` | looks up live keys/ids, writes `context.json` |
| `build-corpus.js` | production log counts to `corpus.json` |
| `diff.js` | the differ |
| `normalize.js` | justified normalisation rules |
| `serve.sh` | starts an app through the guard |
| `cases/` | hand-written write cases |
