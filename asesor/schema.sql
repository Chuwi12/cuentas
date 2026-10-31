-- Esquema de la memoria del asesor (BD propia). Idempotente: se aplica en cada arranque.
-- Contrato y razones de diseño: docs/ASESOR.md.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS memorias (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL,   -- sin FK: los usuarios viven en la otra BD
    tipo       TEXT        NOT NULL CHECK (tipo IN ('analisis', 'conversacion')),
    month      TEXT                 CHECK (month ~ '^\d{4}-\d{2}$'),
    content    TEXT        NOT NULL CHECK (length(content) <= 8000),
    metadata   JSONB       NOT NULL DEFAULT '{}',
    embedding  vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un único análisis por usuario y mes: regenerarlo reemplaza el anterior.
CREATE UNIQUE INDEX IF NOT EXISTS memorias_analisis_mes
    ON memorias (user_id, month) WHERE tipo = 'analisis';
