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

// Mismo criterio que registro.service.js (MAX_PRESTAMOS_ACTIVOS): estos son
// los estatus de operación donde un documento sigue siendo relevante.
const ESTATUS_OPERACION_ACTIVA = ["Abierta", "En Negociacion", "Financiada", "Por_Desembolsar", "En_Cobro"];

/**
 * Operaciones activas de un prestatario — usado para (a) decidir sola la
 * operación destino de un documento cuando solo hay una, o (b) pedirle al
 * prestatario que elija cuando tiene varias a la vez.
 */
async function obtenerOperacionesActivasPrestatario(idUsuario) {
  const { rows } = await pool.query(
    `SELECT id_oportunidad, monto_solicitado, estatus
     FROM oportunidades_mercado
     WHERE id_solicitante = $1 AND estatus = ANY($2::text[])
     ORDER BY fecha_solicitud DESC`,
    [idUsuario, ESTATUS_OPERACION_ACTIVA]
  );
  return rows.map((r) => ({ idOp: r.id_oportunidad, monto: parseFloat(r.monto_solicitado), estatus: r.estatus }));
}

/**
 * Decide a qué operación pertenece un documento que se está subiendo:
 *  - Si el prestatario mandó idOportunidad explícito, se valida que sea
 *    una de SUS operaciones activas.
 *  - Si no mandó nada y solo tiene UNA operación activa, se usa esa sola
 *    (cero fricción — es el caso normal, un prestatario con un préstamo).
 *  - Si no mandó nada y tiene VARIAS activas a la vez, no se puede
 *    adivinar de forma confiable — se le devuelve la lista para que elija.
 *  - Si no tiene ninguna operación activa (ej. subiendo su identidad antes
 *    de que le acepten algo), el documento queda sin operación asignada.
 */
async function determinarOperacionDestino(idUsuarioAutenticado, idOportunidadSolicitada) {
  const activas = await obtenerOperacionesActivasPrestatario(idUsuarioAutenticado);

  if (idOportunidadSolicitada) {
    const coincide = activas.find((o) => o.idOp === idOportunidadSolicitada);
    if (!coincide) {
      return { ok: false, mensaje: "Esa operación no está activa o no te pertenece." };
    }
    return { ok: true, idOportunidad: coincide.idOp };
  }

  if (activas.length === 0) return { ok: true, idOportunidad: null };
  if (activas.length === 1) return { ok: true, idOportunidad: activas[0].idOp };

  return {
    ok: false,
    requiereSeleccion: true,
    operaciones: activas,
    mensaje: "Tienes varias solicitudes activas — indica a cuál de ellas corresponde este documento.",
  };
}

/**
 * Sube un documento de identidad (cédula). Permite subir varios — cada uno
 * queda como una fila nueva, no reemplaza a los anteriores.
 */
async function subirDocumentoIdentidad(idUsuarioAutenticado, { archivoBase64, archivoMimeType, archivoNombre, idOportunidad }) {
  if (!archivoBase64) return { exito: false, mensaje: "Falta el archivo." };

  const destino = await determinarOperacionDestino(idUsuarioAutenticado, idOportunidad);
  if (!destino.ok) return { exito: false, ...destino };

  const { rows } = await pool.query(
    "SELECT nombre_legal, cedula_pasaporte, pais_residencia FROM usuarios WHERE id_usuario = $1",
    [idUsuarioAutenticado]
  );
  const usuario = rows[0] || {};

  const resultadoArchivo = await guardarArchivoBase64(null, { archivoBase64, archivoMimeType, archivoNombre });
  if (resultadoArchivo.error) return { exito: false, mensaje: resultadoArchivo.error };
  const { buffer, mimeType, ruta } = resultadoArchivo;
  const resultadoIA = await analizarDocumentoConIA(buffer, mimeType, "cedula", {
    nombreEsperado: usuario.nombre_legal,
    numeroEsperado: usuario.cedula_pasaporte,
    paisEsperado: usuario.pais_residencia,
  });

  const idDoc = generarId("DOC");
  await pool.query(
    `INSERT INTO documentos_adjuntos (id_documento, id_usuario, id_oportunidad, tipo_documento, url_archivo, nombre_archivo, estatus_ia, detalle_ia)
     VALUES ($1, $2, $3, 'Identidad', $4, $5, $6, $7)`,
    [idDoc, idUsuarioAutenticado, destino.idOportunidad, ruta, archivoNombre || idDoc, resultadoIA.estatus, resultadoIA.detalle]
  );

  await registrarAuditoria(null, idUsuarioAutenticado, "Documento_Identidad_Subido", "DocumentosUsuario", {
    estatusIA: resultadoIA.estatus,
    idOportunidad: destino.idOportunidad,
  });
  // TODO EMAIL: notificar al prestamista asignado que se subió un documento nuevo.

  return { exito: true, mensaje: "Documento subido. " + resultadoIA.mensajeUsuario };
}

