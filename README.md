# PrestaVía Backend

Backend Node.js/Express que reemplaza Google Apps Script, sobre PostgreSQL
(Neon). Ya incluye **autenticación** (módulo 1) y **marketplace +
contraofertas** (módulo 2).

## Módulo 1 — Autenticación

- `POST /auth/login` — reemplaza `verificarCredenciales()`. Si la clave del
  usuario todavía está en texto plano (heredada de Sheets), la valida, la
  re-hashea con bcrypt automáticamente, y sigue normal. Devuelve un JWT.
- `POST /auth/actualizar-clave` — reemplaza `actualizarContrasenaObligatoria()`
  de `ActualizarPassword.html`. Apaga `requiere_cambio_clave`.
- `GET /health` — chequeo simple para que Render sepa que el servicio está vivo.
- Middleware `requiereAutenticacion` / `requiereRol(...)` en
  `src/middleware/auth.js`, protege todos los endpoints de los módulos
  siguientes.

Probado localmente de punta a punta (servidor real + Postgres real, no
mocks): login con clave incorrecta rechazado, login con clave heredada en
texto plano re-hasheada automáticamente y confirmada en la base, segundo
login ya usando bcrypt, y actualizar-clave apagando el flag correctamente.

## Módulo 2 — Marketplace + contraofertas

Reemplaza `Marketplace.gs`. Todas las rutas requieren JWT (header
`Authorization: Bearer ...`), y el usuario autenticado se toma del token,
nunca de un ID que mande el cliente (mejora de seguridad sobre el original,
que confiaba en el ID enviado desde el navegador).

- `GET /marketplace/oportunidades` (rol Prestamista) — lista oportunidades
  abiertas, **filtradas por país de residencia** (solo ve las del mismo país
  del prestamista, nunca cruza países), y solo si tiene la suscripción activa.
- `GET /marketplace/mis-solicitudes` (rol Prestatario) — sus propias
  solicitudes con estatus y cuota estimada.
- `GET /marketplace/mis-prestamos` (rol Prestamista) — préstamos que ya
  otorgó/financió.
- `POST /marketplace/contraoferta` (rol Prestamista) — `{ idOp, nuevaTasa,
  tasaMoraDiaria }`. Valida tasa entre 0.1%–30% anual, valida que la
  oportunidad siga "Abierta", y bloquea la fila con
  `SELECT ... FOR UPDATE` dentro de una transacción (reemplaza el
  `LockService.getScriptLock()` global de Apps Script — ahora solo se
  bloquea la operación específica, no todo el sistema).
- `POST /marketplace/responder` (rol Prestatario) — `{ idOp, aceptada, firma
  }`. Si acepta: calcula amortización (cuota mensual, monto neto a
  entregar tras 5% de comisión de plataforma cargada al prestamista, total a
  pagar) y marca "Financiada". Incluye una verificación de dueño
  (`el usuario autenticado debe ser el solicitante de esa operación`) que el
  Apps Script original no tenía.
- `POST /marketplace/solicitar-documentos` (rol Prestamista) — registra la
  solicitud de cédula + bien en garantía. **Nota:** el envío de correo al
  prestatario todavía no está conectado (falta elegir proveedor de email);
  por ahora el endpoint responde con éxito y deja constancia en la base,
  pero no se manda el correo. Está marcado con `// TODO EMAIL` en el código
  para no perder el pendiente.
- `GET /marketplace/documentos/:idOp` — links de los documentos subidos
  para esa operación (vacíos hasta que el prestatario los suba, en un
  módulo posterior).

Probado localmente de punta a punta contra Postgres real, con 3 usuarios
simulados (prestamista en RD, prestamista en Panamá, prestatario en RD) y
JWTs reales: filtrado por país correcto, tasa fuera de rango rechazada,
contraoferta válida aceptada, no se puede volver a ofertar una operación ya
tomada, un prestatario que no es el dueño no puede responder, el dueño real
acepta y la operación queda "Financiada" con cuota calculada correctamente,
`mis-solicitudes` / `mis-prestamos` reflejan el préstamo financiado, y
`solicitar-documentos` / `documentos/:idOp` responden bien.

## Módulo 3 — Generación de contratos

Reemplaza `GeneradorContratos.gs`. Genera el PDF del contrato de mutuo y un
pagaré digital cuando el prestamista asignado lo confirma sobre una
operación ya "Financiada".

**Decisión de arquitectura importante (la acordamos juntos antes de
construir este módulo):** en Apps Script, los PDFs se guardaban en Google
Drive. Aquí, para no depender de una cuenta de Drive ni de un servicio de
almacenamiento adicional, **los PDFs se guardan directamente en tu base de
datos de Neon** (como contenido binario, en la tabla nueva
`documentos_generados`). Por eso este módulo trae un archivo SQL adicional
que hay que correr en Neon antes de desplegar (ver más abajo,
"Antes de desplegar este módulo").

- `POST /contratos/generar` (rol Prestamista) — `{ idOp, firma }`. Solo lo
  puede ejecutar el prestamista asignado a esa operación. Genera el
  contrato + el pagaré, calcula los hashes de firma (SHA-256), inserta un
  código QR de verificación en el contrato, y avanza la operación a
  "Por_Desembolsar". Si ya existe un contrato para esa operación, no
  duplica — devuelve un aviso.
- `GET /contratos/oportunidad/:idOp` — metadatos del contrato de una
  operación (fecha de firma, hash, links a los PDFs).
