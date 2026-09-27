const authService = require("../services/auth.service");

async function postLogin(req, res) {
  try {
    const { email, clave } = req.body;
    const resultado = await authService.login(email, clave);
    if (!resultado.exito) return res.status(401).json(resultado);
    return res.status(200).json(resultado);
  } catch (error) {
    console.error("Error en /auth/login:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function postActualizarClave(req, res) {
  try {
    const { email, nuevaClave } = req.body;
    const resultado = await authService.actualizarContrasenaObligatoria(email, nuevaClave);
    if (!resultado.exito) return res.status(400).json(resultado);
    return res.status(200).json(resultado);
  } catch (error) {
    console.error("Error en /auth/actualizar-clave:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = { postLogin, postActualizarClave };
