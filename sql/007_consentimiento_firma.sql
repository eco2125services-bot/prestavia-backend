-- PrestaVía — Migración incremental 007
--
-- Hallazgo de seguridad (BAJO) del informe de auditoría: la "firma digital"
-- del prestatario era un campo de texto libre (escribir su nombre) sin
-- ningún otro dato que la respalde — fácil de repudiar ("yo no firmé eso").
-- Además, para cuando se generaba el contrato (que puede ser mucho después,
-- tras la revisión de documentos), ese texto tecleado en el momento de
-- aceptar la oferta ni siquiera se usaba: el hash de firma se calculaba con
-- el nombre legal registrado, no con lo que la persona realmente tecleó al
-- aceptar.
--
-- Esta migración agrega un registro de consentimiento real: qué se
-- escribió, desde qué IP y con qué user-agent, en el momento exacto de
-- aceptar la oferta — y columnas para que esa evidencia viaje junto con el
-- contrato firmado, no solo en el log de auditoría.

CREATE TABLE IF NOT EXISTS aceptaciones_prestatario (
  id_oportunidad   TEXT PRIMARY KEY REFERENCES oportunidades_mercado(id_oportunidad),
  firma_texto      TEXT NOT NULL,
  ip_aceptacion    TEXT,
  user_agent       TEXT,
  fecha_aceptacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contratos_firmados ADD COLUMN IF NOT EXISTS ip_prestatario TEXT;
ALTER TABLE contratos_firmados ADD COLUMN IF NOT EXISTS ip_prestamista TEXT;
ALTER TABLE contratos_firmados ADD COLUMN IF NOT EXISTS user_agent_prestatario TEXT;
