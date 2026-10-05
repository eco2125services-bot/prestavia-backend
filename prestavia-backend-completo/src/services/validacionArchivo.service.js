/**
 * PrestaVía — Backend — validacionArchivo.service.js
 *
 * Hallazgo de seguridad (recomendación #10 del informe de auditoría):
 * "validar archivos en servidor (tipo/contenido/tamaño)". Antes,
 * archivo.service.js y comprobante.service.js guardaban cualquier base64
 * que llegara, con el `archivoMimeType` que el propio NAVEGADOR DEL
 * CLIENTE decía que tenía — nunca verificado contra el contenido real. Eso
 * permite dos cosas:
 *
 *   1. Subir un archivo cuyo contenido real NO es el que dice ser (p. ej.
 *      un .html con <script> etiquetado como "image/png"), y que luego se
 *      sirve de vuelta con ESE MISMO Content-Type declarado
 *      (documentos.controller.js:getArchivo), lo que en el navegador de
 *      quien lo abra (el prestamista revisando documentos) podría
 *      ejecutarse como el tipo real, no el declarado.
 *   2. Subir cualquier cosa sin límite real de tamaño por archivo (el único
 *      límite existente era el de todo el body JSON en server.js, pensado
 *      para no tumbar el proceso, no para esto).
 *
 * Esta validación es deliberadamente simple (sin dependencias nuevas):
 * revisa los primeros bytes del archivo (su "firma"/magic number) contra
 * una lista blanca de formatos, e ignora por completo el Content-Type que
 * mandó el cliente para decidir — el mimeType declarado solo se usa, ya
 * validado, para servir el archivo de vuelta.
 */

const LIMITE_BYTES = 18 * 1024 * 1024; // 18MB — mismo límite que ya se comunica en el frontend

const FIRMAS = [
  { mimeType: "image/jpeg", extensiones: [".jpg", ".jpeg"], firma: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/png", extensiones: [".png"], firma: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    mimeType: "image/webp",
    extensiones: [".webp"],
    firma: (b) => b.length > 12 && b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP",
  },
  { mimeType: "application/pdf", extensiones: [".pdf"], firma: (b) => b.length > 4 && b.slice(0, 4).toString("ascii") === "%PDF" },
  // HEIC/HEIF: el formato por defecto de fotos en iPhones recientes —
  // necesario para no rechazar de golpe las fotos de cédula/garantía que
  // manden desde un iPhone sin convertir. Mismo contenedor ISO-BMFF que
  // .mp4, identificado por la "marca" después de "ftyp".
  {
    mimeType: "image/heic",
    extensiones: [".heic", ".heif"],
    firma: (b) =>
      b.length > 12 &&
      b.slice(4, 8).toString("ascii") === "ftyp" &&
      ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].indexOf(b.slice(8, 12).toString("ascii")) !== -1,
  },
];

/**
 * Valida un buffer ya decodificado de base64. Deliberadamente NO confía en
 * `archivoMimeType` del cliente para decidir si el archivo es válido — solo
 * lo usa (una vez validado el contenido real) como pista de cuál formato
 * esperar primero, por si acaso dos firmas calzaran (no pasa con esta
 * lista, pero deja la puerta abierta a agregar más formatos sin ambigüedad).
 *
 * Devuelve { ok: true, mimeTypeReal } o { ok: false, mensaje }.
 */
function validarArchivo(buffer, archivoMimeTypeDeclarado) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, mensaje: "El archivo está vacío." };
  }
  if (buffer.length > LIMITE_BYTES) {
    return { ok: false, mensaje: "Ese archivo pesa demasiado — usa una foto o PDF de menos de 18 MB." };
  }

  // Si el cliente declaró un tipo de la lista blanca, se prueba primero esa
  // firma (más rápido en el caso normal); si no calza o no declaró nada, se
  // prueban todas.
  const candidatos = FIRMAS.slice().sort((a, b) => (a.mimeType === archivoMimeTypeDeclarado ? -1 : b.mimeType === archivoMimeTypeDeclarado ? 1 : 0));
  const match = candidatos.find((f) => f.firma(buffer));

  if (!match) {
    return {
      ok: false,
      mensaje: "El archivo debe ser una foto (JPG, PNG o WEBP) o un PDF — el contenido no coincide con ninguno de esos formatos.",
    };
  }

  return { ok: true, mimeTypeReal: match.mimeType };
}

module.exports = { validarArchivo, LIMITE_BYTES };
