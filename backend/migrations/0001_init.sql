-- Esquema inicial: usuario único, categorías y transacciones.
-- El dinero se guarda SIEMPRE como entero de céntimos (BIGINT). Nunca float.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT      NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    kind        TEXT        NOT NULL CHECK (kind IN ('income', 'expense')),
    bucket      TEXT                 CHECK (bucket IN ('needs', 'wants', 'savings')),
    color       TEXT        NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    icon        TEXT        NOT NULL DEFAULT 'circle',
    is_archived BOOLEAN     NOT NULL DEFAULT false,
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Invariante del dominio: un gasto pertenece a un cubo 50/30/20; un ingreso no.
    CONSTRAINT bucket_matches_kind CHECK (
        (kind = 'expense' AND bucket IS NOT NULL) OR
        (kind = 'income'  AND bucket IS NULL)
    )
);

-- Nombre único por usuario y tipo, insensible a mayúsculas y espacios.
CREATE UNIQUE INDEX categories_user_kind_name_uniq
    ON categories (user_id, kind, lower(btrim(name)));

CREATE TABLE transactions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id  UUID                 REFERENCES categories(id) ON DELETE SET NULL,
    kind         TEXT        NOT NULL CHECK (kind IN ('income', 'expense')),
    amount_cents BIGINT      NOT NULL CHECK (amount_cents > 0),
    occurred_on  DATE        NOT NULL,
    description  TEXT                 CHECK (description IS NULL OR length(description) <= 500),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transactions_user_date_idx ON transactions (user_id, occurred_on DESC, created_at DESC);
CREATE INDEX transactions_category_idx  ON transactions (category_id);

-- La coherencia kind(transacción) == kind(categoría) se valida en el handler:
-- una FK compuesta obligaría a duplicar `kind` en la tabla y a un índice extra
-- sobre categories(id, kind). Se documenta aquí para que no se pierda.
