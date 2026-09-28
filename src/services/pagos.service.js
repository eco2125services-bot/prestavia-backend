/**
 * PrestaVía — Backend — pagos.service.js
 *
 * Reemplaza RecepcionPagos.gs (el prestatario reporta el pago de una
 * cuota) y PagoComision.gs (el prestamista reporta el pago de la comisión
 * de originación del 5%, retenida del monto del préstamo).
 *
 * Diferencia deliberada frente al original: el usuario que reporta se toma
 * SIEMPRE del JWT (req.usuario.idUsuario en el controller), nunca de un
 * campo idUsuario que mande el cliente — Apps Script confiaba en lo que
 * mandaba el navegador.
 */
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { guardarComprobanteBase64 } = require("./comprobante.service");

function generarId(prefijo) {
  return prefijo + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Cuotas pendientes de UN prestatario, en todas sus operaciones.
 */
async function obtenerCuotasPendientesUsuario(idPrestatario) {
  const { rows } = await pool.query(
    `SELECT id_pago, id_oportunidad, numero_cuota, monto_cuota, fecha_vencimiento
     FROM control_pagos
     WHERE id_prestatario = $1 AND estatus_pago = 'Pendiente'
     ORDER BY fecha_vencimiento ASC`,
    [idPrestatario]
  );
  return rows.map((r) => ({
    idPago: r.id_pago,
    idOp: r.id_oportunidad,
    numCuota: r.numero_cuota,
    montoCuota: parseFloat(r.monto_cuota),
    fechaVenc: r.fecha_vencimiento,
  }));
}

/**
 * Resumen de pago de UN préstamo específico (cuotas pendientes/vencidas,
 * saldo total, próxima cuota) — para el formulario de pago por operación.
 */
async function obtenerResumenPrestamoParaPago(idPrestatario, idOp) {
  const { rows } = await pool.query(
    `SELECT id_pago, numero_cuota, monto_cuota, fecha_vencimiento, estatus_pago
     FROM control_pagos
     WHERE id_prestatario = $1 AND id_oportunidad = $2 AND estatus_pago IN ('Pendiente', 'Vencido')
     ORDER BY numero_cuota ASC`,
    [idPrestatario, idOp]
  );

  const cuotasPendientes = rows.map((r) => ({
    idPago: r.id_pago,
    numCuota: r.numero_cuota,
    montoCuota: parseFloat(r.monto_cuota),
    fechaVenc: r.fecha_vencimiento,
    estatus: r.estatus_pago,
  }));
  const saldoTotalPendiente = parseFloat(cuotasPendientes.reduce((acc, c) => acc + c.montoCuota, 0).toFixed(2));

  return {
    cuotasPendientes,
    saldoTotalPendiente,
    proximaCuota: cuotasPendientes[0] || null,
  };
}

/**
 * El PRESTATARIO reporta el pago de una cuota específica (referencia,
 * método de pago, y opcionalmente un comprobante). Queda "Pendiente" de
 * validación por el prestamista/admin (ver cobranzas.service.js).
 */
async function guardarReportePago(idPrestatarioAutenticado, datos) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id_pago, id_oportunidad, id_prestatario, id_prestamista
       FROM control_pagos WHERE id_pago = $1 FOR UPDATE`,
      [datos.idPago]
    );
    const cuota = rows[0];
    if (!cuota) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "La cuota reportada ya no existe o el ID es inválido." };
    }
    if (cuota.id_prestatario !== idPrestatarioAutenticado) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Esta cuota no te pertenece." };
    }

    const urlComprobante = await guardarComprobanteBase64(client, {
      archivoBase64: datos.archivoBase64,
      archivoMimeType: datos.archivoMimeType,
      archivoNombre: datos.archivoNombre,
    });

    const idTransaccion = generarId("TX");
    await client.query(
      `INSERT INTO registro_pagos
         (id_transaccion, id_pago, id_oportunidad, id_prestatario, monto_reportado, metodo_pago, referencia_bancaria, url_comprobante)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        idTransaccion,
        datos.idPago,
        cuota.id_oportunidad,
        idPrestatarioAutenticado,
        datos.montoPagado,
        datos.metodoPago || null,
        datos.referencia || null,
        urlComprobante,
      ]
    );

    await registrarAuditoria(client, idPrestatarioAutenticado, "Pago_Reportado", "RecepcionPagos", {
      idPago: datos.idPago,
      idTransaccion,
    });

    await client.query("COMMIT");

    // TODO EMAIL: avisar al prestamista asignado que hay un pago nuevo por validar.
    // TODO EMAIL: avisar al admin.

    return { exito: true, mensaje: "Pago reportado. Un administrador validará la transacción.", idTransaccion };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al reportar el pago: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * El PRESTAMISTA reporta que pagó la comisión de originación (5%) a la
 * plataforma. Solo puede reportarla sobre una operación asignada a él
 * mismo (verificación de dueño, igual que en el original).
 */
async function reportarPagoComisionPrestamista(idPrestamistaAutenticado, datos) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id_oportunidad, id_solicitante, id_prestamista_asignado
       FROM oportunidades_mercado WHERE id_oportunidad = $1 FOR UPDATE`,
      [datos.idOportunidad]
    );
    const op = rows[0];
    if (!op || op.id_prestamista_asignado !== idPrestamistaAutenticado) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Esta operación no está asignada a tu cuenta." };
    }

    const urlComprobante = await guardarComprobanteBase64(client, {
      archivoBase64: datos.archivoBase64,
      archivoMimeType: datos.archivoMimeType,
      archivoNombre: datos.archivoNombre,
    });

    const idComision = generarId("FEE");
    await client.query(
      `INSERT INTO pagos_comision
         (id_comision, id_oportunidad, id_prestamista_pagador, monto_pagado, metodo_pago, referencia, url_comprobante, notas_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        idComision,
        datos.idOportunidad,
        idPrestamistaAutenticado,
        datos.montoPagado,
        datos.metodoPago || null,
        datos.referencia || null,
        urlComprobante,
        `Pagado por: ${idPrestamistaAutenticado} (prestamista)`,
      ]
    );

    await registrarAuditoria(client, idPrestamistaAutenticado, "Comision_Reportada", "PagoComision", {
      idOportunidad: datos.idOportunidad,
      idComision,
    });

    await client.query("COMMIT");

    // TODO EMAIL: avisar al admin que hay una comisión por aprobar.

    return { exito: true, mensaje: "Comisión reportada. Un administrador la validará antes de autorizar el desembolso.", idComision };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al reportar la comisión: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * Encuentra, para un prestamista, la operación (si hay alguna) que está
 * esperando el pago de su comisión — para auto-llenar el formulario.
 */
async function obtenerOperacionPendienteComisionPrestamista(idPrestamistaAutenticado) {
  const { rows } = await pool.query(
    `SELECT om.id_oportunidad
     FROM oportunidades_mercado om
     WHERE om.id_prestamista_asignado = $1
       AND om.estatus IN ('Financiada', 'Por_Desembolsar')
       AND NOT EXISTS (
         SELECT 1 FROM pagos_comision pc
         WHERE pc.id_oportunidad = om.id_oportunidad AND pc.estatus_revision = 'Aprobado'
       )
     LIMIT 1`,
    [idPrestamistaAutenticado]
  );
  return rows[0] ? rows[0].id_oportunidad : "";
}

module.exports = {
  obtenerCuotasPendientesUsuario,
  obtenerResumenPrestamoParaPago,
  guardarReportePago,
  reportarPagoComisionPrestamista,
  obtenerOperacionPendienteComisionPrestamista,
};
