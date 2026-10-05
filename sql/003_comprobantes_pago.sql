-- PrestaVía — Migración incremental 003
-- Agrega la tabla que guarda el contenido REAL (bytes) de los comprobantes
-- de pago que suben prestatarios (pago de cuota) y prestamistas (pago de
-- comisión de plataforma). Misma decisión de arquitectura que en la
-- migración 002 para los contratos: en vez de Google Drive, se guarda
-- directo en esta base de datos (Neon) como BYTEA.
--
-- 'registro_pagos.url_comprobante' y 'pagos_comision.url_comprobante' ahora
-- guardan una ruta interna de la API (ej. "/pagos/comprobante/CMP-xxxx") en
-- vez de un link de Drive.

CREATE TABLE comprobantes_pago (
  id_comprobante   TEXT PRIMARY KEY,
  contenido        BYTEA NOT NULL,
  mime_type        TEXT NOT NULL,
  nombre_archivo   TEXT NOT NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
