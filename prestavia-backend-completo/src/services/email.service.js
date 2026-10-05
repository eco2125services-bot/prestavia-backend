/**
 * PrestaVía — Backend — email.service.js
 *
 * Envío de correo real, gratuito: usa la cuenta de Gmail de la propia
 * plataforma (la misma que ya se usa como cuenta Zelle receptora,
 * EMAIL_USER) vía SMTP con una "contraseña de aplicación" — no es un
 * servicio de terceros, no tiene límite mensual artificial más allá del
 * límite normal de envío de Gmail (~500 correos/día en una cuenta
 * personal), y no requiere verificar un dominio propio.
 *
 * Configuración requerida (variables de entorno en Render):
 *   EMAIL_USER          la cuenta de Gmail que envía (ej. eco2125services@gmail.com)
 *   EMAIL_APP_PASSWORD  una "contraseña de aplicación" de 16 caracteres —
 *                       NO la contraseña normal de la cuenta. Se genera en
 *                       myaccount.google.com/apppasswords (requiere tener
 *                       verificación en 2 pasos activada en esa cuenta de
 *                       Google). Ver también el mensaje que le mandé al
 *                       usuario con el paso a paso.
 *
 * Si estas variables no están configuradas (ej. mientras se desarrolla
 * localmente), las funciones de este módulo registran el correo en consola
 * en vez de fallar — así ningún flujo (registro, etc.) se rompe por falta
 * de configuración de correo.
 */
const nodemailer = require("nodemailer");

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const EMAIL_ADMIN = process.env.EMAIL_ADMIN || EMAIL_USER;

let transporter = null;
function obtenerTransporter() {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

/**
 * Envía un correo. Nunca lanza una excepción que tumbe el flujo que lo
 * llama (registro, aceptación de oferta, etc.) — un correo que no sale no
 * debe impedir que la operación de negocio se complete; solo queda
 * registrado el error en consola (y, para los casos críticos, el llamador
 * decide si debe bloquear algo más arriba, como con la verificación de
 * email, que si no se configuró el correo, cae a modo degradado — ver
 * registro.service.js).
 */
async function enviarCorreo({ to, subject, html, text }) {
  const t = obtenerTransporter();
  if (!t) {
    console.log(`✉️  [correo no configurado — EMAIL_USER/EMAIL_APP_PASSWORD faltan] Para: ${to} | Asunto: ${subject}`);
    return { enviado: false, motivo: "Correo no configurado en el servidor." };
  }
  try {
    await t.sendMail({
      from: `"PrestaVía" <${EMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || undefined,
    });
    return { enviado: true };
  } catch (error) {
    console.error("Error enviando correo:", error.message);
    return { enviado: false, motivo: error.message };
  }
}

/** Correo a la propia plataforma (eco2125services@gmail.com por defecto) — para avisos operativos (nueva suscripción pendiente de pago, etc.). */
async function enviarCorreoAdmin({ subject, html, text }) {
  return enviarCorreo({ to: EMAIL_ADMIN, subject, html, text });
}

function correoConfigurado() {
  return !!obtenerTransporter();
}

module.exports = { enviarCorreo, enviarCorreoAdmin, correoConfigurado };
