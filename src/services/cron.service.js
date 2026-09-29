/**
 * PrestaVía — Backend — cron.service.js
 *
 * Reemplaza CronPlanificadores.gs (evaluarVencimientosSuscripcion,
 * evaluarCuotasVencidas). En Apps Script estas dos funciones corrían solas
 * todos los días vía un "trigger" instalable de la propia plataforma
 * (ScriptApp.newTrigger(...).timeBased()...). Aquí no hay un runtime que
 * "duerma y despierte solo" dentro del propio proceso — un `setInterval`
 * dentro del web service de Render NO sirve porque el plan Free se duerme
 * tras ~15 min sin tráfico, y aunque no se durmiera, un restart del
 * servicio reiniciaría el contador.
 *
 * DECISIÓN DELIBERADA: este servicio expone las dos funciones puras (sin
 * ningún `setInterval` ni cron en proceso). Quien las dispara diariamente
 * es un **Render Cron Job** separado — un servicio de Render que
 * simplemente ejecuta un comando en un horario fijo y se apaga — que
 * corre `src/jobs/cron-diario.js` (ver ese archivo y el README para la
 * configuración exacta). Esa es la forma "nativa" de Render de reemplazar
 * los triggers instalables de Apps Script.
 *
 * DIFERENCIA DELIBERADA #2: el original tenía DOS triggers separados
 * (uno a las ~8am para vencimientos de suscripción, otro a las ~9am para
 * mora). Aquí se combinan en una sola ejecución diaria del Cron Job — no
 * hay una razón de negocio real para separarlos en dos horarios distintos,
 * y correr un solo Cron Job (en vez de dos) es más simple de mantener y
 * más barato en el plan Free de Render (que cobra/limita por servicio).
 *
 * EMAIL: igual que en el resto del backend, el envío real de correos
 * (recordatorios de vencimiento, avisos de mora) queda marcado con
 * // TODO EMAIL — no se pierde el requisito, pero no se manda ningún
 * correo real hasta que se conecte un proveedor (ver README).
 */
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { actualizarReputacionUsuario } = require("./reputacion.service");

const DIAS_GRACIA_MORA = 3;
const TASA_MORA_DIARIA_DEFECTO = 0.5; // % diario, si la operación no tiene una propia

/**
 * Revisa las suscripciones de los prestamistas con plan activo:
 *  - Si ya venció (fecha_fin_plan <= hoy): pasa a 'Vencido'.
 *  - Si vence en exactamente 5 o 2 días: dispara un recordatorio (por
 *    ahora solo queda registrado — ver TODO EMAIL).
 * Idempotente: se puede correr varias veces el mismo día sin duplicar
 * nada raro (una vez 'Vencido', deja de aparecer en la consulta).
 */
async function evaluarVencimientosSuscripcion() {
  const resumen = { vencidosHoy: 0, recordatorios5Dias: 0, recordatorios2Dias: 0, errores: 0 };

  const { rows } = await pool.query(
    `SELECT id_usuario, nombre_legal, email, fecha_fin_plan,
            (fecha_fin_plan - CURRENT_DATE) AS dias_restantes
     FROM usuarios
     WHERE rol = 'Prestamista' AND estatus_suscripcion = 'Activo' AND fecha_fin_plan IS NOT NULL`
  );

  for (const usuario of rows) {
    try {
      const diasRestantes = parseInt(usuario.dias_restantes, 10);

      if (diasRestantes <= 0) {
        await pool.query("UPDATE usuarios SET estatus_suscripcion = 'Vencido', updated_at = now() WHERE id_usuario = $1", [
          usuario.id_usuario,
        ]);
        await registrarAuditoria(null, usuario.id_usuario, "Suscripcion_Vencida_Cron", "CronPlanificadores", {
          fechaFinPlan: usuario.fecha_fin_plan,
        });
        resumen.vencidosHoy++;
        // TODO EMAIL: avisar al prestamista que su suscripción venció y su acceso quedó pausado.
      } else if (diasRestantes === 5) {
        resumen.recordatorios5Dias++;
        // TODO EMAIL: recordatorio — la suscripción vence en 5 días.
      } else if (diasRestantes === 2) {
        resumen.recordatorios2Dias++;
        // TODO EMAIL: recordatorio urgente — la suscripción vence en 2 días.
      }
    } catch (error) {
      resumen.errores++;
      console.error(`Error evaluando vencimiento de suscripción para ${usuario.id_usuario}:`, error.message);
    }
  }

  return resumen;
}

