# Contrato de API — finanzas

Fuente de verdad única. Backend y frontend DEBEN ajustarse a esto.
Base URL en dev: `/api` (proxy de Vite hacia `http://127.0.0.1:8080`).

## Convenciones

- Todo el dinero viaja como **entero de céntimos** (`i64` / `number`). Nunca decimales.
  `12,34 €` → `1234`.
- Fechas de operación: `YYYY-MM-DD` (date, sin hora, sin zona).
- Timestamps: RFC3339 UTC.
- IDs: UUID v4 en string.
- Auth: cookie `auth_token` (`httpOnly`, `SameSite=Lax`, `Path=/`). No hay header Bearer.
- Errores: siempre `{"error": {"code": "<slug>", "message": "<texto en español>"}}`
  con el status HTTP adecuado. Códigos: `unauthorized`, `forbidden`, `not_found`,
  `validation`, `conflict`, `registration_closed`, `invalid_credentials`, `internal`.

## Enums

```
Kind   = "income" | "expense"
Bucket = "needs" | "wants" | "savings"     // 50 / 30 / 20
```

Regla dura: una categoría `expense` tiene `bucket` NO nulo; una categoría `income`
tiene `bucket` nulo. Se valida en BD (CHECK) y en el handler.

## Modelos JSON

```jsonc
User     { "id": uuid, "email": string, "created_at": rfc3339 }

Category { "id": uuid, "name": string, "kind": Kind, "bucket": Bucket|null,
           "color": string /* hex #rrggbb */, "icon": string /* nombre lucide */,
           "is_archived": bool, "sort_order": int }

Transaction { "id": uuid, "kind": Kind, "amount_cents": i64 /* siempre > 0 */,
              "category_id": uuid|null, "category": Category|null,
              "occurred_on": "YYYY-MM-DD", "description": string|null,
              "created_at": rfc3339 }
```

`amount_cents` es siempre positivo; el signo lo determina `kind`.

## Endpoints

### Auth — `/api/auth`

| Método | Ruta        | Body                     | Respuesta                        |
|--------|-------------|--------------------------|----------------------------------|
| GET    | `/status`   | —                        | `200 {"registration_open": bool}` |
| POST   | `/register` | `{email, password}`      | `201 {user}` + cookie · `403 registration_closed` si ya existe un usuario |
| POST   | `/login`    | `{email, password}`      | `200 {user}` + cookie · `401 invalid_credentials` |
| POST   | `/logout`   | —                        | `204` + cookie vaciada            |
| GET    | `/me`       | —                        | `200 {user}` · `401`             |

`password`: mínimo 12 caracteres. Hash Argon2id. El registro solo funciona si la
tabla `users` está vacía (app de un solo usuario).

### Categorías — `/api/categories`

| Método | Ruta    | Body | Respuesta |
|--------|---------|------|-----------|
| GET    | `/`     | `?include_archived=bool` (def. false) | `200 [Category]` ordenado por `sort_order, name` |
| POST   | `/`     | `{name, kind, bucket?, color?, icon?}` | `201 Category` · `409 conflict` si nombre duplicado en ese `kind` |
| PATCH  | `/:id`  | `{name?, bucket?, color?, icon?, is_archived?, sort_order?}` | `200 Category` |
| DELETE | `/:id`  | — | `204`. Las transacciones que la usaban quedan con `category_id = null` (ON DELETE SET NULL) |

### Transacciones — `/api/transactions`

| Método | Ruta   | Parámetros / Body | Respuesta |
|--------|--------|-------------------|-----------|
| GET    | `/`    | `?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=&category_id=&bucket=&q=&page=1&per_page=50` | `200 {"items":[Transaction], "total": int, "page": int, "per_page": int}` ordenado por `occurred_on DESC, created_at DESC` |
| POST   | `/`    | `{kind, amount_cents, category_id?, occurred_on, description?}` | `201 Transaction` |
| PATCH  | `/:id` | cualquier subconjunto de lo anterior | `200 Transaction` |
| DELETE | `/:id` | — | `204` |

Validación: `amount_cents > 0`; el `kind` de la transacción debe coincidir con el
`kind` de la categoría referenciada; `per_page` máximo 200.

### Resumen 50/30/20 — `/api/summary`

`GET /api/summary?month=YYYY-MM` (por defecto: mes actual)

```jsonc
{
  "month": "2026-09",
  "income_cents": 250000,
  "expense_cents": 190000,
  "buckets": [
    { "bucket": "needs",   "target_pct": 50, "target_cents": 125000,
      "actual_cents": 100000, "delta_cents": -25000, "actual_pct": 40.0 },
    { "bucket": "wants",   "target_pct": 30, "target_cents": 75000,
      "actual_cents": 60000,  "delta_cents": -15000, "actual_pct": 24.0 },
    { "bucket": "savings", "target_pct": 20, "target_cents": 50000,
      "actual_cents": 90000,  "delta_cents": 40000,  "actual_pct": 36.0 }
  ],
  "uncategorized_expense_cents": 0,
  "by_category": [ { "category": Category, "amount_cents": i64, "pct_of_income": f64 } ]
}
```

**Semántica del cubo `savings`** (decisión explícita, documentada porque no es obvia):
`actual_cents` de `savings` = gastos con `bucket = "savings"` (p. ej. inversión)
**más** el dinero no gastado del mes (`income - todos los gastos`), con suelo en 0.
Motivo: en la regla 50/30/20 el 20% es "ahorro", y el dinero que simplemente no
gastas también es ahorro. Si solo contáramos las transacciones marcadas como
inversión, alguien que ahorra sin registrarlo aparecería con 0% de ahorro, que es
falso. `delta_cents = actual - target` (positivo = por encima del objetivo).

`target_*` se calculan sobre `income_cents`. Si `income_cents = 0`, todos los
`target_cents` son 0 y `actual_pct` es 0 (no dividir por cero).

`GET /api/summary/trend?months=12`

```jsonc
{ "points": [ { "month": "2026-09", "income_cents": i64, "needs_cents": i64,
                "wants_cents": i64, "savings_cents": i64 } ] }
```

Ordenado del mes más antiguo al más reciente, incluyendo meses sin datos (a 0).

## Categorías semilla

Creadas automáticamente al registrarse el usuario. El `bucket` es editable después.

| Nombre      | kind    | bucket  | icono (lucide) | color     |
|-------------|---------|---------|----------------|-----------|
| Nómina      | income  | null    | `wallet`       | `#2f7d5e` |
| Extras      | income  | null    | `circle-plus`  | `#4a9c78` |
| Alquiler    | expense | needs   | `house`        | `#c2410c` |
| Comida      | expense | needs   | `utensils`     | `#d97706` |
| Suministros | expense | needs   | `zap`          | `#b45309` |
| Transporte  | expense | needs   | `bus`          | `#a16207` |
| Gym         | expense | wants   | `dumbbell`     | `#7c3aed` |
| Ropa        | expense | wants   | `shirt`        | `#9333ea` |
| Ocio        | expense | wants   | `party-popper` | `#c026d3` |
| Inversión   | expense | savings | `trending-up`  | `#0369a1` |

Nota: "Gym" se siembra como `wants` (30%). Es discutible —para mucha gente es salud,
no capricho— y por eso el cubo es editable desde la UI.
