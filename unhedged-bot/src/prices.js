// Sumber harga aset, mengikuti sumber resolusi resmi tiap market Unhedged
// (autoResolution.resolverConfig.venue + symbol). Contoh: BTC -> binance BTCUSDT (candle 1 detik).
// Venue yang didukung: binance, mexc, bybit, okx, gate, kucoin (+ coinbase & data Unhedged sebagai cadangan).

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
const BYBIT_HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
const DEFAULT_SOURCES = {
  BTC: { venue: 'binance', symbol: 'BTCUSDT', asset: 'BTC', quote: 'USDT' },
  ETH: { venue: 'binance', symbol: 'ETHUSDT', asset: 'ETH', quote: 'USDT' },
  SOL: { venue: 'binance', symbol: 'SOLUSDT', asset: 'SOL', quote: 'USDT' },
};
const COINBASE_PRODUCT = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD' };

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function baseOf(src) {
  if (src.asset) return String(src.asset).toUpperCase();
  const q = String(src.quote ?? 'USDT').toUpperCase();
  const s = String(src.symbol).toUpperCase();
  return s.endsWith(q) ? s.slice(0, -q.length) : s;
}

export class PriceFeed {
  constructor({ api, logger }) {
    this.api = api;
    this.log = logger;
    this.cache = new Map(); // asset -> {at, data}
    this.samples = new Map(); // asset -> [{t,p}] harga yang pernah diamati
    this.sources = new Map(); // asset -> sumber resolusi yang dipelajari dari market
    this.binanceHost = null;
    this.ctmRoundCache = new Map();
    this.warned = new Set();
    this.tradePoints = new Map(); // asset -> [{t,p}] trade terbaru (Bybit)
    this.tradeIds = new Map();
  }

  /** Simpan sumber harga resmi untuk aset (dipelajari dari data market). */
  setAssetSource(asset, src) {
    if (!src) return;
    const prev = this.sources.get(asset);
    if (!prev || prev.venue !== src.venue || prev.symbol !== src.symbol) {
      this.sources.set(asset, src);
      this.cache.delete(asset);
      this.log?.info(`Sumber harga ${asset}: ${src.venue} ${src.symbol}`);
    }
  }

  sourceFor(asset) {
    return this.sources.get(asset) ?? DEFAULT_SOURCES[asset] ?? null;
  }

