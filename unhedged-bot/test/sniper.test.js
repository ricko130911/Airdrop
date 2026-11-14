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
