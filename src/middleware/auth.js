/**
 * Middleware de autenticación — protege rutas que antes vivían "detrás"
 * del login de Apps Script (donde toda la sesión vivía en localStorage del
 * navegador). Ahora el cliente manda el JWT en el header:
 *   Authorization: Bearer <token>
 */
const jwt = require("jsonwebtoken");

const { leerUsuarioDeSesion } = require("../services/sesiones.service");

const JWT_SECRET = process.env.JWT_SECRET;

async function requiereAutenticacion(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ exito: false, mensaje: "Falta el token de autenticación." });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ exito: false, mensaje: "Token inválido o expirado." });
  }
  try {
    // Además de la firma: el usuario debe existir y el token no debe haber
    // sido invalidado (cierre de sesión, cambio o restablecimiento de clave).
    const usuario = await leerUsuarioDeSesion(payload.sub, payload.iat);
    if (!usuario) {
      return res.status(401).json({ exito: false, mensaje: "Tu sesión ya no es válida. Inicia sesión de nuevo." });
    }
    // El rol sale de la base de datos, no del token: un cambio de rol aplica de inmediato.
    req.usuario = { idUsuario: usuario.id_usuario, rol: usuario.rol, datos: usuario };
    return next();
  } catch (error) {
    console.error("Error validando la sesión:", error.message);
    return res.status(503).json({ exito: false, mensaje: "No pudimos validar tu sesión. Intenta de nuevo." });
  }
}

// Uso: router.get('/admin/metricas', requiereAutenticacion, requiereRol('Admin'), controller)
function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.usuario || rolesPermitidos.indexOf(req.usuario.rol) === -1) {
      return res.status(403).json({ exito: false, mensaje: "No tienes permiso para esta acción." });
    }
    return next();
  };
}

module.exports = { requiereAutenticacion, requiereRol };
