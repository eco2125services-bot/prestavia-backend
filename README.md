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

## Módulo 4 — Pagos y cobranzas

Reemplaza `RecepcionPagos.gs`, `PagoComision.gs` y `ActualizacionCobranzas.gs`
(y la parte de `Amortizacion.gs` que genera la tabla de cuotas real). Es el
módulo que conecta todo el ciclo: comisión de plataforma → autorización de
desembolso → generación de cuotas → reporte y validación de pagos → cierre
del préstamo.

**Introduce el rol Admin por primera vez** (ya existía en el esquema de la
base de datos, pero ningún módulo anterior tenía rutas para él). Todo lo
que cuelga de `/admin/*` exige que el usuario autenticado tenga
`rol = 'Admin'` en la tabla `usuarios` — si necesitas convertir tu propio
usuario en Admin para probarlo, corre en el SQL Editor de Neon:
```sql
UPDATE usuarios SET rol = 'Admin' WHERE email = 'TU_EMAIL_DE_ADMIN';
```

Rutas para el **Prestatario**:
- `GET /pagos/mis-cuotas` — todas sus cuotas pendientes, en todos sus préstamos.
- `GET /pagos/resumen/:idOp` — cuotas pendientes/vencidas y saldo total de un préstamo específico.
- `POST /pagos/reportar` — `{ idPago, montoPagado, metodoPago, referencia, archivoBase64?, archivoMimeType?, archivoNombre? }`. Reporta el pago de una cuota (con comprobante opcional). Queda "Pendiente" de validación.

Rutas para el **Prestamista**:
- `POST /pagos/comision/reportar` — `{ idOportunidad, montoPagado, metodoPago, referencia, archivoBase64?, ... }`. Reporta el pago de la comisión de originación (5%), retenida del monto del préstamo.
- `GET /pagos/comision/pendiente` — encuentra automáticamente si tiene alguna operación esperando ese pago (para auto-llenar el formulario).

Rutas para el **Admin**:
- `GET /admin/comisiones/pendientes` / `POST /admin/comisiones/:idComision/aprobar` — aprobar o rechazar la comisión reportada por el prestamista.
- `POST /admin/prestamos/:idOp/autorizar-desembolso` — solo funciona si la comisión ya está aprobada. Pasa la operación a "En_Cobro", bloquea la garantía, y genera automáticamente la tabla de amortización real (todas las cuotas en `control_pagos`, con candado anti-duplicados).
- `GET /admin/pagos/pendientes` / `POST /admin/pagos/:idTransaccion/validar` — aprobar o rechazar un pago de cuota reportado. Al aprobar, aplica el monto contra las cuotas pendientes en orden (cuotas completas → "Pagado"; un remanente que no alcanza para una cuota entera se aplica como abono adelantado). Si ya no quedan cuotas pendientes, cierra el préstamo ("Pagada"), libera la garantía, y bonifica la reputación de ambas partes (+5 por cada cuota pagada a tiempo, +25 al prestatario y +15 al prestamista por completar el préstamo).

Descarga de comprobantes: `GET /pagos/comprobante/:idComprobante` (misma
decisión de guardar el contenido en Neon en vez de Drive, ver más abajo).

Probado localmente de punta a punta contra Postgres real, simulando el
ciclo completo con 3 usuarios (prestamista, prestatario, admin): el
desembolso no se autoriza si la comisión no está aprobada; al aprobarla y
autorizar, se genera la tabla de amortización correcta y no se duplica si
se intenta de nuevo; el prestatario reporta un pago con comprobante, el
admin lo valida y la cuota queda "Pagada"; un pago que cubre varias cuotas
de una vez las marca todas y cierra el préstamo, libera la garantía, y
bonifica la reputación y el contador de préstamos exitosos de ambas
partes; los controles de acceso por rol (Prestatario/Prestamista/Admin)
funcionan correctamente en cada ruta.

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

## Módulo 5 — Registro de usuarios + documentos + IA

