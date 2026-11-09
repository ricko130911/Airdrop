// Model peluang untuk market "harga naik/turun dalam N menit".
//
// Ide dasar: log-harga diperlakukan sebagai random walk (Brownian motion).
// Jika sisa waktu τ detik, harga sekarang S, harga acuan (open window) K,
// volatilitas σ (per √detik), dan drift μ (per detik), maka
//
//     P(harga akhir > K) = Φ( (ln(S/K) + μ·τ) / (σ·√τ) )
//
// Konsekuensinya: menjelang akhir window, selisih kecil antara S dan K sudah
// membuat peluang sangat condong. Di sinilah "edge" biasanya muncul, yaitu ketika
// harga order book belum menyesuaikan dengan pergerakan harga terbaru.

/** Fungsi distribusi kumulatif normal standar (Φ). Akurasi ~1e-7. */
export function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  // Abramowitz & Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Estimasi volatilitas (σ per √detik) dari deret harga dengan jarak waktu tidak beraturan.
 * Memakai bobot EWMA agar data terbaru lebih berpengaruh.
 * @param {{t:number, p:number}[]} series  t dalam milidetik, urut naik
 * @param {{halfLifeSec?: number}} opts
 * @returns {number|null}
 */
export function estimateVolatility(series, { halfLifeSec = 1800 } = {}) {
  if (!series || series.length < 3) return null;
  const lastT = series[series.length - 1].t;
  let sumW = 0;
  let sumR2 = 0;
  let sumDt = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0) || !(a.p > 0) || !(b.p > 0)) continue;
    const r = Math.log(b.p / a.p);
    const age = (lastT - b.t) / 1000;
    const w = Math.pow(0.5, age / halfLifeSec);
    sumR2 += w * r * r;
    sumDt += w * dt;
    sumW += w;
  }
  if (sumW === 0 || sumDt === 0) return null;
  return Math.sqrt(sumR2 / sumDt);
}

/**
 * Drift (log-return per detik) dari pergerakan harga terakhir dalam lookbackSec.
 * @returns {number} 0 bila data tidak cukup
 */
export function estimateDrift(series, { lookbackSec = 300 } = {}) {
  if (!series || series.length < 2) return 0;
  const last = series[series.length - 1];
  const cutoff = last.t - lookbackSec * 1000;
  let first = null;
  for (const pt of series) {
    if (pt.t >= cutoff) {
      first = pt;
      break;
    }
  }
  if (!first || first === last || !(first.p > 0)) return 0;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 0;
  return Math.log(last.p / first.p) / dt;
}

/**
 * Peluang harga akhir window > harga acuan.
 * @param {object} a
 * @param {number} a.spot           harga sekarang
 * @param {number} a.strike         harga acuan (harga saat window dibuka)
 * @param {number} a.secondsLeft    sisa detik sampai market ditutup
 * @param {number} a.sigma          volatilitas per √detik
 * @param {number} [a.drift=0]      drift per detik
 * @param {number} [a.momentumWeight=0]  seberapa besar drift dipercaya (0..1)
 * @param {number} [a.sigmaMultiplier=1] pengali σ untuk antisipasi fat-tail
 */
export function probabilityUp({ spot, strike, secondsLeft, sigma, drift = 0, momentumWeight = 0, sigmaMultiplier = 1 }) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (secondsLeft <= 0) return spot > strike ? 1 : spot < strike ? 0 : 0.5;
  if (!(sigma > 0)) return null;
  const sd = sigma * sigmaMultiplier * Math.sqrt(secondsLeft);
  const mean = Math.log(spot / strike) + momentumWeight * drift * secondsLeft;
  return normCdf(mean / sd);
}

/**
 * Ukuran taruhan Kelly untuk kontrak biner yang dibayar $1 bila menang.
 * Membeli di harga c dengan peluang menang p: f* = (p - c) / (1 - c).
 * @returns {number} USD yang dianjurkan (>= 0)
 */
export function kellyStakeUsd({ prob, price, bankroll, fraction = 0.25 }) {
  if (!(price > 0 && price < 1) || !(bankroll > 0)) return 0;
  const f = (prob - price) / (1 - price);
  if (f <= 0) return 0;
  return bankroll * fraction * f;
}

/** Brier score sederhana untuk evaluasi kalibrasi model (lebih kecil = lebih baik). */
export function brier(prob, outcome) {
  return (prob - outcome) ** 2;
}
