const express = require("express");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/pagos.controller");

const router = express.Router();

router.use(requiereAutenticacion);

router.get("/mis-cuotas", requiereRol("Prestatario"), controller.getMisCuotas);
router.get("/resumen/:idOp", requiereRol("Prestatario"), controller.getResumenPrestamo);
router.post("/reportar", requiereRol("Prestatario"), controller.postReportarPago);

router.post("/comision/reportar", requiereRol("Prestamista"), controller.postReportarComision);
router.get("/comision/pendiente", requiereRol("Prestamista"), controller.getComisionPendiente);

// Comprobantes: cualquier usuario autenticado que tenga el ID puede
// descargarlo (ver nota de seguridad en el controller).
router.get("/comprobante/:idComprobante", controller.getComprobante);

module.exports = router;