Reemplaza `GestionUsuarios.gs`, `DocumentosUsuario.gs` y `AuditoriaIA.gs`.
Es el módulo que faltaba para que el ciclo completo funcione de principio
a fin: alguien se registra → su garantía se evalúa automáticamente → sube
sus documentos → el prestamista los aprueba → **eso genera el contrato
solo** (conecta directo con el módulo 3, sin duplicar esa lógica).

**Importante sobre "la IA":** el motor que evalúa el avalúo/riesgo de la
garantía (`ia.service.js`) es un **motor de reglas fijas** (avalúo = 85%
del valor declarado, riesgo por LTV), no un modelo de inteligencia
artificial — así era también en el Apps Script original, el nombre es
heredado. Donde sí hay un modelo de IA real es en el análisis de las fotos
de los documentos subidos (Gemini, de Google), y **es completamente
opcional**: sin configurar `GEMINI_API_KEY`, los documentos simplemente
quedan marcados "Pendiente_Revision_Manual" — nada se rompe, tu equipo
revisa a mano. Con la key (gratis en https://aistudio.google.com/app/apikey),
la IA compara la foto contra los datos declarados y avisa si detecta
inconsistencias. Te lo aviso desde ya para que decidas si quieres activarla
ahora o más adelante — no bloquea nada de este módulo.

Registro (rutas **públicas**, no requieren sesión):
- `POST /registro/prestamista` — crea la cuenta con `estatus_suscripcion = 'Pendiente'` hasta que el admin confirme el pago (Zelle u otro método).
- `POST /registro/prestatario` — crea la cuenta, el bien en garantía, y la publica en el marketplace, todo en un solo paso. Corre la evaluación de riesgo automáticamente.

Registro (requieren sesión):
- `POST /registro/solicitud` (rol Prestatario) — nueva solicitud de préstamo para quien ya tiene cuenta. Bloqueada si tiene cuotas en mora sin resolver, o si ya tiene 3 préstamos activos.
- `POST /registro/cancelar-suscripcion` — solo si no tiene ningún préstamo activo.

Documentos (rol Prestatario):
- `POST /documentos/identidad` / `POST /documentos/bien` — sube un documento (foto/PDF en base64). Corre el análisis de IA si está configurada.
- `GET /documentos/mis-documentos` — lista todo lo que ha subido.

Documentos (rol Prestamista):
- `POST /documentos/aprobar` — `{ idOp, aprobado, bajoResponsabilidad?, notas? }`. Si aprueba, **genera el contrato automáticamente** (llama al mismo servicio del módulo 3). `bajoResponsabilidad: true` dice que aprueba aunque la IA haya marcado inconsistencias — queda constancia en la auditoría.
- `GET /documentos/aprobacion/:idOp` — estatus de aprobación de una operación.

Descarga de archivos: `GET /documentos/archivo/:idArchivo` — solo el
prestatario dueño, su prestamista asignado, o un Admin pueden verlo (mismo
patrón de almacenamiento en Neon que contratos y comprobantes de pago —
ver migración más abajo).

**Nota técnica sobre la tasa de interés:** la tabla exige que toda
operación tenga una tasa de interés (no puede quedar vacía), pero en el
diseño original la tasa la propone el prestamista DESPUÉS, vía
contraoferta — al momento de publicar la solicitud todavía no se conoce.
Se resolvió guardando un valor "placeholder" de 0.1% (el mínimo permitido)
hasta que llega la primera contraoferta real, que lo reemplaza. No afecta
nada visible para el usuario.

Probado localmente de punta a punta, con el ciclo COMPLETO conectando los
5 módulos: registro de prestamista y prestatario → evaluación automática
de riesgo (avalúo, LTV, calificación) → contraoferta del prestamista →
aceptación del prestatario → subida de documentos (sin Gemini configurada,
cae correctamente a revisión manual) → aprobación del prestamista →
generación automática del contrato + pagaré → operación en
"Por_Desembolsar". También probados: bloqueo de país (EEUU), duplicados de
email/cédula/RIF, límite de 3 préstamos activos, bloqueo de cancelación de
suscripción con préstamo activo, y control de acceso a los archivos
(dueño/prestamista asignado/Admin únicamente).

## Módulo 6 — Panel de administrador

Reemplaza `AdminPanel.gs` y `AdminPanelRootBackend.gs`. Todo bajo el
namespace `/admin/*` que ya existía desde el módulo 4 (protegido con
`requiereAutenticacion` + `requiereRol("Admin")` a nivel de router — nadie
que no sea Admin puede tocar ninguna de estas rutas).

**No necesita ninguna tabla nueva** — a diferencia de los módulos 3, 4 y 5,
este solo lee/agrega datos que ya existen en las tablas de los módulos
anteriores. No hay migración que correr en Neon para este módulo.

Gestión de usuarios:
- `GET /admin/usuarios?rol=Prestamista` — listado maestro, `rol` es opcional (Prestamista/Prestatario/Admin).
- `PATCH /admin/usuarios/:idUsuario` — `{ nombre?, email?, telefono?, direccion? }`. A propósito NO permite tocar la contraseña ni el rol desde aquí (eso sigue siendo un `UPDATE` SQL directo, ver módulo 4) — un typo en un formulario no debe poder convertir a alguien en Admin.
- `GET /admin/prestamistas/pendientes-activacion` — prestamistas que ya se registraron y están esperando que el admin confirme su pago de suscripción (Zelle u otro método manual).
- `POST /admin/prestamistas/:idUsuario/activar-suscripcion` — `{ plan: "mensual" | "anual" }`. Activa la cuenta y calcula `fecha_fin_plan` (+30 o +365 días).

Ingresos e indicadores:
- `GET /admin/ingresos` — comisiones de plataforma ya aprobadas + suscripciones de prestamistas activas (a $20/mes o $200/año, igual que el original).
- `GET /admin/indicadores` — préstamos por estatus, garantías por estatus, totales generales.
- `GET /admin/dashboard/metricas` — total de préstamos, monto total financiado, solicitudes pendientes (para la tarjeta principal del dashboard).
- `GET /admin/dashboard/tareas-pendientes` — el widget de "cosas por hacer": prestamistas pendientes de activación, comisiones pendientes, cuotas pendientes de validar, desembolsos listos, y garantías todavía sin evaluación de IA (`contarActivosPendientesEvaluacion` del original, reimplementado como una consulta).

Operaciones (préstamos):
- `GET /admin/oportunidades` — vista maestra (mismas llaves que esperaba el frontend original: `ID_Op`, `Prestatario`, `Monto_Solicitado`, `Estatus`).
- `GET /admin/prestamos/por-desembolsar` — operaciones con contrato ya generado, con el estatus de su comisión (para saber cuáles están realmente listas para `POST /admin/prestamos/:idOp/autorizar-desembolso`, del módulo 4).
- `POST /admin/prestamos/:idOp/cerrar-manual` — `{ motivo }`. Cierre manual de un préstamo en `En_Cobro` (fallback para cuando el pago se recibió fuera de la plataforma, o hay un acuerdo especial con el prestatario). Aplica los MISMOS efectos que el cierre automático del módulo 4: marca `Pagada`, bonifica reputación y contador de préstamos exitosos de ambas partes, libera la garantía, y condona cualquier cuota que hubiera quedado pendiente o vencida.

Contratos:
- `GET /admin/contratos` — vista maestra (mismas llaves del original: `ID_Contrato`, `ID_Op`, `Fecha_Firma_Digital`, `Estatus_Legal`, `Link_PDF_Generado`).
- `GET /admin/contratos/boveda` — "bóveda" de contratos: cada contrato firmado con los datos de ambas partes y los links de descarga (contrato + pagaré), que apuntan a `GET /contratos/documento/:idDocumento` del módulo 3 (que ya valida acceso de Admin).

Perfil propio: `GET /admin/perfil`.

**Funciones del original que NO se portaron** (no aplican a esta
arquitectura Postgres/Node, a diferencia de Sheets + Drive):
- `crearUsuarioAdminInicial()` — en Sheets era un setup manual de una sola vez; aquí un Admin se promueve con un `UPDATE` SQL directo (ver módulo 4).
- `fijarEncabezadosOportunidadesMercado()` — utilidad de encabezados de columna de Sheets, no existe ese concepto en una tabla de Postgres.
- `forzarAutorizacionCompletaDrive()` / `diagnosticarGeneracionContrato()` — diagnóstico de permisos de Google Drive; nuestros contratos nunca tocan Drive (BYTEA en Neon, módulo 3).
- `generarContratoManualTemporal()` — función de debug/prueba del original, no una operación real del panel.

Probado localmente con datos que cubren los 5 módulos anteriores a la vez
(prestamistas activos/pendientes en plan mensual y anual, préstamos en
cada estatus, comisiones aprobadas/pendientes, cuotas pagadas/vencidas,
contratos generados, garantías en distintos estados): listado y filtro de
usuarios, edición de datos de contacto, activación de suscripción (con
recálculo correcto de ingresos después), los 3 endpoints de
indicadores/métricas/tareas-pendientes con los números verificados a mano
contra la base, vista maestra y bóveda de contratos, y el ciclo completo
de cierre manual (bloqueado en estatus incorrecto, exitoso en `En_Cobro`
con verificación directa en la base de datos de reputación/contador de
préstamos/liberación de garantía/condonación de cuotas, y bloqueado si se
intenta de nuevo sobre una operación ya `Pagada`). También verificado el
403 para roles distintos de Admin en todas las rutas nuevas.

## ⚠️ Antes de desplegar el módulo 4: correr OTRA migración en Neon

Mismo patrón: este módulo necesita la tabla `comprobantes_pago` (para
guardar las fotos/PDFs de comprobantes de pago, igual que los contratos se
guardan en `documentos_generados`).

1. Entra al **SQL Editor** de Neon.
2. Abre `sql/003_comprobantes_pago.sql` y pega su contenido.
3. Ejecútalo.

También una sola vez. Si despliegas antes de correrla, solo el módulo de
pagos/cobranzas fallará — el resto sigue funcionando.

## ⚠️ Antes de desplegar el módulo 5: correr OTRA migración más en Neon

Mismo patrón otra vez: este módulo necesita la tabla `archivos_documentos`
(para las fotos de cédula y del bien en garantía).

1. Entra al **SQL Editor** de Neon.
2. Abre `sql/004_archivos_documentos.sql` y pega su contenido.
3. Ejecútalo.

Si además quieres activar el análisis de fotos con IA (opcional, ver
arriba), agrega la variable de entorno `GEMINI_API_KEY` en Render junto
con las demás (`DATABASE_URL`, `JWT_SECRET`, etc.) — si la dejas vacía o no
la agregas, no pasa nada, los documentos quedan para revisión manual.

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
2. ~~Marketplace + contraofertas (`Marketplace.gs`)~~ ✅ desplegado en producción
3. ~~Generación de contratos (`GeneradorContratos.gs`)~~ ✅ desplegado en producción
4. ~~Pagos y cobranzas (`RecepcionPagos.gs`, `ActualizacionCobranzas.gs`)~~ ✅ desplegado en producción
5. ~~Registro de usuarios + documentos + IA (`GestionUsuarios.gs`, `DocumentosUsuario.gs`, `AuditoriaIA.gs`)~~ ✅ desplegado en producción
6. ~~Admin panel (`AdminPanel.gs`, `AdminPanelRootBackend.gs`)~~ ✅ este entregable (falta desplegar)
7. Cron de mora y vencimientos de suscripción (`CronPlanificadores.gs`) — en
   Render esto se resuelve con un **Cron Job** de Render (no con
   `setInterval` dentro del web service, que se duerme).
