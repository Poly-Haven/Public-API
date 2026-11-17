# Cutover: Express/Node 15 nodes to Fastify/Node LTS nodes

Replaces api3 (`136.244.109.36`) and api5 (`139.162.192.148`) with two new VPSs, called A and B below (`$A_IP`, `$B_IP`). The old nodes stay untouched and serving until the very end, so every step before the last one rolls back by pointing traffic at them.

Ground rules

- A push to `master` deploys (`.github/workflows/main.yml`). The workflow must target the new nodes before master changes, and the new nodes must exist first. Steps 6 and 7 enforce that order. Pushing the `fastify` branch itself does not deploy anything, but it still needs your explicit go-ahead.
- Never `localhost` in the nginx upstream, never `pm2 restart` (use `pm2 reload`), never a proxy cache in nginx. All three are already encoded in the files here.
- Nothing here edits Firestore or Cloudflare for you. Steps marked HUMAN are production writes to approve and do.

Node major: `provision.sh` defaults to `NODE_MAJOR=24` (needs >= 22.18). If a newer LTS is current, set it at step 1 and bump `node-version` in the workflow `test` job to match.

## 0. Preconditions

- The `fastify` branch is on the remote (`git ls-remote origin fastify` prints a sha). As of writing it is local only: `git push origin fastify` is needed so the nodes can clone it (HUMAN, explicit go-ahead; it does not deploy).
- Two fresh Debian 12/13 VPSs, 1 vCPU / 1 GB or better, with your ssh key as `root`. Same region as the old nodes unless you are deliberately moving.
- A workstation with the parity harness prerequisites (`test/parity/README.md`: an Express baseline worktree of master with deps and `.env`).

## 1. Provision both nodes

On each new node, as root (clone the repo or copy `deploy/` over; the script finds the nginx file next to itself):

```
scp -r deploy root@$A_IP:/root/deploy
ssh root@$A_IP 'NODE_MAJOR=24 BRANCH=fastify bash /root/deploy/provision.sh'
```

Repeat for B. It ends with "Provisioned, but NOT started" because `.env` is missing; that is expected.

Verify (per node):

```
ssh root@$A_IP 'node -v; pm2 -v; ufw status; nginx -t; systemctl is-enabled pm2-api nginx; sudo -u api git -C /home/api/api log --oneline -1'
ssh api@$A_IP 'echo key login ok'
```

Expect Node >= 22.18, ufw active with 22, Nginx Full, 443 allowed and 3000 denied. `curl -s -o /dev/null -w '%{http_code}\n' http://$A_IP/` returns 502 now (nginx up, app not): correct.

Rollback: nothing is live. Destroy the VPS, or re-run the script after fixing the cause (it is idempotent).

## 2. Copy `.env` from an old node

The file holds the Firebase service account and all keys; it never goes in the repo or a chat. Through your workstation so the secret passes through no third host's shell history:

```
scp api@136.244.109.36:~/api/.env ./api.env.tmp
scp ./api.env.tmp api@$A_IP:~/api/.env
scp ./api.env.tmp api@$B_IP:~/api/.env
shred -u ./api.env.tmp    # or delete it securely on Windows
ssh api@$A_IP "chmod 600 ~/api/.env; sed -i 's/^NODE_ID=.*/NODE_ID=apiA/' ~/api/.env"
ssh api@$B_IP "chmod 600 ~/api/.env; sed -i 's/^NODE_ID=.*/NODE_ID=apiB/' ~/api/.env"
```

`NODE_ID` must be unique per node (it is what `/ping` reports and what admin logs). Check `.env.example` against the copied file for variables added since the old nodes were set up (the Cloudflare Workers AI pair for `/search`, `I18NEXUS_API_KEY`, `CLOUDFLARE_*`).

Verify: `ssh api@$A_IP "grep -c . ~/api/.env; grep '^NODE_ID' ~/api/.env; stat -c %a ~/api/.env"` shows the id and `600`.

Rollback: delete the file on the new node.

## 3. Parity run against a new node (guarded, not yet in service)

Goal: prove the new app on the new runtime matches the Express baseline. `diff.js` cannot send a custom `Host` header (it takes a base URL and uses its hostname), and the app does not route on Host, so run the app on the node on a spare port and reach it through an ssh tunnel to loopback. The node's firewall stays closed to this port.

On node A, as `api`, start the app through the write guard (no Firestore writes, no mutating outbound calls) on 3102, with PM2 not yet running so the 1 GB box holds only one copy of the in-memory caches:

```
ssh api@$A_IP
cd ~/api && bash test/parity/serve.sh ~/api 3102 ~/parity.writes.log > ~/parity.server.log 2>&1 &
curl -s 127.0.0.1:3102/ping     # runtime should be the new Node; the guard prints its startup line in ~/parity.server.log
```

