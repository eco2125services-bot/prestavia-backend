/**
 * PrestaVía — Backend — src/jobs/cron-diario.js
 *
 * Este archivo NO es parte del web service (server.js) — es el comando
 * que ejecuta un **Render Cron Job** aparte, una vez al día. Corre, hace
 * su trabajo, imprime un resumen, y termina el proceso (exit code 0 si
 * todo salió bien, 1 si algo falló) — así es como Render sabe si la
 * corrida fue exitosa o no.
 *
 * Ver README ("Módulo 7") para la configuración exacta del Cron Job en
 * Render (comando, horario, variables de entorno).
 */
require("dotenv").config();
const { pool } = require("../db");
const { evaluarVencimientosSuscripcion, evaluarCuotasVencidas } = require("../services/cron.service");

async function main() {
  const inicio = new Date();
  console.log(`🕐 Cron diario de PrestaVía iniciado: ${inicio.toISOString()}`);

  const resumenSuscripciones = await evaluarVencimientosSuscripcion();
  console.log("📋 Vencimientos de suscripción:", JSON.stringify(resumenSuscripciones));

  const resumenMora = await evaluarCuotasVencidas();
  console.log("📋 Cuotas en mora:", JSON.stringify(resumenMora));

  const huboErrores = resumenSuscripciones.errores > 0 || resumenMora.errores > 0;
  console.log(huboErrores ? "⚠️ Cron terminado con errores parciales (ver arriba)." : "✅ Cron diario completado sin errores.");

  return huboErrores;
}

main()
  .then((huboErrores) => {
    pool.end().finally(() => process.exit(huboErrores ? 1 : 0));
  })
  .catch((error) => {
    console.error("❌ Error crítico en el cron diario:", error);
    pool.end().finally(() => process.exit(1));
  });
