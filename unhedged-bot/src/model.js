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

/**
 * Peluang UP untuk market Unhedged yang diselesaikan dengan RATA-RATA (TWAP):
 *   UP menang bila rata-rata N detik terakhir (penutupan per detik) >= harga acuan.
 *
 * Rata-rata akhir = (jumlah harga yang SUDAH diketahui + jumlah harga yang AKAN datang) / N.
 * Harga mendatang dimodelkan sebagai random walk dari harga sekarang. Varians rata-rata
 * dari m titik random walk yang dimulai τ0 detik lagi ≈ σ²·(τ0 + (m+1)(2m+1)/(6m)).
 *
 * @param {object} a
 * @param {number} a.spot              harga sekarang
 * @param {number} a.threshold         harga acuan resmi (TWAP awal)
 * @param {number} a.secondsLeft       sisa detik sampai market ditutup
 * @param {number} [a.avgSeconds=60]   panjang jendela rata-rata
 * @param {number} [a.knownSum=0]      jumlah harga penutupan per detik yang sudah terjadi di jendela akhir
 * @param {number} [a.knownCount=0]    banyaknya detik yang sudah diketahui
 * @param {number} a.sigma             volatilitas per √detik
 * @param {number} [a.drift=0]
 * @param {number} [a.momentumWeight=0]
 * @param {number} [a.sigmaMultiplier=1]
 */
export function probabilityUpTwap({
  spot,
  threshold,
  secondsLeft,
  avgSeconds = 60,
  knownSum = 0,
  knownCount = 0,
  sigma,
  drift = 0,
  momentumWeight = 0,
  sigmaMultiplier = 1,
}) {
  if (!(spot > 0) || !(threshold > 0)) return null;
  const N = avgSeconds;
  const left = Math.max(0, secondsLeft);
  // Detik mendatang di dalam jendela rata-rata
  const m = Math.min(N, Math.ceil(left));
  // Detik yang sudah lewat di jendela tapi datanya belum ada -> dianggap = spot
  const known = Math.min(knownCount, N - m);
  const gap = N - m - known;
  const fixedSum = (known > 0 ? (knownSum / knownCount) * known : 0) + gap * spot;

  if (m <= 0) {
    const twap = fixedSum / N;
    return twap >= threshold ? 1 : 0;
  }
  if (!(sigma > 0)) return null;
  const tau0 = Math.max(0, left - N);
  const mu = momentumWeight * drift;
  const futureMean = spot * (1 + mu * (tau0 + (m + 1) / 2));
  const varFactor = tau0 + ((m + 1) * (2 * m + 1)) / (6 * m);
  const futureSd = spot * sigma * sigmaMultiplier * Math.sqrt(varFactor);

  const mean = (fixedSum + m * futureMean) / N;
  const sd = (m / N) * futureSd;
  return normCdf((mean - threshold) / sd);
}