/**
 * Sube un documento del bien en garantía (fotos, título de propiedad,
 * factura, etc.) — no reemplaza a los anteriores.
 */
async function subirDocumentoBien(idUsuarioAutenticado, { archivoBase64, archivoMimeType, archivoNombre, idOportunidad }) {
  if (!archivoBase64) return { exito: false, mensaje: "Falta el archivo." };

  const destino = await determinarOperacionDestino(idUsuarioAutenticado, idOportunidad);
  if (!destino.ok) return { exito: false, ...destino };

  // BUG real encontrado: esto antes tomaba SIEMPRE el bien en garantía más
  // reciente del usuario (ORDER BY created_at DESC LIMIT 1), sin importar a
  // cuál solicitud pertenecía el documento que se estaba subiendo. Cada
  // solicitud tiene su propio bien en garantía (oportunidades_mercado.
  // id_activo_garantia, creado en registro.service.js al pedir el
  // préstamo) — así que un prestatario con 2+ solicitudes activas, cada
  // una con un bien distinto, terminaba con la foto subida para la
  // solicitud antigua evaluada por IA contra la descripción del bien de la
  // solicitud NUEVA (o viceversa), y el id_activo guardado en el documento
  // apuntaba al bien equivocado. Ahora se usa el bien de la operación
  // específica a la que pertenece el documento.
  let activo;
  if (destino.idOportunidad) {
    const { rows } = await pool.query(
      `SELECT ag.id_activo, ag.tipo_bien, ag.marca_modelo, ag.valor_declarado_usuario
       FROM oportunidades_mercado om
       JOIN activos_garantia ag ON ag.id_activo = om.id_activo_garantia
       WHERE om.id_oportunidad = $1`,
      [destino.idOportunidad]
    );
    activo = rows[0];
  }
  if (!activo) {
    // Sin operación (documento subido antes de tener una solicitud) o la
    // operación no tiene bien asociado todavía — mejor esfuerzo: el más
    // reciente del usuario, como antes.
    const { rows } = await pool.query(
      "SELECT id_activo, tipo_bien, marca_modelo, valor_declarado_usuario FROM activos_garantia WHERE id_usuario = $1 ORDER BY created_at DESC LIMIT 1",
      [idUsuarioAutenticado]
    );
    activo = rows[0];
  }
  if (!activo) return { exito: false, mensaje: "No se encontró ningún bien en garantía registrado para tu cuenta." };

  const resultadoArchivo = await guardarArchivoBase64(null, { archivoBase64, archivoMimeType, archivoNombre });
  if (resultadoArchivo.error) return { exito: false, mensaje: resultadoArchivo.error };
  const { buffer, mimeType, ruta } = resultadoArchivo;
  const resultadoIA = await analizarDocumentoConIA(buffer, mimeType, "bien", {
    tipoBienEsperado: activo.tipo_bien,
    descripcionEsperada: activo.marca_modelo,
    valorDeclarado: activo.valor_declarado_usuario,
  });

  const idDoc = generarId("DOC");
  await pool.query(
    `INSERT INTO documentos_adjuntos (id_documento, id_usuario, id_activo, id_oportunidad, tipo_documento, url_archivo, nombre_archivo, estatus_ia, detalle_ia)
     VALUES ($1, $2, $3, $4, 'Bien', $5, $6, $7, $8)`,
    [idDoc, idUsuarioAutenticado, activo.id_activo, destino.idOportunidad, ruta, archivoNombre || idDoc, resultadoIA.estatus, resultadoIA.detalle]
  );

  await registrarAuditoria(null, idUsuarioAutenticado, "Documento_Bien_Subido", "DocumentosUsuario", {
    estatusIA: resultadoIA.estatus,
    idOportunidad: destino.idOportunidad,
  });
  // TODO EMAIL: notificar al prestamista asignado.

  return { exito: true, mensaje: "Documento subido. " + resultadoIA.mensajeUsuario };
}

