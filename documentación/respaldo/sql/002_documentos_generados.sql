-- PrestaVía — Migración incremental 002
-- Agrega la tabla que guarda el contenido REAL (bytes) de los PDFs de
-- contratos y pagarés generados por el módulo 3 (GeneradorContratos.gs).
--
-- Decisión de arquitectura: en Apps Script estos PDFs vivían en Google
-- Drive y 'contratos_firmados.url_documento_pdf' guardaba un link real de
-- Drive. Ahora, en vez de depender de una cuenta de Drive o de un servicio
-- de almacenamiento en la nube adicional, los PDFs se guardan directamente
-- en esta misma base de datos (Neon) como BYTEA. Es la opción recomendada:
-- cero cuentas nuevas que administrar, y quedan tan seguros/respaldados
-- como el resto de tu información. El límite práctico es el espacio total
-- del plan de Neon (0.5 GB en el plan gratuito), que alcanza cómodo para
-- un volumen moderado de contratos.
--
-- 'contratos_firmados.url_documento_pdf' y 'lien_ucc_registro' (reutilizada
-- para el pagaré, igual que en el Apps Script original) ahora guardan una
-- ruta interna de la API (ej. "/contratos/documento/DOC-xxxx") en vez de un
-- link de Drive. El navegador del usuario descarga el PDF real pidiendo esa
-- ruta al backend, que lo sirve desde esta tabla.

CREATE TABLE documentos_generados (
  id_documento     TEXT PRIMARY KEY,
  id_oportunidad   TEXT NOT NULL REFERENCES oportunidades_mercado (id_oportunidad),
  tipo_documento   TEXT NOT NULL CHECK (tipo_documento IN ('Contrato', 'Pagare')),
  nombre_archivo   TEXT NOT NULL,
  contenido_pdf    BYTEA NOT NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_docgen_oportunidad ON documentos_generados (id_oportunidad);
