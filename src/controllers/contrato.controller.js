const contratoService = require("../services/contrato.service");

async function postGenerar(req, res) {
  try {
    const { idOp, firma } = req.body;
    if (!idOp) return res.status(400).json({ exito: false, mensaje: "Falta idOp." });
    const resultado = await contratoService.generarContratoDigital(idOp, req.usuario.idUsuario, firma);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /contratos/generar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getContratoDeOperacion(req, res) {
  try {
    const contrato = await contratoService.obtenerContratoDeOperacion(req.params.idOp);
    if (!contrato) return res.status(404).json({ exito: false, mensaje: "No hay contrato generado para esta operación." });
    return res.status(200).json({ exito: true, datos: contrato });
  } catch (error) {
    console.error("Error en GET /contratos/oportunidad/:idOp:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getDocumento(req, res) {
  try {
    const documento = await contratoService.obtenerDocumentoPorId(req.params.idDocumento);
    if (!documento) return res.status(404).json({ exito: false, mensaje: "Documento no encontrado." });

    // Solo las partes involucradas (o un Admin) pueden descargar el PDF.
    const { idUsuario, rol } = req.usuario;
    const esParte = idUsuario === documento.id_solicitante || idUsuario === documento.id_prestamista_asignado;
    if (!esParte && rol !== "Admin") {
      return res.status(403).json({ exito: false, mensaje: "No tienes permiso para ver este documento." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${documento.nombre_archivo}"`);
    return res.status(200).send(documento.contenido_pdf);
  } catch (error) {
    console.error("Error en GET /contratos/documento/:idDocumento:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = { postGenerar, getContratoDeOperacion, getDocumento };
