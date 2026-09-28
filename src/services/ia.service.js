/**
 * PrestaVía — Backend — ia.service.js
 *
 * Reemplaza AuditoriaIA.gs. Importante (igual que decía el comentario en el
 * original): esto NO es un modelo de IA para el avalúo — es un motor de
 * REGLAS FIJAS (avalúo = 85% del valor declarado, riesgo por LTV). Es
 * determinista y no depende de ningún servicio externo.
 *
 * La única parte que sí usa un modelo de IA real es el análisis de
 * documentos con Gemini (visión) — ver analizarDocumentoConIA más abajo.
 * Requiere una GEMINI_API_KEY (gratis en https://aistudio.google.com/app/apikey).
 * SIN esa variable configurada, el análisis simplemente queda marcado como
 * "Pendiente_Revision_Manual" — nada se rompe, el equipo revisa a mano.
 * Aviso igual que con el correo y DocuSeal: esto es opcional, lo puedes
 * activar cuando quieras agregando la variable de entorno en Render.
 */
const { pool } = require("../db");

const CASTIGO_LIQUIDEZ_GARANTIA = 0.85; // 15% de descuento sobre el valor declarado
const LTV_MAXIMO_ACEPTABLE = 0.6;
const LTV_BAJO_RIESGO = 0.4;

/**
 * Evalúa UN activo de garantía: avalúo conservador, LTV, y calificación de
 * riesgo. Si el riesgo es muy alto y la oportunidad sigue "Abierta", la
 * rechaza automáticamente. Se llama justo después de crear la solicitud
 * (registro nuevo, o nueva solicitud de un usuario existente).
 */
async function evaluarActivoIndividual(client, idActivo) {
  const ejecutor = client || pool;

  const { rows: rowsAct } = await ejecutor.query(
    "SELECT id_activo, valor_declarado_usuario FROM activos_garantia WHERE id_activo = $1",
    [idActivo]
  );
  const activo = rowsAct[0];
  if (!activo) return;

  const { rows: rowsOp } = await ejecutor.query(
    "SELECT id_oportunidad, monto_solicitado, estatus FROM oportunidades_mercado WHERE id_activo_garantia = $1",
    [idActivo]
  );
  const op = rowsOp[0];

  const valorDeclarado = parseFloat(activo.valor_declarado_usuario) || 0;
  const montoSolicitado = op ? parseFloat(op.monto_solicitado) || 0 : 0;
  const baseEstimada = valorDeclarado > 0 ? valorDeclarado : montoSolicitado * 2;
  const valorAvaluoIA = Math.round(baseEstimada * CASTIGO_LIQUIDEZ_GARANTIA);
  const ltv = valorAvaluoIA > 0 ? parseFloat((montoSolicitado / valorAvaluoIA).toFixed(4)) : 1;

  // El análisis de fraude en fotos se hace de verdad cuando se sube el
  // documento real (analizarDocumentoConIA). En el registro todavía no hay
  // foto que analizar.
  const fraudeFotos = "Pendiente_Documento";
  let calificacionRiesgo = "Medio";
  if (ltv > LTV_MAXIMO_ACEPTABLE) calificacionRiesgo = "Rechazado por Riesgo Alto";
  else if (ltv < LTV_BAJO_RIESGO) calificacionRiesgo = "Bajo";

  await ejecutor.query(
    `UPDATE activos_garantia
     SET valor_avaluo_ia = $1, analisis_fraude_fotos = $2, estatus_validacion = 'Validado',
         metadata_ia_analisis = $3, updated_at = now()
     WHERE id_activo = $4`,
    [
      valorAvaluoIA,
      fraudeFotos,
      JSON.stringify({ fechaEvaluacion: new Date().toISOString(), castigoLiquidezAplicado: "15%", dictamenFraude: fraudeFotos }),
      idActivo,
    ]
  );

  if (op) {
    await ejecutor.query(
      `UPDATE oportunidades_mercado
       SET ltv_preliminar = $1, scoring_riesgo_ia = $2,
           observaciones_ia = $3, updated_at = now()
       WHERE id_oportunidad = $4`,
      [
        ltv,
        calificacionRiesgo,
        `Avalúo: $${valorAvaluoIA} | LTV: ${(ltv * 100).toFixed(1)}% | Fraude: ${fraudeFotos}`,
        op.id_oportunidad,
      ]
    );
    if (calificacionRiesgo === "Rechazado por Riesgo Alto" && op.estatus === "Abierta") {
      await ejecutor.query("UPDATE oportunidades_mercado SET estatus = 'Rechazada', updated_at = now() WHERE id_oportunidad = $1", [
        op.id_oportunidad,
      ]);
    }
  }
}

