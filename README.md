# Cuentas

Finanzas personales con la regla 50/30/20. Apuntas lo que entra y lo que sale, y la app
te enseña cómo se reparte tu dinero entre necesidades (50 %), deseos (30 %) y ahorro (20 %).

App de **un solo usuario**: la primera persona que se registra crea la cuenta y el registro
se cierra. Después se entra con email y contraseña desde cualquier dispositivo.

## Stack

| Parte    | Tecnología |
|----------|------------|
| Frontend | Vite 8, React 19, TypeScript, Tailwind v4, TanStack Query, Recharts |
| Backend  | Rust, axum 0.8, sqlx 0.9 |
| Datos    | PostgreSQL 18 en un contenedor de podman |
| Sesión   | JWT en cookie `httpOnly` (el token nunca es accesible desde JavaScript), contraseñas con Argon2id |

## Arrancar

Requisitos: Rust ≥ 1.94, Node ≥ 20, podman.

```bash
cp .env.example .env
# pon un secreto propio en JWT_SECRET:
openssl rand -base64 48
./scripts/dev.sh          # BD + backend (:8080) + frontend (:5173)
```

Abre http://localhost:5173 y crea tu cuenta. Las migraciones se aplican solas al arrancar el
backend.

Solo la base de datos: `./scripts/db.sh {up|down|status|logs|psql|reset}`.

## Cómo se calcula el 50/30/20

- La base es lo que **ingresas** en el mes.
- Cada gasto va a un cubo según su categoría. Puedes cambiar el cubo de cualquier categoría
  desde la pantalla Categorías (por ejemplo, el gym viene en Deseos, pero si para ti es una
  necesidad, muévelo).
- **El ahorro incluye lo que no gastas**: `ahorro = gastos de categorías de ahorro (inversión…)
  + (ingresos − todos los gastos)`, con mínimo 0. Si no, alguien que ahorra sin apuntarlo
  aparecería con 0 % de ahorro.
- Los gastos sin categoría no cuentan en ningún cubo, pero sí reducen el ahorro.
- Todo el dinero se guarda en céntimos enteros: no hay errores de redondeo con decimales.

Detalle completo en [`docs/API.md`](docs/API.md).

## Estructura

```
backend/   API en Rust (auth/, categories/, transactions/, summary/) y migraciones SQL
frontend/  SPA en React (pages/, components/ui.tsx, lib/)
docs/      contrato de la API
scripts/   db.sh (PostgreSQL en podman) y dev.sh (todo junto)
```

## Producción

Pon `COOKIE_SECURE=true` y sirve la app detrás de HTTPS. Sin HTTPS, la cookie de sesión y la
contraseña viajarían en claro.
