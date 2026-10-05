-- PrestaVía — Migración incremental 005
--
-- Problema real encontrado en producción: los documentos de identidad y
-- del bien en garantía se guardaban SOLO por usuario (id_usuario), nunca
-- por operación/préstamo (id_oportunidad). Si un prestatario tenía dos
-- préstamos activos con dos prestamistas distintos, cada prestamista podía
-- terminar viendo los documentos del OTRO préstamo (incluyendo fotos del
-- bien en garantía de una operación que no le pertenece) — confirmado en
-- documentos.controller.js (getArchivo), cuyo chequeo de permisos solo
-- verificaba "¿eres prestamista de ALGUNA operación de este prestatario?",
-- no "¿eres prestamista de ESTA operación específica?".
--
-- Esta migración agrega la columna que faltaba y rellena (best-effort) los
-- documentos que ya existen: si el usuario tenía una sola operación activa
-- al momento de subir el documento, se la asignamos; si tenía varias, queda
-- en NULL (ambiguo) y un administrador puede revisarlo a mano desde Neon.

ALTER TABLE documentos_adjuntos ADD COLUMN IF NOT EXISTS id_oportunidad TEXT;

-- Solicitudes de documentos que un prestamista le hace a un prestatario
-- sobre una operación puntual — antes esto solo quedaba en el log de
-- auditoría (invisible para el prestatario). Ahora queda aquí para
-- mostrarse en su dashboard, por operación, con el mensaje exacto.
CREATE TABLE IF NOT EXISTS solicitudes_documentos (
  id_oportunidad   TEXT PRIMARY KEY REFERENCES oportunidades_mercado(id_oportunidad),
  mensaje          TEXT,
  fecha_solicitud  TIMESTAMPTZ NOT NULL DEFAULT now(),
  atendida         BOOLEAN NOT NULL DEFAULT false
);

-- Backfill best-effort: documentos de prestatarios que SOLO tenían una
-- operación activa (o cerrada) al momento de la migración.
UPDATE documentos_adjuntos d
SET id_oportunidad = sub.id_oportunidad
FROM (
  SELECT id_solicitante, MIN(id_oportunidad) AS id_oportunidad
  FROM oportunidades_mercado
  GROUP BY id_solicitante
  HAVING COUNT(*) = 1
) sub
WHERE d.id_usuario = sub.id_solicitante AND d.id_oportunidad IS NULL;