/**
 * KYC placeholder: aprueba automáticamente (igual que el original — para
 * verificación de identidad real haría falta un proveedor externo, que
 * queda fuera de este alcance por ahora).
 */
async function verificarIdentidadIndividual(client, idUsuario) {
  const ejecutor = client || pool;
  await ejecutor.query(
    "UPDATE usuarios SET verificacion_identidad_ia = 'Aprobado' WHERE id_usuario = $1 AND (verificacion_identidad_ia IS NULL OR verificacion_identidad_ia = '' OR verificacion_identidad_ia = 'Pendiente')",
    [idUsuario]
  );
}

/**
 * Análisis por IA de visión (Gemini) de un documento subido: ¿corresponde
 * a lo declarado? ¿hay señales visuales de edición? Si no hay
 * GEMINI_API_KEY configurada, o el archivo no es una imagen (ej. PDF),
 * queda "Pendiente_Revision_Manual" sin romper el flujo de subida.
 */
async function analizarDocumentoConIA(buffer, mimeType, tipoDocumento, datosEsperados) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      estatus: "Pendiente_Revision_Manual",
      detalle: "No hay GEMINI_API_KEY configurada.",
      mensajeUsuario: "Será revisado manualmente por el equipo.",
    };
  }
  if (!mimeType || mimeType.indexOf("image/") !== 0) {
    return {
      estatus: "Pendiente_Revision_Manual",
      detalle: "Documento no es una imagen, requiere revisión manual.",
      mensajeUsuario: "Como no es una imagen (ej. PDF), será revisado manualmente por el equipo.",
    };
  }

  try {
    const base64Imagen = buffer.toString("base64");
    let promptTexto;
    if (tipoDocumento === "cedula") {
      promptTexto =
        "Eres un analista de verificación de identidad para una plataforma de préstamos. " +
        `Analiza esta imagen de un documento de identidad. El usuario declaró llamarse '${datosEsperados.nombreEsperado}' ` +
        `y tener el número de documento '${datosEsperados.numeroEsperado}'. ` +
        'Responde ÚNICAMENTE con un JSON (sin texto adicional, sin markdown) con este formato exacto: ' +
        '{"esDocumentoValido": true/false, "coincideNombre": true/false, "coincideNumero": true/false, ' +
        '"señalesDeEdicion": true/false, "explicacion": "breve explicación en español"}';
    } else {
      promptTexto =
        "Eres un analista de verificación de garantías para una plataforma de préstamos. " +
        `Analiza esta imagen de un bien declarado como garantía. El usuario declaró: tipo de bien '${datosEsperados.tipoBienEsperado}', ` +
        `descripción '${datosEsperados.descripcionEsperada}', y un valor estimado de $${datosEsperados.valorDeclarado}. ` +
        'Responde ÚNICAMENTE con un JSON (sin texto adicional, sin markdown) con este formato exacto: ' +
        '{"correspondeTipoBien": true/false, "valorPareceRazonable": true/false, ' +
        '"señalesDeEdicion": true/false, "explicacion": "breve explicación en español"}';
    }

    const payload = { contents: [{ parts: [{ text: promptTexto }, { inline_data: { mime_type: mimeType, data: base64Imagen } }] }] };
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const resultadoJson = await response.json();

    if (!resultadoJson.candidates || !resultadoJson.candidates[0]) {
      return { estatus: "Pendiente_Revision_Manual", detalle: "Respuesta inesperada de la IA.", mensajeUsuario: "Será revisado manualmente." };
    }

    let textoRespuesta = resultadoJson.candidates[0].content.parts[0].text.trim();
    textoRespuesta = textoRespuesta.replace(/```json|```/g, "").trim();
    const analisis = JSON.parse(textoRespuesta);

    const sospechoso =
      analisis["señalesDeEdicion"] === true ||
      analisis.coincideNombre === false ||
      analisis.coincideNumero === false ||
      analisis.correspondeTipoBien === false;

    return {
      estatus: sospechoso ? "Revision_Manual_IA" : "Validado_IA",
      detalle: JSON.stringify(analisis),
      mensajeUsuario: sospechoso
        ? "⚠️ La IA detectó inconsistencias — el prestamista será advertido antes de aprobar."
        : "La IA validó el documento sin inconsistencias.",
    };
  } catch (error) {
    return { estatus: "Pendiente_Revision_Manual", detalle: "Error en análisis IA: " + error.message, mensajeUsuario: "Será revisado manualmente." };
  }
}

module.exports = { evaluarActivoIndividual, verificarIdentidadIndividual, analizarDocumentoConIA };
