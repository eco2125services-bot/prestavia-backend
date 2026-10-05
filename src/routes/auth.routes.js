const express = require("express");
const rateLimit = require("express-rate-limit");
const authController = require("../controllers/auth.controller");
const { requiereAutenticacion } = require("../middleware/auth");

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

router.post("/login", loginLimiter, authController.postLogin);
// HALLAZGO DE SEGURIDAD (ALTO) corregido: esta ruta aceptaba {email,
// nuevaClave} SIN ningún token — cualquiera que conociera el correo de un
// usuario podía cambiarle la contraseña y tomar su cuenta. Ahora exige el
// JWT de sesión (emitido por /auth/login, incluso cuando requiereCambioClave
// es true) y el usuario a modificar sale SIEMPRE del token, nunca del body.
router.post("/actualizar-clave", requiereAutenticacion, authController.postActualizarClave);

module.exports = router;
