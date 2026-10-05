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
const crypto = require("crypto");
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { evaluarActivoIndividual, verificarIdentidadIndividual, LTV_MAXIMO_ACEPTABLE } = require("./ia.service");
const { enviarCorreo, correoConfigurado } = require("./email.service");

// Hallazgo de seguridad (MEDIO) corregido: no había verificación de
// correo — cualquiera podía registrar la cuenta de OTRA persona con su
// email real (sin poder acceder nunca, pero sí dejando una cuenta y, en el
// caso de un prestatario, una SOLICITUD DE PRÉSTAMO PUBLICADA a su nombre,
// sin su consentimiento). Ver sql/008_verificacion_email.sql.
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://prestavia-backend.onrender.com";
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || "https://eco2125services-bot.github.io/prestavia-web/";
const VERIFICACION_HORAS_VALIDEZ = 48;

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

// Hallazgo de seguridad (MEDIO): esto usaba Math.random() — no es un
// generador criptográficamente seguro, así que la clave temporal era, en
// teoría, más predecible de lo que su longitud sugiere. Ahora usa
// crypto.randomInt (CSPRNG de Node) para cada carácter. El formato
// ("Pv" + 8 alfanuméricos + "!" + 2 dígitos) se mantiene por compatibilidad
// con la política de contraseña del cliente (letras+símbolo+dígitos), pero
// con ~8 caracteres realmente aleatorios en vez de 6.
function generarClaveTemporal() {
  const alfabeto = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let cuerpo = "";
  for (let i = 0; i < 8; i++) {
    cuerpo += alfabeto[crypto.randomInt(alfabeto.length)];
  }
  const digitos = String(crypto.randomInt(10, 100));
  return "Pv" + cuerpo + "!" + digitos;
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
 * Crea la cuenta REAL de prestamista — antes era todo el cuerpo de
 * registrarPrestamistaNuevo(). Ahora es un paso que solo se ejecuta cuando
 * ya se confirmó el correo (completarRegistroPendiente), o de inmediato
 * como respaldo si el correo todavía no está configurado en el servidor
 * (ver registrarPrestamistaNuevo).
 */
async function crearCuentaPrestamista(datos) {
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

    enviarCorreo({
      to: datos.email,
      subject: "Tu contraseña temporal de PrestaVía",
      html: `<p>Hola ${escapeHtml(datos.nombre)},</p><p>Tu cuenta de <strong>prestamista</strong> en PrestaVía ya está creada. Tu contraseña temporal es:</p><p style="font-size:18px;font-family:monospace;background:#f3f3f3;padding:10px;border-radius:6px;">${claveTemporal}</p><p>Inicia sesión con ella en <a href="${FRONTEND_PUBLIC_URL}">${FRONTEND_PUBLIC_URL}</a> — te pedirá cambiarla de inmediato.</p><p>Tu acceso para ofertar se activará cuando confirmemos tu pago de suscripción.</p>`,
    }).catch(() => {});

    return {
      exito: true,
      idUsuario: idNuevo,
      claveTemporal,
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
 * REGISTRO DE PRESTAMISTA. Queda con estatus_suscripcion = 'Pendiente'
 * hasta que el admin confirme el pago manual (Zelle u otro método).
 *
 * Si el correo está configurado en el servidor (EMAIL_USER/
 * EMAIL_APP_PASSWORD), la cuenta NO se crea todavía: se guarda la solicitud
 * en registros_pendientes y se manda un correo de verificación — la cuenta
 * se crea recién cuando se hace clic en ese enlace (completarRegistroPendiente).
 * Si el correo NO está configurado todavía (servidor recién desplegado,
 * antes de generar la contraseña de aplicación de Gmail), se cae al
 * comportamiento anterior: crear la cuenta de inmediato y devolver la
 * clave temporal en la respuesta, para no romper el registro mientras eso
 * se termina de configurar.
 */
async function registrarPrestamistaNuevo(datos) {
  if (esPaisBloqueado(datos.paisResidencia)) {
    return { exito: false, mensaje: "Por el momento, PrestaVía no está disponible para residentes de Estados Unidos." };
  }
  if (!datos.email || !datos.nombre) {
    return { exito: false, mensaje: "Faltan datos obligatorios (nombre, email)." };
  }

  if (!correoConfigurado()) {
    return crearCuentaPrestamista(datos);
  }

  return crearRegistroPendiente({ email: datos.email, rol: "Prestamista", datos });
}

/**
 * Crea la cuenta REAL de prestatario (+ su activo en garantía + su
 * solicitud publicada en el marketplace) — antes era todo el cuerpo de
 * registrarPrestatarioNuevo(). Mismo patrón que crearCuentaPrestamista.
 */
async function crearCuentaPrestatario(datos) {
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

    enviarCorreo({
      to: datos.email,
      subject: "Tu contraseña temporal de PrestaVía",
      html: `<p>Hola ${escapeHtml(datos.nombre)},</p><p>Tu cuenta de <strong>prestatario</strong> en PrestaVía ya está creada y tu solicitud ${idOportunidad} fue publicada en el marketplace. Tu contraseña temporal es:</p><p style="font-size:18px;font-family:monospace;background:#f3f3f3;padding:10px;border-radius:6px;">${claveTemporal}</p><p>Inicia sesión con ella en <a href="${FRONTEND_PUBLIC_URL}">${FRONTEND_PUBLIC_URL}</a> — te pedirá cambiarla de inmediato.</p>`,
    }).catch(() => {});

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
 * REGISTRO DE PRESTATARIO. Mismo patrón de verificación por correo que
 * registrarPrestamistaNuevo (ver ese comentario) — aquí es todavía más
 * importante, porque de lo contrario cualquiera podría publicar una
 * solicitud de préstamo real a nombre del correo de otra persona.
 */
async function registrarPrestatarioNuevo(datos) {
  if (esPaisBloqueado(datos.paisResidencia)) {
    return { exito: false, mensaje: "Por el momento, PrestaVía no está disponible para residentes de Estados Unidos." };
  }
  if (!datos.email || !datos.nombre || !datos.monto || !datos.tipoGarantia) {
    return { exito: false, mensaje: "Faltan datos obligatorios (nombre, email, monto, tipoGarantia)." };
  }

  if (!correoConfigurado()) {
    return crearCuentaPrestatario(datos);
  }

  return crearRegistroPendiente({ email: datos.email, rol: "Prestatario", datos });
}

function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Guarda la solicitud de registro en espera de confirmación por correo, y
 * manda el correo con el enlace de verificación. La cuenta real se crea
 * recién en completarRegistroPendiente(), cuando se hace clic en ese
 * enlace — ver sql/008_verificacion_email.sql para el porqué.
 */
async function crearRegistroPendiente({ email, rol, datos }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (await verificarDuplicados(client, datos)) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Ya existe una cuenta registrada con ese correo, cédula o RIF." };
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiraEn = new Date(Date.now() + VERIFICACION_HORAS_VALIDEZ * 60 * 60 * 1000);

    await client.query("DELETE FROM registros_pendientes WHERE expira_en < now()");
    await client.query(
      `INSERT INTO registros_pendientes (token, email, rol, datos, expira_en)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lower(email)) DO UPDATE SET token = EXCLUDED.token, rol = EXCLUDED.rol,
         datos = EXCLUDED.datos, expira_en = EXCLUDED.expira_en, creado_en = now()`,
      [token, email, rol, JSON.stringify(datos), expiraEn]
    );

    await client.query("COMMIT");

    const enlace = `${BACKEND_PUBLIC_URL}/registro/verificar-email?token=${token}`;
    const resultadoEnvio = await enviarCorreo({
      to: email,
      subject: "Confirma tu cuenta de PrestaVía",
      html: `<p>Hola ${escapeHtml(datos.nombre)},</p><p>Para activar tu cuenta de ${rol === "Prestamista" ? "prestamista" : "prestatario"} en PrestaVía, confirma que este es tu correo:</p><p><a href="${enlace}" style="display:inline-block;padding:10px 18px;background:#1f6f4a;color:#fff;border-radius:6px;text-decoration:none;">Confirmar mi cuenta</a></p><p>Si el botón no funciona, copia este enlace: ${enlace}</p><p>Este enlace vence en ${VERIFICACION_HORAS_VALIDEZ} horas. Si no intentaste crear una cuenta en PrestaVía, ignora este correo.</p>`,
    });

    if (!resultadoEnvio.enviado) {
      // El correo no salió (ej. Gmail rechazó, credenciales mal puestas) —
      // mejor decirlo ahora que dejar a la persona esperando un correo que
      // nunca llegará. La fila en registros_pendientes queda igual por si
      // se reintenta el envío manualmente.
      return { exito: false, mensaje: "No pudimos enviar el correo de confirmación. Intenta de nuevo en unos minutos." };
    }

    return {
      exito: true,
      mensaje: `Te enviamos un correo a ${email} para confirmar tu cuenta. Ábrelo y haz clic en el enlace — ahí verás tu contraseña temporal.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return { exito: false, mensaje: "Error al registrar: " + error.message };
  } finally {
    client.release();
  }
}

/**
 * Se ejecuta cuando la persona hace clic en el enlace del correo. Crea la
 * cuenta real recién ahora (con los datos que quedaron guardados) y
 * consume el token — un enlace usado dos veces la segunda vez dice
 * "ya fue usado", no crea una cuenta duplicada.
 */
async function completarRegistroPendiente(token) {
  const { rows } = await pool.query("SELECT * FROM registros_pendientes WHERE token = $1", [token]);
  const pendiente = rows[0];
  if (!pendiente) {
    return { exito: false, mensaje: "Ese enlace de confirmación no es válido o ya fue usado." };
  }
  if (new Date(pendiente.expira_en) < new Date()) {
    await pool.query("DELETE FROM registros_pendientes WHERE token = $1", [token]);
    return { exito: false, mensaje: "Ese enlace de confirmación venció. Vuelve a registrarte para recibir uno nuevo." };
  }

  const resultado =
    pendiente.rol === "Prestamista" ? await crearCuentaPrestamista(pendiente.datos) : await crearCuentaPrestatario(pendiente.datos);

  // Se consume el token en cualquier caso (éxito o error de negocio, como
  // un duplicado que apareció mientras tanto) — un enlace de correo no
  // debe poder reintentarse indefinidamente.
  await pool.query("DELETE FROM registros_pendientes WHERE token = $1", [token]);

  return { ...resultado, rol: pendiente.rol };
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

    // BUG real encontrado (reporte de seguridad): este mensaje era fijo —
    // siempre decía "fue publicada en el marketplace", sin importar que
    // evaluarActivoIndividual() (línea de arriba) pudiera haber marcado la
    // solicitud como 'Rechazada' en la MISMA transacción, por LTV
    // demasiado alto. El prestatario veía un mensaje de éxito para una
    // solicitud que ya nació rechazada, sin saber por qué. Ahora se
    // relee el estatus final y se devuelve el mensaje que corresponde.
    const { rows: rowsFinal } = await client.query(
      "SELECT estatus, ltv_preliminar FROM oportunidades_mercado WHERE id_oportunidad = $1",
      [idOportunidad]
    );
    const estatusFinal = rowsFinal[0] ? rowsFinal[0].estatus : "Abierta";
    const ltvFinal = rowsFinal[0] && rowsFinal[0].ltv_preliminar !== null ? parseFloat(rowsFinal[0].ltv_preliminar) : null;

    await client.query("COMMIT");

    if (estatusFinal === "Rechazada") {
      return {
        exito: true,
        idOportunidad,
        mensaje:
          `Tu solicitud ${idOportunidad} fue evaluada automáticamente y NO fue publicada: el valor del bien declarado es demasiado bajo frente al monto pedido` +
          (ltvFinal !== null ? ` (LTV ${(ltvFinal * 100).toFixed(1)}%, máximo aceptado ${(LTV_MAXIMO_ACEPTABLE * 100).toFixed(0)}%)` : "") +
          `. Puedes intentar de nuevo con un monto menor o una garantía de mayor valor.`,
      };
    }

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
  completarRegistroPendiente,
};
