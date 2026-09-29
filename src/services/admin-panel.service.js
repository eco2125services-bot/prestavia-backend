/**
 * PrestaVía — Backend — admin-panel.service.js
 *
 * Reemplaza AdminPanel.gs y AdminPanelRootBackend.gs — el panel de
 * administración: listado/edición de usuarios, activación manual de
 * suscripciones de prestamistas, indicadores de gestión, ingresos de la
 * plataforma, cierre manual de préstamos (fallback), bóveda de contratos,
 * y el widget de "tareas pendientes" del dashboard.
 *
 * Funciones del original NO portadas aquí, por no aplicar a esta
 * arquitectura (Postgres/Node en vez de Sheets + Drive):
 *  - crearUsuarioAdminInicial(): en Apps Script era un setup manual de
 *    una sola vez sobre la hoja de Sheets. Aquí un Admin se promueve con
 *    un UPDATE SQL directo (ver README, sección de Módulo 4).
 *  - fijarEncabezadosOportunidadesMercado(): utilidad de encabezados de
 *    Sheets — no existe el concepto de "encabezados de columna" en una
 *    tabla de Postgres.
 *  - forzarAutorizacionCompletaDrive() / diagnosticarGeneracionContrato():
 *    utilidades de diagnóstico de permisos de Google Drive — nuestro
 *    contrato.service.js nunca toca Drive (los PDFs se guardan como BYTEA
 *    en Neon, ver Módulo 3).
 *  - generarContratoManualTemporal(): función de debug/prueba del
 *    original, no una operación real del panel.
 *
 * Todas las funciones de este archivo son de uso EXCLUSIVO de un usuario
 * con rol 'Admin' (verificado en el middleware de las rutas /admin/*).
 */
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { actualizarReputacionUsuario, incrementarPrestamosExitosos } = require("./reputacion.service");

// Precios de referencia de la suscripción de prestamista (igual que el
// original de Apps Script): $20/mes o $200/año.
const PRECIO_PLAN_MENSUAL = 20;
const PRECIO_PLAN_ANUAL = 200;

const ESTADOS_PRESTAMO_ACTIVO = ["Financiada", "Por_Desembolsar", "En_Cobro", "Pagada"];

// ---------------------------------------------------------------------
// Gestión de usuarios
// ---------------------------------------------------------------------

/**
 * Lista maestra de usuarios, opcionalmente filtrada por rol
 * ('Prestamista' | 'Prestatario' | 'Admin').
 */
async function obtenerUsuariosAdmin(filtroRol) {
  const params = [];
  let where = "";
  if (filtroRol) {
    params.push(filtroRol);
    where = "WHERE rol = $1";
  }
  const { rows } = await pool.query(
    `SELECT id_usuario, nombre_legal, email, telefono, direccion_fiscal, cedula_pasaporte, rif, rol,
            plan_suscripcion, estatus_suscripcion, fecha_fin_plan, verificacion_identidad_ia,
            puntos_reputacion, prestamos_exitosos, pais_residencia, created_at
     FROM usuarios
     ${where}
     ORDER BY created_at DESC`,
    params
  );
  return rows;
}

/**
 * Edición de datos de contacto de un usuario por el Admin — igual que el
 * original, deliberadamente NO permite tocar contraseña ni rol desde
 * aquí (eso evita que un error de UI convierta a alguien en Admin por
 * accidente; el rol se cambia con SQL directo, a propósito).
 */
async function actualizarDatosUsuarioAdmin(idUsuario, datos, idAdmin) {
  const { rows } = await pool.query(
    `UPDATE usuarios
     SET nombre_legal = COALESCE($1, nombre_legal),
         email = COALESCE($2, email),
         telefono = COALESCE($3, telefono),
         direccion_fiscal = COALESCE($4, direccion_fiscal),
         updated_at = now()
     WHERE id_usuario = $5
     RETURNING id_usuario`,
    [datos.nombre || null, datos.email || null, datos.telefono || null, datos.direccion || null, idUsuario]
  );
  if (rows.length === 0) return { exito: false, mensaje: "Usuario no encontrado." };

  await registrarAuditoria(null, idAdmin, "Usuario_Editado_Por_Admin", "AdminPanel", { idUsuario });
  return { exito: true, mensaje: "Datos del usuario actualizados." };
}

