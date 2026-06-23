#!/usr/bin/env bash
# Pull the latest main and rebuild the running container. Idempotent: if nothing
# changed, the build is a no-op and the container keeps running. Run by the
# GitHub Action on every push to main, or by hand on the box.
set -euo pipefail
cd "$(dirname "$0")"

git pull --ff-only
docker compose up -d --build

# The Caddyfile is a read-only bind mount, so `up` won't restart Caddy when only
# the config changed. Hot-reload it (zero downtime); fall back to a restart if the
# reload RPC isn't reachable. Reload validates first and keeps the old config on error.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
  || docker compose restart caddy

docker image prune -f
echo "wordshot: deploy complete"
