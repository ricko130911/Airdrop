// Keputusan trading murni (tanpa I/O) agar mudah diuji.

import { kellyStakeUsd } from './model.js';

/** Bulatkan ke bawah ke sen terdekat (format harga Unhedged: 2 desimal). */
export function floorCents(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/**
 * Keputusan untuk market ORDER_BOOK.
 * Strategi: pasang limit BID pada sisi yang diunggulkan model, di harga
 * (peluang model - MIN_EDGE). Order hanya terisi bila ada penjual di harga
 * itu atau lebih murah, jadi setiap fill punya edge minimal MIN_EDGE menurut model.
 *
 * @returns {{action:'buy', side:'up'|'down', prob:number, price:number, quantity:number, stakeUsd:number} | {action:'skip', reason:string}}
 */
export function decideOrderBook({ pUp, cfg, bankroll, exposureLeftUsd }) {
  if (pUp === null || !Number.isFinite(pUp)) return { action: 'skip', reason: 'peluang tidak tersedia' };
  const side = pUp >= 0.5 ? 'up' : 'down';
  const prob = side === 'up' ? pUp : 1 - pUp;

  // Hanya trading bila model cukup yakin (hindari kondisi 50:50 yang rawan adverse selection)
  if (prob < 0.5 + cfg.minEdge) return { action: 'skip', reason: `model belum yakin (p=${prob.toFixed(3)})` };
  let price = floorCents(prob - cfg.minEdge);
  price = Math.min(price, cfg.maxPrice);
  if (price < cfg.minPrice) return { action: 'skip', reason: `harga di bawah MIN_PRICE (p=${prob.toFixed(3)})` };

  const kelly = kellyStakeUsd({ prob, price, bankroll, fraction: cfg.kellyFraction });
  const stakeUsd = Math.min(kelly, cfg.maxOrderUsd, Math.max(0, exposureLeftUsd));
  const quantity = Math.floor(stakeUsd / price);
  if (quantity < 1) {
    return { action: 'skip', reason: exposureLeftUsd <= 0 ? 'batas exposure tercapai' : `ukuran terlalu kecil ($${stakeUsd.toFixed(2)})` };
  }
  return { action: 'buy', side, prob, price, quantity, stakeUsd: quantity * price };
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