  /** @returns {Promise<{series:{t:number,p:number}[], spot:number, source:string}|null>} */
  async series(asset, { maxAgeMs = 2500 } = {}) {
    const cached = this.cache.get(asset);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.data;

    const attempts = [];
    const src = this.sourceFor(asset);
    // Kumpulkan trade Bybit terus-menerus agar penutupan per detik lengkap saat dibutuhkan
    if (src?.venue === 'bybit') this.collectBybitTrades(asset, src).catch(() => {});
    if (src) attempts.push(() => this.venueSeries(src));
    if (COINBASE_PRODUCT[asset] && src?.venue !== 'coinbase') attempts.push(() => this.coinbaseSeries(asset));
    attempts.push(() => this.unhedgedCtmSeries(asset));

    let data = null;
    for (const run of attempts) {
      try {
        data = await run();
        if (data && data.series.length >= 2 && data.spot > 0) break;
        data = null;
      } catch (e) {
        this.log?.debug(`sumber harga gagal untuk ${asset}: ${e.message}`);
      }
    }
    if (data) {
      this.recordSample(asset, { t: Date.now(), p: data.spot });
      this.cache.set(asset, { at: Date.now(), data });
    } else {
      const key = `${asset}:nodata`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log?.warn(`Harga ${asset} tidak tersedia dari ${src ? `${src.venue} ${src.symbol}` : 'sumber mana pun'}.`);
      }
    }
    return data;
  }

  recordSample(asset, pt) {
    const arr = this.samples.get(asset) ?? [];
    if (!arr.length || pt.t > arr[arr.length - 1].t) arr.push(pt);
    const cutoff = Date.now() - 3 * 3600_000;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    this.samples.set(asset, arr);
  }

  // ------------------------------------------------------------ venue: deret 1 menit + spot

  async venueSeries(src) {
    const base = baseOf(src);
    const quote = String(src.quote ?? 'USDT').toUpperCase();
    const now = Date.now();
    let rows; // [{t, o, c}] urut naik
    switch (src.venue) {
      case 'binance': {
        const r = await this.binanceGet(`/api/v3/klines?symbol=${src.symbol}&interval=1m&limit=120`);
        rows = r.map((k) => ({ t: k[0], o: +k[1], c: +k[4] }));
        break;
      }
      case 'mexc': {
        const r = await getJson(`https://api.mexc.com/api/v3/klines?symbol=${src.symbol}&interval=1m&limit=120`);
        rows = r.map((k) => ({ t: k[0], o: +k[1], c: +k[4] }));
        break;
      }
      case 'bybit': {
        const r = await this.bybitGet(`/v5/market/kline?category=spot&symbol=${src.symbol}&interval=1&limit=120`);
        rows = (r?.result?.list ?? []).map((k) => ({ t: +k[0], o: +k[1], c: +k[4] })).reverse();
        break;
      }
      case 'okx': {
        const r = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${base}-${quote}&bar=1m&limit=120`);
        rows = (r?.data ?? []).map((k) => ({ t: +k[0], o: +k[1], c: +k[4] })).reverse();
        break;
      }
      case 'gate':
      case 'gateio': {
        const r = await getJson(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${base}_${quote}&interval=1m&limit=120`);
        rows = r.map((k) => ({ t: +k[0] * 1000, o: +k[5], c: +k[2] }));
        break;
      }
      case 'kucoin': {
        const r = await getJson(`https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=${base}-${quote}&startAt=${Math.floor(now / 1000) - 7200}`);
        rows = (r?.data ?? []).map((k) => ({ t: +k[0] * 1000, o: +k[1], c: +k[2] })).reverse();
        break;
      }
      case 'coinbase':
        return this.coinbaseSeries(base);
      default:
        throw new Error(`venue ${src.venue} belum didukung`);
    }
    rows = rows.filter((r) => r.o > 0 && r.c > 0).sort((a, b) => a.t - b.t);
    if (rows.length < 2) return null;
    const series = rows.map((r) => ({ t: r.t, p: r.o }));
    const spot = rows[rows.length - 1].c;
    series.push({ t: now, p: spot });
    return { series, spot, source: `${src.venue}` };
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

  async coinbaseSeries(asset) {
    const product = COINBASE_PRODUCT[asset] ?? `${asset}-USD`;
    const rows = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`);
    const sorted = rows.slice(0, 120).sort((a, b) => a[0] - b[0]);
    const series = sorted.map((r) => ({ t: r[0] * 1000, p: Number(r[3]) }));
    const spot = Number(sorted[sorted.length - 1][4]);
    series.push({ t: Date.now(), p: spot });
    return { series, spot, source: 'coinbase' };
  }

  async unhedgedCtmSeries(asset) {
    const c = this.ctmRoundCache.get(asset);
    let roundId = c && Date.now() - c.at < 60_000 ? c.roundId : undefined;
    if (roundId === undefined) {
      const res = await this.api.ctmRounds({ asset, status: 'OPEN,HEATMAP,LOCKED', limit: 50 });
      const rounds = (res?.rounds ?? []).filter((r) => String(r.asset).toUpperCase() === asset);
      rounds.sort((a, b) => Date.parse(a.openStartsAt ?? 0) - Date.parse(b.openStartsAt ?? 0));
      roundId = rounds[0]?.id ?? null;
      this.ctmRoundCache.set(asset, { at: Date.now(), roundId });
    }
    if (!roundId) return null;
    const res = await this.api.ctmPriceHistory(roundId);
    const series = (res?.prices ?? [])
      .map((x) => ({ t: Number(x.timestamp), p: Number(x.price) }))
      .filter((x) => x.p > 0 && Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
    if (series.length < 2) return null;
    return { series, spot: series[series.length - 1].p, source: 'unhedged-ctm' };
  }

  // ------------------------------------------------------------ harga penutupan per detik (untuk TWAP)

  /**
   * Jumlah & banyaknya harga penutupan per detik untuk detik-detik yang SUDAH selesai
   * di rentang [fromMs, toMs). Detik tanpa trade memakai harga terakhir (sesuai aturan Unhedged).
   * @returns {Promise<{sum:number, count:number, source:string}>}
   */
  async secondCloses(asset, fromMs, toMs) {
    const end = Math.min(toMs, Math.floor(Date.now() / 1000) * 1000); // hanya detik yang sudah selesai
    if (end <= fromMs) return { sum: 0, count: 0, source: 'none' };
    const src = this.sourceFor(asset);
    if (src?.venue === 'binance') {
      try {
        const rows = await this.binanceGet(
          `/api/v3/klines?symbol=${src.symbol}&interval=1s&startTime=${fromMs - 5000}&endTime=${end - 1}&limit=1000`,
        );
        const byT = new Map(rows.map((k) => [k[0], +k[4]]));
        // Harga terakhir sebelum jendela (untuk carry-forward di detik pertama)
        let last = null;
        for (const k of rows) if (k[0] < fromMs) last = +k[4];
        let sum = 0;
        let count = 0;
        for (let t = fromMs; t < end; t += 1000) {
          if (byT.has(t)) last = byT.get(t);
          if (last === null) continue;
          sum += last;
          count++;
        }
        return { sum, count, source: 'binance-1s' };
      } catch (e) {
        this.log?.debug(`1s klines gagal untuk ${asset}: ${e.message}`);
      }
    }
    // Bybit (sumber CC): bangun penutupan per detik dari trade terbaru, sama seperti Unhedged ("bybit-trades")
    if (src?.venue === 'bybit') {
      try {
        await this.collectBybitTrades(asset, src);
      } catch (e) {
        this.log?.debug(`trade bybit gagal untuk ${asset}: ${e.message}`);
      }
      const points = mergePoints(this.tradePoints.get(asset) ?? [], this.samples.get(asset) ?? []);
      return { ...closesFromPoints(points, fromMs, end), source: 'bybit-trades' };
    }
    // Cadangan: sampel harga yang dikumpulkan bot sendiri (kurang presisi)
    return { ...closesFromPoints(this.samples.get(asset) ?? [], fromMs, end), source: 'samples' };
  }

  /** Ambil trade terbaru Bybit spot dan simpan (maks 15 menit) untuk membentuk penutupan per detik. */
  async collectBybitTrades(asset, src) {
    const r = await this.bybitGet(`/v5/market/recent-trade?category=spot&symbol=${src.symbol}&limit=60`);
    const list = r?.result?.list ?? [];
    const arr = this.tradePoints.get(asset) ?? [];
    const seen = this.tradeIds.get(asset) ?? new Set();
    for (const x of list) {
      const id = x.execId ?? `${x.time}:${x.price}:${x.size}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const t = Number(x.time);
      const p = Number(x.price);
      if (Number.isFinite(t) && p > 0) arr.push({ t, p });
    }
    arr.sort((a, b) => a.t - b.t);
    const cutoff = Date.now() - 15 * 60_000;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    if (seen.size > 5000) this.tradeIds.set(asset, new Set([...seen].slice(-2000)));
    else this.tradeIds.set(asset, seen);
    this.tradePoints.set(asset, arr);
  }

  async bybitGet(pathAndQuery) {
    let lastErr;
    for (const h of BYBIT_HOSTS) {
      try {
        const data = await getJson(h + pathAndQuery);
        if (data?.retCode && data.retCode !== 0) throw new Error(`bybit retCode ${data.retCode}: ${data.retMsg}`);
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** TWAP penutupan per detik pada [fromMs, toMs); null bila data kurang dari 90%. */
  async twap(asset, fromMs, toMs) {
    const { sum, count } = await this.secondCloses(asset, fromMs, toMs);
    const expected = Math.round((toMs - fromMs) / 1000);
    return count >= expected * 0.9 && count > 0 ? sum / count : null;
  }
}

/** Gabungkan dua deret titik harga {t,p} dan urutkan menurut waktu. */
export function mergePoints(a, b) {
  return [...a, ...b].sort((x, y) => x.t - y.t);
}

/**
 * Penutupan per detik dari titik harga (trade/sampel), dengan aturan Unhedged:
 * penutupan detik = harga terakhir sampai akhir detik itu; detik tanpa trade memakai harga terakhir.
 * @param {{t:number,p:number}[]} points urut naik
 * @returns {{sum:number, count:number}}
 */
export function closesFromPoints(points, fromMs, endMs) {
  let i = 0;
  let last = null;
  let sum = 0;
  let count = 0;
  for (let t = fromMs; t < endMs; t += 1000) {
    while (i < points.length && points[i].t < t + 1000) last = points[i++].p;
    if (last === null) continue;
    sum += last;
    count++;
  }
  return { sum, count };
}

