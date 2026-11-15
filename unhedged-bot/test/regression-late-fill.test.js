// Regresi: trade ETH "terisi" 8 detik SETELAH market tutup di harga basi 0.36 (+$10.06 palsu)
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradesFromRecords, Learner, RECORD_VERSION } from '../src/analytics.js';
import { decideSnipe } from '../src/strategy.js';

const rec = (price, quantity, secondsLeft, won = true) => ({
  kind: 'settle',
  v: RECORD_VERSION,
  asset: 'ETH',
  outcomeUp: won ? 1 : 0,
  checkpoints: [],
  paper: { side: 'up', price, quantity, fee: 0.001, strategy: 'sniper', fill: { secondsLeft, prob: 1 } },
});

test('trade yang terisi setelah market tutup diabaikan dari statistik', () => {
  const trades = tradesFromRecords([rec(0.36, 16, -8), rec(0.97, 3, 12)]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].price, 0.97);
});

test('ask jauh di bawah keyakinan (0.36 saat p=100%) dianggap data basi', () => {
  const cfg = { snipeMinProb: 0.97, snipeMaxPrice: 0.97, snipeMinPrice: 0.8, snipeMinEv: 0.015, snipeUsd: 3, feeModel: 'official' };
  const d = decideSnipe({ prob: 1, side: 'up', book: { up: { bestAsk: 0.36 } }, feeRate: 0.05, cfg, exposureLeftUsd: 20 });
  assert.equal(d.action, 'skip');
  assert.equal(d.code, 'suspicious');
});

test('satu trade murah tidak membuat sniper dianggap "terbukti"', () => {
  const L = new Learner();
  // 30 tembakan menang di 0.97 + 1 tembakan valid tapi murah (0.40, 16 kontrak)
  L.addRecords([...Array.from({ length: 30 }, () => rec(0.97, 3, 12)), rec(0.4, 16, 10)]);
  const t = L.sniperTrust(30);
  assert.equal(t.trusted, false, t.reason); // 31/31 baru membuktikan ~92% < impas rata-rata ~95%
});
