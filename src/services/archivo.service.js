/**
 * PrestaVía — Backend — archivo.service.js
 * Almacén genérico de archivos (bytes) para documentos de usuario (cédula,
 * fotos del bien en garantía). Mismo patrón que comprobante.service.js
 * (módulo 4) y documentos_generados (módulo 3) — todo el contenido vive en
 * esta base de datos en vez de depender de una cuenta de Drive.
 */
const { pool } = require("../db");

function generarId() {
  return "ARCH-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function guardarArchivoBase64(client, { archivoBase64, archivoMimeType, archivoNombre }) {
  const ejecutor = client || pool;
  const idArchivo = generarId();
  const buffer = Buffer.from(archivoBase64, "base64");
  await ejecutor.query(
    "INSERT INTO archivos_documentos (id_archivo, contenido, mime_type, nombre_archivo) VALUES ($1, $2, $3, $4)",
    [idArchivo, buffer, archivoMimeType || "application/octet-stream", archivoNombre || idArchivo]
  );
  return { idArchivo, ruta: `/documentos/archivo/${idArchivo}`, buffer, mimeType: archivoMimeType || "application/octet-stream" };
}

async function obtenerArchivoPorId(idArchivo) {
  const { rows } = await pool.query(
    "SELECT id_archivo, contenido, mime_type, nombre_archivo FROM archivos_documentos WHERE id_archivo = $1",
    [idArchivo]
  );
  return rows[0] || null;
}

module.exports = { guardarArchivoBase64, obtenerArchivoPorId };
