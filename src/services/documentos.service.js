/**
 * PrestaVía — Backend — documentos.service.js
 *
 * Reemplaza DocumentosUsuario.gs: subida de documentos de identidad y del
 * bien en garantía (con análisis por IA de visión, ver ia.service.js), y
 * la aprobación de esos documentos por el prestamista — que es lo que
 * dispara la generación del contrato (contrato.service.js, módulo 3).
 *
 * Esta es la pieza que faltaba desde el módulo 3: allá dejamos dicho que
 * "cuando construyamos el módulo de documentos + IA, ese módulo llamará a
 * este mismo servicio [generarContratoDigital] en vez de duplicar la
 * lógica" — eso es justo lo que hace aprobarDocumentosYGenerarContrato más
 * abajo.
 */
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { guardarArchivoBase64 } = require("./archivo.service");
const { analizarDocumentoConIA } = require("./ia.service");
const { generarContratoDigital } = require("./contrato.service");

function generarId(prefijo) {
  return prefijo + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Sube un documento de identidad (cédula). Permite subir varios — cada uno
 * queda como una fila nueva, no reemplaza a los anteriores.
 */
async function subirDocumentoIdentidad(idUsuarioAutenticado, { archivoBase64, archivoMimeType, archivoNombre }) {
  if (!archivoBase64) return { exito: false, mensaje: "Falta el archivo." };

  const { rows } = await pool.query("SELECT nombre_legal, cedula_pasaporte FROM usuarios WHERE id_usuario = $1", [
    idUsuarioAutenticado,
  ]);
  const usuario = rows[0] || {};

  const { buffer, mimeType, ruta } = await guardarArchivoBase64(null, { archivoBase64, archivoMimeType, archivoNombre });
  const resultadoIA = await analizarDocumentoConIA(buffer, mimeType, "cedula", {
    nombreEsperado: usuario.nombre_legal,
    numeroEsperado: usuario.cedula_pasaporte,
  });

  const idDoc = generarId("DOC");
  await pool.query(
    `INSERT INTO documentos_adjuntos (id_documento, id_usuario, tipo_documento, url_archivo, nombre_archivo, estatus_ia, detalle_ia)
     VALUES ($1, $2, 'Identidad', $3, $4, $5, $6)`,
    [idDoc, idUsuarioAutenticado, ruta, archivoNombre || idDoc, resultadoIA.estatus, resultadoIA.detalle]
  );

  await registrarAuditoria(null, idUsuarioAutenticado, "Documento_Identidad_Subido", "DocumentosUsuario", { estatusIA: resultadoIA.estatus });
  // TODO EMAIL: notificar al prestamista asignado que se subió un documento nuevo.

  return { exito: true, mensaje: "Documento subido. " + resultadoIA.mensajeUsuario };
}

/**
 * Sube un documento del bien en garantía (fotos, título de propiedad,
 * factura, etc.) — no reemplaza a los anteriores.
 */
async function subirDocumentoBien(idUsuarioAutenticado, { archivoBase64, archivoMimeType, archivoNombre }) {
  if (!archivoBase64) return { exito: false, mensaje: "Falta el archivo." };

  const { rows } = await pool.query(
    "SELECT id_activo, tipo_bien, marca_modelo, valor_declarado_usuario FROM activos_garantia WHERE id_usuario = $1 ORDER BY created_at DESC LIMIT 1",
    [idUsuarioAutenticado]
  );
  const activo = rows[0];
  if (!activo) return { exito: false, mensaje: "No se encontró ningún bien en garantía registrado para tu cuenta." };

  const { buffer, mimeType, ruta } = await guardarArchivoBase64(null, { archivoBase64, archivoMimeType, archivoNombre });
  const resultadoIA = await analizarDocumentoConIA(buffer, mimeType, "bien", {
    tipoBienEsperado: activo.tipo_bien,
    descripcionEsperada: activo.marca_modelo,
    valorDeclarado: activo.valor_declarado_usuario,
  });

  const idDoc = generarId("DOC");
  await pool.query(
    `INSERT INTO documentos_adjuntos (id_documento, id_usuario, id_activo, tipo_documento, url_archivo, nombre_archivo, estatus_ia, detalle_ia)
     VALUES ($1, $2, $3, 'Bien', $4, $5, $6, $7)`,
    [idDoc, idUsuarioAutenticado, activo.id_activo, ruta, archivoNombre || idDoc, resultadoIA.estatus, resultadoIA.detalle]
  );

  await registrarAuditoria(null, idUsuarioAutenticado, "Documento_Bien_Subido", "DocumentosUsuario", { estatusIA: resultadoIA.estatus });
  // TODO EMAIL: notificar al prestamista asignado.

  return { exito: true, mensaje: "Documento subido. " + resultadoIA.mensajeUsuario };
}

/**
 * Lista todos los documentos (identidad + bien) subidos por un prestatario.
 */
async function obtenerEstadoDocumentosPrestatario(idUsuario) {
  const { rows } = await pool.query(
    `SELECT tipo_documento, url_archivo, nombre_archivo, fecha_subida, estatus_ia
     FROM documentos_adjuntos WHERE id_usuario = $1 ORDER BY fecha_subida DESC`,
    [idUsuario]
  );
  const resultado = { identidad: [], bien: [] };
  for (const r of rows) {
    const item = { url: r.url_archivo, nombre: r.nombre_archivo, fecha: r.fecha_subida, estatusIA: r.estatus_ia };
    if (r.tipo_documento === "Identidad") resultado.identidad.push(item);
    else resultado.bien.push(item);
  }
  return resultado;
}

/**
 * Documentos de la OPERACIÓN de un prestatario específico, para que el
 * prestamista los revise desde "Mis Préstamos" (reemplaza el stub que
 * vivía en marketplace.service.js desde el módulo 2).
 */
async function obtenerDocumentosDeOperacion(idOp) {
  const { rows } = await pool.query("SELECT id_solicitante FROM oportunidades_mercado WHERE id_oportunidad = $1", [idOp]);
  if (!rows[0]) return { identidad: [], bien: [] };
  return obtenerEstadoDocumentosPrestatario(rows[0].id_solicitante);
}

/**
 * Estatus actual de aprobación de documentos para una operación.
 */
async function obtenerEstatusAprobacionDocumentos(idOp) {
  const { rows } = await pool.query("SELECT estatus_aprobacion, notas FROM aprobaciones_documentos WHERE id_oportunidad = $1", [idOp]);
  return rows[0] ? { estatus: rows[0].estatus_aprobacion, notas: rows[0].notas } : { estatus: "Pendiente" };
}

/**
 * El PRESTAMISTA aprueba (o rechaza) los documentos de una operación. Si
 * aprueba, genera el contrato (delega en contrato.service.js — módulo 3 —
 * en vez de duplicar esa lógica). 'bajoResponsabilidad' se usa cuando la
 * IA marcó inconsistencias pero el prestamista decide aprobar de todas
 * formas — queda constancia de eso.
 */
async function aprobarDocumentosYGenerarContrato(idOp, idPrestamistaAutenticado, aprobado, bajoResponsabilidad, notas) {
  const { rows: rowsOp } = await pool.query(
    "SELECT id_solicitante, id_prestamista_asignado FROM oportunidades_mercado WHERE id_oportunidad = $1",
    [idOp]
  );
  const op = rowsOp[0];
  if (!op) return { exito: false, mensaje: "Operación no encontrada: " + idOp };
  if (op.id_prestamista_asignado !== idPrestamistaAutenticado) {
    return { exito: false, mensaje: "Esta operación no te pertenece." };
  }

  const estatusAprobacion = !aprobado ? "Rechazado" : bajoResponsabilidad ? "Aprobado_Bajo_Responsabilidad" : "Aprobado";

  await pool.query(
    `INSERT INTO aprobaciones_documentos (id_oportunidad, estatus_aprobacion, aprobado_por, fecha_aprobacion, notas)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (id_oportunidad) DO UPDATE SET estatus_aprobacion = EXCLUDED.estatus_aprobacion, fecha_aprobacion = now(), notas = EXCLUDED.notas`,
    [idOp, estatusAprobacion, idPrestamistaAutenticado, notas || null]
  );

  await registrarAuditoria(null, idPrestamistaAutenticado, "Documentos_" + estatusAprobacion, "DocumentosUsuario", { idOp, notas: notas || "" });

  if (!aprobado) {
    return { exito: true, mensaje: "Documentos rechazados. El contrato NO se generará hasta que se resuelva." };
  }

  const resultadoContrato = await generarContratoDigital(idOp, idPrestamistaAutenticado, null);
  if (!resultadoContrato.exito) {
    return {
      exito: true,
      mensaje:
        "Documentos aprobados" +
        (bajoResponsabilidad ? " (bajo tu responsabilidad, la IA había marcado inconsistencias)" : "") +
        ", pero el contrato no se generó automáticamente: " +
        resultadoContrato.mensaje,
    };
  }

  return {
    exito: true,
    mensaje:
      "✅ Documentos aprobados" +
      (bajoResponsabilidad ? " bajo tu responsabilidad" : "") +
      " y contrato + pagaré generados. Operación lista para autorización de desembolso.",
    urlContrato: resultadoContrato.urlContrato,
    urlPagare: resultadoContrato.urlPagare,
  };
}

module.exports = {
  subirDocumentoIdentidad,
  subirDocumentoBien,
  obtenerEstadoDocumentosPrestatario,
  obtenerDocumentosDeOperacion,
  obtenerEstatusAprobacionDocumentos,
  aprobarDocumentosYGenerarContrato,
};
