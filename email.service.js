/**
 * PrestaVía — Backend — email.service.js
 *
 * Envío de correo gratuito. Soporta DOS formas, en este orden de preferencia:
 *
 * 1) RELAY POR HTTPS (recomendado en Render gratis): un pequeño "Web App" de
 *    Google Apps Script, creado con la propia cuenta de Gmail de la plataforma,
 *    que recibe un POST y envía el correo con MailApp. Va por el puerto 443
 *    (HTTPS), así que NO lo bloquea Render. Variables de entorno:
 *      EMAIL_WEBAPP_URL      la URL de despliegue del Web App (termina en /exec)
 *      EMAIL_WEBAPP_SECRET   un secreto largo, igual al del script
 *
 * 2) SMTP DE GMAIL (nodemailer + contraseña de aplicación). Funciona en local o
 *    en un plan de pago de Render, pero Render BLOQUEA los puertos SMTP
 *    (25/465/587) en los servicios web gratuitos, así que allí se queda
 *    esperando hasta agotar el tiempo. Variables:
 *      EMAIL_USER, EMAIL_APP_PASSWORD
 *
 * EMAIL_ADMIN (opcional): destino de los avisos operativos; por defecto
 * EMAIL_USER.
 *
 * Si no hay ninguna de las dos configuradas, las funciones registran el correo
 * en consola en vez de fallar — así ningún flujo se rompe por falta de
 * configuración.
 */
const nodemailer = require("nodemailer");

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const EMAIL_WEBAPP_URL = process.env.EMAIL_WEBAPP_URL;
const EMAIL_WEBAPP_SECRET = process.env.EMAIL_WEBAPP_SECRET;
const EMAIL_ADMIN = process.env.EMAIL_ADMIN || EMAIL_USER;

const TIMEOUT_MS = 15000;

function usaRelayWeb() {
  return !!(EMAIL_WEBAPP_URL && EMAIL_WEBAPP_SECRET);
}

let transporter = null;
function obtenerTransporter() {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
      // Sin estos tiempos, si el puerto está bloqueado el registro se
      // quedaría colgado minutos esperando.
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
  }
  return transporter;
}

function correoConfigurado() {
  return usaRelayWeb() || !!obtenerTransporter();
}

async function enviarPorRelayWeb({ to, subject, html, text }) {
  const respuesta = await fetch(EMAIL_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita el preflight CORS de Apps Script
    body: JSON.stringify({ secreto: EMAIL_WEBAPP_SECRET, to, subject, html, text: text || "" }),
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const cuerpo = await respuesta.text();
  let datos;
  try {
    datos = JSON.parse(cuerpo);
  } catch (e) {
    throw new Error(`Respuesta inesperada del relay (HTTP ${respuesta.status}): ${cuerpo.slice(0, 120)}`);
  }
  if (!datos.ok) throw new Error(`El relay rechazó el envío: ${datos.error || "sin detalle"}`);
}

/**
 * Envía un correo. Nunca lanza una excepción que tumbe el flujo que lo
 * llama; devuelve { enviado, motivo }. El llamador decide qué hacer si no
 * salió (ej. el registro con verificación avisa del fallo).
 */
async function enviarCorreo({ to, subject, html, text }) {
  if (!correoConfigurado()) {
    console.log(`✉️  [correo no configurado — faltan EMAIL_WEBAPP_URL/EMAIL_WEBAPP_SECRET o EMAIL_USER/EMAIL_APP_PASSWORD] Para: ${to} | Asunto: ${subject}`);
    return { enviado: false, motivo: "Correo no configurado en el servidor." };
  }
  try {
    if (usaRelayWeb()) {
      await enviarPorRelayWeb({ to, subject, html, text });
    } else {
      await obtenerTransporter().sendMail({
        from: `"PrestaVía" <${EMAIL_USER}>`,
        to,
        subject,
        html,
        text: text || undefined,
      });
    }
    return { enviado: true };
  } catch (error) {
    console.error(`Error enviando correo (${usaRelayWeb() ? "relay web" : "SMTP"}):`, error.message);
    return { enviado: false, motivo: error.message };
  }
}

/** Correo a la propia plataforma (EMAIL_ADMIN) — para avisos operativos. */
async function enviarCorreoAdmin({ subject, html, text }) {
  return enviarCorreo({ to: EMAIL_ADMIN, subject, html, text });
}

module.exports = { enviarCorreo, enviarCorreoAdmin, correoConfigurado };
