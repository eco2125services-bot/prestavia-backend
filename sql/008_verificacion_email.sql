-- PrestaVía — Migración incremental 008
--
-- Hallazgo de seguridad (MEDIO) del informe de auditoría: no había
-- verificación de correo. Cualquiera podía registrar la cuenta de OTRA
-- persona usando su email real (sin poder acceder nunca, porque la clave
-- temporal se mostraba solo en pantalla — pero sí dejaba una cuenta
-- "squateando" ese correo, y en el caso de un prestatario, publicaba una
-- solicitud de préstamo real a su nombre sin su consentimiento).
--
-- Diseño: la cuenta real en `usuarios` (y, para un prestatario, su activo
-- en garantía + su solicitud en el marketplace) ya NO se crea al llenar el
-- formulario — se crea recién cuando la persona hace clic en el enlace de
-- verificación que le llega a SU correo. Mientras tanto, los datos del
-- formulario quedan en esta tabla temporal.

CREATE TABLE IF NOT EXISTS registros_pendientes (
  token        TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  rol          TEXT NOT NULL CHECK (rol IN ('Prestamista', 'Prestatario')),
  datos        JSONB NOT NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en    TIMESTAMPTZ NOT NULL
);

-- Único por email (en minúsculas) para que un reintento de registro
-- reemplace el token pendiente anterior en vez de acumular filas — así un
-- enlace viejo (ya reemplazado) deja de servir.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registros_pendientes_email ON registros_pendientes (lower(email));

CREATE INDEX IF NOT EXISTS idx_registros_pendientes_expira ON registros_pendientes (expira_en);
