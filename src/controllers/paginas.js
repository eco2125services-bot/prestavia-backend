/**
 * Páginas HTML mínimas que sirve el propio backend — las que se abren desde
 * un enlace de correo (confirmar cuenta, restablecer contraseña). Quien las
 * abre es el navegador de la persona, no el frontend de la app, así que
 * responden HTML y no JSON.
 */

function escapeHtml(s) {
  return (s === null || s === undefined ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function paginaHtml({ titulo, mensaje, ok }) {
  const color = ok ? "#1f6f4a" : "#b3261e";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(titulo)} — PrestaVía</title>
    <style>body{font-family:system-ui,sans-serif;background:#0d1b14;color:#eef5f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
    .card{max-width:440px;background:#15271d;border:1px solid #2a4433;border-radius:12px;padding:28px;text-align:center;}
    h1{font-size:20px;color:${color};margin:0 0 14px;}
    .clave{font-family:monospace;font-size:18px;background:#0d1b14;border:1px solid #2a4433;border-radius:6px;padding:10px;margin:14px 0;word-break:break-all;user-select:all;}
    a.btn,button.btn{display:inline-block;margin-top:14px;padding:10px 20px;background:#1f6f4a;color:#fff;border:0;border-radius:6px;text-decoration:none;font-size:15px;cursor:pointer;}
    p{line-height:1.5;}</style></head>
    <body><div class="card"><h1>${escapeHtml(titulo)}</h1>${mensaje}</div></body></html>`;
}

/** Formulario con un solo botón que hace POST al mismo sitio, llevando el token oculto. */
function formularioConfirmar({ accion, token, textoBoton }) {
  return `<form method="POST" action="${escapeHtml(accion)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button class="btn" type="submit">${escapeHtml(textoBoton)}</button></form>`;
}

/** Los tokens que generamos son 32 bytes en hexadecimal: se rechaza cualquier otra forma antes de tocar la base. */
function tokenConFormaValida(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
}

module.exports = { escapeHtml, paginaHtml, formularioConfirmar, tokenConFormaValida };
