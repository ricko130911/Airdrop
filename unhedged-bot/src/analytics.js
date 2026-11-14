// Analitik & pembelajaran dari hasil bot sendiri (fungsi murni, mudah diuji).
//
// Dua cara bot "belajar":
//  1. Kalibrasi peluang: di beberapa titik waktu (checkpoint) bot mencatat peluang mentah
//     model untuk SETIAP market. Setelah hasil resmi keluar, bot menghitung apakah model
//     terlalu yakin / kurang yakin, lalu mengoreksinya (temperature scaling di ruang logit).
//  2. Zona rugi: trade dikelompokkan per waktu tersisa saat terisi & per aset. Zona yang
//     terbukti rugi (cukup banyak sampel) diblokir: bot hanya mengirim order "probe" 1 kontrak
//     di zona itu agar tetap bisa belajar bila kondisinya membaik.

import fs from 'node:fs';

export const TIME_BUCKETS = [
  { key: '0-30s', min: 0, max: 30 },
  { key: '30-60s', min: 30, max: 60 },
  { key: '60-90s', min: 60, max: 90 },
  { key: '90-120s', min: 90, max: 120 },
  { key: '120s+', min: 120, max: Infinity },
];
export const PROB_BUCKETS = [
  { key: '55-65%', min: 0.55, max: 0.65 },
  { key: '65-75%', min: 0.65, max: 0.75 },
  { key: '75-85%', min: 0.75, max: 0.85 },
  { key: '85-100%', min: 0.85, max: 1.01 },
];
/** Titik waktu (detik tersisa) tempat peluang model dicatat untuk kalibrasi. */
export const CHECKPOINTS = [150, 90, 45, 20];
/** Versi format catatan; catatan lebih lama diabaikan oleh pembelajaran. */
export const RECORD_VERSION = 2;

export function timeBucket(sec) {
  return TIME_BUCKETS.find((b) => sec >= b.min && sec < b.max)?.key ?? TIME_BUCKETS[TIME_BUCKETS.length - 1].key;
}
export function probBucket(p) {
  return PROB_BUCKETS.find((b) => p >= b.min && p < b.max)?.key ?? null;
}

/** Baca semua catatan JSONL (baris rusak dilewati). */
export function loadRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* lewati */
    }
  }
  return out;
}

/** Catatan "settle" versi baru saja. */
export function settleRecords(records) {
  return records.filter((r) => r?.kind === 'settle' && (r.v ?? 0) >= RECORD_VERSION && (r.outcomeUp === 0 || r.outcomeUp === 1));
}

/** Ubah catatan settle menjadi daftar trade yang terisi. */
export function tradesFromRecords(records) {
  const trades = [];
  for (const r of settleRecords(records)) {
    const p = r.paper;
    if (!p || !(p.quantity > 0) || !(p.price > 0)) continue;
    const won = (p.side === 'up' ? 1 : 0) === r.outcomeUp;
    const cost = p.quantity * p.price + (p.fee ?? 0);
    const pnl = (won ? p.quantity : 0) - cost;
    trades.push({
      ts: r.ts,
      asset: r.asset,
      side: p.side,
      price: p.price,
      quantity: p.quantity,
      fee: p.fee ?? 0,
      cost,
      won,
      pnl,
      probe: !!p.probe,
      strategy: p.strategy ?? 'model',
      secondsLeft: p.fill?.secondsLeft ?? null,
      prob: p.fill?.prob ?? null,
      edge: p.fill?.edge ?? null,
    });
  }
  return trades;
}

/** Ringkasan sekumpulan trade. breakeven = win rate minimum agar impas (biaya rata-rata per kontrak). */
export function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wins: 0, winrate: null, breakeven: null, pnl: 0, cost: 0, roi: null, avgPrice: null };
  let wins = 0;
  let pnl = 0;
  let cost = 0;
  let qty = 0;
  let px = 0;
  for (const t of trades) {
    if (t.won) wins++;
    pnl += t.pnl;
    cost += t.cost;
    qty += t.quantity;
    px += t.price;
  }
  return { n, wins, winrate: wins / n, breakeven: cost / qty, pnl, cost, roi: cost > 0 ? pnl / cost : null, avgPrice: px / n };
}

