require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const authRoutes = require("./routes/auth.routes");

const app = express();

// Render (y la mayoría de plataformas cloud) ponen la app detrás de un
// proxy inverso, que agrega el header X-Forwarded-For con la IP real del
// visitante. Sin esto, express-rate-limit no puede confiar en esa IP para
// contar intentos de login por persona, y tira una advertencia en los logs.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors()); // en producción, restringir a los dominios reales del frontend
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, servicio: "prestavia-backend" });
});

app.use("/auth", authRoutes);

// Manejador de errores de último recurso — nunca debe filtrar detalles
// internos al cliente.
app.use((err, req, res, next) => {
  console.error("Error no manejado:", err);
  res.status(500).json({ exito: false, mensaje: "Error interno del servidor." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PrestaVía backend escuchando en el puerto ${PORT}`);
});
