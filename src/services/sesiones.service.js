/**
 * Control de sesiones del lado del servidor (informe de seguridad #7).
 * El JWT sigue viajando en el header Authorization, pero ya no basta con que
 * la firma sea correcta: el usuario debe existir y el token debe haberse
 * emitido después de `usuarios.sesiones_validas_desde`.
 */
const { pool } = require("../db");

/** Invalida todos los tokens emitidos hasta ahora para este usuario. */
async function invalidarSesiones(idUsuario, ejecutor) {
  const db = ejecutor || pool;
  try {
    await db.query("UPDATE usuarios SET sesiones_validas_desde = now() WHERE id_usuario = $1", [idUsuario]);
  } catch (error) {
    // 42703 = la columna aún no existe (falta correr la migración 010).
    if (error && error.code === "42703") {
      console.error("⚠️ Falta correr sql/010_invalidar_sesiones.sql: no se pudo invalidar la sesión.");
      return;
    }
    throw error;
  }
}

/**
 * Devuelve la fila del usuario si el token sigue vigente, o null si no.
 * `iat` viene en segundos (campo estándar del JWT).
 */
async function leerUsuarioDeSesion(idUsuario, iat) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id_usuario, nombre_legal, email, rol, estatus_suscripcion,
              floor(extract(epoch FROM sesiones_validas_desde))::bigint AS desde
         FROM usuarios WHERE id_usuario = $1`,
      [idUsuario]
    ));
  } catch (error) {
    if (error && error.code === "42703") {
      // Migración 010 pendiente: se comporta como antes (solo firma + usuario existente).
      ({ rows } = await pool.query(
        "SELECT id_usuario, nombre_legal, email, rol, estatus_suscripcion, NULL::bigint AS desde FROM usuarios WHERE id_usuario = $1",
        [idUsuario]
      ));
    } else {
      throw error;
    }
  }
  const u = rows[0];
  if (!u) return null;
  if (u.desde !== null && u.desde !== undefined && Number(iat) < Number(u.desde)) return null;
  return u;
}

module.exports = { invalidarSesiones, leerUsuarioDeSesion };
