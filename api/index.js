/* KALPA API. One file, no imports beyond Node's own crypto.
 *
 * On Vercel this is the only server-side code that runs. The platform turns any
 * file under /api into a serverless function. server.js imports the same
 * functions to run the app on a plain Node host.
 *
 * The browser only ever talks to this proxy. The Apps Script address and token
 * stay on the server and never reach the page, and login is verified and
 * remembered here with a signed, HttpOnly cookie.
 *
 * Environment variables (Vercel: Settings, Environment Variables):
 *   KALPA_GAS_URL          Apps Script Web App address ending in /exec   (required)
 *   KALPA_SESSION_SECRET   long random string to sign the session cookie (required)
 *   KALPA_GAS_TOKEN        only when TOKEN in Code.gs is set             (optional)
 */

import crypto from 'node:crypto';

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function config() {
  return {
    gasUrl        : String(env('KALPA_GAS_URL', '')),
    gasToken      : String(env('KALPA_GAS_TOKEN', '')),
    secret        : String(env('KALPA_SESSION_SECRET', '')),
    requireLogin  : ['no', 'tidak', 'false', '0']
                      .indexOf(String(env('KALPA_REQUIRE_LOGIN', 'yes')).toLowerCase()) < 0,
    sessionHours  : Number(env('KALPA_SESSION_HOURS', 12)),
    maxFailed     : Number(env('KALPA_MAX_FAILED_LOGINS', 5)),
    lockoutMinutes: Number(env('KALPA_LOCKOUT_MINUTES', 30)),
    cacheSeconds  : Number(env('KALPA_CACHE_SECONDS', 6)),
    timeoutMs     : Number(env('KALPA_TIMEOUT_SECONDS', 45)) * 1000,
    cookieSecure  : String(env('KALPA_COOKIE_SECURE', 'auto'))
  };
}

const COOKIE_NAME = 'kalpa_sesi';
const WRITE_ACTIONS = ['sync'];
const SESSION_EXPIRED = 'SESI_HABIS Sesi Anda berakhir. Muat ulang halaman lalu masuk lagi.';

/* ── signed session cookie ── */
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

function unsign(cookie, secret, sessionHours) {
  if (!cookie || !secret) return null;
  const [body, mac] = String(cookie).split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!u || (Date.now() / 1000 - Number(u.ts || 0)) > sessionHours * 3600) return null;
    return u;
  } catch (e) { return null; }
}

function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieHeader(value, maxAgeSeconds, secure) {
  return COOKIE_NAME + '=' + encodeURIComponent(value) +
    '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') +
    '; Max-Age=' + maxAgeSeconds;
}

/* ── short-lived memory inside one running copy ── */
const memory = { pull: null, pullUntil: 0, failed: new Map() };

function failedCount(mail, lockoutMinutes) {
  const since = Date.now() - lockoutMinutes * 60000;
  const list = (memory.failed.get(mail) || []).filter(t => t >= since);
  memory.failed.set(mail, list);
  return list.length;
}
function recordFailure(mail) {
  const list = memory.failed.get(mail) || [];
  list.push(Date.now());
  memory.failed.set(mail, list);
}

/* ── call Apps Script ──
 * The Web App answers with a redirect to script.googleusercontent.com, so
 * redirects must be followed. The token belongs to the server, never the
 * browser: whatever the client sent in the token field is dropped first. */
async function callGas(payload, K) {
  if (!K.gasUrl || K.gasUrl.includes('PASTE') || K.gasUrl.includes('GANTI')) {
    throw new Error('Alamat Apps Script belum diset. Isi KALPA_GAS_URL.');
  }
  const body = JSON.stringify(Object.assign({}, payload, { token: K.gasToken }));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), K.timeoutMs);
  let res;
  try {
    res = await fetch(K.gasUrl, {
      method: 'POST', redirect: 'follow', signal: abort.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError'
      ? 'Apps Script tidak menjawab dalam ' + Math.round(K.timeoutMs / 1000) + ' detik.'
      : 'Apps Script tidak bisa dihubungi.');
  } finally { clearTimeout(timer); }

  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) {
    throw new Error('Apps Script membalas bukan JSON (HTTP ' + res.status +
      '). Cek setelan akses deployment (harus Anyone) dan alamat /exec.');
  }
}

/* The password column must never reach the browser. */
function stripPasswords(out) {
  if (out && Array.isArray(out.akun)) {
    out.akun = out.akun.map(a => {
      if (!a || typeof a !== 'object' || !('sandi' in a)) return a;
      const copy = Object.assign({}, a);
      delete copy.sandi;
      return copy;
    });
  }
  return out;
}

function emptySnapshot() {
  return { ok: true, rev: '0', syncedAt: new Date().toISOString(), data: [], akun: [] };
}

