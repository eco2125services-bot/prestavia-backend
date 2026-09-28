/**
 * PrestaVía — Backend — contrato.service.js
 *
 * Reemplaza la lógica de generarContratoDigital() (GeneradorContratos.gs).
 *
 * Diferencias deliberadas frente al Apps Script original:
 *
 * 1. ALMACENAMIENTO: en Apps Script los PDFs se guardaban en Google Drive
 *    (ID_CARPETA_CONTRATOS) y se compartían con enlace público. Aquí se
 *    guardan como BYTEA directo en Postgres/Neon (tabla
 *    'documentos_generados') — decisión tomada explícitamente con el
 *    usuario para no depender de una cuenta de Drive ni de un servicio de
 *    almacenamiento adicional. 'contratos_firmados.url_documento_pdf' y
 *    'lien_ucc_registro' (reutilizada para el pagaré) ahora guardan una
 *    ruta interna de la API (/contratos/documento/:id), no un link externo.
 *
 * 2. QR: se genera localmente con la librería 'qrcode' en vez de llamar a
 *    la API pública api.qrserver.com — el PDF no depende de un servicio
 *    externo en el momento de la firma.
 *
 * 3. BLOQUEO: se usa una transacción de Postgres con
 *    SELECT ... FOR UPDATE sobre la fila de la operación específica, en vez
 *    del LockService.getScriptLock() global de Apps Script (que bloqueaba
 *    TODO el sistema mientras se generaba un contrato).
 *
 * 4. TRIGGER DE GENERACIÓN: en el original, generarContratoDigital() se
 *    llamaba desde DocumentosUsuario.gs, DESPUÉS de que el prestamista
 *    aprobaba los documentos de identidad/garantía subidos por el
 *    prestatario (con revisión de IA incluida) — ese módulo de documentos +
 *    IA todavía no está portado (es el módulo 5 en el orden de prioridad
 *    acordado). Por ahora, este módulo expone POST /contratos/generar como
 *    la acción que el PRESTAMISTA asignado ejecuta directamente para
 *    generar el contrato de una operación ya "Financiada" — funcionando
 *    como una aprobación simplificada. Cuando se construya el módulo de
 *    documentos + IA, ese módulo llamará a este mismo servicio en vez de
 *    duplicar la lógica, y quedará detrás de la revisión real de
 *    documentos.
 *
 * 5. EMAIL: igual que en el módulo de marketplace, el envío de correos
 *    (aviso al admin, al prestatario, y al prestamista sobre la comisión)
 *    está marcado con // TODO EMAIL — no se pierde el requisito, pero no se
 *    manda ningún correo real hasta que se conecte un proveedor.
 *
 * 6. FIRMA ELECTRÓNICA CERTIFICADA (DocuSeal): el Apps Script original
 *    intentaba enviar el PDF a DocuSeal para firma electrónica certificada
 *    real. Esa integración quedó pausada en una sesión anterior por
 *    limitaciones del plan gratuito de DocuSeal (pendiente de que el
 *    usuario decida: pagar el plan Pro, u otro proveedor). Por ahora este
 *    backend solo genera el hash SHA-256 de firma (igual de válido como
 *    evidencia técnica de integridad del documento, pero SIN el nivel de
 *    certificación legal de una firma electrónica avanzada de un tercero
 *    certificador). Queda marcado con // TODO DOCUSEAL.
 */
const crypto = require("crypto");
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { generarPdfContrato, generarPdfPagare } = require("./pdf.service");

