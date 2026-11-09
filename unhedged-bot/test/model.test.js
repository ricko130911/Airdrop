import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, estimateVolatility, estimateDrift, probabilityUp, kellyStakeUsd } from '../src/model.js';

test('normCdf nilai standar', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
});

test('estimateVolatility mendekati σ sebenarnya', () => {
  // Random walk deterministik: return ±r tiap 60 detik -> σ = r/√60
  const r = 0.001;
  const series = [];
  let p = 100;
  for (let i = 0; i < 200; i++) {
    series.push({ t: i * 60_000, p });
    p *= Math.exp(i % 2 ? r : -r);
  }
  const sigma = estimateVolatility(series);
  assert.ok(Math.abs(sigma - r / Math.sqrt(60)) / (r / Math.sqrt(60)) < 0.01, `sigma=${sigma}`);
});

test('estimateDrift positif saat harga naik', () => {
  const series = [];
  for (let i = 0; i <= 10; i++) series.push({ t: i * 30_000, p: 100 * (1 + 0.001 * i) });
  assert.ok(estimateDrift(series, { lookbackSec: 300 }) > 0);
});

test('probabilityUp: spot = strike -> 50%', () => {
  const p = probabilityUp({ spot: 100, strike: 100, secondsLeft: 120, sigma: 1e-4 });
  assert.ok(Math.abs(p - 0.5) < 1e-9);
});

test('probabilityUp: makin sedikit waktu tersisa, makin yakin', () => {
  const args = { spot: 100.05, strike: 100, sigma: 1e-4 };
  const pLong = probabilityUp({ ...args, secondsLeft: 240 });
  const pShort = probabilityUp({ ...args, secondsLeft: 20 });
  assert.ok(pLong > 0.5 && pShort > pLong, `${pLong} ${pShort}`);
});

test('probabilityUp: sigmaMultiplier membuat model lebih hati-hati', () => {
  const args = { spot: 100.05, strike: 100, sigma: 1e-4, secondsLeft: 60 };
  assert.ok(probabilityUp({ ...args, sigmaMultiplier: 2 }) < probabilityUp(args));
});

test('probabilityUp: waktu habis -> hasil pasti', () => {
  assert.equal(probabilityUp({ spot: 101, strike: 100, secondsLeft: 0, sigma: 1e-4 }), 1);
  assert.equal(probabilityUp({ spot: 99, strike: 100, secondsLeft: 0, sigma: 1e-4 }), 0);
});

test('kellyStakeUsd', () => {
  assert.equal(kellyStakeUsd({ prob: 0.5, price: 0.6, bankroll: 100 }), 0);
  const s = kellyStakeUsd({ prob: 0.8, price: 0.6, bankroll: 100, fraction: 0.25 });
  assert.ok(Math.abs(s - 100 * 0.25 * 0.5) < 1e-9);
});
