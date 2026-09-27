const express = require("express");
const rateLimit = require("express-rate-limit");
const authController = require("../controllers/auth.controller");

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
router.post("/actualizar-clave", authController.postActualizarClave);

module.exports = router;
