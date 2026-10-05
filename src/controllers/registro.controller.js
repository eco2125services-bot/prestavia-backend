const registroService = require("../services/registro.service");

async function postRegistrarPrestamista(req, res) {
  try {
    const resultado = await registroService.registrarPrestamistaNuevo(req.body);
    return res.status(resultado.exito ? 201 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /registro/prestamista:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postRegistrarPrestatario(req, res) {
  try {
    const resultado = await registroService.registrarPrestatarioNuevo(req.body);
    return res.status(resultado.exito ? 201 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /registro/prestatario:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postNuevaSolicitud(req, res) {
  try {
    const resultado = await registroService.registrarSolicitudPrestamo(req.usuario.idUsuario, req.body);
    return res.status(resultado.exito ? 201 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /registro/solicitud:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postCancelarSuscripcion(req, res) {
  try {
    const resultado = await registroService.cancelarSuscripcionUsuario(req.usuario.idUsuario);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en POST /registro/cancelar-suscripcion:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

function paginaHtml({ titulo, mensaje, ok }) {
  const color = ok ? "#1f6f4a" : "#b3261e";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${titulo} — PrestaVía</title>
    <style>body{font-family:system-ui,sans-serif;background:#0d1b14;color:#eef5f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
    .card{max-width:440px;background:#15271d;border:1px solid #2a4433;border-radius:12px;padding:28px;text-align:center;}
    h1{font-size:20px;color:${color};margin:0 0 14px;}
    .clave{font-family:monospace;font-size:18px;background:#0d1b14;border:1px solid #2a4433;border-radius:6px;padding:10px;margin:14px 0;word-break:break-all;}
    a.btn{display:inline-block;margin-top:14px;padding:10px 20px;background:#1f6f4a;color:#fff;border-radius:6px;text-decoration:none;}
    p{line-height:1.5;}</style></head>
    <body><div class="card"><h1>${titulo}</h1>${mensaje}</div></body></html>`;
}

/**
 * Ruta pública (sin JWT — se abre directo desde el enlace del correo).
 * Responde HTML, no JSON: quien la llama es el navegador de la persona,
 * no el frontend de la app.
 */
async function getVerificarEmail(req, res) {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).send(paginaHtml({ titulo: "Enlace incompleto", ok: false, mensaje: "<p>Falta el token de confirmación.</p>" }));
    }
    const resultado = await registroService.completarRegistroPendiente(token);
    if (!resultado.exito) {
      return res.status(400).send(paginaHtml({ titulo: "No se pudo confirmar", ok: false, mensaje: `<p>${resultado.mensaje}</p>` }));
    }
    // detalleSolicitud lo arma el servidor (id + cifras de LTV, sin texto del
    // usuario) y dice la verdad: publicada o rechazada por riesgo (E3).
    const extra =
      resultado.rol === "Prestatario" && resultado.detalleSolicitud ? `<p>${resultado.detalleSolicitud}</p>` : "";
    return res.status(200).send(
      paginaHtml({
        titulo: "¡Cuenta confirmada!",
        ok: true,
        mensaje:
          `<p>Tu contraseña temporal es:</p><div class="clave">${resultado.claveTemporal}</div>` +
          extra +
          `<p>Inicia sesión con ella — te pedirá cambiarla de inmediato.</p>` +
          `<a class="btn" href="${process.env.FRONTEND_PUBLIC_URL || "https://eco2125services-bot.github.io/prestavia-web/"}">Ir a iniciar sesión</a>`,
      })
    );
  } catch (error) {
    console.error("Error en GET /registro/verificar-email:", error);
    return res
      .status(500)
      .send(paginaHtml({ titulo: "Error del servidor", ok: false, mensaje: "<p>Intenta de nuevo en unos minutos.</p>" }));
  }
}

module.exports = {
  postRegistrarPrestamista,
  postRegistrarPrestatario,
  postNuevaSolicitud,
  postCancelarSuscripcion,
  getVerificarEmail,
};
