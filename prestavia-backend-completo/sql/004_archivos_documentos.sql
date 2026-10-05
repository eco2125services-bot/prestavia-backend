-- PrestaVía — Migración incremental 004
-- Tabla genérica para el contenido (bytes) de los documentos que suben los
-- prestatarios: cédula de identidad y fotos/documentos del bien en
-- garantía. Mismo patrón que 002 (contratos) y 003 (comprobantes de pago):
-- se guarda en esta base de datos en vez de depender de Google Drive.
--
-- 'documentos_adjuntos.url_archivo' ahora guarda una ruta interna de la
-- API (ej. "/documentos/archivo/ARCH-xxxx") en vez de un link de Drive.

CREATE TABLE archivos_documentos (
  id_archivo       TEXT PRIMARY KEY,
  contenido        BYTEA NOT NULL,
  mime_type        TEXT NOT NULL,
  nombre_archivo   TEXT NOT NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