The log must show the guard's "patched" startup line and `~/parity.writes.log` must be empty. If the guard did not start, stop: the app must never run unguarded for this step.

On the workstation, run the baseline on 3101 and the corpus per `test/parity/README.md` steps 1-3, then tunnel and diff:

```
ssh -N -L 3102:127.0.0.1:3102 api@$A_IP &
MSYS_NO_PATHCONV=1 node test/parity/diff.js --old http://127.0.0.1:3101 --new http://127.0.0.1:3102 \
  --corpus $SCRATCH/corpus.json --skip-cases --out $SCRATCH/run-node-a --env $OLD/.env --ctx $SCRATCH/context.json
```

`--skip-cases` is needed because the write cases compare the Firestore write log as a local file (`--new-log`) and the new app's log is on the node. The write cases already pass on the workstation (same code); this run's purpose is the corpus (status, headers, bodies) and the rate-limit check on the real Node version and OS. Optionally `scp api@$A_IP:parity.writes.log` back afterwards and confirm it is empty: reads only produced no writes.

Verify: `summary.txt` shows no mismatch signatures beyond those already explained in the workstation run. Repeat a quick `--limit 300` run against B if you want proof both boxes match.

Cleanup: `ssh api@$A_IP 'pkill -f "node -r .*guard.js"; rm -f ~/parity.*'`, close the tunnel.

Rollback: n/a, nothing live. A mismatch that appears only on the node means a runtime or environment difference (Node major, `.env`, clock): fix before continuing.

## 4. Start PM2 on both nodes

```
ssh api@$A_IP 'cd ~/api && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup systemd -u api --hp /home/api'
```

`provision.sh` already installed the boot unit as root, so `pm2 startup` here only prints a confirmation or the exact `sudo env ...` line to run once as root if it printed one: run that if shown. `pm2 save` is what makes the process list survive a reboot. Then `pm2 install pm2-logrotate` (the app logs with timestamps and nothing else prunes them). Repeat for B.

Verify, on each node, locally and through nginx with a Host header:

```
ssh api@$A_IP 'curl -s 127.0.0.1:3000/ping; echo; curl -s -H "Host: api.polyhaven.com" http://127.0.0.1/ping; echo; pm2 status'
curl -s -H 'Host: api.polyhaven.com' http://$A_IP/ping     # from the workstation: port 80 is open
curl -s -H 'Host: api.polyhaven.com' http://$A_IP/types
curl -s -X POST http://$A_IP/clear_cache -H 'Host: x' -o /dev/null -w '%{http_code}\n'   # admin calls it by IP; expect 401/403 without the key, not 404 or the nginx welcome page
```

`/ping` must show `"runtime":"v24.x"` (or your NODE_MAJOR), the node's own `node` id, and the expected commit. Look at `pm2 logs app --lines 50 --nostream` for errors. Test a reload does not drop requests: `pm2 reload ecosystem.config.cjs --update-env` while `while true; do curl -s -o /dev/null -w '%{http_code} ' 127.0.0.1/ping -H 'Host: api.polyhaven.com'; sleep 0.2; done` runs: no 502s.

Client IP: the app takes the client's address from `CF-Connecting-IP`, and the node's ports 80/443 are open to the whole internet, so nginx does not pass the header through. `api.polyhaven.com.conf` includes `/etc/nginx/cloudflare-ips.conf` (one `set_real_ip_from` per Cloudflare range) with `real_ip_header CF-Connecting-IP`, so only a connection from a Cloudflare address can name the client, and then sets `CF-Connecting-IP` and `X-Forwarded-For` to nginx's own `$remote_addr` for the app. A request that did not come through Cloudflare therefore shows up with its real socket address, whatever headers it sent. Check it (a request from your workstation does not come from a Cloudflare address, so the header it sends must be ignored):

```
ssh api@$A_IP 'sudo nginx -t'
curl -s -H 'Host: api.polyhaven.com' -H 'CF-Connecting-IP: 203.0.113.7' -H 'X-Forwarded-For: 203.0.113.7' http://$A_IP/ping -o /dev/null -w '%{http_code}
'
ssh api@$A_IP 'sudo tail -n 3 /var/log/nginx/access.log'     # the default log format shows $remote_addr: your workstation's address, not 203.0.113.7
```

`provision.sh` writes `/etc/nginx/cloudflare-ips.conf` from https://www.cloudflare.com/ips-v4 and /ips-v6 (falling back to the checked-in `deploy/nginx/cloudflare-ips.conf` if the fetch fails). Cloudflare rarely changes the list, and announces it in advance. To refresh a node: `sudo bash ~api/api/deploy/nginx/refresh-cloudflare-ips.sh && sudo nginx -t && sudo systemctl reload nginx`; to refresh the checked-in copy, run the script with that file as its argument and commit the result. If a range were missing, requests from it would be counted under the Cloudflare edge address instead of the visitor's (rate limits would lump visitors together), which is the safe direction to fail in.

