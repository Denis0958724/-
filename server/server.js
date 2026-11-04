// Сервер «Мікро-консультацій». Запуск: npm start (або node server.js) у теці server.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

// Налаштування з файлу .env поруч (без сторонніх бібліотек). Змінні середовища мають перевагу.
const ENV = path.join(__dirname, '.env');
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const api = require('./lib/api');
const notify = require('./lib/notify');
const mail = require('./lib/mail');
const search = require('./ai/search');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PAGE = process.env.PAGE_FILE || path.join(__dirname, '..', 'prototype.html');

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) return api.handle(req, res, url);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/prototype.html')) {
    try {
      const html = fs.readFileSync(PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не знайдено prototype.html поруч з текою server'); }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не знайдено');
});

server.listen(PORT, HOST, async () => {
  console.log(`Мікро-консультації: http://localhost:${PORT}`);
  console.log(`Пошта: ${await mail.verify()}${mail.MODE === 'off' ? ' (листи не відправляються, див. README, розділ «Пошта»)' : ''}`);
  console.log(`Модель пошуку: ${search.info.features} ознак, точність на тестовому наборі ${Math.round(search.info.testAccuracy * 100)}%`);
});
if (process.env.TEST_MODE !== '1') {
  setInterval(() => notify.run().catch(e => console.error('[notify]', e.name)), 60000).unref();
  setInterval(api.cleanup, 3600000).unref();
  api.cleanup();
}
process.on('SIGINT', () => { server.close(); process.exit(0); });
