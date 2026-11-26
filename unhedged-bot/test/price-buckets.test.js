import test from 'node:test';
import assert from 'node:assert/strict';
import { tradesFromRecords, priceBucket } from '../src/analytics.js';

test('priceBucket: kelompok harga beli', () => {
  assert.equal(priceBucket(0.665), '<0.85');
  assert.equal(priceBucket(0.89), '0.85-0.90');
  assert.equal(priceBucket(0.91), '0.90-0.93');
  assert.equal(priceBucket(0.95), '0.93-0.96');
  assert.equal(priceBucket(0.97), '0.96+');
});

test('tradesFromRecords: membawa ask yang dilihat bot & peluang mentah sisi yang dibeli', () => {
  const r = {
    kind: 'settle', v: 2, live: true, outcomeUp: 1, asset: 'CC',
    paper: { side: 'down', price: 0.91, quantity: 7, fee: 0.03, strategy: 'sniper', fill: { secondsLeft: 20, prob: 0.995, pUpRaw: 0.019, ask: 0.97 } },
  };
  const [t] = tradesFromRecords([r]);
  assert.equal(t.ask, 0.97);
  assert.ok(Math.abs(t.probRaw - 0.981) < 1e-9);
  assert.equal(t.won, false);
});
