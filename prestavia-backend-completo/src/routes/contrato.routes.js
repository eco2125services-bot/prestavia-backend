const express = require("express");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/contrato.controller");

const router = express.Router();

// Todas las rutas de contratos requieren estar logueado.
router.use(requiereAutenticacion);

router.post("/generar", requiereRol("Prestamista"), controller.postGenerar);
router.get("/oportunidad/:idOp", controller.getContratoDeOperacion);
router.get("/documento/:idDocumento", controller.getDocumento);

module.exports = router;