export async function handleRequest(req) {
  const K = config();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  const secure = K.cookieSecure === 'auto' ? req.secure !== false : K.cookieSecure !== 'false';
  const reply = (obj, extra) => ({
    status: 200,
    headers: Object.assign({}, headers, extra || {}),
    body: JSON.stringify(obj)
  });

  if (req.method === 'OPTIONS') return { status: 204, headers, body: '' };

  try {
    if (!K.secret) {
      return reply({ ok: false, error: 'KALPA_SESSION_SECRET belum diset, jadi tidak ada yang bisa masuk.' });
    }

    const input = Object.assign({}, req.query || {}, req.body || {});
    const action = String(input.action || '').trim();
    if (!action) return reply({ ok: false, error: 'Tidak ada action' });

    /* ── diagnostics: {"action":"diag"} ── */
    if (action === 'diag') {
      const raw = process.env.KALPA_GAS_URL || '';
      const info = {
        ok: true, node: process.version,
        sessionSecretSet: !!K.secret, gasTokenSet: !!K.gasToken,
        gasUrlSet: !!raw, gasUrlHasWhitespace: /\s/.test(raw), gasUrlHasQuotes: /["']/.test(raw)
      };
      try {
        const u = new URL(K.gasUrl);
        info.parsed = true; info.host = u.host; info.endsWithExec = u.pathname.endsWith('/exec');
      } catch (e) { info.parsed = false; info.parseError = String(e && e.message || e); }
      if (info.parsed) {
        const t0 = Date.now();
        try {
          const r = await fetch(K.gasUrl, {
            method: 'POST', redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'ping', token: K.gasToken })
          });
          const text = await r.text();
          info.fetchStatus = r.status; info.fetchMs = Date.now() - t0;
          info.replyLooksLikeJson = text.trim().startsWith('{');
          info.replyFirst80 = text.trim().slice(0, 80);
        } catch (e) {
          info.fetchMs = Date.now() - t0;
          info.fetchError = String(e && e.name || '') + ': ' + String(e && e.message || e);
        }
      }
      return reply(info);
    }

    const user = unsign(readCookie(req.cookie, COOKIE_NAME), K.secret, K.sessionHours);

    /* ── who am I: page uses this on load to decide login vs selector ── */
    if (action === 'me') {
      return reply({ ok: true, user: user ? { mail: user.mail, nama: user.nama, peran: user.peran } : null });
    }

    /* ── sign in ── */
    if (action === 'login') {
      const mail = String(input.mail || input.email || '').trim().toLowerCase();
      if (!mail) return reply({ ok: false, error: 'Surel dan kata sandi wajib diisi.' });
      if (failedCount(mail, K.lockoutMinutes) >= K.maxFailed) {
        return reply({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi setelah ' + K.lockoutMinutes + ' menit.' });
      }
      const out = await callGas(
        { action: 'login', email: mail, sandi: String(input.sandi || input.pass || '') }, K);
      if (!out || !out.ok) {
        recordFailure(mail);
        return reply({ ok: false, error: String((out && out.error) || 'Surel atau kata sandi tidak cocok.') });
      }
      memory.failed.delete(mail);
      const acc = out.akun || { email: mail };
      const cookie = cookieHeader(sign({
        mail : String(acc.email || mail).toLowerCase(),
        nama : String(acc.nama || ''),
        peran: String(acc.peran || ''),
        ts   : Math.floor(Date.now() / 1000)
      }, K.secret), K.sessionHours * 3600, secure);
      return reply({ ok: true, akun: { email: acc.email, nama: acc.nama, peran: acc.peran } },
        { 'Set-Cookie': cookie });
    }

    if (action === 'logout') {
      return reply({ ok: true }, { 'Set-Cookie': cookieHeader('', 0, secure) });
    }

    /* ── gate ── */
    if (K.requireLogin && !user) {
      if (action === 'pull') return reply(emptySnapshot());
      if (action === 'ping') return reply({ ok: true });
      return reply({ ok: false, error: SESSION_EXPIRED });
    }

    /* ── read ── */
    if (action === 'pull') {
      if (K.cacheSeconds > 0 && memory.pull && Date.now() < memory.pullUntil) return reply(memory.pull);
      const out = stripPasswords(await callGas({ action: 'pull' }, K));
      if (K.cacheSeconds > 0 && out && out.ok) {
        memory.pull = out; memory.pullUntil = Date.now() + K.cacheSeconds * 1000;
      }
      return reply(out);
    }

    /* ── write ── */
    if (WRITE_ACTIONS.includes(action)) {
      delete input.token;
      const out = stripPasswords(await callGas(input, K));
      memory.pull = null; memory.pullUntil = 0;
      if (out && out.ok) { memory.pull = out; memory.pullUntil = Date.now() + K.cacheSeconds * 1000; }
      return reply(out);
    }

    delete input.token;
    return reply(stripPasswords(await callGas(input, K)));

  } catch (e) {
    console.error('[kalpa] ' + (e && e.message ? e.message : e));
    return reply({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

/* ── helpers for adapters ── */
export async function readJsonBody(stream) {
  if (stream && stream.body && typeof stream.body === 'object' && !Buffer.isBuffer(stream.body)) {
    return stream.body;
  }
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return {}; }
}

export async function nodeHandler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const query = Object.fromEntries(url.searchParams.entries());
  const body = req.method === 'POST' ? await readJsonBody(req) : {};
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const out = await handleRequest({
    method: req.method, query, body,
    cookie: req.headers.cookie || '',
    secure: proto ? proto === 'https' : (req.socket && req.socket.encrypted === true)
  });
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.statusCode = out.status;
  res.end(out.body);
}

/* ── platform entry point (Vercel) ── */
export default async function handler(req, res) {
  try {
    await nodeHandler(req, res);
  } catch (e) {
    console.error('[kalpa] ' + (e && e.message ? e.message : e));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: 'Internal error' }));
  }
}
