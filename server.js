#!/usr/bin/env node
/* KALPA - standalone server.
 *
 * One Node process that serves the app and answers /api, no framework, no
 * dependency beyond Node itself. Runs unchanged on a VPS, Docker, Render,
 * Railway, Fly.io, Cloud Run, or cPanel/Plesk with Node support.
 *
 *     npm start        # reads .env if present, then listens
 *
 * On Vercel this file is not used; api/index.js is the function and index.html
 * is served statically. Settings come from the environment or a .env file.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeHandler, config } from './api/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/* Only these files may be served from the project root. Everything else,
   including .env and api/, is unreachable over HTTP. Deliberate. */
const ROOT_FILES = new Set([
  'index.html', 'sw.js', 'manifest.json', 'manifest.webmanifest',
  'favicon.ico', 'robots.txt', 'icon-192.png', 'icon-512.png', 'icon-180.png'
]);

function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type }, extra || {}));
  res.end(body);
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(res, 200, type, data, { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { return send(res, 400, 'text/plain; charset=utf-8', 'Bad request'); }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try { return await nodeHandler(req, res); }
    catch (e) {
      console.error('[kalpa] ' + (e && e.message ? e.message : e));
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ ok: false, error: 'Internal error' }), { 'Cache-Control': 'no-store' });
    }
  }

  if (pathname === '/healthz') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));

  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (name.startsWith('.') || name.includes('/.')) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  if (ROOT_FILES.has(name)) return serveFile(res, path.join(ROOT, name));

  /* Unknown paths without an extension get the app shell (client-side routing). */
  if (!path.extname(name)) return serveFile(res, path.join(ROOT, 'index.html'));
  return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
});

server.listen(PORT, HOST, () => {
  const K = config();
  console.log('KALPA listening on http://' + HOST + ':' + PORT);
  if (!K.secret) console.warn('WARNING: KALPA_SESSION_SECRET kosong. Tidak ada yang bisa masuk.');
  if (!K.gasUrl) console.warn('WARNING: KALPA_GAS_URL kosong. Tidak ada sumber data.');
});
