/**
 * PrestaVía — Backend — marketplace.service.js
 *
 * Reemplaza Marketplace.gs completo. Diferencias importantes respecto al
 * original en Apps Script (documentadas para que quede claro qué cambió y
 * por qué, no son bugs):
 *
 *  1. LockService.getScriptLock() (un candado GLOBAL para todo el script)
 *     se reemplaza por transacciones de Postgres con
 *     "SELECT ... FOR UPDATE": solo se bloquea la fila de la oportunidad
 *     específica que se está modificando, no el sistema entero. Esto es
 *     justo el tipo de límite de escala que motivó salir de Sheets.
 *
 *  2. idPrestamista / idPrestatario YA NO se reciben como parámetro desde
 *     el cliente — se toman del JWT verificado (req.usuario, puesto por el
 *     middleware requiereAutenticacion). En Apps Script, el navegador podía
 *     mandar cualquier ID y no había forma de comprobar que ese usuario
 *     fuera quien decía ser.
 *
 *  3. El envío de emails (MailApp en Apps Script) queda como TODO explícito
 *     — este backend todavía no tiene un proveedor de correo configurado.
 *     Las funciones igual completan su trabajo (guardar en la base), solo
 *     no se manda la notificación por correo todavía. Está marcado con
 *     "// TODO EMAIL" en cada punto donde Apps Script sí mandaba uno.
 */
const { pool } = require("../db");
const { calcularAmortizacion } = require("./amortizacion.service");
const { registrarAuditoria } = require("./audit.service");

const FEE_PLATAFORMA_PORCENTAJE = 0.05; // 5% al prestamista, sobre el monto — igual que GestionUsuarios.gs

