/**
 * PrestaVía — Backend — Pool de conexión a Postgres (Neon).
 *
 * Se usa el pooler de Neon (el DATABASE_URL con "-pooler" en el host),
 * que ya trae PgBouncer integrado — por eso aquí NO se necesita un pool
 * grande de conexiones propias; unas pocas alcanzan porque Neon absorbe
 * el resto detrás.
 */
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("Falta la variable de entorno DATABASE_URL");
}

// Neon exige SSL (sslmode=require en la connection string); un Postgres
// local de desarrollo normalmente no tiene SSL habilitado. En vez de forzar
// SSL siempre (lo que rompería correr esto en local), se detecta según la
// propia connection string.
const requiereSSL = /sslmode=require/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: requiereSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  // Un error en un cliente inactivo del pool no debe tumbar el proceso.
  console.error("Error inesperado en el pool de Postgres:", err);
});

module.exports = { pool };