/**
 * Prestamistas registrados que están esperando que el Admin confirme su
 * pago de suscripción (Zelle u otro método manual) para poder operar.
 */
async function obtenerPrestamistasPendientesActivacionAdmin() {
  const { rows } = await pool.query(
    `SELECT id_usuario, nombre_legal, email, telefono, plan_suscripcion, pais_residencia, created_at
     FROM usuarios
     WHERE rol = 'Prestamista' AND estatus_suscripcion = 'Pendiente'
     ORDER BY created_at ASC`
  );
  return rows;
}

/**
 * Activa manualmente la suscripción de un prestamista una vez el Admin
 * confirmó el pago fuera de la plataforma. plan: 'mensual' | 'anual'.
 */
async function activarSuscripcionAdmin(idUsuario, plan, idAdmin) {
  const planNormalizado = plan === "anual" ? "anual" : "mensual";
  const diasVigencia = planNormalizado === "anual" ? 365 : 30;

  const { rows } = await pool.query(
    `UPDATE usuarios
     SET estatus_suscripcion = 'Activo', plan_suscripcion = $1,
         fecha_fin_plan = (CURRENT_DATE + $2::int), updated_at = now()
     WHERE id_usuario = $3 AND rol = 'Prestamista'
     RETURNING id_usuario, to_char(fecha_fin_plan, 'YYYY-MM-DD') AS fecha_fin_plan`,
    [planNormalizado, diasVigencia, idUsuario]
  );
  if (rows.length === 0) return { exito: false, mensaje: "Prestamista no encontrado." };

  await registrarAuditoria(null, idAdmin, "Suscripcion_Activada", "AdminPanel", { idUsuario, plan: planNormalizado });

  // TODO EMAIL: avisar al prestamista que su cuenta ya está activa.

  return {
    exito: true,
    mensaje: `Suscripción activada (plan ${planNormalizado}). Vigente hasta ${rows[0].fecha_fin_plan}.`,
  };
}

// ---------------------------------------------------------------------
// Ingresos e indicadores
// ---------------------------------------------------------------------

/**
 * Ingresos de la plataforma: comisiones ya aprobadas + suscripciones de
 * prestamistas actualmente activas (a los precios de referencia).
 */
