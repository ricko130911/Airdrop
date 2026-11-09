// Server dashboard web (tanpa dependensi): halaman statis + API JSON + Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {{bot: import('../bot.js').Bot, cfg: any, log: any}} deps
 */
export function startDashboard({ bot, cfg, log }) {
  const { dashboardHost: host, dashboardPort: port, dashboardUser: user, dashboardPassword: password } = cfg;
  if (!isLoopback(host) && (!password || password.length < 8)) {
    log.error(
      `Dashboard TIDAK dijalankan: DASHBOARD_PASSWORD wajib diisi (min. 8 karakter) karena dashboard dibuka di ${host}:${port}.`,
    );
    return null;
  }

  const failures = new Map(); // ip -> {count, until}
  const clients = new Set();

  function checkAuth(req, res) {
    if (!password) return true;
    const ip = req.socket.remoteAddress ?? '?';
    const f = failures.get(ip);
    if (f && f.count >= 10 && Date.now() < f.until) {
      res.writeHead(429, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
      res.end('Terlalu banyak percobaan login. Coba lagi nanti.');
      return false;
    }
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (m) {
      const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      const okUser = safeEqual(u, user);
      const okPass = safeEqual(rest.join(':'), password);
      if (okUser && okPass) {
        failures.delete(ip);
        return true;
      }
      const cur = failures.get(ip) ?? { count: 0, until: 0 };
      cur.count++;
      cur.until = Date.now() + 15 * 60_000;
      failures.set(ip, cur);
      log.warn(`Login dashboard gagal dari ${ip} (${cur.count}x)`);
    }
    res.writeHead(401, {
      ...SECURITY_HEADERS,
      'www-authenticate': 'Basic realm="Unhedged Bot", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    res.end('Login diperlukan');
    return false;
  }

  function sendJson(res, status, data) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req, limit = 4096) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('body terlalu besar');
      chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (!checkAuth(req, res)) return;

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache' });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, bot.snapshot());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        clients.add(res);
        res.write(`data: ${JSON.stringify(bot.snapshot())}\n\n`);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/control') {
        // Header khusus mencegah CSRF dari situs lain (browser tidak bisa mengirimnya lintas origin tanpa izin CORS)
        if (req.headers['x-requested-with'] !== 'dashboard') {
          sendJson(res, 403, { error: 'forbidden' });
          return;
        }
        const { action } = await readBody(req);
        if (action === 'pause') await bot.setPaused(true);
        else if (action === 'resume') await bot.setPaused(false);
        else if (action === 'cancel-all') await bot.cancelAll();
        else if (action === 'release-halt') bot.resumeAfterHalt();
        else {
          sendJson(res, 400, { error: 'aksi tidak dikenal' });
          return;
        }
        sendJson(res, 200, { ok: true, state: bot.snapshot() });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      log.error(`Dashboard error: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  const timer = setInterval(() => {
    if (!clients.size) return;
    const payload = `data: ${JSON.stringify(bot.snapshot())}\n\n`;
    for (const c of clients) c.write(payload);
  }, 2000);
  timer.unref();

  server.on('error', (e) => log.error(`Dashboard gagal listen di ${host}:${port}: ${e.message}`));
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'IP_VPS_ANDA' : host;
    log.info(`Dashboard aktif: http://${shown}:${port}  (login: ${password ? user : 'tanpa password, hanya lokal'})`);
  });
  return server;
}