function generarIdOportunidadRelacionado(prefijo) {
  return prefijo + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

async function obtenerPaisUsuario(client, idUsuario) {
  if (!idUsuario) return "";
  const { rows } = await client.query("SELECT pais_residencia FROM usuarios WHERE id_usuario = $1", [idUsuario]);
  return rows[0] ? rows[0].pais_residencia || "" : "";
}

async function suscripcionPrestamistaActiva(idUsuario) {
  if (!idUsuario) return false;
  const { rows } = await pool.query("SELECT estatus_suscripcion FROM usuarios WHERE id_usuario = $1", [idUsuario]);
  return !!rows[0] && rows[0].estatus_suscripcion === "Activo";
}

/**
 * Lista de oportunidades ABIERTAS para que el prestamista las evalúe,
 * filtradas a solicitantes de SU MISMO país (misma regla legal de
 * Marketplace.gs: evita ambigüedad sobre qué ley de usura aplica).
 */
async function obtenerOportunidadesMercado(idPrestamista) {
  const paisPrestamista = await obtenerPaisUsuario(pool, idPrestamista);

  const { rows } = await pool.query(
    `SELECT om.id_oportunidad, om.id_solicitante, om.monto_solicitado, om.plazo_meses,
            om.tasa_interes_anual, om.tipo_garantia, om.estatus, u.pais_residencia,
            u.puntos_reputacion, u.prestamos_exitosos
     FROM oportunidades_mercado om
     JOIN usuarios u ON u.id_usuario = om.id_solicitante
     WHERE om.estatus = 'Abierta'
       AND ($1 = '' OR u.pais_residencia = $1)`,
    [paisPrestamista || ""]
  );

  return rows.map((fila) => ({
    idOp: fila.id_oportunidad,
    idSolicitanteAnonimo: "Solicitante-" + fila.id_solicitante.slice(-4),
    estatusPublicacion: fila.estatus,
    montoSolicitado: parseFloat(fila.monto_solicitado),
    plazoMeses: fila.plazo_meses,
    interesAnual: parseFloat(fila.tasa_interes_anual) || 0,
    tipoGarantia: fila.tipo_garantia,
    paisSolicitante: fila.pais_residencia,
    // Puntaje de credibilidad del solicitante (sube con pagos a tiempo y
    // préstamos terminados, baja con mora) — antes se calculaba pero solo
    // lo veía el Admin; ahora el prestamista lo ve ANTES de ofertar.
    puntosReputacion: fila.puntos_reputacion === null ? 0 : parseInt(fila.puntos_reputacion, 10),
    prestamosExitosos: fila.prestamos_exitosos === null ? 0 : parseInt(fila.prestamos_exitosos, 10),
  }));
}

/**
 * Historial de solicitudes del propio prestatario, con el saldo pendiente
 * calculado desde control_pagos (mismo criterio que Marketplace.gs:
 * cuotas Pendiente o Vencido cuentan como saldo).
 */
async function obtenerPrestamosSolicitados(idUsuario) {
  if (!idUsuario) return [];

  // Mismo cuidado que en obtenerMisPrestamosPrestamista: LATERAL + LIMIT 1
  // para que varios contratos de la misma operación no dupliquen la fila.
  const { rows } = await pool.query(
    `SELECT om.id_oportunidad, om.monto_solicitado, om.plazo_meses, om.tasa_interes_anual,
            om.cuota_estimada_mensual, om.estatus,
            cf.url_documento_pdf, cf.url_finiquito,
            COALESCE(saldo.saldo_pendiente, 0) AS saldo_pendiente,
            sd.mensaje AS solicitud_docs_mensaje, sd.fecha_solicitud AS solicitud_docs_fecha
     FROM oportunidades_mercado om
     LEFT JOIN LATERAL (
       SELECT url_documento_pdf, url_finiquito FROM contratos_firmados
       WHERE id_oportunidad = om.id_oportunidad
       ORDER BY fecha_firma DESC LIMIT 1
     ) cf ON true
     LEFT JOIN (
       SELECT id_oportunidad, SUM(monto_cuota) AS saldo_pendiente
       FROM control_pagos
       WHERE estatus_pago IN ('Pendiente', 'Vencido')
       GROUP BY id_oportunidad
     ) saldo ON saldo.id_oportunidad = om.id_oportunidad
     LEFT JOIN solicitudes_documentos sd ON sd.id_oportunidad = om.id_oportunidad AND sd.atendida = false
     WHERE om.id_solicitante = $1
     ORDER BY om.fecha_solicitud DESC`,
    [idUsuario]
  );

  return rows.map((fila) => ({
    idOp: fila.id_oportunidad,
    monto: parseFloat(fila.monto_solicitado),
    montoSolicitado: parseFloat(fila.monto_solicitado),
    plazo: fila.plazo_meses,
    plazoMeses: fila.plazo_meses,
    tasa: parseFloat(fila.tasa_interes_anual),
    tasaAceptada: parseFloat(fila.tasa_interes_anual),
    cuotaMensual: fila.cuota_estimada_mensual !== null ? parseFloat(fila.cuota_estimada_mensual) : "--",
    saldoTotalPendiente: parseFloat(parseFloat(fila.saldo_pendiente).toFixed(2)),
    estatusOp: fila.estatus,
    estatusPublicacion: fila.estatus,
    estatusOperacion: fila.estatus,
    linkPdf: fila.url_documento_pdf || "",
    linkPDF: fila.url_documento_pdf || "",
    linkFiniquito: fila.url_finiquito || "",
    solicitudDocumentos: fila.solicitud_docs_mensaje ? { mensaje: fila.solicitud_docs_mensaje, fecha: fila.solicitud_docs_fecha } : null,
  }));
}

/**
 * Préstamos que un prestamista ya financió (cualquier estatus posterior a
 * "Abierta"), para su pestaña "Mis Préstamos".
 */
async function obtenerMisPrestamosPrestamista(idPrestamista) {
  if (!idPrestamista) return [];

  // LEFT JOIN LATERAL con LIMIT 1 (en vez de un JOIN directo) a propósito:
  // puede haber más de un contrato generado para la misma operación (ej. de
  // pruebas repetidas), y un JOIN directo multiplicaría la fila de la
  // operación una vez por cada contrato encontrado — el prestamista vería
  // la misma operación duplicada varias veces en su lista.
  const { rows } = await pool.query(
    `SELECT om.id_oportunidad, om.nombre_prestatario, om.monto_solicitado, om.plazo_meses,
            om.tasa_interes_anual, om.cuota_estimada_mensual, om.estatus, cf.url_documento_pdf, cf.url_finiquito
     FROM oportunidades_mercado om
     LEFT JOIN LATERAL (
       SELECT url_documento_pdf, url_finiquito FROM contratos_firmados
       WHERE id_oportunidad = om.id_oportunidad
       ORDER BY fecha_firma DESC LIMIT 1
     ) cf ON true
     WHERE om.id_prestamista_asignado = $1
     ORDER BY om.fecha_solicitud DESC`,
    [idPrestamista]
  );

  return rows.map((fila) => ({
    idOp: fila.id_oportunidad,
    nombrePrestatario: fila.nombre_prestatario,
    montoSolicitado: parseFloat(fila.monto_solicitado),
    plazoMeses: fila.plazo_meses,
    tasaAnual: parseFloat(fila.tasa_interes_anual),
    cuotaMensual: fila.cuota_estimada_mensual !== null ? parseFloat(fila.cuota_estimada_mensual) : "--",
    estatus: fila.estatus,
    linkPdf: fila.url_documento_pdf || "",
    linkFiniquito: fila.url_finiquito || "",
  }));
}

/**
 * El prestamista propone una tasa. idPrestamista viene SIEMPRE del JWT,
 * nunca del body de la petición.
 */
async function enviarContraoferta(idOp, nuevaTasa, idPrestamista, tasaMoraDiaria) {
  if (!(await suscripcionPrestamistaActiva(idPrestamista))) {
    return { exito: false, mensaje: "Tu suscripción no está activa. No puedes hacer ofertas hasta que el administrador confirme tu pago." };
  }

  const numTasa = parseFloat(nuevaTasa);
  if (isNaN(numTasa) || numTasa < 0.1 || numTasa > 30) {
    return { exito: false, mensaje: "La tasa debe estar entre 0.1% y 30% anual." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Bloquea SOLO esta fila hasta que termine la transacción — equivalente
    // fino al LockService.getScriptLock() global de Apps Script.
    const { rows } = await client.query(
      "SELECT id_oportunidad, id_solicitante, estatus FROM oportunidades_mercado WHERE id_oportunidad = $1 FOR UPDATE",
      [idOp]
    );
    const op = rows[0];
    if (!op) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Oportunidad no encontrada." };
    }
    if (op.estatus !== "Abierta") {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: `Esta oportunidad ya no está disponible (estatus: ${op.estatus}).` };
    }

    const paisPrestamista = await obtenerPaisUsuario(client, idPrestamista);
    const paisPrestatario = await obtenerPaisUsuario(client, op.id_solicitante);
    if (paisPrestamista && paisPrestatario && paisPrestamista !== paisPrestatario) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "No puedes ofertar en solicitudes de un país distinto al tuyo." };
    }

    await client.query(
      `UPDATE oportunidades_mercado
       SET tasa_interes_anual = $1, tasa_mora_diaria = $2, id_prestamista_asignado = $3, estatus = 'En Negociacion'
       WHERE id_oportunidad = $4`,
      [numTasa, parseFloat(tasaMoraDiaria) || 0.5, idPrestamista, idOp]
    );

    await registrarAuditoria(client, idPrestamista, "Contraoferta_Enviada", "Marketplace", { idOp, tasa: numTasa });

    await client.query("COMMIT");

    // TODO EMAIL: notificar al prestatario (op.id_solicitante) que recibió una oferta.
    // Antes vivía en MailApp.sendEmail(...) dentro de Marketplace.gs. Falta
    // decidir/configurar un proveedor de correo (ej. Resend, SendGrid, Postmark)
    // para este backend antes de poder mandar esta notificación.

    return { exito: true, mensaje: "Propuesta enviada. Esperando respuesta del prestatario." };
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error en enviarContraoferta:", error);
    return { exito: false, mensaje: "Error al enviar contraoferta." };
  } finally {
    client.release();
  }
}

