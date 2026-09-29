const cobranzasService = require("../services/cobranzas.service");
const adminPanelService = require("../services/admin-panel.service");
const cronService = require("../services/cron.service");

async function getComisionesPendientes(req, res) {
  try {
    const datos = await cobranzasService.obtenerPagosComisionPendientesAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/comisiones/pendientes:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postAprobarComision(req, res) {
  try {
    const { aprobado, notas } = req.body;
    if (typeof aprobado !== "boolean") return res.status(400).json({ exito: false, mensaje: "Falta 'aprobado' (boolean)." });
    const resultado = await cobranzasService.aprobarPagoComisionAdmin(req.params.idComision, aprobado, notas, req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /admin/comisiones/:idComision/aprobar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postAutorizarDesembolso(req, res) {
  try {
    const resultado = await cobranzasService.autorizarDesembolsoPrestamoAdmin(req.params.idOp, req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /admin/prestamos/:idOp/autorizar-desembolso:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getPagosPendientes(req, res) {
  try {
    const datos = await cobranzasService.obtenerPagosDeCuotaPendientesAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/pagos/pendientes:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postValidarPago(req, res) {
  try {
    const { aprobado, motivoRechazo } = req.body;
    if (typeof aprobado !== "boolean") return res.status(400).json({ exito: false, mensaje: "Falta 'aprobado' (boolean)." });
    const resultado = await cobranzasService.concluirValidacionTransaccion(
      req.params.idTransaccion,
      aprobado,
      motivoRechazo,
      req.usuario.idUsuario
    );
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /admin/pagos/:idTransaccion/validar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

// ---------------------------------------------------------------------
// Módulo 6 — Panel de administrador
// ---------------------------------------------------------------------

async function getUsuarios(req, res) {
  try {
    const datos = await adminPanelService.obtenerUsuariosAdmin(req.query.rol);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/usuarios:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function patchUsuario(req, res) {
  try {
    const resultado = await adminPanelService.actualizarDatosUsuarioAdmin(req.params.idUsuario, req.body || {}, req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en PATCH /admin/usuarios/:idUsuario:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getPrestamistasPendientesActivacion(req, res) {
  try {
    const datos = await adminPanelService.obtenerPrestamistasPendientesActivacionAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/prestamistas/pendientes-activacion:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postActivarSuscripcion(req, res) {
  try {
    const resultado = await adminPanelService.activarSuscripcionAdmin(req.params.idUsuario, req.body ? req.body.plan : null, req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /admin/prestamistas/:idUsuario/activar-suscripcion:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getIngresos(req, res) {
  try {
    const datos = await adminPanelService.obtenerIngresosPlataformaAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/ingresos:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getIndicadores(req, res) {
  try {
    const datos = await adminPanelService.obtenerIndicadoresGestionAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/indicadores:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getDashboardMetricas(req, res) {
  try {
    const datos = await adminPanelService.obtenerMetricasDashboardAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/dashboard/metricas:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getTareasPendientes(req, res) {
  try {
    const datos = await adminPanelService.obtenerTareasPendientesAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/dashboard/tareas-pendientes:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getOportunidadesMaster(req, res) {
  try {
    const datos = await adminPanelService.obtenerOportunidadesMasterParaAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/oportunidades:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getPorDesembolsar(req, res) {
  try {
    const datos = await adminPanelService.obtenerOperacionesPorDesembolsarAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/prestamos/por-desembolsar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postCerrarManual(req, res) {
  try {
    const resultado = await adminPanelService.cerrarOperacionManualAdmin(req.params.idOp, req.body ? req.body.motivo : null, req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /admin/prestamos/:idOp/cerrar-manual:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getContratosMaster(req, res) {
  try {
    const datos = await adminPanelService.obtenerContratosMasterParaAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/contratos:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getBovedaContratos(req, res) {
  try {
    const datos = await adminPanelService.obtenerBovedaContratosAdmin();
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/contratos/boveda:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getPerfil(req, res) {
  try {
    const datos = await adminPanelService.obtenerPerfilPropioAdmin(req.usuario.idUsuario);
    if (!datos) return res.status(404).json({ exito: false, mensaje: "Perfil no encontrado." });
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /admin/perfil:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

// ---------------------------------------------------------------------
// Módulo 7 — disparo manual del cron diario (además del Render Cron Job
// automático — útil para probar o forzar una corrida sin esperar al
// horario programado).
// ---------------------------------------------------------------------

async function postCronVencimientosSuscripcion(req, res) {
  try {
    const resumen = await cronService.evaluarVencimientosSuscripcion();
    return res.status(200).json({ exito: true, mensaje: "Revisión de vencimientos de suscripción ejecutada.", datos: resumen });
  } catch (error) {
    console.error("Error en POST /admin/cron/vencimientos-suscripcion:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postCronCuotasVencidas(req, res) {
  try {
    const resumen = await cronService.evaluarCuotasVencidas();
    return res.status(200).json({ exito: true, mensaje: "Revisión de cuotas en mora ejecutada.", datos: resumen });
  } catch (error) {
    console.error("Error en POST /admin/cron/cuotas-vencidas:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = {
  getComisionesPendientes,
  postAprobarComision,
  postAutorizarDesembolso,
  getPagosPendientes,
  postValidarPago,
  getUsuarios,
  patchUsuario,
  getPrestamistasPendientesActivacion,
  postActivarSuscripcion,
  getIngresos,
  getIndicadores,
  getDashboardMetricas,
  getTareasPendientes,
  getOportunidadesMaster,
  getPorDesembolsar,
  postCerrarManual,
  getContratosMaster,
  getBovedaContratos,
  getPerfil,
  postCronVencimientosSuscripcion,
  postCronCuotasVencidas,
};
