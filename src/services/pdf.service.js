/**
 * PrestaVía — Backend — pdf.service.js
 *
 * Construye los PDFs de contrato y pagaré con PDFKit (librería pura de
 * Node, sin dependencias nativas ni llamadas a servicios externos), en
 * lugar de copiar una plantilla de Google Docs como hacía Apps Script.
 * El texto legal reproduce el contenido real definido en
 * GeneradorContratos.gs (función reescribirPlantillaContratoReal), incluida
 * la cláusula de independencia de la plataforma y la de arbitraje.
 *
 * El código QR se genera localmente con la librería 'qrcode' (en vez de
 * llamar a la API externa api.qrserver.com que usaba Apps Script) — así el
 * PDF no depende de que un servicio externo esté disponible en el momento
 * de la firma.
 */
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const COLOR_TITULO = "#0F766E";
const COLOR_SUBTITULO = "#14B8A6";

function crearPdfEnBuffer(dibujar) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      await dibujar(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function parrafo(doc, texto, opciones) {
  doc.fontSize(10).fillColor("#000000").text(texto, { align: "justify", ...(opciones || {}) });
  doc.moveDown(0.6);
}

async function generarPdfContrato(datos) {
  const {
    idContrato,
    idOp,
    nombrePrestamista,
    cedulaPrestamista,
    nombrePrestatario,
    cedulaPrestatario,
    direccionPrestatario,
    montoSolicitado,
    montoNetoEntregar,
    plazoMeses,
    cuotaMensual,
    tipoBien,
    marcaModelo,
    fechaFirma,
    hashPrestatario,
    hashPrestamista,
  } = datos;

  const datosQR = `PrestaVia|Contrato:${idContrato}|Op:${idOp}|Hash:${hashPrestatario}`;
  const qrBuffer = await QRCode.toBuffer(datosQR, { width: 140, margin: 1 });

  return crearPdfEnBuffer(async (doc) => {
    doc
      .fontSize(16)
      .fillColor(COLOR_TITULO)
      .text(`CONTRATO # ${idContrato}`, { align: "center" });
    doc
      .fontSize(12)
      .fillColor(COLOR_SUBTITULO)
      .text("CONTRATO DE MUTUO CON GARANTÍA PRENDARIA SIN DESPLAZAMIENTO", { align: "center" });
    doc.moveDown(1);

    parrafo(doc, "ENTRE LOS SUSCRITOS:", { align: "left" });
    parrafo(
      doc,
      `Por una parte, PRESTAVÍA (plataforma tecnológica facilitadora), en representación y en nombre de ${nombrePrestamista}, ` +
        `titular de la cédula de identidad / RIF N.º ${cedulaPrestamista || "N/D"}, quien en lo adelante y a los efectos de este contrato ` +
        `se denominará "EL PRESTAMISTA".`
    );
    parrafo(
      doc,
      `Y por la otra parte, ${nombrePrestatario}, titular de la cédula de identidad / RIF N.º ${cedulaPrestatario || "N/D"}, domiciliado en ` +
        `${direccionPrestatario || "N/D"}, quien en lo adelante se denominará "EL PRESTATARIO".`
    );
    parrafo(
      doc,
      "Ambas partes declaran ser mayores de edad, capaces para contratar y obligarse, y han convenido de mutuo acuerdo celebrar el " +
        "presente contrato bajo las siguientes cláusulas:"
    );

    doc.fontSize(11).fillColor(COLOR_TITULO).text("CLÁUSULAS DEL CONTRATO", { underline: true });
    doc.moveDown(0.4);

    parrafo(
      doc,
      `PRIMERA (OBJETO): EL PRESTAMISTA entrega en este acto a EL PRESTATARIO la cantidad de $${montoSolicitado} (dólares de los Estados ` +
        `Unidos de América, o su equivalente en moneda nacional al tipo de cambio oficial), la cual EL PRESTATARIO declara recibir a su entera ` +
        `satisfacción. El monto neto efectivamente entregado a EL PRESTATARIO, luego de la deducción de la comisión de originación de la ` +
        `plataforma, es de $${montoNetoEntregar}.`
    );
    parrafo(
      doc,
      `SEGUNDA (PLAZOS Y PAGOS): EL PRESTATARIO se obliga formal e irrevocablemente a devolver la cantidad recibida en un plazo de ` +
        `${plazoMeses} meses, mediante el pago de cuotas mensuales y consecutivas de $${cuotaMensual}, de acuerdo con la tabla de amortización ` +
        "generada dinámicamente por la plataforma PrestaVía."
    );
    parrafo(
      doc,
      "TERCERA (GARANTÍA PRENDARIA SIN DESPLAZAMIENTO): Para garantizar el fiel cumplimiento de la obligación de pago, EL PRESTATARIO " +
        "constituye garantía prendaria/hipotecaria sin desplazamiento de posesión sobre el bien de su propiedad que se describe a " +
        `continuación: Tipo de bien: ${tipoBien || "N/D"}. Identificación / marca / modelo / año / dirección: ${marcaModelo || "N/D"}. ` +
        "EL PRESTATARIO mantendrá el uso y custodia del bien mientras se mantenga al día con el calendario de pagos."
    );
    parrafo(
      doc,
      "CUARTA (CLÁUSULA DE MORA E INCUMPLIMIENTO): Ambas partes acuerdan expresamente que el plazo para el pago de cada cuota mensual " +
        "es improrrogable. Se establece un plazo de gracia máximo de tres (03) días continuos de mora. Si transcurridos tres (03) días " +
        "después de la fecha de vencimiento de la cuota, EL PRESTATARIO no ha hecho efectivo el pago, EL PRESTAMISTA tendrá derecho pleno " +
        "y ejecución inmediata sobre la propiedad o bien dejado en garantía, pudiendo tomar posesión del mismo para resarcir el capital " +
        "adeudado, sin necesidad de notificación judicial previa, aceptando EL PRESTATARIO este procedimiento como dación en pago por " +
        "incumplimiento."
    );
    parrafo(
      doc,
      "QUINTA (ACEPTACIÓN Y JURAMENTO): Las partes declaran que han leído, comprendido y aceptado todas las cláusulas aquí descritas. " +
        "En prueba de conformidad y bajo fe de juramento, firman digitalmente este documento a través de la plataforma PrestaVía."
    );
    parrafo(
      doc,
      "SEXTA (CLÁUSULA DE INDEPENDENCIA DE LA PLATAFORMA): Ambas partes (EL PRESTAMISTA y EL PRESTATARIO) reconocen y declaran " +
        "expresamente que la plataforma PrestaVía opera únicamente como un tercero facilitador tecnológico e infraestructura digital. " +
        "PrestaVía no es parte del presente contrato de mutuo ni actúa como fiadora, avalista o garante de las obligaciones financieras " +
        "o de la entrega de fondos acordados. Ambas partes liberan a PrestaVía y a sus administradores de cualquier responsabilidad civil, " +
        "penal, administrativa o mercantil derivada de mora, impago o disputas sobre la ejecución de la garantía."
    );
    parrafo(
      doc,
      "SÉPTIMA (CLÁUSULA DE ARBITRAJE): Toda controversia, disputa o reclamación que surja de este contrato, o relacionada con su " +
        "incumplimiento, interpretación o validez, será resuelta mediante arbitraje vinculante, con exclusión de la jurisdicción de los " +
        "tribunales ordinarios, de conformidad con la Convención de las Naciones Unidas sobre el Reconocimiento y Ejecución de Sentencias " +
        "Arbitrales Extranjeras (Convención de Nueva York, 1958). El laudo arbitral que se dicte será definitivo y vinculante para ambas " +
        "partes, y podrá ser ejecutado en cualquier jurisdicción donde alguna de las partes tenga bienes o residencia."
    );

    doc.moveDown(1);
    const yFirmas = doc.y;
    doc.fontSize(10).text("_________________________", 70, yFirmas, { width: 200, align: "center" });
    doc.text("_________________________", 320, yFirmas, { width: 200, align: "center" });
    doc.font("Helvetica-Bold").text(nombrePrestatario, 70, yFirmas + 15, { width: 200, align: "center" });
    doc.text(nombrePrestamista, 320, yFirmas + 15, { width: 200, align: "center" });
    doc.font("Helvetica").fontSize(9).text("EL PRESTATARIO", 70, yFirmas + 32, { width: 200, align: "center" });
    doc.text("EL PRESTAMISTA", 320, yFirmas + 32, { width: 200, align: "center" });
    doc.moveDown(4);

    doc.fontSize(11).fillColor(COLOR_TITULO).text("CERTIFICACIÓN Y REGISTRO DE FIRMA DIGITAL (SHA-256)");
    doc.fontSize(9).fillColor("#000000");
    doc.text(
      "La autenticidad de este contrato está respaldada electrónicamente de conformidad con la Ley de Mensajes de Datos y Firmas " +
        "Electrónicas:"
    );
    doc.text(`• FECHA DE FIRMA Y EJECUCIÓN: ${fechaFirma}`);
    doc.text(`• FIRMANTE 1 (EL PRESTATARIO) — Hash de Firma Criptográfica: ${hashPrestatario}`);
    doc.text(`• FIRMANTE 2 (EL PRESTAMISTA) — Hash de Firma Criptográfica: ${hashPrestamista}`);
    doc.moveDown(0.5);

    try {
      const yQr = doc.y;
      doc.image(qrBuffer, doc.page.width / 2 - 60, yQr, { width: 120, height: 120 });
      doc.y = yQr + 130; // avanzar el cursor de texto más allá de la imagen, para no solaparla
    } catch (eQr) {
      // Si por algún motivo el QR no se puede insertar, el contrato sigue
      // siendo válido igual (el hash de texto ya está impreso arriba).
    }

    doc
      .fontSize(9)
      .fillColor("#888888")
      .text("[SELLO DIGITAL PRESTAVÍA — DOCUMENTO PDF OFICIAL REGISTRADO]", { align: "center" });
  });
}

async function generarPdfPagare(datos) {
  const { idContrato, idOp, nombrePrestatario, nombrePrestamista, cedulaPrestatario, monto, plazoMeses, cuotaMensual, hashFirma, fechaHoy } =
    datos;

  return crearPdfEnBuffer(async (doc) => {
    doc.fontSize(18).fillColor("#000000").text("PAGARÉ", { align: "center" });
    doc.fontSize(10).text(`Pagaré N.º: ${idContrato} | Operación: ${idOp}`, { align: "center" });
    doc.moveDown(1.5);

    parrafo(
      doc,
      `Yo, ${nombrePrestatario}, titular de la cédula de identidad / RIF N.º ${cedulaPrestatario || "N/D"}, debo y pagaré ` +
        `INCONDICIONALMENTE, sin protesto, a la orden de ${nombrePrestamista} ("EL BENEFICIARIO"), la cantidad de $${monto} (dólares de ` +
        `los Estados Unidos de América), en ${plazoMeses} cuotas mensuales y consecutivas de $${cuotaMensual} cada una, de acuerdo con la ` +
        `tabla de amortización de la operación ${idOp} registrada en la plataforma PrestaVía, a partir de la fecha de hoy, ${fechaHoy}.`
    );
    parrafo(
      doc,
      "En caso de mora en el pago de cualquier cuota, EL BENEFICIARIO podrá dar por vencida la totalidad de la deuda restante y exigir " +
        "su pago inmediato, sin necesidad de requerimiento o notificación judicial previa, quedando este pagaré sujeto al procedimiento " +
        "ejecutivo o de cobro abreviado que corresponda según la legislación aplicable."
    );

    doc.moveDown(2);
    doc.fontSize(10).text("_________________________", { align: "center" });
    doc.font("Helvetica-Bold").text(nombrePrestatario, { align: "center" });
    doc.font("Helvetica").fontSize(9).text("DEUDOR (EL PRESTATARIO)", { align: "center" });

    doc.moveDown(1);
    doc.fontSize(8).fillColor("#888888").text(`Hash de firma digital: ${hashFirma}`, { align: "center" });
  });
}

module.exports = { generarPdfContrato, generarPdfPagare };
