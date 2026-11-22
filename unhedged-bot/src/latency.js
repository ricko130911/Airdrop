// Pengukur latency VPS -> server Unhedged.
// "Ping" = waktu jabat tangan TCP ke port 443 (sama dengan "connect time" curl),
// tanpa waktu DNS. Tidak butuh root (beda dengan ping ICMP).
import net from 'node:net';
import dns from 'node:dns/promises';

/** Waktu connect TCP (ms) ke host:port, atau null bila gagal/timeout. */
export async function tcpPing(host, port = 443, timeoutMs = 3000) {
  let address = host;
  try {
    if (!net.isIP(host)) address = (await dns.lookup(host)).address;
  } catch {
    return { ms: null, address: null, error: 'DNS gagal' };
  }
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host: address, port });
    let settled = false;
    const done = (ms, error = null) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ms, address, error });
    };
    sock.setTimeout(timeoutMs, () => done(null, 'timeout'));
    sock.once('connect', () => done(Number(process.hrtime.bigint() - t0) / 1e6));
    sock.once('error', (e) => done(null, e.code ?? e.message));
  });
}

/** Mengukur ping secara berkala dan menyimpan ringkasannya untuk dashboard. */
export class LatencyMonitor {
  constructor({ url = 'https://api.unhedged.gg', intervalMs = 15_000, keep = 40, ping = tcpPing, log } = {}) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
    this.intervalMs = intervalMs;
    this.keep = keep;
    this.ping = ping;
    this.log = log;
    this.samples = []; // { at, ms|null }
    this.address = null;
    this.lastError = null;
    this.timer = null;
  }

  async sample() {
    const r = await this.ping(this.host, this.port).catch((e) => ({ ms: null, error: e.message }));
    if (r.address) this.address = r.address;
    this.lastError = r.ms === null ? (r.error ?? 'gagal') : null;
    this.samples.push({ at: Date.now(), ms: r.ms });
    if (this.samples.length > this.keep) this.samples.shift();
    return r;
  }

  start() {
    if (this.timer) return;
    this.sample().catch(() => {});
    this.timer = setInterval(() => this.sample().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    const ok = this.samples.filter((s) => s.ms !== null).map((s) => s.ms);
    const last = this.samples.at(-1) ?? null;
    const sorted = [...ok].sort((a, b) => a - b);
    return {
      host: this.host,
      address: this.address,
      lastMs: last?.ms ?? null,
      at: last?.at ?? null,
      avgMs: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
      minMs: sorted[0] ?? null,
      maxMs: sorted.at(-1) ?? null,
      lossPct: this.samples.length ? (100 * (this.samples.length - ok.length)) / this.samples.length : null,
      samples: this.samples.length,
      error: this.lastError,
    };
  }
}