async function obtenerIngresosPlataformaAdmin() {
  const { rows: rowsComisiones } = await pool.query(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS total, COUNT(*) AS cantidad
     FROM pagos_comision WHERE estatus_revision = 'Aprobado'`
  );
  const totalComisiones = parseFloat(rowsComisiones[0].total) || 0;
  const cantidadComisiones = parseInt(rowsComisiones[0].cantidad, 10) || 0;

  const { rows: rowsSuscripciones } = await pool.query(
    `SELECT plan_suscripcion, COUNT(*) AS cantidad
     FROM usuarios
     WHERE rol = 'Prestamista' AND estatus_suscripcion = 'Activo'
     GROUP BY plan_suscripcion`
  );
  let prestamistasActivosMensual = 0;
  let prestamistasActivosAnual = 0;
  for (const fila of rowsSuscripciones) {
    if (fila.plan_suscripcion === "anual") prestamistasActivosAnual = parseInt(fila.cantidad, 10);
    else prestamistasActivosMensual += parseInt(fila.cantidad, 10);
  }
  const ingresosSuscripciones = prestamistasActivosMensual * PRECIO_PLAN_MENSUAL + prestamistasActivosAnual * PRECIO_PLAN_ANUAL;

  return {
    comisiones: { total: totalComisiones, cantidadPagos: cantidadComisiones },
    suscripciones: {
      prestamistasActivosMensual,
      prestamistasActivosAnual,
      ingresosEstimadosRecurrentes: ingresosSuscripciones,
    },
    totalIngresos: parseFloat((totalComisiones + ingresosSuscripciones).toFixed(2)),
  };
}

/**
 * Indicadores operativos: préstamos por estatus, garantías por estatus, y
 * totales generales.
 */
async function obtenerIndicadoresGestionAdmin() {
  const { rows: prestamosPorEstatus } = await pool.query(
    `SELECT estatus, COUNT(*) AS cantidad, COALESCE(SUM(monto_solicitado), 0) AS monto
     FROM oportunidades_mercado GROUP BY estatus ORDER BY estatus`
  );
  const { rows: garantiasPorEstatus } = await pool.query(
    `SELECT COALESCE(estatus_validacion, 'Sin_Evaluar') AS estatus_validacion, COUNT(*) AS cantidad
     FROM activos_garantia GROUP BY COALESCE(estatus_validacion, 'Sin_Evaluar') ORDER BY 1`
  );
  const { rows: totales } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM usuarios WHERE rol = 'Prestatario') AS total_prestatarios,
       (SELECT COUNT(*) FROM usuarios WHERE rol = 'Prestamista') AS total_prestamistas,
       (SELECT COUNT(*) FROM oportunidades_mercado) AS total_oportunidades`
  );

  return {
    prestamosPorEstatus: prestamosPorEstatus.map((f) => ({ estatus: f.estatus, cantidad: parseInt(f.cantidad, 10), monto: parseFloat(f.monto) })),
    garantiasPorEstatus: garantiasPorEstatus.map((f) => ({ estatus: f.estatus_validacion, cantidad: parseInt(f.cantidad, 10) })),
    totales: {
      totalPrestatarios: parseInt(totales[0].total_prestatarios, 10),
      totalPrestamistas: parseInt(totales[0].total_prestamistas, 10),
      totalOportunidades: parseInt(totales[0].total_oportunidades, 10),
    },
  };
}

/**
 * Métricas resumidas para el dashboard principal del Admin.
 */
