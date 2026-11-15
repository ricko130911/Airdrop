import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSnipeScan, describeSnipeScan } from '../src/strategy.js';
import { Learner, RECORD_VERSION } from '../src/analytics.js';

test('updateSnipeScan: simpan peluang & untung terbaik dengan dua asumsi fee', () => {
  let s = updateSnipeScan(null, { prob: 0.99, side: 'up', ask: 0.98, feeRate: 0.05, secondsLeft: 20, code: 'too_pricey' });
  s = updateSnipeScan(s, { prob: 0.999, side: 'up', ask: 0.97, feeRate: 0.05, secondsLeft: 10, code: 'too_pricey' });
  s = updateSnipeScan(s, { prob: null, side: 'up', ask: null, feeRate: 0.05, secondsLeft: 8, code: 'data' });
  assert.equal(s.ticks, 3);
  assert.equal(s.maxProb, 0.999);
  assert.equal(s.bestFlat.ask, 0.97);
  assert.ok(s.bestFlat.ev < 0); // 0.999 - 0.97 - 0.0485
  assert.ok(s.bestRisk.ev > 0.015); // 0.999 - 0.97 - 0.0015
  assert.equal(s.reasons.too_pricey, 2);
  assert.equal(s.reasons.data, 1);
  assert.match(describeSnipeScan(s), /tidak menembak \(paling sering: harga terlalu mahal\)/);
});

function rec(strategy, won) {
  return {
    kind: 'settle',
    v: RECORD_VERSION,
    asset: 'BTC',
    outcomeUp: won ? 1 : 0,
    checkpoints: [],
    scan: { ticks: 5, maxProb: 0.99, bestFlat: { ev: -0.02, side: 'up' }, bestRisk: { ev: 0.02, side: 'up' }, reasons: { too_pricey: 5 }, fired: false, probe: true },
    paper: { side: 'up', price: 0.98, quantity: 1, fee: 0.049, strategy, probe: strategy === 'sniper-probe', fill: { secondsLeft: 10 } },
  };
}

test('probe tidak memengaruhi kepercayaan sniper & zona strategi lama', () => {
  const L = new Learner({ minZoneTrades: 5 });
  L.addRecords(Array.from({ length: 40 }, () => rec('sniper-probe', false)));
  const trust = L.sniperTrust(30);
  assert.equal(trust.n, 0); // probe tidak dihitung sebagai trade sniper
  assert.equal(L.zoneVerdict('BTC', 10).blocked, false); // probe tidak memblokir zona strategi lama
  const sc = L.snipeScanSummary(0.015);
  assert.equal(sc.rounds, 40);
  assert.equal(sc.probes, 40);
  assert.equal(sc.evFlat, 0);
  assert.equal(sc.evRisk, 40);
});
