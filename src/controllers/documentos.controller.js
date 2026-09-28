const documentosService = require("../services/documentos.service");
const { obtenerArchivoPorId } = require("../services/archivo.service");
const { pool } = require("../db");

async function postSubirIdentidad(req, res) {
  try {
    const { archivoBase64, archivoMimeType, archivoNombre } = req.body;
    const resultado = await documentosService.subirDocumentoIdentidad(req.usuario.idUsuario, {
      archivoBase64,
      archivoMimeType,
      archivoNombre,
    });
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /documentos/identidad:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postSubirBien(req, res) {
  try {
    const { archivoBase64, archivoMimeType, archivoNombre } = req.body;
    const resultado = await documentosService.subirDocumentoBien(req.usuario.idUsuario, {
      archivoBase64,
      archivoMimeType,
      archivoNombre,
    });
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /documentos/bien:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getMisDocumentos(req, res) {
  try {
    const datos = await documentosService.obtenerEstadoDocumentosPrestatario(req.usuario.idUsuario);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /documentos/mis-documentos:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getAprobacion(req, res) {
  try {
    const datos = await documentosService.obtenerEstatusAprobacionDocumentos(req.params.idOp);
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /documentos/aprobacion/:idOp:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postAprobar(req, res) {
  try {
    const { idOp, aprobado, bajoResponsabilidad, notas } = req.body;
    if (!idOp || typeof aprobado !== "boolean") {
      return res.status(400).json({ exito: false, mensaje: "Faltan datos (idOp, aprobado)." });
    }
    const resultado = await documentosService.aprobarDocumentosYGenerarContrato(
      idOp,
      req.usuario.idUsuario,
      aprobado,
      !!bajoResponsabilidad,
      notas
    );
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /documentos/aprobar:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function getArchivo(req, res) {
  try {
    const archivo = await obtenerArchivoPorId(req.params.idArchivo);
    if (!archivo) return res.status(404).json({ exito: false, mensaje: "Archivo no encontrado." });

    // Verificación de dueño: solo el prestatario que lo subió, el
    // prestamista asignado a alguna de sus operaciones, o un Admin.
    const { idUsuario, rol } = req.usuario;
    if (rol !== "Admin") {
      const { rows } = await pool.query(
        `SELECT 1 FROM documentos_adjuntos da
         WHERE da.url_archivo = $1
           AND (
             da.id_usuario = $2
             OR EXISTS (
               SELECT 1 FROM oportunidades_mercado om
               WHERE om.id_solicitante = da.id_usuario AND om.id_prestamista_asignado = $2
             )
           )`,
        [`/documentos/archivo/${req.params.idArchivo}`, idUsuario]
      );
      if (rows.length === 0) {
        return res.status(403).json({ exito: false, mensaje: "No tienes permiso para ver este documento." });
      }
    }

    res.setHeader("Content-Type", archivo.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${archivo.nombre_archivo}"`);
    return res.status(200).send(archivo.contenido);
  } catch (error) {
    console.error("Error en GET /documentos/archivo/:idArchivo:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = { postSubirIdentidad, postSubirBien, getMisDocumentos, getAprobacion, postAprobar, getArchivo };