Rollback: `pm2 delete app`. Nothing is live.

## 5. Deploy plumbing, before touching master

Do this in the `fastify` branch; the workflow file in this branch already targets `SSH_HOST_API_A` / `SSH_HOST_API_B`.

1. HUMAN: in GitHub repo Settings > Secrets, create `SSH_HOST_API_A` = `$A_IP`, `SSH_HOST_API_B` = `$B_IP`. Keep `SSH_USERNAME` = `api`. Recommended: generate a deploy key (`ssh-keygen -t ed25519 -f deploykey -N ''`), append the public half to `~api/.ssh/authorized_keys` on both nodes, store the private half as `SSH_KEY`, and delete `SSH_PASSWORD` (the new nodes have no password for `api` anyway). With neither `SSH_KEY` nor `SSH_PASSWORD` the deploy cannot authenticate. These must exist before the merge in step 7. Also recommended: pin each node's host key with `SSH_FINGERPRINT_API_A` / `SSH_FINGERPRINT_API_B`, the `SHA256:...` value from `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on that node. The workflow passes them to `appleboy/ssh-action`'s `fingerprint` input; left unset, the action does not verify the host at all, so a man in the middle could capture the deploy key.
2. Make sure the old secrets `SSH_HOST_API3` / `SSH_HOST_API5` are not needed any more (the workflow no longer references them). Leave them until step 10.
3. Verify the deploy path on the new nodes by hand, exactly what the workflow runs: `ssh api@$A_IP 'cd ~/api && git pull --ff-only && bash deploy.sh'` and the same on B (they are on `fastify`, already up to date, so it only exercises `deploy.sh` and `pm2 reload`). Then `/ping` again.

Rollback: revert the workflow commit. Secrets are harmless to leave.

## 6. Register the new nodes for cache flushes (HUMAN, production write)

Admin's `/clear_cache` fan-out calls `http://<ip>/clear_cache` for each node in Firestore doc `api_nodes/v1`. Add `$A_IP` and `$B_IP` alongside the old two (do not remove the old ones yet). Show the proposed doc to whoever approves it first.

Verify: trigger a flush from admin (or `curl -s -X POST http://$A_IP/clear_cache -H "<the DL_KEY header the route expects>"`) and confirm the node's `/ping` `search` stats or logs show it. Check the old nodes still receive it.

Rollback: remove the two new entries.

## 7. Merge to master (this deploys, to the new nodes only)

Preconditions, all verified: step 5's secrets exist; the workflow in the branch targets only the new nodes; both new nodes are running (`/ping` ok). The old nodes are not touched by this merge: the workflow no longer reaches them, so they keep running the last Express commit.

1. HUMAN, explicit go-ahead: merge `fastify` into `master` and push.
2. Watch the Actions run: `test` (typecheck) then `deploy` A then B. A failure on A stops before B.
3. The new nodes track `fastify`, but the workflow pulls whatever branch each node has checked out, so switch them to master now (fast-forward, same code):
   `ssh api@$A_IP 'cd ~/api && git fetch && git checkout master && git pull --ff-only'` and B. Do this immediately after the merge, before the next push to master, or that push will deploy from a stale branch.

Verify: `curl -s -H 'Host: api.polyhaven.com' http://$A_IP/ping` shows the merge commit on both nodes.

Rollback: these nodes are not serving public traffic yet, so there is nothing to roll back. To undo the merge itself, `git revert` it, and note that would deploy the Express code to nodes that cannot run it (Node 24 with no Express deps): do not revert master; fix forward, or `git checkout fastify` on the nodes.

## 8. Switch Cloudflare traffic, one node at a time (HUMAN)

`api.polyhaven.com` has proxied DNS records pointing at the old nodes. Do this once the nodes have been warm for a few minutes (the first requests build the per-node Firestore and search caches; hit `/ping`, `/assets?t=hdris`, `/search?q=wood` against each node directly first).

1. Replace the origin IP of one record (api3's) with `$A_IP` (edit the record's content in place so the TTL and proxy status stay). Cloudflare proxied records take effect within seconds.
2. Watch for 10-15 minutes: the Cloudflare analytics 5xx rate for the zone, `pm2 logs app` on A, and the runtime seen through the edge. The edge caches, so bypass it: `for i in $(seq 1 20); do curl -s "https://api.polyhaven.com/ping?x=$RANDOM" -H 'Cache-Control: no-cache' | grep -o '"node":"[^"]*","commit":"[^"]*","runtime":"[^"]*"'; done` should show a mix of the old node (`runtime` v15) and `apiA`.
3. If clean, replace api5's record with `$B_IP` and repeat. After this every `/ping` shows `apiA` / `apiB` and a Node 24 runtime.
4. If the zone also has AAAA records for the old nodes, replace or remove them the same way, and add the new nodes' IPv6 only if you want it.