export function groupSummary(trades, keyFn, keys) {
  const groups = new Map((keys ?? []).map((k) => [k, []]));
  for (const t of trades) {
    const k = keyFn(t);
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, ...summarize(list) }));
}

/**
 * Penilaian zona: pakai 60 trade TERAKHIR, setiap trade berbobot sama (return = PnL / modal),
 * sehingga order probe 1 kontrak ikut menentukan dan zona bisa dibuka lagi bila membaik.
 * Diblokir bila rata-rata return negatif DAN cukup konsisten (t-stat < -0.5), bukan sekadar sial.
 */
export function zoneEval(trades, minN, { window = 60, tCut = -0.5 } = {}) {
  const recent = trades.slice(-window);
  const n = recent.length;
  if (!n) return { n: 0, meanRet: null, t: null, blocked: false };
  const rets = recent.map((t) => (t.cost > 0 ? t.pnl / t.cost : 0));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : mean < 0 ? -Infinity : Infinity;
  return { n, meanRet: mean, t, blocked: n >= minN && mean < 0 && t < tCut };
}

const clip = (p) => Math.min(0.999, Math.max(0.001, p));
const logit = (p) => Math.log(clip(p) / (1 - clip(p)));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Temperature scaling: cari k sehingga p' = sigmoid(k · logit(p)) paling cocok dengan hasil (log loss).
 * k < 1 = model terlalu yakin (dikoreksi ke arah 50%), k > 1 = model kurang yakin.
 * @param {{p:number, y:0|1}[]} samples
 */
export function fitTemperature(samples, { minK = 0.2, maxK = 1.5 } = {}) {
  const n = samples.length;
  if (n < 2) return { k: 1, n };
  let k = 1;
  for (let it = 0; it < 50; it++) {
    let g = 0;
    let h = 0;
    for (const { p, y } of samples) {
      const z = logit(p);
      const q = sigmoid(k * z);
      g += (q - y) * z;
      h += q * (1 - q) * z * z;
    }
    if (h < 1e-12) break;
    const step = g / h;
    k = Math.min(maxK, Math.max(minK, k - step));
    if (Math.abs(step) < 1e-6) break;
  }
  return { k, n };
}

export function brierOf(samples, k = 1) {
  if (!samples.length) return null;
  let s = 0;
  for (const { p, y } of samples) s += (sigmoid(k * logit(p)) - y) ** 2;
  return s / samples.length;
}

export class Learner {
  /**
   * @param {{minCalibrationSamples?:number, minZoneTrades?:number, enabled?:boolean}} opts
   */
  constructor({ minCalibrationSamples = 40, minZoneTrades = 25, enabled = true } = {}) {
    this.minCal = minCalibrationSamples;
    this.minZone = minZoneTrades;
    this.enabled = enabled;
    this.records = [];
    this.samples = new Map(CHECKPOINTS.map((c) => [c, []])); // checkpoint -> [{p,y}]
    this.fits = new Map();
    this.trades = [];
  }

  addRecords(records) {
    for (const r of settleRecords(records)) this.addRecord(r, false);
    this.refit();
  }

  addRecord(r, refit = true) {
    if (r?.kind !== 'settle' || (r.v ?? 0) < RECORD_VERSION) return;
    this.records.push(r);
    for (const c of r.checkpoints ?? []) {
      if (this.samples.has(c.s) && Number.isFinite(c.pUp)) this.samples.get(c.s).push({ p: c.pUp, y: r.outcomeUp });
    }
    const [t] = tradesFromRecords([r]);
    if (t) this.trades.push(t);
    if (refit) this.refit();
  }

  refit() {
    for (const [c, list] of this.samples) {
      const fit = list.length >= this.minCal ? fitTemperature(list) : { k: 1, n: list.length };
      this.fits.set(c, { ...fit, active: list.length >= this.minCal, brierRaw: brierOf(list), brierCal: brierOf(list, fit.k) });
    }
  }

  nearestCheckpoint(secondsLeft) {
    let best = CHECKPOINTS[0];
    for (const c of CHECKPOINTS) if (Math.abs(c - secondsLeft) < Math.abs(best - secondsLeft)) best = c;
    return best;
  }

