#!/usr/bin/env bash
# Provision a fresh Debian 12 or 13 VPS as a Poly Haven api node. Run as root, from anywhere:
#   NODE_MAJOR=24 BRANCH=fastify bash provision.sh
# Idempotent: safe to re-run. It stops before starting the app if ~api/api/.env is missing; see deploy/README.md.
set -euo pipefail

# --- settings (override from the environment) ---
# Node major to install from NodeSource. The app needs >= 22.18 (it runs .ts directly). 24 is the LTS line I
# could confirm; if a newer LTS is current when you provision, set NODE_MAJOR to it and bump the setup-node
# version in .github/workflows/main.yml to match.
NODE_MAJOR="${NODE_MAJOR:-24}"
REPO_URL="${REPO_URL:-https://github.com/Poly-Haven/Public-API.git}" # public, so the node needs no deploy key to clone
BRANCH="${BRANCH:-fastify}" # after the merge to master, switch nodes with: git checkout master (see README)
API_USER="${API_USER:-api}"
PM2_VERSION="${PM2_VERSION:-latest}"
INSTALL_BUILD_TOOLS="${INSTALL_BUILD_TOOLS:-0}" # all dependencies are pure JS; set 1 only if npm ci wants to compile
NGINX_CONF_SRC="${NGINX_CONF_SRC:-}"            # defaults to the copy next to this script, or the repo clone

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive # apt must never stop to ask a question over ssh

HOME_DIR="/home/$API_USER"
APP_DIR="$HOME_DIR/api"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Run a command as the api user. `runuser -u` switches uid but leaves the environment alone, so HOME would still be
# /root: git would look for (and try to write) config under root's home and npm would use root's cache and
# ~/.npmrc, failing with permission errors or leaving root-owned files in the api user's tree. env sets HOME, USER
# and LOGNAME as a login would, and the command starts in the api home, because the working directory is also
# inherited and api cannot read /root (git and npm both complain when they cannot read their cwd).
as_api() { runuser -u "$API_USER" -- env HOME="$HOME_DIR" USER="$API_USER" LOGNAME="$API_USER" bash -c 'cd "$HOME" && exec "$@"' bash "$@"; }

echo "==> packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx ufw unattended-upgrades
if [ "$INSTALL_BUILD_TOOLS" = "1" ]; then apt-get install -y -qq build-essential; fi

echo "==> api user"
if ! id "$API_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$API_USER" # no password: ssh keys only
fi
install -d -m 700 -o "$API_USER" -g "$API_USER" "$HOME_DIR/.ssh"
if [ -s /root/.ssh/authorized_keys ]; then
  # Same operator keys as root, so whoever provisioned the box can log in as api and deploy. Appended only if
  # missing so a re-run never duplicates or drops a key someone added later.
  touch "$HOME_DIR/.ssh/authorized_keys"
  while IFS= read -r key; do
    if [ -n "$key" ] && ! grep -qxF "$key" "$HOME_DIR/.ssh/authorized_keys"; then
      echo "$key" >> "$HOME_DIR/.ssh/authorized_keys"
    fi
  done < /root/.ssh/authorized_keys
  chown "$API_USER:$API_USER" "$HOME_DIR/.ssh/authorized_keys"
  chmod 600 "$HOME_DIR/.ssh/authorized_keys"
else
  echo "WARNING: /root/.ssh/authorized_keys is empty; add a public key to $HOME_DIR/.ssh/authorized_keys by hand" >&2
fi

echo "==> Node $NODE_MAJOR from NodeSource"
# Debian's own nodejs package is far too old. The repo is added by hand (signed-by keyring) rather than piping
# NodeSource's setup script into bash.
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs
# Fail now rather than at first start: older Node cannot strip types, so the app would crash on boot.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) { console.error("Node "+process.version+" is older than 22.18"); process.exit(1) }'
echo "node $(node -v), npm $(npm -v)"

