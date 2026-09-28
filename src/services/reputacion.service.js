/**
 * PrestaVía — Backend — reputacion.service.js
 * Reemplaza actualizarReputacionUsuario() / incrementarPrestamosExitosos()
 * (funciones auxiliares usadas por ActualizacionCobranzas.gs).
 *
 * Recibe 'client' opcional para poder correr dentro de la misma transacción
 * que la operación de cobranza que las dispara (si algo falla después, se
 * revierte todo junto, incluida la reputación).
 */
const { pool } = require("../db");

async function actualizarReputacionUsuario(client, idUsuario, puntos) {
  if (!idUsuario) return;
  const ejecutor = client || pool;
  await ejecutor.query("UPDATE usuarios SET puntos_reputacion = puntos_reputacion + $1 WHERE id_usuario = $2", [puntos, idUsuario]);
}

async function incrementarPrestamosExitosos(client, idUsuario) {
  if (!idUsuario) return;
  const ejecutor = client || pool;
  await ejecutor.query("UPDATE usuarios SET prestamos_exitosos = prestamos_exitosos + 1 WHERE id_usuario = $1", [idUsuario]);
}

module.exports = { actualizarReputacionUsuario, incrementarPrestamosExitosos };
