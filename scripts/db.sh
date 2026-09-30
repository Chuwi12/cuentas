#!/usr/bin/env bash
# Gestión del PostgreSQL de desarrollo en un contenedor rootless de podman.
# Si el servicio Quadlet está instalado (./scripts/db.sh install) lo gestiona systemd,
# que lo para con SIGINT antes de desmontar nada al apagar. Si no, usa podman a pelo.
# Uso: ./scripts/db.sh {install|uninstall|up|down|logs|psql|reset|status}
set -euo pipefail

NAME=finanzas-db
IMAGE=docker.io/library/postgres:18-alpine
VOLUME=finanzas-pgdata
PORT=5433
DB=finanzas
PGUSER=finanzas
PASS=finanzas_dev
SERVICE=$NAME.service

HERE="$(cd "$(dirname "$0")" && pwd)"
UNIT_SRC="$HERE/../deploy/$NAME.container"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
UNIT_DST="$UNIT_DIR/$NAME.container"

installed() { [ -f "$UNIT_DST" ]; }

# Espera a que el contenedor deje de existir o de ejecutarse; el código de salida lo
# comprueba quien llama (un PANIC de Postgres en el apagado sale con código distinto de 0).
wait_stopped() {
  local state
  for _ in $(seq 1 90); do
    state=$(podman container inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo gone)
    case "$state" in gone|exited|stopped|created) return 0 ;; esac
    sleep 1
  done
  echo "el contenedor $NAME sigue en ejecución tras 90 s" >&2; return 1
}

wait_ready() {
  printf 'esperando a postgres'
  for _ in $(seq 1 40); do
    if podman exec "$NAME" pg_isready -U "$PGUSER" -d "$DB" >/dev/null 2>&1; then
      echo " · listo en 127.0.0.1:$PORT"; return 0
    fi
    printf '.'; sleep 1
  done
  echo; echo "postgres no respondió a tiempo; revisa: ./scripts/db.sh logs" >&2; return 1
}

case "${1:-up}" in
  install)
    [ -f "$UNIT_SRC" ] || { echo "falta $UNIT_SRC" >&2; exit 1; }
    # Un contenedor creado a mano chocaría en nombre con el del servicio.
    # Se elimina el contenedor, nunca el volumen con los datos.
    if podman container exists "$NAME" && ! installed; then
      echo "existe un contenedor $NAME creado a mano: se parará (hasta 60 s, apagado limpio)"
      echo "y se eliminará. El volumen $VOLUME y sus datos no se tocan."
      podman stop -t 60 "$NAME" >/dev/null
      podman rm "$NAME" >/dev/null
    fi
    podman volume exists "$VOLUME" || podman volume create "$VOLUME" >/dev/null
    mkdir -p "$UNIT_DIR"
    cp "$UNIT_SRC" "$UNIT_DST"
    systemctl --user daemon-reload
    echo "servicio $SERVICE instalado. Arráncalo con: ./scripts/db.sh up"
    ;;
  uninstall)
    if systemctl --user is-active --quiet "$SERVICE"; then
      systemctl --user stop "$SERVICE"
    fi
    rm -f "$UNIT_DST"
    systemctl --user daemon-reload
    echo "servicio desinstalado (el volumen $VOLUME se conserva)"
    ;;
  up)
    if installed; then
      systemctl --user start "$SERVICE"
      echo "servicio $SERVICE arrancado"
    elif podman container exists "$NAME"; then
      podman start "$NAME" >/dev/null
      echo "contenedor $NAME arrancado (ya existía; para gestionarlo con systemd: ./scripts/db.sh install)"
    else
      podman volume exists "$VOLUME" || podman volume create "$VOLUME" >/dev/null
      podman run -d --name "$NAME" \
        -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB="$DB" \
        -p "127.0.0.1:$PORT:5432" \
        -v "$VOLUME:/var/lib/postgresql" \
        --health-cmd "pg_isready -U $PGUSER -d $DB" \
        --health-interval 5s --health-retries 10 \
        --stop-timeout 60 \
        "$IMAGE" >/dev/null
      echo "contenedor $NAME creado"
    fi
    wait_ready
    ;;
  down)
    if installed; then
      systemctl --user stop "$SERVICE"
      wait_stopped
      # El servicio hace `podman rm`, así que no queda código de salida que consultar:
      # un apagado fallido se vería como fallo del servicio.
      if systemctl --user is-failed --quiet "$SERVICE"; then
        echo "el servicio terminó con error; revisa: ./scripts/db.sh logs" >&2; exit 1
      fi
    elif podman container exists "$NAME"; then
      podman stop -t 60 "$NAME" >/dev/null
      wait_stopped
      code=$(podman container inspect -f '{{.State.ExitCode}}' "$NAME")
      [ "$code" = 0 ] || { echo "postgres salió con código $code; revisa: ./scripts/db.sh logs" >&2; exit 1; }
    else
      echo "$NAME no existe"; exit 0
    fi
    echo "$NAME parado limpiamente"
    ;;
  logs)
    if installed; then journalctl --user -u "$SERVICE" -f -n 100
    else podman logs -f "$NAME"; fi
    ;;
  psql)   podman exec -it "$NAME" psql -U "$PGUSER" -d "$DB" ;;
  status)
    if installed; then systemctl --user status "$SERVICE" --no-pager || true
    else podman ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'; fi
    ;;
  reset)
    # Borra TODOS los datos. Pregunta antes porque no tiene vuelta atrás.
    read -rp "Esto borra todos los datos de $DB. ¿Seguro? (escribe 'si'): " ok
    [ "$ok" = "si" ] || { echo "cancelado"; exit 1; }
    if installed; then systemctl --user stop "$SERVICE" || true; fi
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    podman volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "borrado. Ejecuta './scripts/db.sh up' para empezar de cero."
    ;;
  *) echo "uso: $0 {install|uninstall|up|down|logs|psql|reset|status}" >&2; exit 1 ;;
esac
