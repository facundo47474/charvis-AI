const https = require('https');
const http = require('http');

function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  
  if (!url) {
    console.warn("[KeepAlive] No se encontró RENDER_EXTERNAL_URL o APP_URL. El auto-ping está desactivado.");
    return;
  }

  const pingInterval = 14 * 60 * 1000; // 14 minutos

  console.log(`[KeepAlive] Auto-ping configurado cada 14 minutos hacia: ${url}/api/ping`);

  setInterval(() => {
    const targetUrl = `${url.replace(/\/$/, '')}/api/ping`;
    const protocol = targetUrl.startsWith('https') ? https : http;

    protocol.get(targetUrl, (res) => {
      console.log(`[KeepAlive] Ping ejecutado. Estado: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error(`[KeepAlive] Error en auto-ping: ${err.message}`);
    });
  }, pingInterval);
}

module.exports = startKeepAlive;
