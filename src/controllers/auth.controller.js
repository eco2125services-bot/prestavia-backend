const authService = require("../services/auth.service");
const { paginaHtml, formularioConfirmar, tokenConFormaValida } = require("./paginas");

const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL || "https://eco2125services-bot.github.io/prestavia-web/";

async function postLogin(req, res) {
  try {
    const { email, clave } = req.body;
    const resultado = await authService.login(email, clave, req.ip);
    if (!resultado.exito) return res.status(401).json(resultado);
    return res.status(200).json(resultado);
  } catch (error) {
    console.error("Error en /auth/login:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postActualizarClave(req, res) {
  try {
    const { nuevaClave } = req.body;
    // El usuario a modificar sale del JWT (req.usuario, puesto por
    // requiereAutenticacion), NUNCA del body — ver nota de seguridad en
    // auth.routes.js.
    const resultado = await authService.actualizarContrasenaObligatoria(req.usuario.idUsuario, nuevaClave, req.ip);
    if (!resultado.exito) return res.status(400).json(resultado);
    return res.status(200).json(resultado);
  } catch (error) {
    console.error("Error en /auth/actualizar-clave:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

// "¿Olvidaste tu contraseña?" — responde siempre lo mismo exista o no la cuenta.
async function postOlvideClave(req, res) {
  try {
    const resultado = await authService.solicitarRecuperacionClave(req.body && req.body.email, req.ip);
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en /auth/olvide-clave:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

// Páginas del enlace del correo. GET solo muestra un botón; POST restablece
// (así un escáner de correo no puede gastar el enlace).
async function getRestablecer(req, res) {
  try {
    res.set("Cache-Control", "no-store");
    const { token } = req.query;
    if (!tokenConFormaValida(token)) {
      return res.status(400).send(paginaHtml({ titulo: "Enlace incompleto", ok: false, mensaje: "<p>El enlace está incompleto o dañado. Usa el botón del correo que te enviamos.</p>" }));
    }
    const estado = await authService.consultarRecuperacion(token);
    if (!estado.valido) {
      return res.status(400).send(paginaHtml({ titulo: "No se pudo continuar", ok: false, mensaje: `<p>${estado.mensaje}</p>` }));
    }
    return res.status(200).send(
      paginaHtml({
        titulo: "Restablecer contraseña",
        ok: true,
        mensaje:
          `<p>Pulsa el botón para generar una contraseña temporal nueva. La actual dejará de funcionar.</p>` +
          formularioConfirmar({ accion: "/auth/restablecer", token, textoBoton: "Restablecer mi contraseña" }),
      })
    );
  } catch (error) {
    console.error("Error en GET /auth/restablecer:", error);
    return res.status(500).send(paginaHtml({ titulo: "Error del servidor", ok: false, mensaje: "<p>Intenta de nuevo en unos minutos.</p>" }));
  }
}

async function postRestablecer(req, res) {
  try {
    res.set("Cache-Control", "no-store");
    const token = req.body && req.body.token;
    if (!tokenConFormaValida(token)) {
      return res.status(400).send(paginaHtml({ titulo: "Enlace incompleto", ok: false, mensaje: "<p>Falta el token.</p>" }));
    }
    const resultado = await authService.restablecerClaveConToken(token, req.ip);
    if (!resultado.exito) {
      return res.status(400).send(paginaHtml({ titulo: "No se pudo continuar", ok: false, mensaje: `<p>${resultado.mensaje}</p>` }));
    }
    return res.status(200).send(
      paginaHtml({
        titulo: "Contraseña restablecida",
        ok: true,
        mensaje:
          `<p>Tu contraseña temporal nueva es:</p><div class="clave">${resultado.claveTemporal}</div>` +
          `<p>Cópiala ahora. Inicia sesión con ella — te pedirá definir una contraseña nueva. Vale 48 horas.</p>` +
          `<a class="btn" href="${FRONTEND_PUBLIC_URL}">Ir a iniciar sesión</a>`,
      })
    );
  } catch (error) {
    console.error("Error en POST /auth/restablecer:", error);
    return res.status(500).send(paginaHtml({ titulo: "Error del servidor", ok: false, mensaje: "<p>Intenta de nuevo en unos minutos.</p>" }));
  }
}

module.exports = { postLogin, postActualizarClave, postOlvideClave, getRestablecer, postRestablecer };