/**
 * El prestatario acepta o rechaza la propuesta. idPrestatarioAutenticado
 * viene del JWT — se verifica que sea el dueño real de la oportunidad
 * (esto NO se validaba en la versión de Apps Script).
 */
async function responderPropuesta(idOp, idPrestatarioAutenticado, aceptada, firma, ipAceptacion, userAgent) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id_oportunidad, id_solicitante, id_prestamista_asignado, estatus,
              monto_solicitado, plazo_meses, tasa_interes_anual
       FROM oportunidades_mercado WHERE id_oportunidad = $1 FOR UPDATE`,
      [idOp]
    );
    const op = rows[0];
    if (!op) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Oportunidad no encontrada." };
    }
    if (op.id_solicitante !== idPrestatarioAutenticado) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Esta operación no te pertenece." };
    }
    if (op.estatus !== "En Negociacion") {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: `Esta operación no está esperando tu respuesta (estatus: ${op.estatus}).` };
    }

    if (!aceptada) {
      await client.query(
        "UPDATE oportunidades_mercado SET estatus = 'Abierta', id_prestamista_asignado = NULL WHERE id_oportunidad = $1",
        [idOp]
      );
      await client.query("COMMIT");
      return { exito: true, mensaje: "Propuesta rechazada. Tu solicitud vuelve a estar abierta en el marketplace." };
    }

    if (!firma) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "La firma digital es requerida para aceptar." };
    }

    const monto = parseFloat(op.monto_solicitado) || 0;
    const plazo = parseInt(op.plazo_meses, 10) || 1;
    const tasaAnual = parseFloat(op.tasa_interes_anual) || 0;
    const calculo = calcularAmortizacion(monto, plazo, tasaAnual);
    const feePlataforma = parseFloat((monto * FEE_PLATAFORMA_PORCENTAJE).toFixed(2));
    const montoNeto = parseFloat((monto - feePlataforma).toFixed(2));

    await client.query(
      `UPDATE oportunidades_mercado
       SET fee_plataforma_usd = $1, monto_neto_entregar = $2, monto_total_pagar = $3,
           cuota_estimada_mensual = $4, fecha_aprobacion_financiamiento = now(), estatus = 'Financiada'
       WHERE id_oportunidad = $5`,
      [feePlataforma, montoNeto, calculo.totalPagar, calculo.cuotaMensual, idOp]
    );

    // Hallazgo de seguridad (BAJO) corregido: antes la firma tecleada solo
    // quedaba en el JSONB del audit_log, sin IP ni user-agent, y ni
    // siquiera era lo que contrato.service.js usaba para el hash de firma
    // (usaba el nombre legal registrado). Ahora queda en su propia tabla,
    // con la evidencia que acompaña a un consentimiento real, y
    // contrato.service.js la lee de aquí al generar el contrato.
    await client.query(
      `INSERT INTO aceptaciones_prestatario (id_oportunidad, firma_texto, ip_aceptacion, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_oportunidad) DO UPDATE SET firma_texto = EXCLUDED.firma_texto,
         ip_aceptacion = EXCLUDED.ip_aceptacion, user_agent = EXCLUDED.user_agent, fecha_aceptacion = now()`,
      [idOp, firma, ipAceptacion || null, userAgent || null]
    );

    await registrarAuditoria(client, idPrestatarioAutenticado, "Prestamo_Aceptado", "Marketplace", { idOp, firma }, ipAceptacion);

    await client.query("COMMIT");

    // TODO EMAIL: notificar al prestamista (op.id_prestamista_asignado) para que
    // revise documentos, y al prestatario para que suba sus documentos.
    // Misma nota que arriba: pendiente de un proveedor de correo configurado.

    return {
      exito: true,
      mensaje: `✅ Préstamo aceptado y financiado. Cuota estimada: $${calculo.cuotaMensual}/mes. Ahora sube tus documentos (cédula + bien en garantía) para que el prestamista pueda aprobar tu contrato.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error en responderPropuesta:", error);
    return { exito: false, mensaje: "Error al procesar respuesta." };
  } finally {
    client.release();
  }
}

