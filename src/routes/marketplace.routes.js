const express = require("express");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/marketplace.controller");

const router = express.Router();

// Todas las rutas de marketplace requieren estar logueado.
router.use(requiereAutenticacion);

router.get("/oportunidades", requiereRol("Prestamista"), controller.getOportunidades);
router.get("/mis-solicitudes", requiereRol("Prestatario"), controller.getMisSolicitudes);
router.get("/mis-prestamos", requiereRol("Prestamista"), controller.getMisPrestamos);
router.post("/contraoferta", requiereRol("Prestamista"), controller.postContraoferta);
router.post("/responder", requiereRol("Prestatario"), controller.postResponder);
router.post("/solicitar-documentos", requiereRol("Prestamista"), controller.postSolicitarDocumentos);
router.get("/documentos/:idOp", controller.getDocumentosOperacion);

module.exports = router;
