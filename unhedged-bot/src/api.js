// Klien REST Unhedged (https://api.unhedged.gg) berdasarkan API Reference v1.

export class ApiError extends Error {
  constructor(status, body, method, path) {
    const detail = body && typeof body === 'object' ? `${body.error ?? ''} ${body.message ?? ''}`.trim() : String(body ?? '');
    super(`${method} ${path} -> HTTP ${status}${detail ? ': ' + detail : ''}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UnhedgedApi {
  constructor({ baseUrl = 'https://api.unhedged.gg', apiKey = '', timeoutMs = 10000, logger } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.log = logger;
    this.authCalls = []; // timestamp panggilan ber-auth, untuk menjaga batas 60 req/menit
  }

  async throttleAuth() {
    // Batas resmi 60 req/menit untuk endpoint ber-auth; kita jaga di 50 agar aman.
    const LIMIT = 50;
    for (;;) {
      const now = Date.now();
      this.authCalls = this.authCalls.filter((t) => now - t < 60_000);
      if (this.authCalls.length < LIMIT) break;
      await sleep(60_000 - (now - this.authCalls[0]) + 50);
    }
    this.authCalls.push(Date.now());
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{query?: object, body?: any, auth?: boolean, retry?: boolean, throttle?: boolean}} opts
   *   retry=true hanya untuk request yang aman diulang (GET). POST /orders TIDAK punya idempotensi di server.
   */
  async request(method, path, { query, body, auth = false, retry = method === 'GET', throttle = auth } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!this.apiKey) throw new Error(`Endpoint ${path} membutuhkan UNHEDGED_API_KEY`);
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const maxAttempts = retry ? 4 : 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (throttle) await this.throttleAuth();
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        if (res.ok) return data;
        const err = new ApiError(res.status, data, method, path);
        // 429 / 5xx: tunggu lalu ulangi (hanya bila retry diizinkan)
        if (retry && (res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          const wait = 1000 * 2 ** attempt;
          this.log?.warn(`API ${res.status}, coba lagi dalam ${wait}ms`, { path });
          await sleep(wait);
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        lastErr = e;
        if (!retry || attempt >= maxAttempts) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  // ---------- Public ----------
  feed(params = {}) {
    return this.request('GET', '/api/v1/feed', { query: params });
  }
  market(id) {
    return this.request('GET', `/api/v1/markets/${encodeURIComponent(id)}`);
  }
  ctmRounds(params = {}) {
    return this.request('GET', '/api/v1/ctm/rounds', { query: params });
  }
  ctmPriceHistory(roundId) {
    return this.request('GET', `/api/v1/ctm/rounds/${encodeURIComponent(roundId)}/price-history`);
  }

  // ---------- Auth ----------
  me() {
    return this.request('GET', '/api/v1/users/me', { auth: true });
  }
  balance() {
    return this.request('GET', '/api/v1/balance', { auth: true });
  }
  equity() {
    return this.request('GET', '/api/v1/portfolio/me/equity', { auth: true, throttle: false });
  }
  positions(params = {}) {
    return this.request('GET', '/api/v1/portfolio/me/positions', { query: params, auth: true, throttle: false });
  }

  /** Semua open order (mengikuti cursor pagination). */
  async openOrders({ marketId } = {}) {
    const all = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const res = await this.request('GET', '/api/v1/orders', {
        query: { marketId, limit: 500, cursor },
        auth: true,
      });
      all.push(...(res?.orders ?? []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return all;
  }

  placeOrder({ marketId, outcome, side, type = 'Limit', price, quantity }) {
    return this.request('POST', '/api/v1/orders', {
      body: { marketId, outcome, side, type, price, quantity },
      auth: true,
      retry: false,
    });
  }

  cancelOrders(marketId, orderIds) {
    return this.request('DELETE', '/api/v1/orders', { body: { marketId, orderIds }, auth: true, retry: false });
  }

  replaceOrder({ marketId, orderId, price, quantity }) {
    return this.request('POST', '/api/v1/orders/replace', {
      body: { marketId, orderId, price, quantity },
      auth: true,
      retry: false,
    });
  }

  placeBet({ marketId, outcomeIndex, amount, idempotencyKey }) {
    // Endpoint bets punya idempotencyKey, jadi aman diulang.
    return this.request('POST', '/api/v1/bets', {
      body: { marketId, outcomeIndex, amount, idempotencyKey },
      auth: true,
      retry: true,
    });
  }
}