/**
 * Lista todos los documentos (identidad + bien) subidos por un prestatario,
 * agrupados por operación (idOportunidad null = subido antes de este
 * cambio o sin préstamo activo en ese momento).
 */
async function obtenerEstadoDocumentosPrestatario(idUsuario) {
  const { rows } = await pool.query(
    `SELECT tipo_documento, url_archivo, nombre_archivo, fecha_subida, estatus_ia, id_oportunidad
     FROM documentos_adjuntos WHERE id_usuario = $1 ORDER BY fecha_subida DESC`,
    [idUsuario]
  );
  const resultado = { identidad: [], bien: [] };
  for (const r of rows) {
    const item = { url: r.url_archivo, nombre: r.nombre_archivo, fecha: r.fecha_subida, estatusIA: r.estatus_ia, idOportunidad: r.id_oportunidad };
    if (r.tipo_documento === "Identidad") resultado.identidad.push(item);
    else resultado.bien.push(item);
  }
  return resultado;
}

/**
 * Documentos de la OPERACIÓN de un prestatario específico, para que el
 * prestamista los revise desde "Mis Préstamos" (reemplaza el stub que
 * vivía en marketplace.service.js desde el módulo 2).
 *
 * IMPORTANTE: filtra estrictamente por id_oportunidad — antes esto
 * devolvía TODOS los documentos del prestatario sin importar a cuál
 * préstamo pertenecían, así que un prestamista con una operación podía ver
 * documentos (incluyendo fotos del bien en garantía) de OTRA operación de
 * ese mismo prestatario asignada a un prestamista distinto.
 */
async function obtenerDocumentosDeOperacion(idOp) {
  const { rows } = await pool.query(
    `SELECT tipo_documento, url_archivo, nombre_archivo, fecha_subida, estatus_ia
     FROM documentos_adjuntos WHERE id_oportunidad = $1 ORDER BY fecha_subida DESC`,
    [idOp]
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
async function aprobarDocumentosYGenerarContrato(idOp, idPrestamistaAutenticado, aprobado, bajoResponsabilidad, notas, ip) {
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
  // Si había una solicitud de documentos pendiente para esta operación, ya
  // se resolvió (aprobado o rechazado) — deja de mostrarse en el dashboard
  // del prestatario como pendiente.
  await pool.query("UPDATE solicitudes_documentos SET atendida = true WHERE id_oportunidad = $1", [idOp]);

  await registrarAuditoria(null, idPrestamistaAutenticado, "Documentos_" + estatusAprobacion, "DocumentosUsuario", { idOp, notas: notas || "" }, ip);

  if (!aprobado) {
    return { exito: true, mensaje: "Documentos rechazados. El contrato NO se generará hasta que se resuelva." };
  }

  const resultadoContrato = await generarContratoDigital(idOp, idPrestamistaAutenticado, null, ip);
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
  obtenerOperacionesActivasPrestatario,
};
