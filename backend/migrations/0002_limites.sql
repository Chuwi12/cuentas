-- Límites de cordura en los movimientos (ver MAX_AMOUNT_CENTS, MIN_DATE y
-- MAX_DATE en src/domain.rs). Sin tope de importe, dos movimientos enormes en
-- el mismo mes desbordaban SUM(...)::BIGINT y el resumen de ese mes daba 500.
-- El rango de fechas es el mismo que aceptan los informes: fuera de él un
-- movimiento no aparecía en ninguno.

ALTER TABLE transactions
    ADD CONSTRAINT transactions_amount_max CHECK (amount_cents <= 100000000000),
    ADD CONSTRAINT transactions_occurred_on_range
        CHECK (occurred_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31');