async function obtenerMetricasDashboardAdmin() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM oportunidades_mercado WHERE estatus = ANY($1)) AS total_prestamos,
       (SELECT COALESCE(SUM(monto_solicitado), 0) FROM oportunidades_mercado WHERE estatus = ANY($1)) AS monto_total_financiado,
       (SELECT COUNT(*) FROM oportunidades_mercado WHERE estatus IN ('En Negociacion','Financiada','Por_Desembolsar')) AS solicitudes_pendientes`,
    [ESTADOS_PRESTAMO_ACTIVO]
  );
  return {
    totalPrestamos: parseInt(rows[0].total_prestamos, 10),
    montoTotalFinanciado: parseFloat(rows[0].monto_total_financiado),
    solicitudesPendientes: parseInt(rows[0].solicitudes_pendientes, 10),
  };
}

// ---------------------------------------------------------------------
// Operaciones (préstamos)
// ---------------------------------------------------------------------

/**
 * Vista "master" de oportunidades para el Admin — mismas llaves que
 * esperaba el frontend original (AdminPanelRootBackend.gs).
 */
async function obtenerOportunidadesMasterParaAdmin() {
  const { rows } = await pool.query(
    `SELECT om.id_oportunidad, u.nombre_legal AS prestatario, om.monto_solicitado, om.estatus
     FROM oportunidades_mercado om
     LEFT JOIN usuarios u ON u.id_usuario = om.id_solicitante
     ORDER BY om.created_at DESC`
  );
  return rows.map((f) => ({
    ID_Op: f.id_oportunidad,
    Prestatario: f.prestatario,
    Monto_Solicitado: parseFloat(f.monto_solicitado),
    Estatus: f.estatus,
  }));
}

/**
 * Operaciones con contrato ya generado, listas para que el Admin
 * autorice el desembolso (una vez la comisión esté aprobada — ver
 * cobranzas.service.js).
 */
async function obtenerOperacionesPorDesembolsarAdmin() {
  const { rows } = await pool.query(
    `SELECT om.id_oportunidad, up.nombre_legal AS prestatario, ul.nombre_legal AS prestamista,
            om.monto_solicitado, om.monto_neto_entregar, om.estatus,
            (SELECT estatus_revision FROM pagos_comision pc WHERE pc.id_oportunidad = om.id_oportunidad
               ORDER BY pc.fecha_reporte DESC LIMIT 1) AS estatus_comision
     FROM oportunidades_mercado om
     LEFT JOIN usuarios up ON up.id_usuario = om.id_solicitante
     LEFT JOIN usuarios ul ON ul.id_usuario = om.id_prestamista_asignado
     WHERE om.estatus IN ('Financiada', 'Por_Desembolsar')
     ORDER BY om.updated_at ASC`
  );
  return rows;
}

/**
 * CIERRE MANUAL de un préstamo — fallback para cuando el flujo automático
 * de validación de pagos (cobranzas.service.js) no aplica (ej. pago
 * recibido fuera de la plataforma, acuerdo especial con el prestatario).
 * Aplica exactamente los mismos efectos que el cierre automático: marca
 * la operación 'Pagada', bonifica reputación y contador de préstamos
 * exitosos de ambas partes, libera la garantía, y condona (perdona)
 * cualquier cuota que hubiera quedado pendiente o vencida.
 */
async function cerrarOperacionManualAdmin(idOp, motivo, idAdmin) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT id_oportunidad, estatus, id_solicitante, id_prestamista_asignado, id_activo_garantia FROM oportunidades_mercado WHERE id_oportunidad = $1 FOR UPDATE",
      [idOp]
    );
    const op = rows[0];
    if (!op) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Operación no encontrada." };
    }
    if (op.estatus === "Pagada") {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Esta operación ya estaba cerrada ('Pagada')." };
    }
    if (op.estatus !== "En_Cobro") {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: `Solo se pueden cerrar manualmente operaciones en 'En_Cobro' (estatus actual: ${op.estatus}).` };
    }

    const { rowCount: cuotasCondonadas } = await client.query(
      `UPDATE control_pagos SET estatus_pago = 'Condonado', observaciones_conciliacion = $1, updated_at = now()
       WHERE id_oportunidad = $2 AND estatus_pago IN ('Pendiente', 'Vencido')`,
      [`Condonada por cierre manual del Admin. Motivo: ${motivo || "no especificado"}`, idOp]
    );

    await client.query("UPDATE oportunidades_mercado SET estatus = 'Pagada', updated_at = now() WHERE id_oportunidad = $1", [idOp]);

    await incrementarPrestamosExitosos(client, op.id_solicitante);
    await incrementarPrestamosExitosos(client, op.id_prestamista_asignado);
    await actualizarReputacionUsuario(client, op.id_solicitante, 25);
    await actualizarReputacionUsuario(client, op.id_prestamista_asignado, 15);

    if (op.id_activo_garantia) {
      await client.query("UPDATE activos_garantia SET estatus_validacion = 'Liberada', updated_at = now() WHERE id_activo = $1", [
        op.id_activo_garantia,
      ]);
    }

    await registrarAuditoria(client, idAdmin, "Cierre_Manual_Admin", "AdminPanel", { idOp, motivo, cuotasCondonadas });

    await client.query("COMMIT");

    // TODO EMAIL: notificar a prestatario y prestamista que la operación fue cerrada manualmente por el Admin.

    return {
      exito: true,
      mensaje: `✅ Operación cerrada manualmente. ${cuotasCondonadas} cuota(s) pendiente(s) condonada(s). Garantía liberada.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "❌ Error al cerrar operación: " + error.message };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// Contratos (bóveda)
// ---------------------------------------------------------------------

/**
 * Vista "master" de contratos para el Admin — mismas llaves que esperaba
 * el frontend original.
 */
async function obtenerContratosMasterParaAdmin() {
  const { rows } = await pool.query(
    `SELECT id_contrato, id_oportunidad, fecha_firma, estatus_contrato, url_documento_pdf
     FROM contratos_firmados
     ORDER BY fecha_firma DESC`
  );
  return rows.map((f) => ({
    ID_Contrato: f.id_contrato,
    ID_Op: f.id_oportunidad,
    Fecha_Firma_Digital: f.fecha_firma,
    Estatus_Legal: f.estatus_contrato,
    Link_PDF_Generado: f.url_documento_pdf,
  }));
}

