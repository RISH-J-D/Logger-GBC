#!/usr/bin/env bash
# One command to run the whole host: database + server (+ both portals).
#   ./run.sh                 # start DB + server on :4100
#   PUBLIC=1 ./run.sh        # also start a public cloudflared tunnel
set -e
cd "$(dirname "$0")"

PORT="${PORT:-4100}"

echo "[1/3] Starting database (logger-pg)…"
docker start logger-pg >/dev/null 2>&1 || \
  docker run -d --name logger-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
    -e POSTGRES_DB=device_logger -p 5544:5432 postgres:16 >/dev/null
until docker exec logger-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
echo "      database ready."

if [ "${PUBLIC:-0}" = "1" ] && [ -x /tmp/cloudflared ]; then
  echo "[2/3] Starting public tunnel…"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  nohup /tmp/cloudflared tunnel --url "http://localhost:$PORT" > /tmp/cf.log 2>&1 &
  sleep 6
  echo "      public URL: $(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf.log | head -1)"
else
  echo "[2/3] (local only — set PUBLIC=1 for a public tunnel)"
fi

echo "[3/3] Server on http://localhost:$PORT  (admin: /   employee: /portal)"
cd server
exec env PORT="$PORT" npm run bootstrap
