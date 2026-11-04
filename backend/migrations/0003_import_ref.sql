-- Referencia de importación: identifica un movimiento importado desde CSV para
-- que reimportar un fichero solapado no lo duplique. Es `ref:<referencia del
-- banco>` o `fp:<huella>` (ver src/import). Los movimientos creados a mano la
-- dejan en NULL y no participan en la detección de duplicados.

ALTER TABLE transactions
    ADD COLUMN import_ref TEXT
        CONSTRAINT transactions_import_ref_len CHECK (length(import_ref) <= 512);

-- Parcial: solo indexa lo importado. También es el árbitro del
-- `ON CONFLICT DO NOTHING` que resuelve dos importaciones simultáneas.
CREATE UNIQUE INDEX transactions_user_import_ref_uniq
    ON transactions (user_id, import_ref)
    WHERE import_ref IS NOT NULL;
