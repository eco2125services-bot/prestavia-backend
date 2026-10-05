-- PrestaVía — Migración incremental 006
--
-- Columna para guardar el link del finiquito (constancia de préstamo
-- pagado en su totalidad) que se genera automáticamente cuando se valida
-- la última cuota pendiente de una operación. Vive junto al contrato
-- porque es el mismo documento "del expediente" de esa operación.

ALTER TABLE contratos_firmados ADD COLUMN IF NOT EXISTS url_finiquito TEXT;
