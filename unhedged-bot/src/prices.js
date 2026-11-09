// Sumber harga aset: Binance -> Coinbase -> data harga Unhedged sendiri (CTM price-history).
// Catatan: Unhedged menyelesaikan market dengan oracle-nya sendiri. Harga bursa
// bisa sedikit berbeda, sehingga model memakai SIGMA_MULTIPLIER dan MIN_EDGE sebagai bantalan.

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const COINBASE_PRODUCT = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD' };

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export class PriceFeed {
  /**
   * @param {{api: import('./api.js').UnhedgedApi, logger?: any}} opts
   */
  constructor({ api, logger }) {
    this.api = api;
    this.log = logger;
    this.cache = new Map(); // asset -> {at, data}
    this.priceAtCache = new Map(); // `${asset}:${t}` -> number
    this.samples = new Map(); // asset -> [{t,p}] harga yang pernah diamati (cadangan)
    this.binanceHost = null;
    this.ctmRoundCache = new Map(); // asset -> {at, roundId}
  }

  sourcesFor(asset) {
    const list = [];
    if (BINANCE_SYMBOL[asset]) list.push('binance');
    if (COINBASE_PRODUCT[asset]) list.push('coinbase');
    list.push('unhedged-ctm');
    if (asset === 'CC') list.push('unhedged-balance');
    return list;
  }

  /**
   * Deret harga terbaru + harga spot.
   * @returns {Promise<{series:{t:number,p:number}[], spot:number, source:string}|null>}
   */
  async series(asset, { maxAgeMs = 3000 } = {}) {
    const cached = this.cache.get(asset);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.data;
    let data = null;
    for (const src of this.sourcesFor(asset)) {
      try {
        data = await this.fetchSeries(src, asset);
        if (data && data.series.length >= 2) break;
        data = null;
      } catch (e) {
        this.log?.debug(`sumber harga ${src} gagal untuk ${asset}: ${e.message}`);
      }
    }
    if (data) {
      this.recordSample(asset, { t: Date.now(), p: data.spot });
      this.cache.set(asset, { at: Date.now(), data });
    } else {
      // Pakai sampel yang pernah diamati bila semua sumber gagal
      const s = this.samples.get(asset) ?? [];
      if (s.length >= 3) data = { series: s, spot: s[s.length - 1].p, source: 'samples' };
    }
    return data;
  }

  recordSample(asset, pt) {
    const arr = this.samples.get(asset) ?? [];
    arr.push(pt);
    const cutoff = Date.now() - 3 * 3600_000;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    this.samples.set(asset, arr);
  }

  async fetchSeries(src, asset) {
    switch (src) {
      case 'binance':
        return this.binanceSeries(asset);
      case 'coinbase':
        return this.coinbaseSeries(asset);
      case 'unhedged-ctm':
        return this.unhedgedCtmSeries(asset);
      case 'unhedged-balance':
        return this.unhedgedBalanceSeries(asset);
      default:
        return null;
    }
  }

  async binanceGet(pathAndQuery) {
    const hosts = this.binanceHost ? [this.binanceHost, ...BINANCE_HOSTS.filter((h) => h !== this.binanceHost)] : BINANCE_HOSTS;
    let lastErr;
    for (const h of hosts) {
      try {
        const data = await getJson(h + pathAndQuery);
        this.binanceHost = h;
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async binanceSeries(asset) {
    const symbol = BINANCE_SYMBOL[asset];
    const rows = await this.binanceGet(`/api/v3/klines?symbol=${symbol}&interval=1m&limit=120`);
    // [openTime, open, high, low, close, ...]
    const series = rows.map((r) => ({ t: r[0], p: Number(r[1]) }));
    const spot = Number(rows[rows.length - 1][4]);
    series.push({ t: Date.now(), p: spot });
    return { series, spot, source: 'binance' };
  }

  async coinbaseSeries(asset) {
    const product = COINBASE_PRODUCT[asset];
    const rows = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`);
    // [time(detik), low, high, open, close, volume], terbaru di depan
    const sorted = rows.slice(0, 120).sort((a, b) => a[0] - b[0]);
    const series = sorted.map((r) => ({ t: r[0] * 1000, p: Number(r[3]) }));
    const spot = Number(sorted[sorted.length - 1][4]);
    series.push({ t: Date.now(), p: spot });
    return { series, spot, source: 'coinbase' };
  }

  /** Cari ronde CTM aktif dengan aset ini (pilih yang paling lama berjalan = histori terpanjang). */
  async ctmRoundFor(asset) {
    const c = this.ctmRoundCache.get(asset);
    if (c && Date.now() - c.at < 60_000) return c.roundId;
    const res = await this.api.ctmRounds({ asset, status: 'OPEN,HEATMAP,LOCKED', limit: 50 });
    const rounds = (res?.rounds ?? []).filter((r) => String(r.asset).toUpperCase() === asset);
    rounds.sort((a, b) => Date.parse(a.openStartsAt ?? 0) - Date.parse(b.openStartsAt ?? 0));
    const roundId = rounds[0]?.id ?? null;
    this.ctmRoundCache.set(asset, { at: Date.now(), roundId });
    return roundId;
  }

  async unhedgedCtmSeries(asset) {
    const roundId = await this.ctmRoundFor(asset);
    if (!roundId) return null;
    const res = await this.api.ctmPriceHistory(roundId);
    const series = (res?.prices ?? [])
      .map((x) => ({ t: Number(x.timestamp), p: Number(x.price) }))
      .filter((x) => x.p > 0 && Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
    if (series.length < 2) return null;
    // Gabungkan dengan sampel internal agar histori lebih panjang
    const merged = mergeSeries(this.samples.get(asset) ?? [], series);
    return { series: merged, spot: series[series.length - 1].p, source: 'unhedged-ctm' };
  }

  async unhedgedBalanceSeries(asset) {
    if (asset !== 'CC' || !this.api.apiKey) return null;
    const res = await this.api.balance();
    const p = Number(res?.ccPriceUsd);
    if (!(p > 0)) return null;
    this.recordSample(asset, { t: Date.now(), p });
    const s = this.samples.get(asset);
    return s.length >= 2 ? { series: s, spot: p, source: 'unhedged-balance' } : null;
  }

  /**
   * Harga pada waktu tertentu (dipakai sebagai harga acuan saat window dibuka).
   * @returns {Promise<number|null>}
   */
  async priceAt(asset, tMs) {
    if (tMs > Date.now()) return null;
    const key = `${asset}:${tMs}`;
    if (this.priceAtCache.has(key)) return this.priceAtCache.get(key);
    let price = null;
    try {
      if (BINANCE_SYMBOL[asset]) {
        // Kline 1 detik: harga open pada detik window dimulai
        const rows = await this.binanceGet(`/api/v3/klines?symbol=${BINANCE_SYMBOL[asset]}&interval=1s&startTime=${tMs}&limit=1`);
        if (rows?.length && Math.abs(rows[0][0] - tMs) <= 2000) price = Number(rows[0][1]);
      }
    } catch (e) {
      this.log?.debug(`priceAt binance gagal: ${e.message}`);
    }
    if (price === null) {
      // Cadangan: titik terdekat di deret harga yang ada (maks selisih 60 detik)
      const data = await this.series(asset);
      price = nearest(data?.series ?? [], tMs, 60_000);
    }
    // Hanya cache bila window sudah lewat beberapa detik (data final)
    if (price !== null && Date.now() - tMs > 5000) this.priceAtCache.set(key, price);
    return price;
  }
}

export function nearest(series, tMs, maxDiffMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const pt of series) {
    const d = Math.abs(pt.t - tMs);
    if (d < bestDiff) {
      bestDiff = d;
      best = pt.p;
    }
  }
  return bestDiff <= maxDiffMs ? best : null;
}

function mergeSeries(a, b) {
  const map = new Map();
  for (const pt of [...a, ...b]) map.set(pt.t, pt);
  return [...map.values()].sort((x, y) => x.t - y.t);
}
