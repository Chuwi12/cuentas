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

### Informes — `/api/reports`

Parámetros comunes (query string) de ambas rutas:

| param    | valores                         | defecto   | notas |
|----------|---------------------------------|-----------|-------|
| `period` | `week` \| `month` \| `year`     | `month`   | La semana es ISO: lunes a domingo. |
| `date`   | `YYYY-MM-DD`                    | hoy       | Cualquier día del periodo; el servidor lo normaliza. Rango válido 2000-01-01 a 2100-12-31. |
| `scope`  | `expenses` \| `income` \| `all` | `all`     | Filtra `series`, `by_category`, `top_transactions` y el CSV. `totals`, `previous`, `buckets` e `insights` no dependen del scope. |

Un valor inválido responde `422 validation` con el mensaje en español.

`GET /api/reports`

```jsonc
{
  "period":   { "kind": "month", "from": "2026-09-01", "to": "2026-09-30" },  // `to` inclusivo
  "scope": "all",
  "totals": {
    "income_cents": 250000, "expense_cents": 180000, "net_cents": 70000,
    "transaction_count": 42,
    "savings_rate_bp": 2800        // net / income * 10000, redondeado; null si income == 0
  },
  "previous": {                     // mismo tipo de periodo, inmediatamente anterior
    "period": { "kind": "month", "from": "2026-08-01", "to": "2026-08-31" },
    "totals": { /* misma forma que totals */ }
  },
  "series": [                       // week: 7 días · month: cada día · year: 12 meses
    { "from": "2026-09-01", "to": "2026-09-01", "income_cents": 0, "expense_cents": 1250 }
  ],                                // siempre completa: los huecos salen a 0
  "by_category": [                  // orden: amount_cents desc
    { "category_id": "uuid|null", "name": "Supermercado", "color": "#16a34a",
      "kind": "expense", "bucket": "needs", "amount_cents": 42000, "count": 9,
      "share_bp": 2333 }            // % sobre el total de SU tipo en el periodo
  ],                                // sin categoría: category_id null, name "Sin categoría", color "#9ca3af", bucket null
  "buckets": [                      // solo gastos; siempre 4 filas en este orden
    { "bucket": "needs",   "amount_cents": 90000, "target_cents": 125000, "income_share_bp": 3600 },
    { "bucket": "wants",   "amount_cents": 60000, "target_cents": 75000,  "income_share_bp": 2400 },
    { "bucket": "savings", "amount_cents": 20000, "target_cents": 50000,  "income_share_bp": 800 },
    { "bucket": null,      "amount_cents": 10000, "target_cents": null,   "income_share_bp": 400 }
  ],
  "top_transactions": [             // máx. 10, mayor importe primero, dentro de scope
    { "id": "uuid", "occurred_on": "2026-09-03", "kind": "expense", "amount_cents": 65000,
      "description": "Alquiler", "category_name": "Vivienda", "category_color": "#2563eb" }
  ],                                // description y category_* pueden ser null
  "insights": [
    { "code": "top_category", "level": "info",
      "message": "Vivienda concentra el 36 % del gasto (650,00 €)." }
  ]
}
```

Porcentajes en puntos básicos enteros (`_bp`, 10000 = 100 %).

- **Cubos.** `buckets` cuenta solo gasto registrado: a diferencia de `/api/summary`, no suma el
  dinero no gastado al ahorro. Los objetivos usan el mismo reparto que el resumen (50 % y 30 %
  truncados; el ahorro se lleva el resto). `target_cents` e `income_share_bp` son `null` si no
  hubo ingresos; la fila sin cubo (gasto sin categoría) nunca tiene objetivo.
- **Insights.** Describen el periodo completo, sea cual sea el `scope`. Van en este orden y se
  omiten las que no aplican; `level` es `good`, `info` o `warning`:

  | `code`            | nivel | cuándo |
  |-------------------|-------|--------|
  | `empty`           | info | no hay movimientos; es la única que se devuelve |
  | `negative_net`    | warning | gastos mayores que ingresos |
  | `savings_rate`    | good si ≥ 20 %, si no info | hay ingresos y `net >= 0` |
  | `expense_change`  | warning si sube ≥ 15 %, good si baja ≥ 15 % | el gasto anterior es > 0 y el cambio llega al 15 % |
  | `top_category`    | info | hay gastos: la categoría de mayor importe (incluye «Sin categoría») |
  | `bucket_over`     | warning | solo `month`/`year` con ingresos: una por cubo necesidades/deseos que supera su objetivo |
  | `largest_expense` | info | hay gastos |
  | `daily_average`   | info | hay gastos; divide entre los días del periodo entero, no los transcurridos |
  | `uncategorized`   | info | hay gasto sin categoría |

`GET /api/reports/export.csv`

Mismos parámetros más `detail=transactions|categories` (por defecto `transactions`).

- Cabeceras: `Content-Type: text/csv; charset=utf-8`,
  `Content-Disposition: attachment; filename="cuentas-<scope>-<period>-<from>.csv"`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Formato para Excel en español: UTF-8 con BOM, separador `;`, fin de línea CRLF y decimales con
  coma (`-12,50`, sin separador de miles). Comillas y saltos de línea según RFC 4180.
- Protección contra inyección de fórmulas: todo texto que empiece por `=`, `+`, `-`, `@`,
  tabulador o retorno de carro se prefija con `'`. Los importes generados por el servidor no se tocan.
- `transactions`: `fecha;tipo;categoría;cubo;descripción;importe`. Fecha `YYYY-MM-DD`, tipo
  `ingreso|gasto`, cubo `necesidades|deseos|ahorro|` (vacío si no aplica), «Sin categoría» si no
  tiene categoría, gastos en negativo. Orden: fecha y hora de alta ascendentes.
- `categories`: `categoría;tipo;cubo;movimientos;importe;porcentaje`, con el importe firmado igual
  que arriba y el porcentaje como `36,00` sobre el total de su tipo.
- Máximo 100 000 filas; si se supera, `422 validation`
  («Demasiados movimientos para exportar; acota el periodo»).

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
