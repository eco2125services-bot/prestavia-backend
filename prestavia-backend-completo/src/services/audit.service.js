/**
 * Reemplaza registrarAuditoria() de ConstantesColumnas.gs.
 */
const { pool } = require("../db");

function generarIdLog() {
  return "LOG-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

// `direccion_ip` ya existía en el esquema desde el inicio, pero esta
// función nunca la llenaba (siempre quedaba NULL) — ningún registro de
// auditoría tenía de dónde vino la acción. El parámetro `ip` es opcional a
// propósito: los call sites que no la tengan a mano (la mayoría, hoy)
// siguen funcionando igual que antes.
async function registrarAuditoria(client, idUsuario, accionRealizada, moduloAfectado, detalles, ip) {
  const ejecutor = client || pool;
  try {
    await ejecutor.query(
      "INSERT INTO audit_log (id_log, id_usuario, accion_realizada, modulo_afectado, detalles_payload, direccion_ip) VALUES ($1, $2, $3, $4, $5, $6)",
      [generarIdLog(), idUsuario || null, accionRealizada, moduloAfectado, JSON.stringify(detalles || {}), ip || null]
    );
  } catch (error) {
    // La auditoría nunca debe tumbar la operación principal.
    console.error("No se pudo registrar auditoría:", error.message);
  }
}

module.exports = { registrarAuditoria };
