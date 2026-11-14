// Keputusan trading murni (tanpa I/O) agar mudah diuji.

import { kellyStakeUsd } from './model.js';

/** Bulatkan ke bawah ke sen terdekat (format harga Unhedged: 2 desimal). */
export function floorCents(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/**
 * Keputusan untuk market ORDER_BOOK.
 * Strategi: pasang limit BID pada sisi yang diunggulkan model, di harga maksimum yang
 * masih menyisakan edge setelah fee:  peluang - harga - fee(harga) >= MIN_EDGE.
 * Fee diperkirakan konservatif: feeRate x harga per kontrak (tarif taker).
 * Bila order book punya ask <= harga itu, order langsung terisi di harga ask.
 *
 * Histeresis: berpindah ke sisi lawan dari order yang sedang terpasang butuh
 * keyakinan tambahan (cfg.hysteresis), agar bot tidak bolak-balik karena noise.
 *
 * @returns {{action:'buy', side:'up'|'down', prob:number, price:number, quantity:number, stakeUsd:number, ask:number|null, edgeAtAsk:number|null, fillsNow:boolean} | {action:'skip', reason:string}}
 */
export function decideOrderBook({ pUp, cfg, bankroll, exposureLeftUsd, feeRate = 0, currentSide = null, book = null }) {
  if (pUp === null || !Number.isFinite(pUp)) return { action: 'skip', reason: 'peluang tidak tersedia' };
  const side = pUp >= 0.5 ? 'up' : 'down';
  const prob = side === 'up' ? pUp : 1 - pUp;

  // Hanya trading bila model cukup yakin (hindari kondisi 50:50 yang rawan adverse selection)
  let need = 0.5 + cfg.minEdge;
  if (currentSide && currentSide !== side) need += cfg.hysteresis ?? 0;
  if (prob < need) return { action: 'skip', reason: `model belum yakin (p=${prob.toFixed(3)})` };

  let price = floorCents((prob - cfg.minEdge) / (1 + feeRate));
  price = Math.min(price, cfg.maxPrice);
  if (price < cfg.minPrice) return { action: 'skip', reason: `harga di bawah MIN_PRICE (p=${prob.toFixed(3)})` };

  const ask = book?.[side]?.bestAsk ?? null;
  const fillsNow = ask !== null && ask <= price;
  const execPrice = fillsNow ? ask : price;
  const edgeAtAsk = ask !== null ? prob - ask * (1 + feeRate) : null;

  const kelly = kellyStakeUsd({ prob, price: Math.min(0.99, execPrice * (1 + feeRate)), bankroll, fraction: cfg.kellyFraction });
  const stakeUsd = Math.min(kelly, cfg.maxOrderUsd, Math.max(0, exposureLeftUsd));
  const quantity = Math.floor(stakeUsd / price);
  if (quantity < 1) {
    return { action: 'skip', reason: exposureLeftUsd <= 0 ? 'batas exposure tercapai' : `ukuran terlalu kecil ($${stakeUsd.toFixed(2)})` };
  }
  return { action: 'buy', side, prob, price, quantity, stakeUsd: quantity * price, ask, edgeAtAsk, fillsNow };
}

/**
 * Deteksi arbitrase complete set: beli 1 UP + 1 DOWN < $1 (setelah fee) lalu ditukar $1
 * (autoBurn). Hanya memakai harga ask yang tersedia di kedua sisi.
 * @returns {{costPerSet:number, profitPerSet:number}|null}
 */
export function completeSetArb(book, feeRate = 0) {
  const a = book?.up?.bestAsk;
  const b = book?.down?.bestAsk;
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const cost = (a + b) * (1 + feeRate);
  return cost < 1 ? { costPerSet: cost, profitPerSet: 1 - cost } : null;
}

/** Ambil ukuran pool per outcome dari market PARIMUTUEL (beberapa kemungkinan nama field). */
export function parimutuelPools(m, sides) {
  const poolOf = (o) => {
    const src = (m.outcomes ?? []).find((x, i) => (x.index ?? i) === o.index) ?? {};
    for (const f of ['pool', 'poolSize', 'totalAmount', 'amount', 'totalPool', 'volume']) {
      const v = Number(src[f]);
      if (Number.isFinite(v) && v >= 0 && src[f] !== undefined && src[f] !== null) return v;
    }
    for (const f of ['pools', 'outcomePools', 'poolSizes']) {
      const arr = m[f];
      if (Array.isArray(arr) && arr[o.index] !== undefined) {
        const v = Number(typeof arr[o.index] === 'object' ? arr[o.index].amount ?? arr[o.index].pool : arr[o.index]);
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  };
  const up = poolOf(sides.up);
  const down = poolOf(sides.down);
  if (up === null || down === null) return null;
  const total = Number(m.totalPool);
  return { up, down, total: Number.isFinite(total) && total > 0 ? total : up + down };
}

/**
 * Keputusan untuk market PARIMUTUEL (taruhan pool).
 * Pembayaran per $1 di sisi X ≈ (totalPool·(1-fee) + stake) / (poolX + stake).
 */
export function decideParimutuel({ pUp, pools, feeRate = 0, cfg, bankroll, exposureLeftUsd }) {
  if (pUp === null || !pools) return { action: 'skip', reason: 'data pool/peluang tidak tersedia' };
  const stakeCap = Math.min(cfg.maxOrderUsd, Math.max(0, exposureLeftUsd));
  if (stakeCap < 0.01) return { action: 'skip', reason: 'batas exposure tercapai' };

  let best = null;
  for (const side of ['up', 'down']) {
    const prob = side === 'up' ? pUp : 1 - pUp;
    const pool = pools[side];
    // Cari stake terbaik secara kasar (stake besar menurunkan payout sendiri)
    for (const frac of [1, 0.5, 0.25, 0.1]) {
      const stake = stakeCap * frac;
      const payout = (pools.total * (1 - feeRate) + stake) / (pool + stake);
      const ev = prob * payout - 1;
      const kelly = kellyStakeUsd({ prob, price: 1 / payout, bankroll, fraction: cfg.kellyFraction });
      if (ev >= cfg.minEdge && stake <= kelly + 1e-9 && (!best || ev * stake > best.ev * best.stake)) {
        best = { action: 'bet', side, prob, stake: Math.floor(stake * 100) / 100, payout, ev };
      }
    }
  }
  if (!best || best.stake < 0.01) return { action: 'skip', reason: 'EV pool tidak cukup' };
  return best;
}

/**
 * Perkiraan fee per kontrak.
 *  - 'flat' (default, konservatif): tarif × harga
 *  - 'risk': tarif × min(harga, 1 − harga). Dokumentasi Unhedged menyebut fee memakai
 *    "risk-shaped curve"; pakai ini hanya setelah dicek dengan kolom `fee` di trade live.
 */
export function feeFor(price, rate, model = 'flat') {
  if (!(rate > 0)) return 0;
  return model === 'risk' ? rate * Math.min(price, 1 - price) : rate * price;
}

/**
 * Strategi SNIPER akhir round: hanya MEMBELI dari penjual yang sudah ada (taker), di detik-detik
 * terakhir, ketika hasil hampir pasti dan masih ada untung setelah fee. Tidak memasang order
 * yang menunggu (menghindari "adverse selection" dari trader yang lebih cepat).
 *
 * @param {object} a
 * @param {number} a.prob        peluang menang sisi yang diunggulkan (sudah dipilih yang paling konservatif)
 * @param {'up'|'down'} a.side
 * @param {object} a.book        hasil bookTop()
 * @param {number} a.feeRate
 * @param {object} a.cfg         snipeMinProb, snipeMaxPrice, snipeMinEv, snipeUsd, feeModel
 * @param {number} a.exposureLeftUsd
 */
export function decideSnipe({ prob, side, book, feeRate = 0, cfg, exposureLeftUsd }) {
  if (!Number.isFinite(prob)) return { action: 'skip', reason: 'peluang tidak tersedia' };
  if (prob < cfg.snipeMinProb) return { action: 'skip', reason: `belum pasti (p=${prob.toFixed(3)} < ${cfg.snipeMinProb})` };
  const ask = book?.[side]?.bestAsk ?? null;
  if (ask === null) return { action: 'skip', reason: `tidak ada penjual ${side.toUpperCase()}` };
  if (ask > cfg.snipeMaxPrice) return { action: 'skip', reason: `ask ${ask.toFixed(2)} > maks ${cfg.snipeMaxPrice}` };
  const fee = feeFor(ask, feeRate, cfg.feeModel);
  const ev = prob - ask - fee; // untung harapan per kontrak (USD)
  if (ev < cfg.snipeMinEv) return { action: 'skip', reason: `untung tipis (${(ev * 100).toFixed(1)}¢ < ${(cfg.snipeMinEv * 100).toFixed(1)}¢)` };
  const budget = Math.min(cfg.snipeUsd, Math.max(0, exposureLeftUsd));
  const quantity = Math.floor(budget / (ask + fee));
  if (quantity < 1) return { action: 'skip', reason: exposureLeftUsd <= 0 ? 'batas exposure tercapai' : 'modal per tembakan terlalu kecil' };
  return {
    action: 'buy',
    strategy: 'sniper',
    side,
    prob,
    price: ask,
    ask,
    quantity,
    stakeUsd: quantity * ask,
    ev,
    edgeAtAsk: ev,
    fillsNow: true,
  };
}
