const express = require("express");
const rateLimit = require("express-rate-limit");
const authController = require("../controllers/auth.controller");
const { requiereAutenticacion } = require("../middleware/auth");
const { requiereCaptcha } = require("../services/captcha.service");

const router = express.Router();

// Máximo 10 intentos de login por IP cada 15 minutos — mitiga fuerza bruta
// contra las claves en texto plano que aún no se han re-hasheado.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { exito: false, mensaje: "Demasiados intentos. Intenta de nuevo en unos minutos." },
});

// Recuperación de contraseña: pedir el enlace (5 por IP cada 15 min — cada
// pedido puede mandar un correo) y abrir/usar el enlace.
const olvideLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { exito: false, mensaje: "Demasiados intentos. Intenta de nuevo en unos minutos." },
});
const restablecerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Demasiados intentos. Intenta de nuevo en unos minutos.",
});

// Sesión: revalidar al abrir la app y cerrar sesión de verdad (invalida el token).
router.get("/sesion", requiereAutenticacion, authController.getSesion);
router.post("/logout", requiereAutenticacion, authController.postLogout);
router.post("/login", loginLimiter, requiereCaptcha, authController.postLogin);
router.post("/olvide-clave", olvideLimiter, requiereCaptcha, authController.postOlvideClave);
router.get("/restablecer", restablecerLimiter, authController.getRestablecer);
router.post("/restablecer", restablecerLimiter, authController.postRestablecer);
// HALLAZGO DE SEGURIDAD (ALTO) corregido: esta ruta aceptaba {email,
// nuevaClave} SIN ningún token — cualquiera que conociera el correo de un
// usuario podía cambiarle la contraseña y tomar su cuenta. Ahora exige el
// JWT de sesión (emitido por /auth/login, incluso cuando requiereCambioClave
// es true) y el usuario a modificar sale SIEMPRE del token, nunca del body.
router.post("/actualizar-clave", requiereAutenticacion, authController.postActualizarClave);

module.exports = router;
