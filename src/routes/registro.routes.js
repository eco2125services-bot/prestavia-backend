const express = require("express");
const rateLimit = require("express-rate-limit");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/registro.controller");
const { requiereCaptcha } = require("../services/captcha.service");

const router = express.Router();

// Hallazgo de seguridad (MEDIO), AHORA RESUELTO cuando el correo está
// configurado (EMAIL_USER/EMAIL_APP_PASSWORD en Render): reusar un
// email/cédula/RIF ya registrado devuelve "Ya existe una cuenta..." — eso
// permitía confirmar, probando correos uno por uno, cuáles existen en la
// plataforma. Con la verificación de correo (registro.service.js,
// crearRegistroPendiente / completarRegistroPendiente), la cuenta ya no se
// crea en la respuesta síncrona — pero el mensaje de "ya existe" sigue
// siendo síncrono, así que la enumeración de USUARIOS YA REGISTRADOS
// (cuentas reales, no las pendientes de confirmar) sigue siendo posible.
// Este límite hace que probar muchos correos sea lento y caro de todos
// modos, y es la mitigación mientras el correo no esté configurado.
const registroLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { exito: false, mensaje: "Demasiados intentos. Intenta de nuevo en unos minutos." },
});

// Registro de cuenta nueva: rutas PÚBLICAS a propósito (todavía no hay
// sesión que autenticar en el momento de crear la cuenta).
router.post("/prestamista", registroLimiter, requiereCaptcha, controller.postRegistrarPrestamista);
router.post("/prestatario", registroLimiter, requiereCaptcha, controller.postRegistrarPrestatario);

// También pública (se abre desde el enlace del correo, sin sesión). El
// token es de 256 bits — fuerza bruta es inviable — pero un límite
// generoso no cuesta nada.
router.get("/verificar-email", registroLimiter, controller.getVerificarEmail);
// El GET solo muestra un botón; el POST es el que crea la cuenta (un escáner
// de enlaces de correo hace GET, nunca POST).
router.post("/verificar-email", registroLimiter, controller.postVerificarEmail);

// Estas sí requieren estar logueado (son acciones de un usuario existente).
router.post("/solicitud", requiereAutenticacion, requiereRol("Prestatario"), controller.postNuevaSolicitud);
router.post("/cancelar-suscripcion", requiereAutenticacion, controller.postCancelarSuscripcion);

module.exports = router;
