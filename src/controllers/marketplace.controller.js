const marketplaceService = require("../services/marketplace.service");

async function getOportunidades(req, res) {
  try {
    const datos = await marketplaceService.obtenerOportunidadesMercado(req.usuario.idUsuario);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /marketplace/oportunidades:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getMisSolicitudes(req, res) {
  try {
    const datos = await marketplaceService.obtenerPrestamosSolicitados(req.usuario.idUsuario);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /marketplace/mis-solicitudes:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getMisPrestamos(req, res) {
  try {
    const datos = await marketplaceService.obtenerMisPrestamosPrestamista(req.usuario.idUsuario);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /marketplace/mis-prestamos:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postContraoferta(req, res) {
  try {
    const { idOp, nuevaTasa, tasaMoraDiaria } = req.body;
    if (!idOp || nuevaTasa === undefined) {
      return res.status(400).json({ exito: false, mensaje: "Faltan datos (idOp, nuevaTasa)." });
    }
    const resultado = await marketplaceService.enviarContraoferta(idOp, nuevaTasa, req.usuario.idUsuario, tasaMoraDiaria);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /marketplace/contraoferta:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postResponder(req, res) {
  try {
    const { idOp, aceptada, firma } = req.body;
    if (!idOp || typeof aceptada !== "boolean") {
      return res.status(400).json({ exito: false, mensaje: "Faltan datos (idOp, aceptada)." });
    }
    const resultado = await marketplaceService.responderPropuesta(idOp, req.usuario.idUsuario, aceptada, firma);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /marketplace/responder:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postSolicitarDocumentos(req, res) {
  try {
    const { idOp, mensajePersonalizado } = req.body;
    if (!idOp) return res.status(400).json({ exito: false, mensaje: "Falta idOp." });
    const resultado = await marketplaceService.solicitarDocumentosPrestatario(idOp, mensajePersonalizado, req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /marketplace/solicitar-documentos:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getDocumentosOperacion(req, res) {
  try {
    const datos = await marketplaceService.obtenerDocumentosDeOperacion(req.params.idOp);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /marketplace/documentos/:idOp:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = {
  getOportunidades,
  getMisSolicitudes,
  getMisPrestamos,
  postContraoferta,
  postResponder,
  postSolicitarDocumentos,
  getDocumentosOperacion,
};