function generarId(prefijo) {
  return prefijo + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function calcularHashFirma(idOp, idUsuario, nombreFirma, timestamp) {
  const cadena = `${idOp}|${idUsuario}|${nombreFirma}|${timestamp}`;
  return crypto.createHash("sha256").update(cadena).digest("hex");
}

function formatearFecha(fecha) {
  // dd/MM/yyyy HH:mm, en vez de depender de Utilities.formatDate de Apps Script.
  const pad = (n) => n.toString().padStart(2, "0");
  return (
    `${pad(fecha.getDate())}/${pad(fecha.getMonth() + 1)}/${fecha.getFullYear()} ` +
    `${pad(fecha.getHours())}:${pad(fecha.getMinutes())}`
  );
}

/**
 * Genera el contrato + pagaré de una operación ya financiada, y avanza su
 * estatus a 'Por_Desembolsar'. Solo puede ejecutarlo el prestamista
 * asignado a esa operación (verificación de dueño — el original de Apps
 * Script no distinguía quién llamaba a la función).
 */
async function generarContratoDigital(idOp, idPrestamistaAutenticado, firmaPrestatarioOpcional) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id_oportunidad, id_solicitante, id_prestamista_asignado, id_activo_garantia,
              monto_solicitado, plazo_meses, tasa_interes_anual, cuota_estimada_mensual,
              monto_neto_entregar, estatus
       FROM oportunidades_mercado
       WHERE id_oportunidad = $1
       FOR UPDATE`,
      [idOp]
    );
    const op = rows[0];
    if (!op) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Operación no encontrada: " + idOp };
    }
    if (op.id_prestamista_asignado !== idPrestamistaAutenticado) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Esta operación no te pertenece." };
    }
    if (op.estatus !== "Financiada") {
      await client.query("ROLLBACK");
      return {
        exito: false,
        mensaje: `La operación debe estar en estatus 'Financiada' para generar el contrato (estatus actual: ${op.estatus}).`,
      };
    }

    // ¿Ya existe un contrato para esta operación? No generar duplicados.
    const existente = await client.query("SELECT id_contrato FROM contratos_firmados WHERE id_oportunidad = $1", [idOp]);
    if (existente.rows.length > 0) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Ya existe un contrato generado para esta operación.", idContrato: existente.rows[0].id_contrato };
    }

    const { rows: rowsPrestatario } = await client.query(
      "SELECT nombre_legal, cedula_pasaporte, direccion_fiscal, email FROM usuarios WHERE id_usuario = $1",
      [op.id_solicitante]
    );
    const { rows: rowsPrestamista } = await client.query(
      "SELECT nombre_legal, cedula_pasaporte, email FROM usuarios WHERE id_usuario = $1",
      [op.id_prestamista_asignado]
    );
    const prestatario = rowsPrestatario[0] || {};
    const prestamista = rowsPrestamista[0] || {};

    let bien = {};
    if (op.id_activo_garantia) {
      const { rows: rowsBien } = await client.query(
        "SELECT tipo_bien, marca_modelo FROM activos_garantia WHERE id_activo = $1",
        [op.id_activo_garantia]
      );
      bien = rowsBien[0] || {};
    }

    const nombrePrestatario = prestatario.nombre_legal || "N/D";
    const nombrePrestamista = prestamista.nombre_legal || "N/D";
    const firmaPrestatario = firmaPrestatarioOpcional || nombrePrestatario;
    const firmaPrestamista = nombrePrestamista; // aceptación implícita: fue su oferta la que se aceptó.

    const fechaFirma = new Date();
    const timestampFirma = fechaFirma.getTime();
    const hashPrestatario = calcularHashFirma(idOp, op.id_solicitante, firmaPrestatario, timestampFirma);
    const hashPrestamista = calcularHashFirma(idOp, op.id_prestamista_asignado, firmaPrestamista, timestampFirma);

    const idContrato = generarId("CTR");
    const idDocContrato = generarId("DOC");
    const idDocPagare = generarId("DOC");

    const pdfContratoBuffer = await generarPdfContrato({
      idContrato,
      idOp,
      nombrePrestamista,
      cedulaPrestamista: prestamista.cedula_pasaporte,
      nombrePrestatario,
      cedulaPrestatario: prestatario.cedula_pasaporte,
      direccionPrestatario: prestatario.direccion_fiscal,
      montoSolicitado: op.monto_solicitado,
      montoNetoEntregar: op.monto_neto_entregar,
      plazoMeses: op.plazo_meses,
      cuotaMensual: op.cuota_estimada_mensual,
      tipoBien: bien.tipo_bien,
      marcaModelo: bien.marca_modelo,
      fechaFirma: formatearFecha(fechaFirma),
      hashPrestatario,
      hashPrestamista,
    });

    const pdfPagareBuffer = await generarPdfPagare({
      idContrato,
      idOp,
      nombrePrestatario,
      nombrePrestamista,
      cedulaPrestatario: prestatario.cedula_pasaporte,
      monto: op.monto_solicitado,
      plazoMeses: op.plazo_meses,
      cuotaMensual: op.cuota_estimada_mensual,
      hashFirma: hashPrestatario,
      fechaHoy: formatearFecha(fechaFirma),
    });

    await client.query(
      `INSERT INTO documentos_generados (id_documento, id_oportunidad, tipo_documento, nombre_archivo, contenido_pdf)
       VALUES ($1, $2, 'Contrato', $3, $4)`,
      [idDocContrato, idOp, `Contrato_Mutuo_${idOp}.pdf`, pdfContratoBuffer]
    );
    await client.query(
      `INSERT INTO documentos_generados (id_documento, id_oportunidad, tipo_documento, nombre_archivo, contenido_pdf)
       VALUES ($1, $2, 'Pagare', $3, $4)`,
      [idDocPagare, idOp, `Pagare_${idOp}.pdf`, pdfPagareBuffer]
    );

    const urlContrato = `/contratos/documento/${idDocContrato}`;
    const urlPagare = `/contratos/documento/${idDocPagare}`;

    await client.query(
      `INSERT INTO contratos_firmados
         (id_contrato, id_oportunidad, id_prestatario, id_prestamista, fecha_firma, hash_firma_digital,
          url_documento_pdf, estatus_contrato, clausula_prenda, lien_ucc_registro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Vigente', $8, $9)`,
      [
        idContrato,
        idOp,
        op.id_solicitante,
        op.id_prestamista_asignado,
        fechaFirma,
        hashPrestatario,
        urlContrato,
        "Prenda sin desplazamiento sobre el bien declarado en la solicitud.",
        urlPagare,
      ]
    );

    await client.query("UPDATE oportunidades_mercado SET estatus = 'Por_Desembolsar', updated_at = now() WHERE id_oportunidad = $1", [
      idOp,
    ]);

    await registrarAuditoria(client, op.id_solicitante, "Contrato_Generado", "GeneradorContratos", { idOp, hash: hashPrestatario });

    await client.query("COMMIT");

    // TODO EMAIL: avisar al admin (correo con link al contrato).
    // TODO EMAIL: avisar al prestatario que su contrato ya está listo.
    // TODO EMAIL: avisar al prestamista que debe pagar la comisión de plataforma (5%) antes del desembolso.
    // TODO DOCUSEAL: enviar pdfContratoBuffer a DocuSeal para firma electrónica certificada real
    //   (pausado por límites del plan gratuito de DocuSeal — pendiente de decisión del usuario).

    return {
      exito: true,
      mensaje: "Contrato y pagaré generados. Operación lista para autorización de desembolso.",
      idContrato,
      urlContrato,
      urlPagare,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al generar contrato: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * Trae los metadatos del contrato de una operación (sin el PDF en sí — eso
 * se pide aparte vía GET /contratos/documento/:idDocumento).
 */
async function obtenerContratoDeOperacion(idOp) {
  const { rows } = await pool.query(
    `SELECT id_contrato, id_oportunidad, id_prestatario, id_prestamista, fecha_firma, hash_firma_digital,
            url_documento_pdf, estatus_contrato, lien_ucc_registro AS url_pagare
     FROM contratos_firmados WHERE id_oportunidad = $1`,
    [idOp]
  );
  return rows[0] || null;
}

/**
 * Trae el contenido binario de un documento (contrato o pagaré) generado,
 * junto con el id de la operación (para que el controller pueda verificar
 * que quien lo pide es una de las partes involucradas, o un Admin).
 */
async function obtenerDocumentoPorId(idDocumento) {
  const { rows } = await pool.query(
    `SELECT dg.id_documento, dg.tipo_documento, dg.nombre_archivo, dg.contenido_pdf, dg.id_oportunidad,
            om.id_solicitante, om.id_prestamista_asignado
     FROM documentos_generados dg
     JOIN oportunidades_mercado om ON om.id_oportunidad = dg.id_oportunidad
     WHERE dg.id_documento = $1`,
    [idDocumento]
  );
  return rows[0] || null;
}

module.exports = { generarContratoDigital, obtenerContratoDeOperacion, obtenerDocumentoPorId, calcularHashFirma };
