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
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { registrarAuditoria } = require("./audit.service");

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "10", 10);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

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

  await registrarAuditoria(null, idUsuario, "Contrasena_Actualizada", "Auth", {}, ip);

  return { exito: true, mensaje: "Contraseña actualizada correctamente." };
}

module.exports = { login, actualizarContrasenaObligatoria, esHashBcrypt };
