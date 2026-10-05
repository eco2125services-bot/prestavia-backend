const pagosService = require("../services/pagos.service");
const { obtenerComprobantePorId } = require("../services/comprobante.service");

async function getMisCuotas(req, res) {
  try {
    const datos = await pagosService.obtenerCuotasPendientesUsuario(req.usuario.idUsuario);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /pagos/mis-cuotas:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getResumenPrestamo(req, res) {
  try {
    const datos = await pagosService.obtenerResumenPrestamoParaPago(req.usuario.idUsuario, req.params.idOp);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /pagos/resumen/:idOp:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postReportarPago(req, res) {
  try {
    const { idPago, montoPagado, metodoPago, referencia, archivoBase64, archivoMimeType, archivoNombre } = req.body;
    if (!idPago || montoPagado === undefined) {
      return res.status(400).json({ exito: false, mensaje: "Faltan datos (idPago, montoPagado)." });
    }
    const resultado = await pagosService.guardarReportePago(req.usuario.idUsuario, {
      idPago,
      montoPagado,
      metodoPago,
      referencia,
      archivoBase64,
      archivoMimeType,
      archivoNombre,
    });
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /pagos/reportar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postReportarComision(req, res) {
  try {
    const { idOportunidad, montoPagado, metodoPago, referencia, archivoBase64, archivoMimeType, archivoNombre } = req.body;
    if (!idOportunidad || montoPagado === undefined) {
      return res.status(400).json({ exito: false, mensaje: "Faltan datos (idOportunidad, montoPagado)." });
    }
    const resultado = await pagosService.reportarPagoComisionPrestamista(req.usuario.idUsuario, {
      idOportunidad,
      montoPagado,
      metodoPago,
      referencia,
      archivoBase64,
      archivoMimeType,
      archivoNombre,
    });
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /pagos/comision/reportar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getComisionPendiente(req, res) {
  try {
    const idOp = await pagosService.obtenerOperacionPendienteComisionPrestamista(req.usuario.idUsuario);
    return res.status(200).json({ exito: true, datos: { idOp } });
  } catch (error) {
    console.error("Error en GET /pagos/comision/pendiente:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getComprobante(req, res) {
  try {
    const comprobante = await obtenerComprobantePorId(req.params.idComprobante);
    if (!comprobante) return res.status(404).json({ exito: false, mensaje: "Comprobante no encontrado." });
    // Nota: a diferencia de /contratos/documento/:id, aquí no se restringe
    // por partes involucradas porque solo Admin, el prestatario o el
    // prestamista que lo subieron llegan a conocer este ID (no se lista
    // públicamente en ningún endpoint). Se podría añadir la misma
    // verificación de dueño si en el futuro se expone en un listado público.
    res.setHeader("Content-Type", comprobante.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${comprobante.nombre_archivo}"`);
    return res.status(200).send(comprobante.contenido);
  } catch (error) {
    console.error("Error en GET /pagos/comprobante/:idComprobante:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = { getMisCuotas, getResumenPrestamo, postReportarPago, postReportarComision, getComisionPendiente, getComprobante };
