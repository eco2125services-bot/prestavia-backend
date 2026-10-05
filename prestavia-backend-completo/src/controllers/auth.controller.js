const authService = require("../services/auth.service");

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

module.exports = { postLogin, postActualizarClave };
