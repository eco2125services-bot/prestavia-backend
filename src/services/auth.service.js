/**
 * PrestaVía — Backend — auth.service.js
 *
 * Reemplaza la lógica de verificarCredenciales() y
 * actualizarContrasenaObligatoria() de WebappController.gs / ActualizarPassword.html.
 *
 * Punto clave (por la migración desde Sheets): la columna contrasena_hash
 * puede contener TODAVÍA una clave en texto plano (así vivía en Sheets)
 * para los usuarios que no han vuelto a entrar desde la migración. En vez
 * de forzar una migración masiva aparte, el re-hasheo pasa solo, en el
 * momento del primer login exitoso de cada usuario:
 *
 *   1. Se busca al usuario por email.
 *   2. Si contrasena_hash NO tiene forma de hash bcrypt (no empieza con
 *      "$2"), se compara la clave recibida contra el texto plano.
 *      - Si coincide: se genera el hash bcrypt real y se actualiza la fila
 *        en el mismo momento (recién ahí ese usuario queda "seguro").
 *      - Si no coincide: credenciales inválidas, igual que siempre.
 *   3. Si ya es un hash bcrypt (usuario que ya pasó por este proceso, o
 *      creado directamente en el backend nuevo), se usa bcrypt.compare
 *      normal.
 *
 * requiere_cambio_clave es un campo de NEGOCIO aparte (obliga a definir
 * una contraseña definitiva la primera vez, vía ActualizarPassword.html) —
 * el re-hasheo automático no lo toca; solo actualizarContrasenaObligatoria()
 * lo pone en false.
 */
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");
const { enviarCorreo, correoConfigurado } = require("./email.service");
const { invalidarSesiones } = require("./sesiones.service");
const { generarClaveTemporal, fijarCaducidadClaveTemporal, leerCaducidadClaveTemporal } = require("./claves.service");

const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://prestavia-backend.onrender.com";
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || "https://eco2125services-bot.github.io/prestavia-web/";
const RECUPERACION_MINUTOS_VALIDEZ = 60;
const RECUPERACION_ESPERA_MINUTOS = 2;

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "10", 10);
const JWT_SECRET = process.env.JWT_SECRET;
// Antes 12h. La sesión del navegador ya se cierra a los 5 min de inactividad;
// 1h es el tope absoluto aunque el usuario no deje de usar la página.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";

if (!JWT_SECRET) {
  throw new Error("Falta la variable de entorno JWT_SECRET");
}

function esHashBcrypt(valor) {
  return typeof valor === "string" && /^\$2[aby]?\$/.test(valor);
}

