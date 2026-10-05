/**
 * PrestaVía — Backend — archivo.service.js
 * Almacén genérico de archivos (bytes) para documentos de usuario (cédula,
 * fotos del bien en garantía). Mismo patrón que comprobante.service.js
 * (módulo 4) y documentos_generados (módulo 3) — todo el contenido vive en
 * esta base de datos en vez de depender de una cuenta de Drive.
 */
const { pool } = require("../db");
const { validarArchivo } = require("./validacionArchivo.service");

function generarId() {
  return "ARCH-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Hallazgo de seguridad: ver validacionArchivo.service.js. Esta función
// podía lanzar una excepción genérica antes (buffer inválido, etc.); ahora
// devuelve { error: "mensaje" } cuando el archivo no pasa la validación,
// para que quien la llama pueda devolverle al usuario un mensaje claro en
// vez de un 500 genérico.
async function guardarArchivoBase64(client, { archivoBase64, archivoMimeType, archivoNombre }) {
  const buffer = Buffer.from(archivoBase64 || "", "base64");
  const validacion = validarArchivo(buffer, archivoMimeType);
  if (!validacion.ok) {
    return { error: validacion.mensaje };
  }

  const ejecutor = client || pool;
  const idArchivo = generarId();
  await ejecutor.query(
    "INSERT INTO archivos_documentos (id_archivo, contenido, mime_type, nombre_archivo) VALUES ($1, $2, $3, $4)",
    [idArchivo, buffer, validacion.mimeTypeReal, archivoNombre || idArchivo]
  );
  return { idArchivo, ruta: `/documentos/archivo/${idArchivo}`, buffer, mimeType: validacion.mimeTypeReal };
}

async function obtenerArchivoPorId(idArchivo) {
  const { rows } = await pool.query(
    "SELECT id_archivo, contenido, mime_type, nombre_archivo FROM archivos_documentos WHERE id_archivo = $1",
    [idArchivo]
  );
  return rows[0] || null;
}

module.exports = { guardarArchivoBase64, obtenerArchivoPorId };
