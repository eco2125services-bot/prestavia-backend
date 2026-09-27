/**
 * Reemplaza el cálculo de calcularAmortizacion() de Amortizacion.gs
 * (sistema francés de cuota fija).
 */
function calcularAmortizacion(monto, plazoMeses, tasaAnualPorcentaje) {
  const tasaMensual = tasaAnualPorcentaje / 100 / 12;
  let cuota;

  if (tasaMensual === 0) {
    cuota = monto / plazoMeses;
  } else {
    cuota = (monto * tasaMensual) / (1 - Math.pow(1 + tasaMensual, -plazoMeses));
  }

  cuota = parseFloat(cuota.toFixed(2));
  const totalPagar = parseFloat((cuota * plazoMeses).toFixed(2));

  return { cuotaMensual: cuota, totalPagar };
}

module.exports = { calcularAmortizacion };
