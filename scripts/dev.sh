#!/usr/bin/env bash
# Arranca todo para desarrollo: BD (podman), backend (Rust) y frontend (Vite).
# Ctrl+C para todo a la vez.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "falta .env: cp .env.example .env y pon un JWT_SECRET (openssl rand -base64 48)"; exit 1; }
[ -d frontend/node_modules ] || (cd frontend && npm ci)

./scripts/db.sh up

set -a; . ./.env; set +a
(cd backend && cargo run) &
BACK=$!
(cd frontend && npx vite) &
FRONT=$!
trap 'kill $BACK $FRONT 2>/dev/null; wait 2>/dev/null' INT TERM EXIT
echo "abre http://localhost:5173"
wait
