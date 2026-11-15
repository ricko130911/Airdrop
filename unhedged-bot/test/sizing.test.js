import test from 'node:test';
import assert from 'node:assert/strict';
import { snipeStake, decideSnipe } from '../src/strategy.js';
import { Learner, RECORD_VERSION } from '../src/analytics.js';

const cfg = { snipeUsd: 3, snipeMaxUsd: 15, snipeKellyFraction: 0.05, snipeMinProb: 0.97, snipeMaxPrice: 0.95, snipeMinEv: 0.015, feeModel: 'flat' };

test('snipeStake: belum dipercaya -> selalu minimum', () => {
  assert.equal(snipeStake({ prob: 0.999, cost: 0.8, bankroll: 1000, cfg, allowScale: false }).usd, 3);
});

test('snipeStake: makin yakin -> makin besar (dibatasi min & maks)', () => {
  const lo = snipeStake({ prob: 0.98, cost: 0.95, bankroll: 200, cfg, allowScale: true }).usd;
  const mid = snipeStake({ prob: 0.99, cost: 0.93, bankroll: 200, cfg, allowScale: true }).usd;
  const hi = snipeStake({ prob: 0.999, cost: 0.9, bankroll: 200, cfg, allowScale: true }).usd;
  assert.ok(lo <= mid && mid <= hi, `${lo} ${mid} ${hi}`);
  assert.ok(lo >= 3 && hi <= 15);
  assert.equal(snipeStake({ prob: 0.999, cost: 0.8, bankroll: 100000, cfg, allowScale: true }).usd, 15);
});

test('decideSnipe: jumlah kontrak mengikuti ukuran dinamis', () => {
  const book = { up: { bestAsk: 0.85 }, down: { bestAsk: null } };
  const small = decideSnipe({ prob: 0.999, side: 'up', book, feeRate: 0.05, cfg, exposureLeftUsd: 100, bankroll: 1000, allowScale: false });
  const big = decideSnipe({ prob: 0.999, side: 'up', book, feeRate: 0.05, cfg, exposureLeftUsd: 100, bankroll: 1000, allowScale: true });
  assert.ok(big.quantity > small.quantity, `${small.quantity} ${big.quantity}`);
  // tetap dibatasi exposure
  const capped = decideSnipe({ prob: 0.999, side: 'up', book, feeRate: 0.05, cfg, exposureLeftUsd: 4, bankroll: 1000, allowScale: true });
  assert.ok(capped.quantity * 0.85 <= 4);
});

function sniperRecord(won, price = 0.9) {
  return {
    kind: 'settle',
    v: RECORD_VERSION,
    asset: 'BTC',
    outcomeUp: won ? 1 : 0,
    checkpoints: [],
    paper: { side: 'up', price, quantity: 3, fee: 0.05 * price * 3, strategy: 'sniper', fill: { secondsLeft: 20, prob: 0.99 } },
  };
}

test('Learner.sniperTrust: butuh cukup trade DAN terbukti di atas impas', () => {
  const L = new Learner();
  L.addRecords(Array.from({ length: 10 }, () => sniperRecord(true)));
  assert.equal(L.sniperTrust(30).trusted, false); // sampel kurang
  L.addRecords(Array.from({ length: 25 }, () => sniperRecord(true)));
  // 35/35 menang baru membuktikan akurasi ~92.8% < impas 94.5% (harga 0.90 + fee) -> belum dipercaya
  assert.equal(L.sniperTrust(30).trusted, false);
  assert.match(L.sniperTrust(30).reason, /akurasi terbukti/);
  L.addRecords(Array.from({ length: 40 }, () => sniperRecord(true)));
  assert.equal(L.sniperTrust(30).trusted, true); // 75/75 -> terbukti ~96.5%
  // 4 kekalahan di harga 0.9 menghapus untung -> tidak dipercaya lagi
  L.addRecords(Array.from({ length: 4 }, () => sniperRecord(false)));
  assert.equal(L.sniperTrust(30).trusted, false);
});

import { twapZ } from '../src/model.js';

const lockCfg = { ...cfg, snipeLockZ: 5, snipeLockedUsd: 6 };

test('twapZ: makin banyak detik diketahui di atas acuan -> jarak aman makin besar', () => {
  const base = { spot: 100.01, threshold: 100, sigma: 1e-4, avgSeconds: 60 };
  const early = twapZ({ ...base, secondsLeft: 40, knownSum: 100.01 * 20, knownCount: 20 });
  const late = twapZ({ ...base, secondsLeft: 5, knownSum: 100.01 * 55, knownCount: 55 });
  assert.ok(late > early && early > 0, `${early} ${late}`);
  assert.equal(twapZ({ ...base, secondsLeft: 0, knownSum: 6000.6, knownCount: 60 }), Infinity);
});

test('snipeStake: taruhan naik saat hasil terkunci, walau sniper belum terbukti', () => {
  const s = (lockZ, allowBoost = true) => snipeStake({ prob: 0.999, cost: 0.97, bankroll: 100, cfg: lockCfg, allowScale: false, lockZ, allowBoost });
  assert.equal(s(3).usd, 3); // belum terkunci -> minimum
  assert.equal(s(4.5).usd, 4.5); // hampir terkunci -> setengah jalan
  assert.equal(s(4.5).tier, 'hampir terkunci');
  assert.equal(s(6).usd, 6); // terkunci -> $6
  assert.equal(s(Infinity).usd, 6);
  assert.equal(s(6, false).usd, 3); // sudah kalah hari ini -> tidak ada kenaikan
});
