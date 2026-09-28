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

module.exports = { postRegistrarPrestamista, postRegistrarPrestatario, postNuevaSolicitud, postCancelarSuscripcion };
