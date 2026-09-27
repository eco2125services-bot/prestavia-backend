# PrestaVía Backend

Backend Node.js/Express que reemplaza Google Apps Script, sobre PostgreSQL
(Neon). Este primer módulo cubre **autenticación** — es el que estaba
pendiente directo de la migración (re-hasheo de claves).

## Qué incluye este primer entregable

- `POST /auth/login` — reemplaza `verificarCredenciales()`. Si la clave del
  usuario todavía está en texto plano (heredada de Sheets), la valida, la
  re-hashea con bcrypt automáticamente, y sigue normal. Devuelve un JWT.
- `POST /auth/actualizar-clave` — reemplaza `actualizarContrasenaObligatoria()`
  de `ActualizarPassword.html`. Apaga `requiere_cambio_clave`.
- `GET /health` — chequeo simple para que Render sepa que el servicio está vivo.
- Middleware `requiereAutenticacion` / `requiereRol(...)` en
  `src/middleware/auth.js`, listo para proteger los próximos endpoints
  (marketplace, pagos, admin) sin tener que reescribirlo cada vez.

Probado localmente de punta a punta (servidor real + Postgres real, no
mocks): login con clave incorrecta rechazado, login con clave heredada en
texto plano re-hasheada automáticamente y confirmada en la base, segundo
login ya usando bcrypt, y actualizar-clave apagando el flag correctamente.

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

1. ~~Auth (login + re-hasheo)~~ ✅ este entregable
2. Marketplace + contraofertas (`Marketplace.gs`)
3. Generación de contratos (`GeneradorContratos.gs`)
4. Pagos y cobranzas (`RecepcionPagos.gs`, `ActualizacionCobranzas.gs`)
5. Registro de usuarios + documentos + IA (`GestionUsuarios.gs`, `DocumentosUsuario.gs`, `AuditoriaIA.gs`)
6. Admin panel (`AdminPanel.gs`, `AdminPanelRootBackend.gs`)
7. Cron de mora y vencimientos de suscripción (`CronPlanificadores.gs`) — en
   Render esto se resuelve con un **Cron Job** de Render (no con
   `setInterval` dentro del web service, que se duerme).
