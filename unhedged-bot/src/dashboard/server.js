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
  // Mode admin (tombol kontrol) hanya aktif bila password cukup kuat
  const adminEnabled = !!password && password.length >= 8;
  if (password && !adminEnabled) log.warn('DASHBOARD_PASSWORD kurang dari 8 karakter: halaman /admin (tombol kontrol) dimatikan.');
  // Tampilan publik tanpa login (hanya melihat). Tanpa password, tampilan publik selalu aktif.
  const publicView = cfg.dashboardPublicView !== false || !adminEnabled;

  const failures = new Map(); // ip -> {count, until}
  const clients = new Map(); // res -> admin?

  function checkAuth(req, res) {
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

  /** Data untuk tampilan publik tidak memuat nama akun & tidak bisa mengontrol bot. */
  function viewFor(admin) {
    const s = bot.snapshot();
    s.canControl = admin;
    s.adminAvailable = adminEnabled;
    if (!admin) s.account = { ...s.account, username: null };
    return s;
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

      // /admin/... = halaman dengan tombol kontrol (wajib login); selain itu = tampilan publik
      let p = url.pathname;
      const admin = p === '/admin' || p.startsWith('/admin/');
      if (admin) {
        p = p.slice('/admin'.length) || '/';
        if (!adminEnabled) {
          res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
          res.end('Halaman admin nonaktif. Isi DASHBOARD_PASSWORD (min. 8 karakter) di .env lalu restart bot.');
          return;
        }
        if (!checkAuth(req, res)) return;
      } else if (!publicView && !checkAuth(req, res)) {
        return;
      }

      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache' });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && p === '/api/state') {
        sendJson(res, 200, viewFor(admin));
        return;
      }

      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        clients.set(res, admin);
        res.write(`data: ${JSON.stringify(viewFor(admin))}\n\n`);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'POST' && p === '/api/control') {
        if (!admin) {
          sendJson(res, 403, { error: 'Kontrol hanya bisa dari halaman /admin' });
          return;
        }
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
        sendJson(res, 200, { ok: true, state: viewFor(true) });
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
    const cache = {};
    for (const [c, admin] of clients) {
      cache[admin] ??= `data: ${JSON.stringify(viewFor(admin))}\n\n`;
      c.write(cache[admin]);
    }
  }, 2000);
  timer.unref();

  server.on('error', (e) => log.error(`Dashboard gagal listen di ${host}:${port}: ${e.message}`));
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'IP_VPS_ANDA' : host;
    log.info(
      `Dashboard aktif: http://${shown}:${port}${publicView ? ' (tanpa login, hanya melihat)' : ' (wajib login)'}` +
        (adminEnabled ? ` | kontrol: http://${shown}:${port}/admin (login: ${user})` : ' | tombol kontrol nonaktif (DASHBOARD_PASSWORD kosong)'),
    );
  });
  return server;
}
