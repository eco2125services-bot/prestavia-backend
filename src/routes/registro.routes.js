const express = require("express");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/registro.controller");

const router = express.Router();

// Registro de cuenta nueva: rutas PÚBLICAS a propósito (todavía no hay
// sesión que autenticar en el momento de crear la cuenta).
router.post("/prestamista", controller.postRegistrarPrestamista);
router.post("/prestatario", controller.postRegistrarPrestatario);

// Estas sí requieren estar logueado (son acciones de un usuario existente).
router.post("/solicitud", requiereAutenticacion, requiereRol("Prestatario"), controller.postNuevaSolicitud);
router.post("/cancelar-suscripcion", requiereAutenticacion, controller.postCancelarSuscripcion);

module.exports = router;
