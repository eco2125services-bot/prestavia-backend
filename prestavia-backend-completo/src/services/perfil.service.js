/**
 * PrestaVía — Backend — perfil.service.js
 *
 * Autoservicio de perfil: el PROPIO usuario (prestatario o prestamista) ve
 * y actualiza sus datos de contacto. Antes esto solo existía para el Admin
 * (PATCH /admin/usuarios/:idUsuario en admin-panel.service.js) — aquí es
 * la versión que cualquier usuario autenticado puede usar sobre su PROPIA
 * cuenta (el id SIEMPRE sale del JWT, nunca del body).
 *
 * Deliberadamente NO se permite editar aquí: email (es el identificador de
 * login), cédula/RIF (sensible, cualquier cambio debería pasar por Admin),
 * rol, ni estatus de suscripción.
 */
const { pool } = require("../db");

async function obtenerMiPerfil(idUsuario) {
  const { rows } = await pool.query(
    `SELECT id_usuario, nombre_legal, email, telefono, direccion_fiscal, rol,
            estatus_suscripcion, pais_residencia, created_at,
            puntos_reputacion, prestamos_exitosos
     FROM usuarios WHERE id_usuario = $1`,
    [idUsuario]
  );
  return rows[0] || null;
}

async function actualizarMiPerfil(idUsuario, { nombreLegal, telefono, direccion }) {
  const campos = [];
  const valores = [];
  let i = 1;

  if (nombreLegal !== undefined && nombreLegal !== null && nombreLegal.toString().trim() !== "") {
    campos.push(`nombre_legal = $${i++}`);
    valores.push(nombreLegal.toString().trim());
  }
  if (telefono !== undefined) {
    campos.push(`telefono = $${i++}`);
    valores.push(telefono || null);
  }
  if (direccion !== undefined) {
    campos.push(`direccion_fiscal = $${i++}`);
    valores.push(direccion || null);
  }

  if (campos.length === 0) {
    return { exito: false, mensaje: "No enviaste ningún cambio." };
  }

  valores.push(idUsuario);
  const { rows } = await pool.query(
    `UPDATE usuarios SET ${campos.join(", ")} WHERE id_usuario = $${i}
     RETURNING id_usuario, nombre_legal, telefono, direccion_fiscal`,
    valores
  );
  if (!rows[0]) return { exito: false, mensaje: "Usuario no encontrado." };

  return { exito: true, mensaje: "Tu información fue actualizada.", datos: rows[0] };
}

module.exports = { obtenerMiPerfil, actualizarMiPerfil };
