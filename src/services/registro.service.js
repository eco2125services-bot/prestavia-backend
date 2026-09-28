/**
 * PrestaVía — Backend — registro.service.js
 *
 * Reemplaza GestionUsuarios.gs (registro de prestamistas y prestatarios,
 * nuevas solicitudes de un usuario ya existente, cancelación de
 * suscripción).
 *
 * Mejora deliberada frente al original: la contraseña temporal se guarda
 * ya hasheada con bcrypt desde el primer momento (el original la escribía
 * en texto plano en el Sheet — aceptable ahí porque todo el respaldo era
 * legado, pero en un backend nuevo no hay motivo para repetir eso).
 * requiere_cambio_clave queda en true igual que antes, para forzar que el
 * usuario la cambie en su primer login.
 */
const bcrypt = require("bcrypt");
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { evaluarActivoIndividual, verificarIdentidadIndividual } = require("./ia.service");

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "10", 10);
const FEE_PLATAFORMA_PORCENTAJE = 0.05;
// La tasa de interés todavía no se conoce al momento de publicar la
// solicitud (la propone el prestamista después, vía contraoferta —
// enviarContraoferta en marketplace.service.js). Pero la tabla exige un
// valor (NOT NULL + CHECK entre 0.1 y 30), así que se guarda este valor
// "placeholder" de 0.1% mientras tanto — enviarContraoferta lo sobrescribe
// con la tasa real en cuanto llega la primera oferta.
const TASA_PENDIENTE_NEGOCIACION = 0.1;
const ESTATUS_ACTIVOS_LIMITE = ["Abierta", "En Negociacion", "Financiada", "Por_Desembolsar", "En_Cobro"];
const MAX_PRESTAMOS_ACTIVOS = 3;