echo "==> pm2"
# A global install puts pm2 in /usr/bin, which is on PATH for the non-interactive ssh shell the deploy workflow
# uses. (On the admin box pm2 comes from nvm and silently goes missing over ssh; this avoids that.)
npm install -g --no-audit --no-fund "pm2@$PM2_VERSION"
# Boot unit so the app comes back after a reboot. Needs no running app yet; `pm2 save` happens after first start.
pm2 startup systemd -u "$API_USER" --hp "$HOME_DIR" >/dev/null
systemctl enable "pm2-$API_USER" >/dev/null

echo "==> firewall"
# Rules first, enable last: enabling with no ssh rule would lock us out of a remote box.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 'Nginx Full' # 80 (Cloudflare and admin's /clear_cache) and 443
ufw allow 443/tcp
ufw deny 3000/tcp      # the app is reachable only through nginx on loopback
ufw --force enable

echo "==> unattended-upgrades"
# Debian security updates only (the default origins). NodeSource is not in them, so Node itself is updated by hand:
# apt-get update && apt-get install --only-upgrade nodejs, then pm2 reload. Kernel updates need a manual reboot.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

echo "==> repo"
if [ ! -d "$APP_DIR/.git" ]; then
  as_api git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  as_api git -C "$APP_DIR" fetch origin
  as_api git -C "$APP_DIR" checkout "$BRANCH"
  as_api git -C "$APP_DIR" pull --ff-only # ff-only: never silently merge or clobber local edits on a node
fi

echo "==> nginx"
src="$NGINX_CONF_SRC"
if [ -z "$src" ]; then
  for c in "$SCRIPT_DIR/nginx/api.polyhaven.com.conf" "$APP_DIR/deploy/nginx/api.polyhaven.com.conf"; do
    if [ -f "$c" ]; then src="$c"; break; fi
  done
fi
[ -f "$src" ] || { echo "nginx conf not found; set NGINX_CONF_SRC" >&2; exit 1; }
install -m 644 "$src" /etc/nginx/sites-available/api.polyhaven.com
# The site includes this list (realip: only Cloudflare may say who the client is). Fetched fresh, with the
# checked-in copy as the fallback if Cloudflare's site is unreachable; both live next to the site config.
for d in "$SCRIPT_DIR/nginx" "$APP_DIR/deploy/nginx"; do
  if [ -f "$d/refresh-cloudflare-ips.sh" ]; then bash "$d/refresh-cloudflare-ips.sh" /etc/nginx/cloudflare-ips.conf; break; fi
done
[ -f /etc/nginx/cloudflare-ips.conf ] || { echo "/etc/nginx/cloudflare-ips.conf missing: refresh-cloudflare-ips.sh not found" >&2; exit 1; }
ln -sfn /etc/nginx/sites-available/api.polyhaven.com /etc/nginx/sites-enabled/api.polyhaven.com
# Debian's stock site is also a default_server on :80; two defaults make nginx -t fail.
rm -f /etc/nginx/sites-enabled/default
nginx -t # a bad config must never reach the reload
systemctl enable nginx >/dev/null
systemctl reload-or-restart nginx

echo "==> dependencies"
if [ -f "$APP_DIR/package-lock.json" ]; then
  # Prod deps only: Node runs the TypeScript itself, so no compiler is needed on the node. The first deploy.sh run
  # reinstalls once (it also installs dev deps and writes its own lockfile marker); that is expected.
  as_api bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  cat <<MSG

Provisioned, but NOT started: $APP_DIR/.env does not exist.
Next: copy it from an old node, set a unique NODE_ID, then (as $API_USER):
  chmod 600 ~/api/.env
  cd ~/api && pm2 start ecosystem.config.cjs && pm2 save
See deploy/README.md for the order (parity run first).
MSG
  exit 0
fi
chmod 600 "$APP_DIR/.env"
cat <<MSG

Provisioned. .env is present. Next, as $API_USER:
  cd ~/api && pm2 start ecosystem.config.cjs && pm2 save
MSG