/**
 * Bóveda de contratos: cada contrato firmado con los datos de ambas
 * partes y los links de descarga (contrato + pagaré) — estos últimos
 * apuntan a GET /contratos/documento/:idDocumento, que ya valida acceso
 * de Admin (ver contrato.controller.js).
 */
async function obtenerBovedaContratosAdmin() {
  const { rows } = await pool.query(
    `SELECT cf.id_contrato, cf.id_oportunidad, cf.fecha_firma, cf.hash_firma_digital, cf.estatus_contrato,
            cf.url_documento_pdf AS url_contrato, cf.lien_ucc_registro AS url_pagare,
            up.nombre_legal AS prestatario, ul.nombre_legal AS prestamista,
            om.monto_solicitado, om.estatus AS estatus_operacion
     FROM contratos_firmados cf
     JOIN oportunidades_mercado om ON om.id_oportunidad = cf.id_oportunidad
     LEFT JOIN usuarios up ON up.id_usuario = cf.id_prestatario
     LEFT JOIN usuarios ul ON ul.id_usuario = cf.id_prestamista
     ORDER BY cf.fecha_firma DESC`
  );
  return rows;
}

// ---------------------------------------------------------------------
// Perfil propio y dashboard de tareas pendientes
// ---------------------------------------------------------------------

async function obtenerPerfilPropioAdmin(idAdmin) {
  const { rows } = await pool.query(
    "SELECT id_usuario, nombre_legal, email, telefono, rol, created_at FROM usuarios WHERE id_usuario = $1",
    [idAdmin]
  );
  return rows[0] || null;
}

/**
 * Contador agregado de "cosas por hacer" para el widget principal del
 * panel de Admin.
 */
async function obtenerTareasPendientesAdmin() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM usuarios WHERE rol = 'Prestamista' AND estatus_suscripcion = 'Pendiente') AS prestamistas_pendientes_activacion,
       (SELECT COUNT(*) FROM pagos_comision WHERE estatus_revision = 'Pendiente') AS comisiones_pendientes,
       (SELECT COUNT(*) FROM registro_pagos WHERE estatus_revision = 'Pendiente') AS cuotas_pendientes_validacion,
       (SELECT COUNT(*) FROM oportunidades_mercado WHERE estatus IN ('Financiada','Por_Desembolsar')) AS desembolsos_listos,
       (SELECT COUNT(*) FROM activos_garantia WHERE estatus_validacion IS NULL OR estatus_validacion = 'Pendiente') AS garantias_pendientes_evaluacion_ia`
  );
  const f = rows[0];
  return {
    prestamistasPendientesActivacion: parseInt(f.prestamistas_pendientes_activacion, 10),
    comisionesPendientes: parseInt(f.comisiones_pendientes, 10),
    cuotasPendientesValidacion: parseInt(f.cuotas_pendientes_validacion, 10),
    desembolsosListos: parseInt(f.desembolsos_listos, 10),
    garantiasPendientesEvaluacionIA: parseInt(f.garantias_pendientes_evaluacion_ia, 10),
  };
}

module.exports = {
  obtenerUsuariosAdmin,
  actualizarDatosUsuarioAdmin,
  obtenerPrestamistasPendientesActivacionAdmin,
  activarSuscripcionAdmin,
  obtenerIngresosPlataformaAdmin,
  obtenerIndicadoresGestionAdmin,
  obtenerMetricasDashboardAdmin,
  obtenerOportunidadesMasterParaAdmin,
  obtenerOperacionesPorDesembolsarAdmin,
  cerrarOperacionManualAdmin,
  obtenerContratosMasterParaAdmin,
  obtenerBovedaContratosAdmin,
  obtenerPerfilPropioAdmin,
  obtenerTareasPendientesAdmin,
};
