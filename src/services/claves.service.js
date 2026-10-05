/**
 * PrestaVía — Backend — claves.service.js
 *
 * Generación de contraseñas temporales. Vive aparte porque la usan dos
 * flujos: el registro (registro.service.js) y la recuperación de contraseña
 * (auth.service.js).
 *
 * Hallazgo de seguridad (MEDIO) del informe: antes se generaba con
 * Math.random(), que no es criptográficamente seguro. Ahora usa
 * crypto.randomInt (CSPRNG de Node).
 *
 * Sin caracteres que se confunden al leerlos y teclearlos a mano
 * (0/O, 1/l/I) — antes una clave bien copiada fallaba por eso.
 * Formato: "Pv" + 10 alfanuméricos aleatorios + "!" + 2 dígitos (~58 bits).
 */
const crypto = require("crypto");
const { pool } = require("../db");

// Cuánto vale una clave temporal antes de caducar (recomendación #3 del informe).
const CLAVE_TEMPORAL_HORAS_VALIDEZ = 48;

/**
 * Marca cuándo caduca la clave temporal de un usuario. Es un paso aparte y
 * "no crítico": si la columna todavía no existe (falta correr la migración
 * 009) o falla por lo que sea, NO debe tumbar el registro ni el login — solo
 * queda esa clave sin caducidad, como antes.
 */
async function fijarCaducidadClaveTemporal(idUsuario) {
  try {
    await pool.query("UPDATE usuarios SET clave_temporal_expira = now() + ($2 || ' hours')::interval WHERE id_usuario = $1", [
      idUsuario,
      String(CLAVE_TEMPORAL_HORAS_VALIDEZ),
    ]);
  } catch (error) {
    console.error("No se pudo fijar la caducidad de la clave temporal (¿falta la migración 009?):", error.message);
  }
}

/** Devuelve la fecha de caducidad de la clave temporal, o null (sin caducidad / columna inexistente). */
async function leerCaducidadClaveTemporal(idUsuario) {
  try {
    const { rows } = await pool.query("SELECT clave_temporal_expira FROM usuarios WHERE id_usuario = $1", [idUsuario]);
    return rows[0] && rows[0].clave_temporal_expira ? new Date(rows[0].clave_temporal_expira) : null;
  } catch (error) {
    return null;
  }
}

function generarClaveTemporal() {
  const alfabeto = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let cuerpo = "";
  for (let i = 0; i < 10; i++) {
    cuerpo += alfabeto[crypto.randomInt(alfabeto.length)];
  }
  const digitos = String(crypto.randomInt(2, 10)) + String(crypto.randomInt(2, 10));
  return "Pv" + cuerpo + "!" + digitos;
}

module.exports = { generarClaveTemporal, fijarCaducidadClaveTemporal, leerCaducidadClaveTemporal, CLAVE_TEMPORAL_HORAS_VALIDEZ };
