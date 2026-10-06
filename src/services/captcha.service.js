/**
 * CAPTCHA (Cloudflare Turnstile, gratis) — informe de seguridad #5.
 * Si TURNSTILE_SECRET no está configurada, el control queda DESACTIVADO
 * (la plataforma funciona igual que antes). Con la variable puesta, las
 * rutas públicas sensibles exigen un token válido, de un solo uso.
 */
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";
const URL_VERIFICACION = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function captchaActivo() {
  return !!TURNSTILE_SECRET;
}

async function verificarCaptcha(token, ip) {
  if (!captchaActivo()) return { ok: true };
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) {
    return { ok: false, motivo: "falta" };
  }
  try {
    const cuerpo = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip) cuerpo.set("remoteip", ip);
    const r = await fetch(URL_VERIFICACION, { method: "POST", body: cuerpo, signal: AbortSignal.timeout(8000) });
    const datos = await r.json();
    return datos && datos.success ? { ok: true } : { ok: false, motivo: "invalido" };
  } catch (error) {
    console.error("Error verificando CAPTCHA:", error.message);
    return { ok: false, motivo: "servicio" };
  }
}

/** Middleware: exige el CAPTCHA (campo captchaToken del body) y lo quita del body. */
async function requiereCaptcha(req, res, next) {
  const token = req.body && req.body.captchaToken;
  if (req.body) delete req.body.captchaToken;
  const r = await verificarCaptcha(token, req.ip);
  if (r.ok) return next();
  const mensaje =
    r.motivo === "servicio"
      ? "No pudimos verificar que eres una persona. Intenta de nuevo en un momento."
      : "Confirma que no eres un robot (espera a que el recuadro de verificación termine) e intenta de nuevo.";
  return res.status(400).json({ exito: false, mensaje });
}

module.exports = { captchaActivo, verificarCaptcha, requiereCaptcha };
