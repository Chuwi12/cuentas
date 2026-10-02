#!/usr/bin/env bash
# Arranca backend (Rust) y frontend (Vite) juntos, en primer plano.
# Ctrl+C para los dos. La BD es un servicio aparte (./scripts/db.sh) y no se toca aquí.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "falta .env: cp .env.example .env y pon un JWT_SECRET (openssl rand -base64 48)"; exit 1; }
[ -d frontend/node_modules ] || (cd frontend && npm ci)

if [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/finanzas-db.container" ]; then
  echo "aviso: el servicio de la BD no está instalado; instálalo una vez con ./scripts/db.sh install" >&2
fi
./scripts/db.sh up

set -a; . ./.env; set +a
API_ADDR="${BIND_ADDR:-127.0.0.1:8080}"

# Cada proceso va en su propio grupo (setsid) para poder pararlo entero, incluido el binario
# que lanza cargo, y no depender de a quién llegue el Ctrl+C del terminal.
start() { # nombre directorio comando...
  local name=$1 dir=$2; shift 2
  setsid bash -c 'set -o pipefail; cd "$1"; n=$2; shift 2; "$@" 2>&1 | sed -u "s/^/[$n] /"' _ "$dir" "$name" "$@" &
}

API=; WEB=; STOPPING=0
stop_all() {
  [ "$STOPPING" = 1 ] && return; STOPPING=1
  trap '' INT TERM
  local pid i
  for pid in $API $WEB; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for i in $(seq 1 100); do   # hasta 10 s
    for pid in $API $WEB; do
      kill -0 -- "-$pid" 2>/dev/null && continue 2
    done
    break
  done
  for pid in $API $WEB; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM
trap stop_all EXIT

start api backend cargo run
API=$!
start web frontend npx vite
WEB=$!

printf 'esperando al backend'
for _ in $(seq 1 300); do
  if curl -fs "http://$API_ADDR/api/health" >/dev/null 2>&1; then
    echo " · listo"; echo "abre http://localhost:5173 (api en http://$API_ADDR)"; break
  fi
  kill -0 "$API" 2>/dev/null && kill -0 "$WEB" 2>/dev/null || break
  printf '.'; sleep 1
done
echo

# Si cualquiera de los dos termina, se para el otro y se sale con error.
rc=0
wait -n "$API" "$WEB" || rc=$?
echo "uno de los procesos terminó (código $rc); parando el otro" >&2
stop_all
exit $(( rc == 0 ? 1 : rc ))
