/**
 * PrestaVía — Backend — comprobante.service.js
 *
 * Guarda comprobantes de pago (fotos/PDFs de transferencias, capturas de
 * pantalla) subidos por prestatarios y prestamistas. Reemplaza el patrón
 * de "subir a una carpeta de Drive y compartir el link" de RecepcionPagos.gs
 * y PagoComision.gs — igual que con los contratos (módulo 3), se guarda el
 * contenido real como BYTEA en esta base de datos en vez de depender de
 * una cuenta de Drive.
 */
const { pool } = require("../db");
const { validarArchivo } = require("./validacionArchivo.service");

function generarId() {
  return "CMP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Guarda un comprobante recibido como base64 (igual que Apps Script recibía
 * 'archivoBytes' en base64 desde el navegador) y devuelve la ruta interna
 * de la API donde se puede descargar.
 *
 * Hallazgo de seguridad: ver validacionArchivo.service.js — antes guardaba
 * cualquier contenido con el Content-Type que dijera el cliente, sin
 * verificarlo. Ahora, si el archivo no pasa la validación, devuelve
 * { error } en vez de guardarlo (comprobante sigue siendo opcional: sin
 * archivo, se devuelve null como antes).
 */
async function guardarComprobanteBase64(client, { archivoBase64, archivoMimeType, archivoNombre }) {
  if (!archivoBase64) return null; // comprobante opcional en algunos flujos

  const buffer = Buffer.from(archivoBase64, "base64");
  const validacion = validarArchivo(buffer, archivoMimeType);
  if (!validacion.ok) {
    return { error: validacion.mensaje };
  }

  const ejecutor = client || pool;
  const idComprobante = generarId();
  await ejecutor.query(
    "INSERT INTO comprobantes_pago (id_comprobante, contenido, mime_type, nombre_archivo) VALUES ($1, $2, $3, $4)",
    [idComprobante, buffer, validacion.mimeTypeReal, archivoNombre || idComprobante]
  );
  return `/pagos/comprobante/${idComprobante}`;
}

async function obtenerComprobantePorId(idComprobante) {
  const { rows } = await pool.query(
    "SELECT id_comprobante, contenido, mime_type, nombre_archivo FROM comprobantes_pago WHERE id_comprobante = $1",
    [idComprobante]
  );
  return rows[0] || null;
}

module.exports = { guardarComprobanteBase64, obtenerComprobantePorId };
