/**
 * Reemplaza registrarAuditoria() de ConstantesColumnas.gs.
 */
const { pool } = require("../db");

function generarIdLog() {
  return "LOG-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

async function registrarAuditoria(client, idUsuario, accionRealizada, moduloAfectado, detalles) {
  const ejecutor = client || pool;
  try {
    await ejecutor.query(
      "INSERT INTO audit_log (id_log, id_usuario, accion_realizada, modulo_afectado, detalles_payload) VALUES ($1, $2, $3, $4, $5)",
      [generarIdLog(), idUsuario || null, accionRealizada, moduloAfectado, JSON.stringify(detalles || {})]
    );
  } catch (error) {
    // La auditoría nunca debe tumbar la operación principal.
    console.error("No se pudo registrar auditoría:", error.message);
  }
}

module.exports = { registrarAuditoria };
