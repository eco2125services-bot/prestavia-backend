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

// --- Módulo 6: panel de administrador -------------------------------

router.get("/usuarios", controller.getUsuarios);
router.patch("/usuarios/:idUsuario", controller.patchUsuario);

router.get("/reportes/prestamistas", controller.getReportePrestamistas);
router.get("/reportes/prestatarios", controller.getReportePrestatarios);

router.get("/prestamistas/pendientes-activacion", controller.getPrestamistasPendientesActivacion);
router.post("/prestamistas/:idUsuario/activar-suscripcion", controller.postActivarSuscripcion);

router.get("/ingresos", controller.getIngresos);
router.get("/indicadores", controller.getIndicadores);
router.get("/dashboard/metricas", controller.getDashboardMetricas);
router.get("/dashboard/tareas-pendientes", controller.getTareasPendientes);

router.get("/oportunidades", controller.getOportunidadesMaster);
router.get("/prestamos/por-desembolsar", controller.getPorDesembolsar);
router.post("/prestamos/:idOp/cerrar-manual", controller.postCerrarManual);

router.get("/contratos", controller.getContratosMaster);
router.get("/contratos/boveda", controller.getBovedaContratos);

router.get("/perfil", controller.getPerfil);

// --- Módulo 7: disparo manual del cron diario (opcional, el Render Cron
// Job ya lo corre solo — esto es para pruebas o forzar una corrida) -----

router.post("/cron/vencimientos-suscripcion", controller.postCronVencimientosSuscripcion);
router.post("/cron/cuotas-vencidas", controller.postCronCuotasVencidas);

module.exports = router;
