const express = require("express");
const { requiereAutenticacion } = require("../middleware/auth");
const controller = require("../controllers/usuarios.controller");

const router = express.Router();

// Autoservicio: cualquier usuario autenticado ve/edita SU PROPIA cuenta.
router.use(requiereAutenticacion);

router.get("/mi-perfil", controller.getMiPerfil);
router.patch("/mi-perfil", controller.patchMiPerfil);

module.exports = router;