// Antes el login no quedaba registrado en ningún lado (ni éxito ni
// fallo) — sin esto, un ataque de fuerza bruta contra una cuenta puntual
// (el rate-limit por IP de auth.routes.js no frena a quien rota de IP) era
// invisible. `ip` es opcional y nunca cambia el resultado del login, solo
// qué queda anotado.
async function login(email, claveIngresada, ip) {
  const emailNormalizado = (email || "").toString().trim().toLowerCase();
  if (!emailNormalizado || !claveIngresada) {
    return { exito: false, mensaje: "Email y contraseña son requeridos." };
  }

  const { rows } = await pool.query(
    "SELECT id_usuario, nombre_legal, email, rol, estatus_suscripcion, contrasena_hash, requiere_cambio_clave FROM usuarios WHERE lower(email) = $1",
    [emailNormalizado]
  );
  const usuario = rows[0];
  if (!usuario) {
    // Mensaje genérico a propósito: no revelar si el email existe o no.
    await registrarAuditoria(null, null, "Login_Fallido", "Auth", { email: emailNormalizado, motivo: "email_no_existe" }, ip);
    return { exito: false, mensaje: "Credenciales inválidas." };
  }

  let credencialesValidas = false;

  if (esHashBcrypt(usuario.contrasena_hash)) {
    credencialesValidas = await bcrypt.compare(claveIngresada, usuario.contrasena_hash);
  } else {
    // Clave heredada de Sheets, todavía en texto plano.
    credencialesValidas = claveIngresada === usuario.contrasena_hash;
    if (credencialesValidas) {
      const nuevoHash = await bcrypt.hash(claveIngresada, BCRYPT_ROUNDS);
      await pool.query("UPDATE usuarios SET contrasena_hash = $1 WHERE id_usuario = $2", [
        nuevoHash,
        usuario.id_usuario,
      ]);
      console.log(`🔐 Usuario ${usuario.id_usuario} re-hasheado automáticamente en su primer login post-migración.`);
    }
  }

  if (!credencialesValidas) {
    await registrarAuditoria(null, usuario.id_usuario, "Login_Fallido", "Auth", { email: emailNormalizado, motivo: "clave_incorrecta" }, ip);
    return { exito: false, mensaje: "Credenciales inválidas." };
  }

  // Recomendación #3 del informe: las claves temporales caducan. Solo se
  // dice DESPUÉS de verificar la clave correcta, así que no sirve para saber
  // si un correo existe. La salida es "¿Olvidaste tu contraseña?".
  if (usuario.requiere_cambio_clave) {
    const caduca = await leerCaducidadClaveTemporal(usuario.id_usuario);
    if (caduca && caduca < new Date()) {
      await registrarAuditoria(null, usuario.id_usuario, "Login_Fallido", "Auth", { email: emailNormalizado, motivo: "clave_temporal_vencida" }, ip);
      return {
        exito: false,
        claveVencida: true,
        mensaje: "Tu contraseña temporal venció. Usa «¿Olvidaste tu contraseña?» para recibir una nueva.",
      };
    }
  }

  const token = jwt.sign(
    { sub: usuario.id_usuario, rol: usuario.rol },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  await registrarAuditoria(null, usuario.id_usuario, "Login_Exitoso", "Auth", { email: emailNormalizado }, ip);

  return {
    exito: true,
    token,
    requiereCambioClave: !!usuario.requiere_cambio_clave,
    usuario: {
      idUsuario: usuario.id_usuario,
      nombreLegal: usuario.nombre_legal,
      email: usuario.email,
      rol: usuario.rol,
      estatusSuscripcion: usuario.estatus_suscripcion,
    },
  };
}

// Antes recibía un `email` de body sin ninguna verificación de identidad —
// cualquiera que lo conociera podía cambiarle la clave a otro usuario
// (hallazgo de seguridad ALTO). Ahora SIEMPRE recibe el idUsuario que salió
// del JWT validado por requiereAutenticacion — ya no hay look-up por email
// aquí, así que no hay forma de apuntar a una cuenta que no sea la propia.
// Política de contraseña reforzada (hallazgo BAJO del informe de
// seguridad: antes solo pedía 6 caracteres, sin complejidad, y solo en el
// servidor — el cliente podía mandar cualquier cosa). No se sube a 10+
// para no romper la experiencia de un prototipo con usuarios de prueba ya
// creados, pero sí exige mínimo 8 caracteres con al menos una letra y un
// número.
function claveCumplePolitica(clave) {
  return typeof clave === "string" && clave.length >= 10 && clave.length <= 128 && /[a-zA-Z]/.test(clave) && /[0-9]/.test(clave);
}

async function actualizarContrasenaObligatoria(idUsuario, nuevaClave, ip) {
  if (!idUsuario || !claveCumplePolitica(nuevaClave)) {
    return {
      exito: false,
      mensaje: "La contraseña debe tener entre 10 y 128 caracteres, con al menos una letra y un número.",
    };
  }

  const nuevoHash = await bcrypt.hash(nuevaClave, BCRYPT_ROUNDS);
  const { rows } = await pool.query(
    "UPDATE usuarios SET contrasena_hash = $1, requiere_cambio_clave = false WHERE id_usuario = $2 RETURNING id_usuario",
    [nuevoHash, idUsuario]
  );
  if (!rows[0]) {
    return { exito: false, mensaje: "Usuario no encontrado." };
  }

  // Al cambiar la clave se cierran TODAS las sesiones abiertas (incluida esta).
  await invalidarSesiones(idUsuario);
  await registrarAuditoria(null, idUsuario, "Contrasena_Actualizada", "Auth", {}, ip);

  return { exito: true, mensaje: "Contraseña actualizada correctamente." };
}

// ---------------------------------------------------------------------------
// RECUPERACIÓN DE CONTRASEÑA (enlace de un solo uso por correo)
//
// Diseño:
//  1. La persona pide recuperar con su correo. La respuesta es SIEMPRE la
//     misma exista o no la cuenta (anti-enumeración), y el trabajo real
//     (consulta + envío del correo) corre DESPUÉS de responder, para que ni
//     el tiempo de respuesta delate si el correo existe.
//  2. El correo trae un enlace con un token de 256 bits. En la base solo se
//     guarda su hash sha256, y vale 60 minutos.
//  3. Abrir el enlace NO cambia nada: muestra un botón. Solo al pulsarlo se
//     genera la clave temporal nueva — así un escáner de correo que "visita"
//     el enlace no puede restablecer la clave ni gastar el token.
//  4. Pedir la recuperación no toca la contraseña actual: nadie puede
//     bloquear a otra persona solo conociendo su correo.
// ---------------------------------------------------------------------------

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const MENSAJE_RECUPERACION_GENERICO =
  "Si ese correo tiene una cuenta, te enviamos un enlace para restablecer tu contraseña. Revisa también la carpeta de spam. El enlace vale 60 minutos.";

async function procesarSolicitudRecuperacion(emailNormalizado, ip) {
  if (!correoConfigurado()) {
    console.log(`🔑 [correo no configurado] Solicitud de recuperación de clave para ${emailNormalizado} — no se puede enviar el enlace.`);
    return;
  }

  const { rows } = await pool.query("SELECT id_usuario, nombre_legal, email FROM usuarios WHERE lower(email) = $1", [emailNormalizado]);
  const usuario = rows[0];
  if (!usuario) {
    await registrarAuditoria(null, null, "Recuperacion_Email_Desconocido", "Auth", { email: emailNormalizado }, ip);
    return;
  }

  // Freno por cuenta: si ya se mandó un enlace hace un momento, no mandar otro
  // (evita usar esto para llenarle el buzón a alguien).
  const reciente = await pool.query(
    "SELECT 1 FROM recuperaciones_clave WHERE id_usuario = $1 AND creado_en > now() - ($2 || ' minutes')::interval LIMIT 1",
    [usuario.id_usuario, String(RECUPERACION_ESPERA_MINUTOS)]
  );
  if (reciente.rows.length > 0) return;

  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM recuperaciones_clave WHERE id_usuario = $1 OR expira_en < now()", [usuario.id_usuario]);
  await pool.query(
    "INSERT INTO recuperaciones_clave (token_hash, id_usuario, expira_en) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)",
    [hashToken(token), usuario.id_usuario, String(RECUPERACION_MINUTOS_VALIDEZ)]
  );
  await registrarAuditoria(null, usuario.id_usuario, "Recuperacion_Solicitada", "Auth", {}, ip);

  const enlace = `${BACKEND_PUBLIC_URL}/auth/restablecer?token=${token}`;
  await enviarCorreo({
    to: usuario.email,
    subject: "Restablece tu contraseña de PrestaVía",
    html:
      `<p>Hola,</p><p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en PrestaVía. ` +
      `Si fuiste tú, abre este enlace y pulsa el botón de confirmar (vale ${RECUPERACION_MINUTOS_VALIDEZ} minutos):</p>` +
      `<p><a href="${enlace}" style="display:inline-block;padding:10px 18px;background:#1f6f4a;color:#fff;border-radius:6px;text-decoration:none;">Restablecer mi contraseña</a></p>` +
      `<p>Si el botón no funciona, copia este enlace: ${enlace}</p>` +
      `<p>Si no fuiste tú, ignora este mensaje: tu contraseña actual no cambió.</p>`,
  });
}

/** Siempre responde lo mismo. El trabajo real se hace en segundo plano (ver arriba). */
async function solicitarRecuperacionClave(email, ip) {
  const emailNormalizado = (email || "").toString().trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
    return { exito: false, mensaje: "Escribe un correo electrónico válido." };
  }
  procesarSolicitudRecuperacion(emailNormalizado, ip).catch((error) => {
    console.error("Error procesando la recuperación de clave:", error.message);
  });
  return { exito: true, mensaje: MENSAJE_RECUPERACION_GENERICO };
}

