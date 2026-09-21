#!/usr/bin/env bash
# Gestión del PostgreSQL de desarrollo en un contenedor rootless de podman.
# No requiere podman-compose. Uso: ./scripts/db.sh {up|down|logs|psql|reset|status}
set -euo pipefail

NAME=finanzas-db
IMAGE=docker.io/library/postgres:18-alpine
VOLUME=finanzas-pgdata
PORT=5433
DB=finanzas
USER=finanzas
PASS=finanzas_dev

case "${1:-up}" in
  up)
    if podman container exists "$NAME"; then
      podman start "$NAME" >/dev/null
      echo "contenedor $NAME arrancado (ya existía)"
    else
      podman volume exists "$VOLUME" || podman volume create "$VOLUME" >/dev/null
      podman run -d --name "$NAME" \
        -e POSTGRES_USER="$USER" -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB="$DB" \
        -p "127.0.0.1:$PORT:5432" \
        -v "$VOLUME:/var/lib/postgresql" \
        --health-cmd "pg_isready -U $USER -d $DB" \
        --health-interval 5s --health-retries 10 \
        "$IMAGE" >/dev/null
      echo "contenedor $NAME creado"
    fi
    printf 'esperando a postgres'
    for _ in $(seq 1 40); do
      if podman exec "$NAME" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
        echo " · listo en 127.0.0.1:$PORT"; exit 0
      fi
      printf '.'; sleep 1
    done
    echo; echo "postgres no respondió a tiempo; revisa: ./scripts/db.sh logs" >&2; exit 1
    ;;
  down)   podman stop "$NAME" >/dev/null && echo "$NAME parado" ;;
  logs)   podman logs -f "$NAME" ;;
  psql)   podman exec -it "$NAME" psql -U "$USER" -d "$DB" ;;
  status) podman ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' ;;
  reset)
    # Borra TODOS los datos. Pregunta antes porque no tiene vuelta atrás.
    read -rp "Esto borra todos los datos de $DB. ¿Seguro? (escribe 'si'): " ok
    [ "$ok" = "si" ] || { echo "cancelado"; exit 1; }
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    podman volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "borrado. Ejecuta './scripts/db.sh up' para empezar de cero."
    ;;
  *) echo "uso: $0 {up|down|logs|psql|reset|status}" >&2; exit 1 ;;
esac