/**
 * Revisa TODAS las cuotas Pendiente/Vencido de control_pagos. Si una cuota
 * pasó su fecha de vencimiento + 3 días de gracia (cláusula CUARTA del
 * contrato, ver pdf.service.js) sin pagarse, la marca 'Vencido', calcula
 * los días de mora y el interés de mora usando la tasa_mora_diaria que el
 * PRESTAMISTA fijó para esa operación específica (no una tasa global de
 * la plataforma — igual que el original). La primera vez que una cuota
 * entra en mora, penaliza la reputación del prestatario; en revisiones
 * posteriores del mismo atraso, solo actualiza días/interés sin penalizar
 * de nuevo ni duplicar notificaciones.
 */
async function evaluarCuotasVencidas() {
  const resumen = { cuotasNuevasEnMora: 0, cuotasActualizadas: 0, errores: 0 };

  const { rows } = await pool.query(
    `SELECT cp.id_pago, cp.id_oportunidad, cp.id_prestatario, cp.id_prestamista, cp.monto_cuota,
            cp.estatus_pago, cp.fecha_vencimiento,
            (CURRENT_DATE - cp.fecha_vencimiento) AS dias_mora,
            COALESCE(om.tasa_mora_diaria, $1) AS tasa_mora_diaria
     FROM control_pagos cp
     JOIN oportunidades_mercado om ON om.id_oportunidad = cp.id_oportunidad
     WHERE cp.estatus_pago IN ('Pendiente', 'Vencido')
       AND cp.fecha_vencimiento + $2::int < CURRENT_DATE`,
    [TASA_MORA_DIARIA_DEFECTO, DIAS_GRACIA_MORA]
  );

  for (const cuota of rows) {
    try {
      const diasMora = parseInt(cuota.dias_mora, 10);
      const tasaMoraDiaria = parseFloat(cuota.tasa_mora_diaria) || TASA_MORA_DIARIA_DEFECTO;
      const montoCuota = parseFloat(cuota.monto_cuota) || 0;
      const interesMora = parseFloat(((montoCuota * (tasaMoraDiaria / 100)) * diasMora).toFixed(2));
      const eraVencidaAntes = cuota.estatus_pago === "Vencido";

      await pool.query(
        `UPDATE control_pagos SET estatus_pago = 'Vencido', dias_mora = $1, interes_mora_aplicado = $2, updated_at = now()
         WHERE id_pago = $3`,
        [diasMora, interesMora, cuota.id_pago]
      );

      if (!eraVencidaAntes) {
        await actualizarReputacionUsuario(null, cuota.id_prestatario, -10);
        await registrarAuditoria(null, cuota.id_prestatario, "Cuota_En_Mora_Cron", "CronPlanificadores", {
          idPago: cuota.id_pago,
          idOportunidad: cuota.id_oportunidad,
          diasMora,
          interesMora,
        });
        resumen.cuotasNuevasEnMora++;
        // TODO EMAIL: avisar a prestatario y prestamista que la cuota entró en mora (monto + interés aplicado).
      } else {
        resumen.cuotasActualizadas++;
      }
    } catch (error) {
      resumen.errores++;
      console.error(`Error evaluando mora de la cuota ${cuota.id_pago}:`, error.message);
    }
  }

  return resumen;
}

module.exports = { evaluarVencimientosSuscripcion, evaluarCuotasVencidas };
