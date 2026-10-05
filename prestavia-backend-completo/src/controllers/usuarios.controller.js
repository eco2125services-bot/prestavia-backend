const perfilService = require("../services/perfil.service");

async function getMiPerfil(req, res) {
  try {
    const datos = await perfilService.obtenerMiPerfil(req.usuario.idUsuario);
    if (!datos) return res.status(404).json({ exito: false, mensaje: "Usuario no encontrado." });
    return res.status(200).json({ exito: true, datos });
  } catch (error) {
    console.error("Error en GET /usuarios/mi-perfil:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

async function patchMiPerfil(req, res) {
  try {
    const { nombreLegal, telefono, direccion } = req.body;
    const resultado = await perfilService.actualizarMiPerfil(req.usuario.idUsuario, { nombreLegal, telefono, direccion });
    return res.status(resultado.exito ? 200 : 400).json(resultado);
  } catch (error) {
    console.error("Error en PATCH /usuarios/mi-perfil:", error);
    return res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
  }
}

module.exports = { getMiPerfil, patchMiPerfil };
