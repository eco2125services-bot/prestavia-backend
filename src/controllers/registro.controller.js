const registroService = require("../services/registro.service");
const { paginaHtml, formularioConfirmar, tokenConFormaValida } = require("./paginas");

const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || "https://eco2125services-bot.github.io/prestavia-web/";

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

// ---------------------------------------------------------------------------
// Confirmación de correo (páginas HTML — se abren desde el enlace del correo,
// sin JWT). Dos pasos a propósito:
//   GET  → solo MUESTRA un botón (no cambia nada).
//   POST → crea la cuenta de verdad.
// Antes el GET creaba la cuenta y gastaba el token: los escáneres de enlaces
// de los proveedores de correo (que "abren" los enlaces de los mensajes para
// revisarlos) lo consumían antes que la persona, y ella veía "ya fue usado"
// con la clave perdida. Un escáner hace GET, nunca POST.
// ---------------------------------------------------------------------------

function sinCache(res) {
  res.set("Cache-Control", "no-store");
}

async function getVerificarEmail(req, res) {
  try {
    sinCache(res);
    const { token } = req.query;
    if (!tokenConFormaValida(token)) {
      return res.status(400).send(paginaHtml({ titulo: "Enlace incompleto", ok: false, mensaje: "<p>El enlace de confirmación está incompleto o dañado. Usa el botón del correo que te enviamos.</p>" }));
    }
    const estado = await registroService.consultarRegistroPendiente(token);
    if (!estado.valido) {
      return res.status(400).send(paginaHtml({ titulo: "No se pudo confirmar", ok: false, mensaje: `<p>${estado.mensaje}</p>` }));
    }
    return res.status(200).send(
      paginaHtml({
        titulo: "Confirma tu cuenta",
        ok: true,
        mensaje:
          `<p>Un último paso: pulsa el botón para activar tu cuenta de PrestaVía y ver tu contraseña temporal.</p>` +
          formularioConfirmar({ accion: "/registro/verificar-email", token, textoBoton: "Confirmar mi cuenta" }),
      })
    );
  } catch (error) {
    console.error("Error en GET /registro/verificar-email:", error);
    return res.status(500).send(paginaHtml({ titulo: "Error del servidor", ok: false, mensaje: "<p>Intenta de nuevo en unos minutos.</p>" }));
  }
}

async function postVerificarEmail(req, res) {
  try {
    sinCache(res);
    const token = req.body && req.body.token;
    if (!tokenConFormaValida(token)) {
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
          `<p>Cópiala ahora. Inicia sesión con ella — te pedirá cambiarla de inmediato. También te la enviamos por correo.</p>` +
          `<a class="btn" href="${FRONTEND_PUBLIC_URL}">Ir a iniciar sesión</a>`,
      })
    );
  } catch (error) {
    console.error("Error en POST /registro/verificar-email:", error);
    return res.status(500).send(paginaHtml({ titulo: "Error del servidor", ok: false, mensaje: "<p>Intenta de nuevo en unos minutos.</p>" }));
  }
}

module.exports = {
  postRegistrarPrestamista,
  postRegistrarPrestatario,
  postNuevaSolicitud,
  postCancelarSuscripcion,
  getVerificarEmail,
  postVerificarEmail,
};