  /** Peluang terkalibrasi. Tanpa cukup data, peluang dikembalikan apa adanya. */
  calibrate(pUp, secondsLeft) {
    if (!this.enabled || pUp === null || !Number.isFinite(pUp)) return pUp;
    const fit = this.fits.get(this.nearestCheckpoint(secondsLeft));
    if (!fit?.active) return pUp;
    if (pUp <= 0 || pUp >= 1) return pUp; // hasil sudah pasti
    return sigmoid(fit.k * logit(pUp));
  }

  /** Apakah zona (waktu tersisa / aset) terbukti rugi? */
  zoneVerdict(asset, secondsLeft) {
    if (!this.enabled) return { blocked: false };
    const tk = timeBucket(secondsLeft);
    const modelTrades = this.trades.filter((t) => t.strategy !== 'sniper');
    const byTime = zoneEval(modelTrades.filter((t) => t.secondsLeft !== null && timeBucket(t.secondsLeft) === tk), this.minZone);
    const byAsset = zoneEval(modelTrades.filter((t) => t.asset === asset), this.minZone);
    if (byTime.blocked) {
      return { blocked: true, reason: `zona ${tk} rugi (rata² ${(byTime.meanRet * 100).toFixed(1)}%/trade, ${byTime.n} trade)` };
    }
    if (byAsset.blocked) {
      return { blocked: true, reason: `${asset} rugi (rata² ${(byAsset.meanRet * 100).toFixed(1)}%/trade, ${byAsset.n} trade)` };
    }
    return { blocked: false };
  }

  /**
   * Apakah sniper sudah "dipercaya" untuk menaikkan taruhan?
   * Syarat: minimal `minTrades` trade sniper DAN win rate di atas titik impas + 1%.
   */
  sniperTrust(minTrades) {
    const st = summarize(this.trades.filter((t) => t.strategy === 'sniper'));
    // Batas bawah keyakinan 95% (Wilson) dari win rate: "akurasi minimal yang sudah terbukti"
    const lower = st.n ? wilsonLower(st.wins, st.n) : null;
    let reason = null;
    if (st.n < minTrades) reason = `baru ${st.n}/${minTrades} trade`;
    else if (!(st.pnl > 0)) reason = 'total sniper masih rugi';
    else if (lower < st.breakeven) reason = `akurasi terbukti ${(lower * 100).toFixed(1)}% < impas ${(st.breakeven * 100).toFixed(1)}%`;
    return { trusted: reason === null, reason, n: st.n, need: minTrades, winrate: st.winrate, provenWinrate: lower, breakeven: st.breakeven, pnl: st.pnl };
  }

  /** Laporan untuk dashboard / CLI. */
  report() {
    const trades = this.trades;
    const withZone = (groups, keyFn) =>
      groups.map((g) => {
        const z = zoneEval(trades.filter((t) => t.strategy !== 'sniper' && keyFn(t) === g.key), this.minZone);
        return { ...g, recentMeanRet: z.meanRet, recentN: z.n, tStat: z.t, blocked: this.enabled && z.blocked };
      });
    const timeKey = (t) => (t.secondsLeft === null ? null : timeBucket(t.secondsLeft));
    const byTime = withZone(groupSummary(trades, timeKey, TIME_BUCKETS.map((b) => b.key)), timeKey);
    const byAsset = withZone(groupSummary(trades, (t) => t.asset), (t) => t.asset);
    return {
      enabled: this.enabled,
      minZoneTrades: this.minZone,
      minCalibrationSamples: this.minCal,
      markets: this.records.length,
      total: summarize(trades),
      byTime,
      byAsset,
      byStrategy: groupSummary(trades, (t) => t.strategy),
      sniper: summarize(trades.filter((t) => t.strategy === 'sniper')),
      byProb: groupSummary(trades, (t) => (t.prob === null ? null : probBucket(t.prob)), PROB_BUCKETS.map((b) => b.key)).map((g) => ({
        ...g,
        avgProb: avg(trades.filter((t) => t.prob !== null && probBucket(t.prob) === g.key).map((t) => t.prob)),
      })),
      calibration: CHECKPOINTS.map((c) => ({ checkpoint: c, ...(this.fits.get(c) ?? { k: 1, n: 0, active: false }) })),
    };
  }
}

/** Batas bawah interval Wilson (satu sisi, ~95%) untuk proporsi menang. */
export function wilsonLower(wins, n, z = 1.645) {
  if (!n) return 0;
  const p = wins / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
