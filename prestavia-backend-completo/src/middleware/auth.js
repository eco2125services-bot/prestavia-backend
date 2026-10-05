/**
 * Middleware de autenticación — protege rutas que antes vivían "detrás"
 * del login de Apps Script (donde toda la sesión vivía en localStorage del
 * navegador). Ahora el cliente manda el JWT en el header:
 *   Authorization: Bearer <token>
 */
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function requiereAutenticacion(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ exito: false, mensaje: "Falta el token de autenticación." });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.usuario = { idUsuario: payload.sub, rol: payload.rol };
    return next();
  } catch (error) {
    return res.status(401).json({ exito: false, mensaje: "Token inválido o expirado." });
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
