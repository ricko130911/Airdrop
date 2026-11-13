import test from 'node:test';
import assert from 'node:assert/strict';
import { fitTemperature, Learner, summarize, timeBucket, tradesFromRecords, zoneEval, RECORD_VERSION } from '../src/analytics.js';

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

test('timeBucket', () => {
  assert.equal(timeBucket(10), '0-30s');
  assert.equal(timeBucket(45), '30-60s');
  assert.equal(timeBucket(170), '120s+');
});

test('fitTemperature: model yang terlalu yakin dikoreksi (k < 1)', () => {
  const r = rng(7);
  const samples = [];
  for (let i = 0; i < 2000; i++) {
    const trueP = 0.2 + 0.6 * r(); // peluang sebenarnya 20-80%
    const z = Math.log(trueP / (1 - trueP));
    const overconfident = 1 / (1 + Math.exp(-2 * z)); // model melaporkan logit 2x lipat
    samples.push({ p: overconfident, y: r() < trueP ? 1 : 0 });
  }
  const { k } = fitTemperature(samples);
  assert.ok(k > 0.4 && k < 0.6, `k=${k}`); // seharusnya sekitar 0.5
});

test('fitTemperature: model yang sudah tepat -> k sekitar 1', () => {
  const r = rng(11);
  const samples = [];
  for (let i = 0; i < 3000; i++) {
    const p = 0.1 + 0.8 * r();
    samples.push({ p, y: r() < p ? 1 : 0 });
  }
  const { k } = fitTemperature(samples);
  assert.ok(Math.abs(k - 1) < 0.15, `k=${k}`);
});

function settle({ asset = 'BTC', outcomeUp, side, price, quantity = 5, secondsLeft, prob = 0.8, checkpoints = [] }) {
  return {
    kind: 'settle',
    v: RECORD_VERSION,
    asset,
    outcomeUp,
    checkpoints,
    paper: side ? { side, price, quantity, fee: 0.05 * price * quantity, fill: { secondsLeft, prob, edge: 0.05 } } : null,
  };
}

test('tradesFromRecords & summarize: impas dan ROI', () => {
  const recs = [
    settle({ outcomeUp: 1, side: 'up', price: 0.8, secondsLeft: 40 }),
    settle({ outcomeUp: 0, side: 'up', price: 0.8, secondsLeft: 40 }),
    { kind: 'settle', v: 1, outcomeUp: 1, paper: { side: 'up', price: 0.5, quantity: 5 } }, // versi lama diabaikan
  ];
  const trades = tradesFromRecords(recs);
  assert.equal(trades.length, 2);
  const s = summarize(trades);
  assert.equal(s.winrate, 0.5);
  assert.ok(Math.abs(s.breakeven - 0.84) < 1e-9); // 0.80 + fee 5%
  assert.ok(s.roi < 0);
});

test('Learner: zona rugi diblokir setelah cukup banyak trade', () => {
  const L = new Learner({ minZoneTrades: 10 });
  const recs = [];
  // Zona 90-120s: selalu kalah
  for (let i = 0; i < 12; i++) recs.push(settle({ outcomeUp: 0, side: 'up', price: 0.6, secondsLeft: 100 }));
  // Zona 0-30s: selalu menang
  for (let i = 0; i < 12; i++) recs.push(settle({ outcomeUp: 1, side: 'up', price: 0.8, secondsLeft: 20, asset: 'ETH' }));
  L.addRecords(recs);
  assert.equal(L.zoneVerdict('ETH', 100).blocked, true);
  assert.equal(L.zoneVerdict('ETH', 20).blocked, false);
  // BTC hanya punya trade rugi -> diblokir per aset juga
  assert.equal(L.zoneVerdict('BTC', 20).blocked, true);
  const rep = L.report();
  assert.equal(rep.byTime.find((g) => g.key === '90-120s').blocked, true);
});

test('zoneEval: rugi kecil yang tidak konsisten tidak diblokir', () => {
  // 30 trade: hampir impas, naik-turun acak
  const trades = Array.from({ length: 30 }, (_, i) => ({ pnl: i % 2 ? 1.0 : -1.05, cost: 4 }));
  assert.equal(zoneEval(trades, 25).blocked, false);
});

test('Learner: zona yang diblokir bisa dibuka lagi lewat trade probe', () => {
  const L = new Learner({ minZoneTrades: 10 });
  const recs = [];
  for (let i = 0; i < 20; i++) recs.push(settle({ outcomeUp: 0, side: 'up', price: 0.6, secondsLeft: 100, asset: 'ETH' }));
  L.addRecords(recs);
  assert.equal(L.zoneVerdict('SOL', 100).blocked, true);
  // 60 probe 1 kontrak yang menang di zona yang sama
  const probes = [];
  for (let i = 0; i < 60; i++) {
    const r = settle({ outcomeUp: 1, side: 'up', price: 0.6, quantity: 1, secondsLeft: 100, asset: 'SOL' });
    r.paper.probe = true;
    probes.push(r);
  }
  L.addRecords(probes);
  assert.equal(L.zoneVerdict('SOL', 100).blocked, false);
});

test('Learner: kalibrasi baru aktif setelah sampel cukup', () => {
  const L = new Learner({ minCalibrationSamples: 50 });
  assert.equal(L.calibrate(0.9, 90), 0.9); // belum ada data
  const r = rng(3);
  const recs = [];
  for (let i = 0; i < 200; i++) {
    const trueP = 0.3 + 0.4 * r();
    const z = Math.log(trueP / (1 - trueP));
    const p = 1 / (1 + Math.exp(-3 * z)); // terlalu yakin 3x
    recs.push(settle({ outcomeUp: r() < trueP ? 1 : 0, checkpoints: [{ s: 90, pUp: p }] }));
  }
  L.addRecords(recs);
  const cal = L.calibrate(0.9, 90);
  assert.ok(cal < 0.8 && cal > 0.5, `cal=${cal}`);
  assert.equal(L.calibrate(0.9, 150), 0.9); // checkpoint 150 belum punya data
  assert.equal(L.calibrate(1, 90), 1); // hasil pasti tidak diubah
});