- `GET /contratos/documento/:idDocumento` — descarga el PDF real (contrato
  o pagaré). Solo pueden descargarlo el prestatario y el prestamista
  involucrados en esa operación (o un Admin).

**Nota sobre el disparador de este módulo:** en Apps Script, el contrato se
generaba automáticamente cuando el prestamista APROBABA los documentos de
identidad y garantía que subía el prestatario (con revisión de IA de por
medio) — ese módulo de documentos + IA todavía no está construido (es el
siguiente en la lista, módulo 5). Por ahora, `POST /contratos/generar` es
la acción directa que hace el prestamista para generar el contrato, sin
esa revisión previa de documentos. Cuando construyamos el módulo de
documentos + IA, ese módulo llamará a este mismo servicio en vez de
duplicar la lógica, y quedará detrás de la aprobación real de documentos.

**Dos cosas pendientes que te aviso desde ya, para que no te tomen por
sorpresa (igual que con el correo del módulo 2):**
1. **Correos** (aviso al admin, al prestatario y al prestamista sobre la
   comisión) — todavía no están conectados, marcados con `// TODO EMAIL`.
2. **Firma electrónica certificada (DocuSeal)** — esa integración quedó
   pausada en una sesión anterior por limitaciones del plan gratuito de
   DocuSeal. Por ahora el contrato queda con un hash SHA-256 como evidencia
   técnica de integridad (válido, pero sin el nivel de certificación legal
   de un firmante electrónico externo). Cuando quieras retomarlo, hay que
   decidir entre pagar el plan Pro de DocuSeal u otro proveedor.

Probado localmente de punta a punta contra Postgres real: un prestamista
no asignado no puede generar el contrato de una operación ajena, un
prestatario no puede generarlo (rol equivocado), el prestamista asignado sí
puede, no se duplica si ya existe, el PDF del contrato y el del pagaré se
generan correctamente (contenido, cláusulas legales, QR de verificación, y
firmas visibles), la descarga del PDF respeta que solo las partes
involucradas puedan verlo, y la operación pasa a "Por_Desembolsar".

## ⚠️ Antes de desplegar el módulo 3: correr una migración en Neon

Este módulo necesita una tabla nueva (`documentos_generados`) que no existe
todavía en tu base de datos. Antes de subir este código a producción:

1. Entra al **SQL Editor** de tu proyecto en Neon (el mismo lugar donde
   corriste `001_schema.sql` durante la migración).
2. Abre el archivo `sql/002_documentos_generados.sql` (incluido en esta
   entrega) y pega todo su contenido en el SQL Editor.
3. Ejecútalo. Deberías ver `CREATE TABLE` y `CREATE INDEX` sin errores.

Solo hace falta correrlo **una vez**. Si despliegas el código antes de
correr esta migración, el módulo de contratos fallará (la tabla no
existirá) — el resto de la app (auth, marketplace) seguirá funcionando
normal.

## Cómo correrlo tú (local, antes de desplegar)

1. `npm install`
2. Copia `.env.example` a `.env` y llena:
   - `DATABASE_URL`: tu connection string de Neon (la misma de la migración).
   - `JWT_SECRET`: genera uno con `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
3. `npm run dev` (se reinicia solo si cambias código) o `npm start`.
4. Prueba con curl o Postman:
   ```
   curl -X POST http://localhost:3000/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"TU_EMAIL_REAL","clave":"LA_CLAVE_QUE_TENIA_EN_SHEETS"}'
   ```

## Desplegar en Render

1. Sube esta carpeta a un repositorio de GitHub (Render se conecta a GitHub,
   no acepta subir un zip directo para despliegue continuo).
2. En Render: **New +** → **Web Service** → conecta el repo.
3. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. En la pestaña **Environment** del servicio, agrega las mismas variables
   de `.env.example` (`DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
   `BCRYPT_ROUNDS`) — Render las inyecta como variables reales, `PORT` la
   define Render solo, no hace falta ponerla.
5. Deploy. Render te da una URL tipo `https://prestavia-backend.onrender.com`.

**Nota sobre el plan Free de Render:** el servicio se "duerme" tras ~15 min
sin tráfico, y el primer request después tarda unos 30-50 segundos en
despertar. Para una app en producción real esto afecta la primera carga de
cualquier usuario después de un rato de inactividad — cuando tengas
usuarios pagando, vale la pena subir al plan pago ($7/mes) que no duerme.
Por ahora, para arrancar gratis, es aceptable.

## Próximos módulos (en este orden, por prioridad de riesgo)

1. ~~Auth (login + re-hasheo)~~ ✅ desplegado en producción
2. ~~Marketplace + contraofertas (`Marketplace.gs`)~~ ✅ este entregable (falta desplegar)
3. ~~Generación de contratos (`GeneradorContratos.gs`)~~ ✅ este entregable (falta desplegar)
4. Pagos y cobranzas (`RecepcionPagos.gs`, `ActualizacionCobranzas.gs`)
5. Registro de usuarios + documentos + IA (`GestionUsuarios.gs`, `DocumentosUsuario.gs`, `AuditoriaIA.gs`)
6. Admin panel (`AdminPanel.gs`, `AdminPanelRootBackend.gs`)
7. Cron de mora y vencimientos de suscripción (`CronPlanificadores.gs`) — en
   Render esto se resuelve con un **Cron Job** de Render (no con
   `setInterval` dentro del web service, que se duerme).