function generarId(prefijo) {
  return prefijo + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function generarClaveTemporal() {
  return "Pv" + Math.random().toString(36).slice(-6) + "!" + Math.floor(Math.random() * 90 + 10);
}

function esPaisBloqueado(pais) {
  const p = (pais || "").toString().trim().toUpperCase();
  return p === "ESTADOS UNIDOS" || p === "USA" || p === "EEUU";
}

async function verificarDuplicados(client, { email, cedula, rif }) {
  const emailN = (email || "").toString().trim().toLowerCase();
  const cedulaN = (cedula || "").toString().trim().toLowerCase();
  const rifN = (rif || "").toString().trim().toLowerCase();

  const { rows } = await client.query(
    `SELECT 1 FROM usuarios
     WHERE lower(email) = $1
        OR ($2 <> '' AND lower(cedula_pasaporte) = $2)
        OR ($3 <> '' AND lower(rif) = $3)
     LIMIT 1`,
    [emailN, cedulaN, rifN]
  );
  return rows.length > 0;
}

/**
 * REGISTRO DE PRESTAMISTA. Queda con estatus_suscripcion = 'Pendiente'
 * hasta que el admin confirme el pago manual (Zelle u otro método).
 */
async function registrarPrestamistaNuevo(datos) {
  if (esPaisBloqueado(datos.paisResidencia)) {
    return { exito: false, mensaje: "Por el momento, PrestaVía no está disponible para residentes de Estados Unidos." };
  }
  if (!datos.email || !datos.nombre) {
    return { exito: false, mensaje: "Faltan datos obligatorios (nombre, email)." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (await verificarDuplicados(client, datos)) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Ya existe una cuenta registrada con ese correo, cédula o RIF." };
    }

    const idNuevo = generarId("USR");
    const claveTemporal = generarClaveTemporal();
    const hash = await bcrypt.hash(claveTemporal, BCRYPT_ROUNDS);

    await client.query(
      `INSERT INTO usuarios
         (id_usuario, nombre_legal, email, telefono, direccion_fiscal, cedula_pasaporte, rif, rol,
          plan_suscripcion, estatus_suscripcion, contrasena_hash, verificacion_identidad_ia,
          puntos_reputacion, prestamos_exitosos, requiere_cambio_clave, pais_residencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Prestamista', $8, 'Pendiente', $9, 'Pendiente', 0, 0, true, $10)`,
      [
        idNuevo,
        datos.nombre,
        datos.email,
        datos.telefono || null,
        datos.direccion || null,
        datos.cedula || null,
        datos.rif || null,
        datos.planSuscripcion || "mensual",
        hash,
        datos.paisResidencia || null,
      ]
    );

    await verificarIdentidadIndividual(client, idNuevo);
    await registrarAuditoria(client, idNuevo, "Acepto_Terminos_Plataforma", "GestionUsuarios", { fecha: new Date().toISOString() });

    await client.query("COMMIT");

    // TODO EMAIL: enviar credenciales provisionales + instrucciones de pago (Zelle) por correo.

    return {
      exito: true,
      idUsuario: idNuevo,
      claveTemporal, // el frontend/admin debe comunicársela de forma segura mientras el correo no está conectado
      mensaje: "Cuenta creada. Tu acceso se activará cuando el administrador confirme el pago de suscripción.",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al registrar: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * REGISTRO DE PRESTATARIO. Crea el usuario, el activo en garantía, y la
 * oportunidad en el marketplace en una sola operación — igual que el
 * formulario original.
 */
async function registrarPrestatarioNuevo(datos) {
  if (esPaisBloqueado(datos.paisResidencia)) {
    return { exito: false, mensaje: "Por el momento, PrestaVía no está disponible para residentes de Estados Unidos." };
  }
  if (!datos.email || !datos.nombre || !datos.monto || !datos.tipoGarantia) {
    return { exito: false, mensaje: "Faltan datos obligatorios (nombre, email, monto, tipoGarantia)." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (await verificarDuplicados(client, datos)) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Ya existe una cuenta registrada con ese correo, cédula o RIF." };
    }

    const idUsuario = generarId("USR");
    const claveTemporal = generarClaveTemporal();
    const hash = await bcrypt.hash(claveTemporal, BCRYPT_ROUNDS);

    await client.query(
      `INSERT INTO usuarios
         (id_usuario, nombre_legal, email, telefono, direccion_fiscal, cedula_pasaporte, rif, rol,
          plan_suscripcion, estatus_suscripcion, contrasena_hash, verificacion_identidad_ia,
          puntos_reputacion, prestamos_exitosos, requiere_cambio_clave, pais_residencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Prestatario', 'N/A', 'Activo', $8, 'Pendiente', 0, 0, true, $9)`,
      [
        idUsuario,
        datos.nombre,
        datos.email,
        datos.telefono || null,
        datos.direccionFiscal || null,
        datos.cedula || null,
        datos.rif || null,
        hash,
        datos.paisResidencia || null,
      ]
    );

    const idActivo = generarId("ACT");
    const valorGarantia = parseFloat(datos.valorGarantia) || 0;
    await client.query(
      `INSERT INTO activos_garantia (id_activo, id_usuario, tipo_bien, marca_modelo, valor_declarado_usuario, estatus_validacion)
       VALUES ($1, $2, $3, $4, $5, 'Pendiente')`,
      [idActivo, idUsuario, datos.tipoGarantia, datos.descripcionGarantia || null, valorGarantia]
    );

    const idOportunidad = generarId("OP");
    const monto = parseFloat(datos.monto) || 0;
    const plazoNum = parseInt(datos.plazo || "6", 10) || 6;
    const ltv = valorGarantia > 0 ? parseFloat((monto / valorGarantia).toFixed(4)) : 1;
    const feePlataforma = parseFloat((monto * FEE_PLATAFORMA_PORCENTAJE).toFixed(2));

    await client.query(
      `INSERT INTO oportunidades_mercado
         (id_oportunidad, id_solicitante, nombre_prestatario, monto_solicitado, plazo_meses, tasa_interes_anual,
          frecuencia_pago, estatus, tipo_garantia, id_activo_garantia, valor_estimado_garantia, ltv_preliminar, fee_plataforma_usd)
       VALUES ($1, $2, $3, $4, $5, $6, 'Mensual', 'Abierta', $7, $8, $9, $10, $11)`,
      [idOportunidad, idUsuario, datos.nombre, monto, plazoNum, TASA_PENDIENTE_NEGOCIACION, datos.tipoGarantia, idActivo, valorGarantia, ltv, feePlataforma]
    );

    await evaluarActivoIndividual(client, idActivo);
    await verificarIdentidadIndividual(client, idUsuario);
    await registrarAuditoria(client, idUsuario, "Acepto_Terminos_Plataforma", "GestionUsuarios", { fecha: new Date().toISOString() });

    await client.query("COMMIT");

    // TODO EMAIL: enviar credenciales provisionales por correo.

    return {
      exito: true,
      idUsuario,
      claveTemporal,
      idOportunidad,
      mensaje: `🎉 Registro exitoso. Tu solicitud ${idOportunidad} fue publicada en el marketplace.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al registrar: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * Si el prestatario tiene alguna cuota "Vencido" sin resolver en cualquiera
 * de sus préstamos, no puede pedir un préstamo nuevo.
 */
async function prestatarioPuedeSolicitarNuevoPrestamo(client, idUsuario) {
  const { rows } = await client.query(
    "SELECT 1 FROM control_pagos WHERE id_prestatario = $1 AND estatus_pago = 'Vencido' LIMIT 1",
    [idUsuario]
  );
  if (rows.length > 0) {
    return { puede: false, motivo: "Tienes cuotas en mora sin resolver — debes ponerte al día antes de solicitar un préstamo nuevo." };
  }
  return { puede: true };
}

/**
 * Nueva solicitud de préstamo para un prestatario que YA tiene cuenta
 * (botón "+ Nueva Solicitud" del Dashboard). Límite de 3 préstamos activos
 * simultáneos, y bloqueo si tiene mora activa.
 */
async function registrarSolicitudPrestamo(idPrestatarioAutenticado, datos) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const chequeoMora = await prestatarioPuedeSolicitarNuevoPrestamo(client, idPrestatarioAutenticado);
    if (!chequeoMora.puede) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "⚠️ " + chequeoMora.motivo };
    }

    const { rows: activos } = await client.query(
      `SELECT 1 FROM oportunidades_mercado WHERE id_solicitante = $1 AND estatus = ANY($2::text[])`,
      [idPrestatarioAutenticado, ESTATUS_ACTIVOS_LIMITE]
    );
    if (activos.length >= MAX_PRESTAMOS_ACTIVOS) {
      await client.query("ROLLBACK");
      return {
        exito: false,
        mensaje: "⚠️ Ya tienes 3 préstamos activos (el máximo permitido). Debes esperar a que alguno se cierre antes de solicitar otro.",
      };
    }

    const { rows: rowsUsr } = await client.query("SELECT nombre_legal FROM usuarios WHERE id_usuario = $1", [idPrestatarioAutenticado]);
    const nombreUsuario = rowsUsr[0] ? rowsUsr[0].nombre_legal : "";

    const idActivo = generarId("ACT");
    const valorGarantia = parseFloat(datos.valorDeclarado) || 0;
    await client.query(
      `INSERT INTO activos_garantia (id_activo, id_usuario, tipo_bien, marca_modelo, valor_declarado_usuario, estatus_validacion)
       VALUES ($1, $2, $3, $4, $5, 'Pendiente')`,
      [idActivo, idPrestatarioAutenticado, datos.tipoGarantia || null, datos.descripcionGarantia || null, valorGarantia]
    );

    const idOportunidad = generarId("OP");
    const monto = parseFloat(datos.montoSolicitado) || 0;
    const plazoNum = parseInt(datos.plazoMeses || "6", 10) || 6;
    const ltv = valorGarantia > 0 ? parseFloat((monto / valorGarantia).toFixed(4)) : 1;
    const feePlataforma = parseFloat((monto * FEE_PLATAFORMA_PORCENTAJE).toFixed(2));

    await client.query(
      `INSERT INTO oportunidades_mercado
         (id_oportunidad, id_solicitante, nombre_prestatario, monto_solicitado, plazo_meses, tasa_interes_anual,
          frecuencia_pago, estatus, tipo_garantia, id_activo_garantia, valor_estimado_garantia, ltv_preliminar, fee_plataforma_usd)
       VALUES ($1, $2, $3, $4, $5, $6, 'Mensual', 'Abierta', $7, $8, $9, $10, $11)`,
      [idOportunidad, idPrestatarioAutenticado, nombreUsuario, monto, plazoNum, TASA_PENDIENTE_NEGOCIACION, datos.tipoGarantia, idActivo, valorGarantia, ltv, feePlataforma]
    );

    await evaluarActivoIndividual(client, idActivo);
    await registrarAuditoria(client, idPrestatarioAutenticado, "Nueva_Solicitud_Adicional", "GestionUsuarios", { idOportunidad });

    await client.query("COMMIT");

    return { exito: true, idOportunidad, mensaje: `🎉 Tu nueva solicitud ${idOportunidad} fue publicada en el marketplace.` };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al registrar la solicitud: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * Cancela la suscripción de un usuario — solo permitido si no tiene ningún
 * préstamo activo (como prestatario o como prestamista asignado).
 */
async function cancelarSuscripcionUsuario(idUsuarioAutenticado) {
  const ESTATUS_ACTIVOS = ["Financiada", "Por_Desembolsar", "En_Cobro"];
  const { rows } = await pool.query(
    `SELECT estatus FROM oportunidades_mercado
     WHERE (id_solicitante = $1 OR id_prestamista_asignado = $1) AND estatus = ANY($2::text[])
     LIMIT 1`,
    [idUsuarioAutenticado, ESTATUS_ACTIVOS]
  );
  if (rows.length > 0) {
    return {
      exito: false,
      mensaje: `No puedes cancelar tu suscripción mientras tengas préstamos activos (${rows[0].estatus}). Espera a que se cierren.`,
    };
  }

  const resultado = await pool.query("UPDATE usuarios SET estatus_suscripcion = 'Cancelado' WHERE id_usuario = $1 RETURNING id_usuario", [
    idUsuarioAutenticado,
  ]);
  if (resultado.rows.length === 0) return { exito: false, mensaje: "Usuario no encontrado." };

  await registrarAuditoria(null, idUsuarioAutenticado, "Suscripcion_Cancelada", "GestionUsuarios", {});
  return { exito: true, mensaje: "Tu suscripción fue cancelada. Ya no se te cobrará." };
}

module.exports = {
  registrarPrestamistaNuevo,
  registrarPrestatarioNuevo,
  registrarSolicitudPrestamo,
  cancelarSuscripcionUsuario,
};
