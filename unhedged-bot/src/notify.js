// Notifikasi Telegram (tanpa dependensi). Token & chat id hanya dibaca dari .env.
// Pesan dikirim lewat antrean: maksimal ~1 pesan/detik (batas Telegram), error tidak pernah
// menghentikan bot.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

export class Telegram {
  /**
   * @param {{token?: string, chatId?: string, log?: any, fetchImpl?: Function}} opts
   */
  constructor({ token, chatId, log, fetchImpl } = {}) {
    this.token = token || '';
    this.chatId = chatId || '';
    this.log = log;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.queue = [];
    this.running = false;
    this.failures = 0;
    this.lastErrorLog = 0;
  }

  get enabled() {
    return !!(this.token && this.chatId);
  }

  async call(method, body) {
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(`Telegram ${method}: ${data.description ?? 'HTTP ' + res.status}`);
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  /** Masukkan pesan (HTML) ke antrean; tidak menunggu terkirim. */
  send(html) {
    if (!this.enabled) return;
    this.queue.push(html);
    if (this.queue.length > 50) this.queue.shift(); // jangan menumpuk tanpa batas
    if (!this.running) this.drain();
  }

  async drain() {
    this.running = true;
    while (this.queue.length) {
      const text = this.queue[0];
      try {
        await this.call('sendMessage', { chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
        this.queue.shift();
        this.failures = 0;
        await sleep(1100);
      } catch (e) {
        this.failures++;
        if (Date.now() - this.lastErrorLog > 60_000) {
          this.lastErrorLog = Date.now();
          this.log?.warn(`Notifikasi Telegram gagal: ${e.message}`);
        }
        if (this.failures >= 3) {
          this.queue.shift(); // buang pesan yang terus gagal
          this.failures = 0;
        }
        await sleep(e.retryAfter ? e.retryAfter * 1000 : 5000);
      }
    }
    this.running = false;
  }

  /** Tunggu antrean kosong (dipakai saat bot berhenti). */
  async flush(timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    while ((this.queue.length || this.running) && Date.now() < until) await sleep(100);
  }
}
