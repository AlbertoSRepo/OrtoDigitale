#!/usr/bin/env bash
# deploy_frontend.sh — build SPA e push su RPi5.
# Uso: bash rpi5/scripts/deploy_frontend.sh
#
# Richiede: node + npm sul PC, ssh as@192.168.1.12 funzionante,
# /opt/orto-digitale/frontend/dist gia' montato come /srv in Caddy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FE_DIR="$REPO_ROOT/rpi5/frontend"
RPI_HOST="${RPI_HOST:-as@192.168.1.12}"
RPI_DIST="/opt/orto-digitale/frontend/dist"

echo "[deploy_frontend] build su $FE_DIR"
cd "$FE_DIR"
npm install --silent --no-audit --no-fund
npm run build

echo "[deploy_frontend] sync dist/ -> $RPI_HOST:$RPI_DIST"
ssh "$RPI_HOST" "sudo mkdir -p $RPI_DIST && sudo chown -R as:as /opt/orto-digitale/frontend"

if command -v rsync >/dev/null 2>&1; then
  rsync -avz --delete -e ssh dist/ "$RPI_HOST:$RPI_DIST/"
else
  echo "[deploy_frontend] rsync non disponibile, fallback scp"
  ssh "$RPI_HOST" "rm -rf $RPI_DIST/*"
  scp -r dist/* "$RPI_HOST:$RPI_DIST/"
fi

echo "[deploy_frontend] reload Caddy"
ssh "$RPI_HOST" "cd /opt/orto-digitale && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile" \
  || ssh "$RPI_HOST" "cd /opt/orto-digitale && docker compose restart caddy"

echo "[deploy_frontend] done. Apri https://orto.local"