Rollback: set the record's content back to the old IP. The old nodes are still running the Express app and still on `/clear_cache`'s list, so nothing is lost.

## 9. Cloudflare cache rules for /v2 (HUMAN)

Today a page rule bypasses cache for `api.polyhaven.com/v2/*`, and the general `api.polyhaven.com/*` rule forces a 12h edge TTL. The v2 routes now send their own `Cache-Control`: `public, max-age=<computed>` on the public endpoints, `private` / `no-store` on the keyed ones. Desired behaviour:

- `/v2/*` is eligible for cache and uses the origin's `Cache-Control` for both edge and browser TTL ("respect origin"; Cache Rules: Eligible for cache, Edge TTL = "Use cache-control header if present, bypass cache if not present", Browser TTL = respect origin). Not "Cache Everything with an override TTL".
- The general rule (12h edge TTL) must not apply to `/v2/*`. Page Rules apply only the first matching rule by priority, so the `/v2/*` rule has to sit above the general one; with Cache Rules, add an exclusion (`not starts_with(lower(http.request.uri.path), "/v2/")`) to the general rule. Match the path lower-cased (`lower(http.request.uri.path)`) in the `/v2/` rule as well: Cloudflare compares paths case-sensitively, so a rule written as `starts_with(http.request.uri.path, "/v2/")` would not see `/V2/ea/files` and the general cache-everything rule could store a keyed response publicly. The app backs this up: any path that is `/v2` in a different case, or percent-encoded to look different, is a 404 with `Cache-Control: no-store`, so there is nothing for a rule to mis-cache. Do both.
- Keyed responses (`private` / `no-store`) must stay uncached: Cloudflare does not store those under this setting, but verify it (below), because a cached keyed response is a key leak.
- Query string stays in the cache key (the default).

Do this after step 8 so the old Express v2 (which sends no cache headers) is never the thing the rule is exposed to; with "bypass if not present" it would be harmless anyway. Change it, then:

```
curl -sI https://api.polyhaven.com/v2/<a public v2 endpoint> | grep -i 'cache-control\|cf-cache-status\|age'    # twice: MISS/EXPIRED then HIT, max-age matches the origin value
curl -sI -H 'Authorization: Bearer <a valid test key>' https://api.polyhaven.com/v2/<a keyed endpoint> | grep -i 'cache-control\|cf-cache-status'    # private/no-store, cf-cache-status DYNAMIC or BYPASS, never HIT
curl -sI https://api.polyhaven.com/V2/assets | grep -i 'HTTP/\|cache-control\|cf-cache-status'    # upper-case path: 404, no-store, never HIT (twice, to be sure)
curl -sI -H 'Authorization: Bearer <a valid test key>' https://api.polyhaven.com/V2/ea/files | grep -i 'HTTP/\|cache-control\|cf-cache-status'    # same: 404 no-store, and certainly not a 200
```

Also confirm that admin's publish purge covers the v2 URLs. It purges exact URLs only, so any v2 URL not in its list is stale for up to its `max-age` after a publish. If it does not, the `max-age` is the staleness bound; decide whether that is acceptable.

Rollback: restore the previous page rule (bypass for `/v2/*`).

## 10. Decommission the old nodes

Only after a quiet period (suggest a week with no 5xx anomalies, `/ping` through the edge showing only apiA/apiB, and no traffic left on the old nodes: `ssh api@136.244.109.36 'tail -n 20 /var/log/nginx/access.log'` shows only stray or health-check hits).

1. HUMAN: remove `136.244.109.36` and `139.162.192.148` from Firestore `api_nodes/v1`. Verify a flush from admin reaches only the new nodes.
2. `pm2 stop app` on the old nodes first and wait a day; if anything complains, `pm2 start app` brings them back.
3. Delete the old VPSs, and the unused secrets `SSH_HOST_API3`, `SSH_HOST_API5`, and `SSH_PASSWORD` if you moved to a key.
4. Update `info/` (a new change-log entry like `api_nginx_proxy_cache_removal.md`, and the memory notes that mention Node 15, api3/api5 and the deploy mechanics).

Rollback: until the VPSs are deleted, `pm2 start app` plus re-pointing the DNS records (step 8) restores the old stack. After deletion there is no rollback, which is why step 2 comes first.

## After the cutover

- Node security updates are manual (NodeSource is outside unattended-upgrades): `apt-get update && apt-get install --only-upgrade nodejs`, then `pm2 reload ecosystem.config.cjs`.
- Kernel updates installed by unattended-upgrades need a reboot; `pm2 save` and the boot unit bring the app back, so reboot one node at a time.
- If the box gets a new `.env` variable, `pm2 reload ecosystem.config.cjs --update-env` (deploy.sh already does this).
