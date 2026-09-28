const express = require("express");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/admin.controller");

const router = express.Router();

// Todo lo de /admin requiere estar logueado Y tener rol Admin.
router.use(requiereAutenticacion, requiereRol("Admin"));

router.get("/comisiones/pendientes", controller.getComisionesPendientes);
router.post("/comisiones/:idComision/aprobar", controller.postAprobarComision);

router.post("/prestamos/:idOp/autorizar-desembolso", controller.postAutorizarDesembolso);

router.get("/pagos/pendientes", controller.getPagosPendientes);
router.post("/pagos/:idTransaccion/validar", controller.postValidarPago);

module.exports = router;
