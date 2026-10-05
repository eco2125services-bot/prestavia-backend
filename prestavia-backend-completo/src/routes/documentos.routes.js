const express = require("express");
const { requiereAutenticacion, requiereRol } = require("../middleware/auth");
const controller = require("../controllers/documentos.controller");

const router = express.Router();

router.use(requiereAutenticacion);

router.post("/identidad", requiereRol("Prestatario"), controller.postSubirIdentidad);
router.post("/bien", requiereRol("Prestatario"), controller.postSubirBien);
router.get("/mis-documentos", requiereRol("Prestatario"), controller.getMisDocumentos);
router.get("/mis-operaciones-activas", requiereRol("Prestatario"), controller.getOperacionesActivas);

router.get("/aprobacion/:idOp", controller.getAprobacion);
router.post("/aprobar", requiereRol("Prestamista"), controller.postAprobar);

router.get("/archivo/:idArchivo", controller.getArchivo);

module.exports = router;
