require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const authRoutes = require("./routes/auth.routes");
const marketplaceRoutes = require("./routes/marketplace.routes");
const contratoRoutes = require("./routes/contrato.routes");
const pagosRoutes = require("./routes/pagos.routes");
const adminRoutes = require("./routes/admin.routes");
const registroRoutes = require("./routes/registro.routes");
const documentosRoutes = require("./routes/documentos.routes");
const usuariosRoutes = require("./routes/usuarios.routes");

const app = express();

// Render (y la mayoría de plataformas cloud) ponen la app detrás de un
// proxy inverso, que agrega el header X-Forwarded-For con la IP real del
// visitante. Sin esto, express-rate-limit no puede confiar en esa IP para
// contar intentos de login por persona, y tira una advertencia en los logs.
app.set("trust proxy", 1);

app.use(helmet());
// Antes: cors() abierto, sin restricción — cualquier sitio podía llamar a
// este API desde el navegador de un usuario logueado (con su token ya en
// sessionStorage, por ejemplo vía el XSS corregido hoy). Ahora solo se
// permiten los orígenes reales del frontend (GitHub Pages) y localhost para
// desarrollo.
const ORIGENES_PERMITIDOS = [
  "https://eco2125services-bot.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
app.use(
  cors({
    origin: function (origin, callback) {
      // Sin header Origin (curl, Postman, llamadas servidor-a-servidor): se
      // permite — no es el caso que este control intenta frenar (navegador
      // de un usuario con sesión activa en un sitio que no es el nuestro).
      if (!origin || ORIGENES_PERMITIDOS.indexOf(origin) !== -1) {
        return callback(null, true);
      }
      return callback(new Error("Origen no permitido por CORS: " + origin));
    },
  })
);
// Límite elevado (por defecto son ~100kb): los comprobantes de pago y los
// documentos de identidad/garantía llegan como imágenes/PDFs codificados en
// base64 dentro del cuerpo JSON — una foto de 15MB de una cédula/pasaporte
// con buena cámara, codificada en base64, pesa ~20MB. 25mb da margen.
app.use(express.json({ limit: "25mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, servicio: "prestavia-backend" });
});

app.use("/auth", authRoutes);
app.use("/marketplace", marketplaceRoutes);
app.use("/contratos", contratoRoutes);
app.use("/pagos", pagosRoutes);
app.use("/admin", adminRoutes);
app.use("/registro", registroRoutes);
app.use("/documentos", documentosRoutes);
app.use("/usuarios", usuariosRoutes);

// Manejador de errores de último recurso — nunca debe filtrar detalles
// internos al cliente.
app.use((err, req, res, next) => {
  console.error("Error no manejado:", err);
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ exito: false, mensaje: "El archivo es demasiado grande. Usa una foto o PDF de menos de 18 MB." });
  }
  res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PrestaVía backend escuchando en el puerto ${PORT}`);
});
