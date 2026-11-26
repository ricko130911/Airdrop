import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSnipe, feeFor } from '../src/strategy.js';

const cfg = { snipeMinProb: 0.97, snipeMaxPrice: 0.95, snipeMinEv: 0.015, snipeUsd: 3, feeModel: 'flat' };
const book = (up, down) => ({ up: { bestAsk: up }, down: { bestAsk: down } });

test('feeFor: flat vs risk', () => {
  assert.ok(Math.abs(feeFor(0.9, 0.05, 'flat') - 0.045) < 1e-12);
  assert.ok(Math.abs(feeFor(0.9, 0.05, 'risk') - 0.005) < 1e-12);
  assert.equal(feeFor(0.9, 0, 'flat'), 0);
});

test('decideSnipe: tembak bila hampir pasti, ada penjual, dan untung setelah fee', () => {
  const d = decideSnipe({ prob: 0.995, side: 'up', book: book(0.9, null), feeRate: 0.05, cfg, exposureLeftUsd: 20 });
  assert.equal(d.action, 'buy');
  assert.equal(d.price, 0.9);
  assert.ok(d.ev > 0.04); // 0.995 - 0.9 - 0.045
  assert.equal(d.quantity, 3); // $3 / (0.9 + 0.045)
  assert.equal(d.strategy, 'sniper');
});

test('decideSnipe: lewati bila belum pasti', () => {
  assert.equal(decideSnipe({ prob: 0.95, side: 'up', book: book(0.5, null), feeRate: 0.05, cfg, exposureLeftUsd: 20 }).action, 'skip');
});

test('decideSnipe: lewati bila tidak ada penjual atau terlalu mahal', () => {
  assert.match(decideSnipe({ prob: 0.999, side: 'down', book: book(0.9, null), feeRate: 0.05, cfg, exposureLeftUsd: 20 }).reason, /tidak ada penjual/);
  assert.match(decideSnipe({ prob: 0.999, side: 'up', book: book(0.97, null), feeRate: 0, cfg, exposureLeftUsd: 20 }).reason, /maks/);
});

test('decideSnipe: lewati bila untung tipis setelah fee', () => {
  // 0.99 - 0.93 - 0.0465 = 0.0135 < 0.015
  assert.match(decideSnipe({ prob: 0.99, side: 'up', book: book(0.93, null), feeRate: 0.05, cfg, exposureLeftUsd: 20 }).reason, /untung tipis/);
});

test('decideSnipe: fee model risk membuat tembakan di harga tinggi masuk akal', () => {
  const d = decideSnipe({ prob: 0.99, side: 'up', book: book(0.93, null), feeRate: 0.05, cfg: { ...cfg, feeModel: 'risk' }, exposureLeftUsd: 20 });
  assert.equal(d.action, 'buy'); // 0.99 - 0.93 - 0.0035 = 0.0565
});

test('feeFor official: cocok dengan tabel resmi Unhedged (100 kontrak, tier 0)', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(feeFor(0.25, 0.05, 'official') * 100, 0.9375)); // taker @0.25
  assert.ok(near(feeFor(0.5, 0.02, 'official') * 100, 0.5)); // maker @0.50
  assert.ok(near(feeFor(0.75, 0.05, 'official') * 100, 0.9375)); // taker @0.75
  assert.ok(feeFor(0.98, 0.05, 'official') < 0.001); // nyaris nol di harga tinggi
});

import { decideSnipe as ds } from '../src/strategy.js';

test('pengaman harga murah: ask < 0.93 butuh yakin >= 99.5%', () => {
  const cfg = { snipeMinProb: 0.98, snipeMaxPrice: 0.97, snipeMinPrice: 0.8, snipeMinEv: 0.015, snipeUsd: 30, snipeMaxUsd: 50, feeModel: 'official', snipeCheapPrice: 0.93, snipeCheapMinProb: 0.995 };
  const book = (a) => ({ down: { bestAsk: a } });
  // Kasus CC 26 Nov: ask 0.91, yakin 99.0% -> ditahan
  const cc = ds({ prob: 0.99, side: 'down', book: book(0.91), feeRate: 0.05, cfg, exposureLeftUsd: 100 });
  assert.equal(cc.action, 'skip');
  assert.equal(cc.code, 'cheap_unsure');
  // Ask murah tapi bot sangat yakin -> tetap menembak (mis. ETH 0.84 p=0.9988)
  assert.equal(ds({ prob: 0.9988, side: 'down', book: book(0.84), feeRate: 0.05, cfg, exposureLeftUsd: 100 }).action, 'buy');
  // Harga normal tidak terpengaruh
  assert.equal(ds({ prob: 0.985, side: 'down', book: book(0.95), feeRate: 0.05, cfg, exposureLeftUsd: 100 }).action, 'buy');
  // Bisa dimatikan
  assert.equal(ds({ prob: 0.99, side: 'down', book: book(0.91), feeRate: 0.05, cfg: { ...cfg, snipeCheapPrice: 0 }, exposureLeftUsd: 100 }).action, 'buy');
});