/**
 * El prestamista pide documentos al prestatario. Se verifica que quien
 * pide sea el prestamista asignado a esa operación.
 */
async function solicitarDocumentosPrestatario(idOp, mensajePersonalizado, idPrestamistaAutenticado) {
  const { rows } = await pool.query(
    "SELECT id_solicitante, id_prestamista_asignado FROM oportunidades_mercado WHERE id_oportunidad = $1",
    [idOp]
  );
  const op = rows[0];
  if (!op) return { exito: false, mensaje: "Operación no encontrada." };
  if (op.id_prestamista_asignado !== idPrestamistaAutenticado) {
    return { exito: false, mensaje: "Esta operación no está asignada a ti." };
  }

  // Antes esto SOLO quedaba en el log de auditoría — invisible para el
  // prestatario. Ahora se guarda en una tabla propia para mostrarse en su
  // dashboard, con el mensaje exacto y la operación exacta (importante
  // cuando tiene varias solicitudes activas con distintos prestamistas a
  // la vez, para que sepa quién le pide qué).
  await pool.query(
    `INSERT INTO solicitudes_documentos (id_oportunidad, mensaje, fecha_solicitud, atendida)
     VALUES ($1, $2, now(), false)
     ON CONFLICT (id_oportunidad) DO UPDATE SET mensaje = EXCLUDED.mensaje, fecha_solicitud = now(), atendida = false`,
    [idOp, mensajePersonalizado || "Por favor sube tu cédula/pasaporte y fotos del bien en garantía."]
  );

  await registrarAuditoria(null, op.id_solicitante, "Documentos_Solicitados", "Marketplace", {
    idOp,
    mensaje: mensajePersonalizado || "",
  });

  // TODO EMAIL: enviar el correo de solicitud de documentos al prestatario.

  return { exito: true, mensaje: "Solicitud registrada — el prestatario la verá en su dashboard, en esta operación." };
}

/**
 * Links de documentos (cédula + bien en garantía) de una operación, para
 * mostrarlos en "Mis Préstamos" del prestamista.
 */
async function obtenerDocumentosDeOperacion(idOp) {
  // Implementación real desde el módulo 5 (documentos + IA) — antes de eso
  // este endpoint era un stub que siempre devolvía links vacíos, porque
  // todavía no existía ninguna tabla ni flujo de subida de documentos.
  const { obtenerDocumentosDeOperacion: obtenerDocsReal } = require("./documentos.service");
  return obtenerDocsReal(idOp);
}

module.exports = {
  obtenerOportunidadesMercado,
  obtenerPrestamosSolicitados,
  obtenerMisPrestamosPrestamista,
  enviarContraoferta,
  responderPropuesta,
  solicitarDocumentosPrestatario,
  obtenerDocumentosDeOperacion,
  suscripcionPrestamistaActiva,
};
