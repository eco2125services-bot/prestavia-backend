/**
 * PrestaVía — Backend — cobranzas.service.js
 *
 * Reemplaza ActualizacionCobranzas.gs (autorización de desembolso por el
 * Admin, validación de pagos de cuota reportados) y la función
 * ejecutarGeneracionAmortizacionReal() de Amortizacion.gs (que en el
 * original se llamaba desde ActualizacionCobranzas.gs al autorizar el
 * desembolso — se mantiene esa misma relación aquí). También incluye la
 * aprobación de comisiones de PagoComision.gs, porque
 * autorizarDesembolsoPrestamoAdmin() depende de ese gate.
 *
 * Todas las funciones de este archivo son de uso EXCLUSIVO de un usuario
 * con rol 'Admin' (verificado en el middleware de las rutas).
 */
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { calcularAmortizacion } = require("./amortizacion.service");
const { actualizarReputacionUsuario, incrementarPrestamosExitosos } = require("./reputacion.service");

function generarId(prefijo) {
  return prefijo + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Lista de comisiones de plataforma PENDIENTES de aprobación.
 */
async function obtenerPagosComisionPendientesAdmin() {
  const { rows } = await pool.query(
    `SELECT pc.id_comision, pc.id_oportunidad, u.nombre_legal AS prestatario, pc.monto_pagado,
            pc.metodo_pago, pc.referencia, pc.url_comprobante
     FROM pagos_comision pc
     LEFT JOIN oportunidades_mercado om ON om.id_oportunidad = pc.id_oportunidad
     LEFT JOIN usuarios u ON u.id_usuario = om.id_solicitante
     WHERE pc.estatus_revision = 'Pendiente'
     ORDER BY pc.fecha_reporte ASC`
  );
  return rows;
}

async function aprobarPagoComisionAdmin(idComision, aprobado, notas, idAdmin) {
  const { rows } = await pool.query(
    `UPDATE pagos_comision
     SET estatus_revision = $1, fecha_aprobacion = now(), notas_admin = $2
     WHERE id_comision = $3
     RETURNING id_comision`,
    [aprobado ? "Aprobado" : "Rechazado", notas || null, idComision]
  );
  if (rows.length === 0) return { exito: false, mensaje: "Registro de comisión no encontrado." };

  await registrarAuditoria(null, idAdmin, aprobado ? "Comision_Aprobada" : "Comision_Rechazada", "PagoComision", { idComision });
  return { exito: true, mensaje: aprobado ? "Comisión aprobada. Ya se puede autorizar el desembolso." : "Comisión rechazada." };
}

async function comisionEstaAprobada(client, idOportunidad) {
  const { rows } = await client.query(
    "SELECT 1 FROM pagos_comision WHERE id_oportunidad = $1 AND estatus_revision = 'Aprobado' LIMIT 1",
    [idOportunidad]
  );
  return rows.length > 0;
}

/**
 * Genera la tabla de cuotas reales en control_pagos para una operación
 * recién desembolsada. Candado anti-duplicados: si la operación ya tiene
 * cuotas generadas, no crea un segundo juego.
 */
async function generarAmortizacionReal(client, idOp) {
  const { rows: existentes } = await client.query("SELECT 1 FROM control_pagos WHERE id_oportunidad = $1 LIMIT 1", [idOp]);
  if (existentes.length > 0) {
    return { exito: false, mensaje: "Esta operación ya tenía una tabla de amortización generada — se omitió para evitar duplicados." };
  }

  const { rows } = await client.query(
    `SELECT monto_solicitado, plazo_meses, tasa_interes_anual, id_solicitante, id_prestamista_asignado
     FROM oportunidades_mercado WHERE id_oportunidad = $1`,
    [idOp]
  );
  const op = rows[0];
  if (!op) throw new Error("Operación no encontrada: " + idOp);

  const monto = parseFloat(op.monto_solicitado) || 0;
  const plazo = parseInt(op.plazo_meses, 10) || 1;
  const tasaAnual = parseFloat(op.tasa_interes_anual) || 0;
  const { cuotaMensual } = calcularAmortizacion(monto, plazo, tasaAnual);

  const hoy = new Date();
  for (let n = 1; n <= plazo; n++) {
    const idPago = generarId("PAY");
    const fechaVenc = new Date(hoy.getFullYear(), hoy.getMonth() + n, hoy.getDate());
    await client.query(
      `INSERT INTO control_pagos
         (id_pago, id_oportunidad, id_prestatario, id_prestamista, numero_cuota, monto_cuota, fecha_vencimiento, estatus_pago)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pendiente')`,
      [idPago, idOp, op.id_solicitante, op.id_prestamista_asignado, n, cuotaMensual, fechaVenc]
    );
  }

  // TODO EMAIL: avisar a prestatario y prestamista que la tabla de amortización ya está lista.

  return { exito: true, mensaje: `Tabla de amortización generada: ${plazo} cuotas.` };
}

/**
 * AUTORIZACIÓN DE DESEMBOLSO — pasa la operación a 'En_Cobro', bloquea la
 * garantía, y genera la tabla de amortización real. Requiere que la
 * comisión de plataforma ya esté aprobada.
 */
async function autorizarDesembolsoPrestamoAdmin(idOp, idAdmin) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT id_oportunidad, estatus, id_activo_garantia FROM oportunidades_mercado WHERE id_oportunidad = $1 FOR UPDATE",
      [idOp]
    );
    const op = rows[0];
    if (!op) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Operación no encontrada." };
    }
    if (op.estatus !== "Por_Desembolsar" && op.estatus !== "Financiada") {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: `La operación no está lista para desembolso (estatus actual: ${op.estatus}).` };
    }

    const comisionOk = await comisionEstaAprobada(client, idOp);
    if (!comisionOk) {
      await client.query("ROLLBACK");
      return {
        exito: false,
        mensaje: "⚠️ No se puede autorizar: el pago de la comisión del 5% del prestamista aún no está aprobado.",
      };
    }

    await client.query("UPDATE oportunidades_mercado SET estatus = 'En_Cobro', updated_at = now() WHERE id_oportunidad = $1", [idOp]);

    if (op.id_activo_garantia) {
      await client.query("UPDATE activos_garantia SET estatus_validacion = 'Bloqueada_En_Garantia', updated_at = now() WHERE id_activo = $1", [
        op.id_activo_garantia,
      ]);
    }

    const resultadoAmortizacion = await generarAmortizacionReal(client, idOp);

    await registrarAuditoria(client, idAdmin, "Desembolso_Autorizado", "Cobranzas", { idOp });

    await client.query("COMMIT");

    return {
      exito: true,
      mensaje: "✅ Desembolso autorizado. Préstamo en 'En_Cobro'" + (resultadoAmortizacion.exito ? " y tabla de amortización generada." : "."),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "❌ Error al autorizar desembolso: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * Lista de pagos de CUOTA pendientes de aprobación.
 */
async function obtenerPagosDeCuotaPendientesAdmin() {
  const { rows } = await pool.query(
    `SELECT rp.id_transaccion, rp.id_pago, rp.id_oportunidad, u.nombre_legal AS prestatario,
            rp.monto_reportado, rp.metodo_pago, rp.referencia_bancaria, rp.url_comprobante
     FROM registro_pagos rp
     LEFT JOIN usuarios u ON u.id_usuario = rp.id_prestatario
     WHERE rp.estatus_revision = 'Pendiente'
     ORDER BY rp.fecha_reporte ASC`
  );
  return rows;
}

/**
 * VALIDACIÓN (aprobación/rechazo) de un pago de cuota reportado. Si se
 * aprueba: aplica el monto contra las cuotas pendientes en orden (cuotas
 * completas se marcan "Pagado"; un remanente que no alcanza para una cuota
 * entera se aplica como abono adelantado descontado de la siguiente
 * cuota). Si ya no quedan cuotas pendientes, cierra el préstamo
 * ("Pagada"), libera la garantía, y bonifica la reputación de ambas
 * partes.
 */
async function concluirValidacionTransaccion(idRegistro, aprobado, motivoRechazo, idAdmin) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: rowsReg } = await client.query(
      "SELECT id_transaccion, id_oportunidad, monto_reportado FROM registro_pagos WHERE id_transaccion = $1 FOR UPDATE",
      [idRegistro]
    );
    const registro = rowsReg[0];
    if (!registro) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Registro de pago no encontrado: " + idRegistro };
    }

    if (!aprobado) {
      await client.query("UPDATE registro_pagos SET estatus_revision = 'Rechazado', notas_admin = $1 WHERE id_transaccion = $2", [
        motivoRechazo || "Comprobante inválido",
        idRegistro,
      ]);
      await registrarAuditoria(client, idAdmin, "Pago_Rechazado", "Cobranzas", { idRegistro });
      await client.query("COMMIT");
      return { exito: true, mensaje: "Transacción rechazada. La cuota permanece pendiente." };
    }

    await client.query("UPDATE registro_pagos SET estatus_revision = 'Validado' WHERE id_transaccion = $1", [idRegistro]);

    const idOportunidad = registro.id_oportunidad;
    let montoRestante = parseFloat(registro.monto_reportado) || 0;
    let cuotasPagadasAhora = 0;
    let huboAbonoParcial = false;
    let montoAbonoParcial = 0;

    const { rows: cuotas } = await client.query(
      `SELECT id_pago, monto_cuota, estatus_pago, id_prestatario
       FROM control_pagos
       WHERE id_oportunidad = $1 AND estatus_pago IN ('Pendiente', 'Vencido')
       ORDER BY numero_cuota ASC
       FOR UPDATE`,
      [idOportunidad]
    );

    for (const cuota of cuotas) {
      if (montoRestante <= 0) break;
      const montoCuotaActual = parseFloat(cuota.monto_cuota) || 0;

      if (montoRestante >= montoCuotaActual - 0.01) {
        await client.query(
          "UPDATE control_pagos SET estatus_pago = 'Pagado', fecha_pago = now(), monto_recibido_confirmado = $1 WHERE id_pago = $2",
          [montoCuotaActual, cuota.id_pago]
        );
        montoRestante = parseFloat((montoRestante - montoCuotaActual).toFixed(2));
        cuotasPagadasAhora++;

        if (cuota.estatus_pago !== "Vencido") {
          await actualizarReputacionUsuario(client, cuota.id_prestatario, 5);
        }
      } else {
        const nuevoMontoCuota = parseFloat((montoCuotaActual - montoRestante).toFixed(2));
        await client.query(
          "UPDATE control_pagos SET monto_cuota = $1, observaciones_conciliacion = $2 WHERE id_pago = $3",
          [
            nuevoMontoCuota,
            `Abono adelantado aplicado: $${montoRestante.toFixed(2)} (monto original de la cuota: $${montoCuotaActual.toFixed(2)})`,
            cuota.id_pago,
          ]
        );
        huboAbonoParcial = true;
        montoAbonoParcial = montoRestante;
        montoRestante = 0;
        break;
      }
    }

    if (cuotasPagadasAhora === 0 && !huboAbonoParcial) {
      await client.query("ROLLBACK");
      return {
        exito: false,
        mensaje: "No se encontró ninguna cuota pendiente para conciliar en esta operación (puede que ya esté completamente pagada).",
      };
    }

    const { rows: pendientes } = await client.query(
      `SELECT monto_cuota FROM control_pagos WHERE id_oportunidad = $1 AND estatus_pago IN ('Pendiente', 'Vencido')`,
      [idOportunidad]
    );
    const pendientesRestantes = pendientes.length;
    const saldoTotalPendiente = parseFloat(pendientes.reduce((acc, c) => acc + parseFloat(c.monto_cuota), 0).toFixed(2));

    // TODO EMAIL: notificar a prestatario y prestamista el resumen de este pago (cuotas pagadas, saldo restante).

    if (pendientesRestantes === 0) {
      const { rows: rowsOp } = await client.query(
        "SELECT id_solicitante, id_prestamista_asignado, id_activo_garantia FROM oportunidades_mercado WHERE id_oportunidad = $1",
        [idOportunidad]
      );
      const op = rowsOp[0];
      if (op) {
        await client.query("UPDATE oportunidades_mercado SET estatus = 'Pagada', updated_at = now() WHERE id_oportunidad = $1", [
          idOportunidad,
        ]);
        await incrementarPrestamosExitosos(client, op.id_solicitante);
        await incrementarPrestamosExitosos(client, op.id_prestamista_asignado);
        await actualizarReputacionUsuario(client, op.id_solicitante, 25);
        await actualizarReputacionUsuario(client, op.id_prestamista_asignado, 15);

        if (op.id_activo_garantia) {
          await client.query("UPDATE activos_garantia SET estatus_validacion = 'Liberada', updated_at = now() WHERE id_activo = $1", [
            op.id_activo_garantia,
          ]);
        }
        // TODO EMAIL: notificar a las 3 partes (prestatario, prestamista, admin) que el préstamo se cerró y la garantía quedó liberada.
      }
    }

    await registrarAuditoria(client, idAdmin, "Pago_Validado", "Cobranzas", { idRegistro, idOportunidad, cuotasPagadasAhora });

    await client.query("COMMIT");

    let mensajeFinal = "✅ Pago aprobado. ";
    if (cuotasPagadasAhora > 0) mensajeFinal += `${cuotasPagadasAhora} cuota(s) marcada(s) como pagada(s). `;
    if (huboAbonoParcial) mensajeFinal += `Abono adelantado de $${montoAbonoParcial.toFixed(2)} aplicado. `;
    mensajeFinal += `Saldo pendiente: $${saldoTotalPendiente.toFixed(2)} (${pendientesRestantes} cuota(s)).`;

    return { exito: true, mensaje: mensajeFinal };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "❌ Error al validar transacción: " + error.message };
  } finally {
    client.release();
  }
}

module.exports = {
  obtenerPagosComisionPendientesAdmin,
  aprobarPagoComisionAdmin,
  autorizarDesembolsoPrestamoAdmin,
  obtenerPagosDeCuotaPendientesAdmin,
  concluirValidacionTransaccion,
};
