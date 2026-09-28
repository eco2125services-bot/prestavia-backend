const cobranzasService = require("../services/cobranzas.service");

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

module.exports = { getComisionesPendientes, postAprobarComision, postAutorizarDesembolso, getPagosPendientes, postValidarPago };