/** ¿El token es válido ahora mismo? (sin consumirlo — es lo que usa la pantalla que muestra el botón). */
async function consultarRecuperacion(token) {
  const { rows } = await pool.query("SELECT expira_en FROM recuperaciones_clave WHERE token_hash = $1", [hashToken(token)]);
  if (!rows[0]) return { valido: false, mensaje: "Este enlace no es válido o ya fue usado. Pide uno nuevo desde «¿Olvidaste tu contraseña?»." };
  if (new Date(rows[0].expira_en) < new Date()) {
    return { valido: false, mensaje: "Este enlace venció. Pide uno nuevo desde «¿Olvidaste tu contraseña?»." };
  }
  return { valido: true };
}

/** Consume el token y deja una clave temporal nueva (que obliga a cambiarla al entrar). */
async function restablecerClaveConToken(token, ip) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // DELETE ... RETURNING consume el token de forma atómica: dos clics a la
    // vez no pueden generar dos claves.
    const { rows } = await client.query("DELETE FROM recuperaciones_clave WHERE token_hash = $1 RETURNING id_usuario, expira_en", [
      hashToken(token),
    ]);
    const fila = rows[0];
    if (!fila) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "Este enlace no es válido o ya fue usado. Pide uno nuevo desde «¿Olvidaste tu contraseña?»." };
    }
    if (new Date(fila.expira_en) < new Date()) {
      await client.query("COMMIT");
      return { exito: false, mensaje: "Este enlace venció. Pide uno nuevo desde «¿Olvidaste tu contraseña?»." };
    }

    const claveTemporal = generarClaveTemporal();
    const hash = await bcrypt.hash(claveTemporal, BCRYPT_ROUNDS);
    const upd = await client.query(
      "UPDATE usuarios SET contrasena_hash = $1, requiere_cambio_clave = true WHERE id_usuario = $2 RETURNING email",
      [hash, fila.id_usuario]
    );
    if (!upd.rows[0]) {
      await client.query("ROLLBACK");
      return { exito: false, mensaje: "No se pudo restablecer la contraseña." };
    }
    await invalidarSesiones(fila.id_usuario, client);
    await registrarAuditoria(client, fila.id_usuario, "Recuperacion_Completada", "Auth", {}, ip);
    await client.query("COMMIT");
    await fijarCaducidadClaveTemporal(fila.id_usuario);

    // Aviso de seguridad al dueño del correo (por si el cambio no lo hizo él).
    enviarCorreo({
      to: upd.rows[0].email,
      subject: "Se restableció la contraseña de tu cuenta de PrestaVía",
      html: `<p>Hola,</p><p>La contraseña de tu cuenta en PrestaVía se acaba de restablecer con el enlace que se envió a este correo. Si no fuiste tú, escríbenos de inmediato.</p><p>Inicia sesión en <a href="${FRONTEND_PUBLIC_URL}">${FRONTEND_PUBLIC_URL}</a> con la contraseña temporal que se mostró al confirmar.</p>`,
    }).catch(() => {});

    return { exito: true, claveTemporal };
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error restableciendo la contraseña:", error.message);
    return { exito: false, mensaje: "Error interno del servidor." };
  } finally {
    client.release();
  }
}

/** Cierre de sesión real: los tokens emitidos hasta ahora dejan de servir. */
async function cerrarSesion(idUsuario, ip) {
  await invalidarSesiones(idUsuario);
  await registrarAuditoria(null, idUsuario, "Logout", "Auth", {}, ip);
  return { exito: true };
}

module.exports = {
  cerrarSesion,
  login,
  actualizarContrasenaObligatoria,
  esHashBcrypt,
  solicitarRecuperacionClave,
  consultarRecuperacion,
  restablecerClaveConToken,
};
