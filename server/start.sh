#!/usr/bin/env bash
# One-command server bootstrap: install deps, create .env, (optionally start the
# bundled PostgreSQL), create tables, import the 183 employees, then run.
#
#   ./start.sh            # use the DB configured in .env
#   START_DB=1 ./start.sh # also spin up the bundled Postgres via docker compose
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/5] Installing dependencies…"
npm install --no-audit --no-fund

echo "[2/5] Ensuring .env…"
node scripts/ensure-env.js

if [ "${START_DB:-0}" = "1" ]; then
  echo "[3/5] Starting bundled PostgreSQL (docker compose)…"
  docker compose up -d
  echo "      waiting for PostgreSQL to accept connections…"
  for i in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1; then echo "      ready."; break; fi
    sleep 1
  done
else
  echo "[3/5] Using DATABASE_URL from .env (set START_DB=1 to auto-start the bundled DB)."
fi

echo "[4/5] Creating tables + importing employees…"
npm run setup

echo "[5/5] Starting server…"
npm start
