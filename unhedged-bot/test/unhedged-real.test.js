// Tes berdasarkan data market asli Unhedged (test/fixtures/btc-5min.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyMarket, extractStrike, resolverInfo, bookTop, marketTakerFee, priceSourceOf, outcomeSides } from '../src/markets.js';
import { probabilityUpTwap } from '../src/model.js';
import { decideOrderBook, completeSetArb } from '../src/strategy.js';

const market = JSON.parse(fs.readFileSync(new URL('./fixtures/btc-5min.json', import.meta.url)));

test('market asli: terdeteksi sebagai BTC 5 menit dengan window dari resolver', () => {
  const c = classifyMarket(market, { assets: ['BTC', 'ETH', 'SOL', 'CC'], durationSec: 300 });
  assert.ok(c.ok, c.reason);
  assert.equal(c.asset, 'BTC');
  assert.equal(c.window.startSource, 'resolver.windowStartTime');
  assert.equal(c.window.endMs - c.window.startMs, 300_000);
});

test('market asli: acuan resmi = TWAP awal dari priceReferences', () => {
  const s = extractStrike(market);
  assert.ok(Math.abs(s.value - 68714.624166) < 1e-3);
  assert.equal(s.final, true);
  const r = resolverInfo(market);
  assert.equal(r.venue, 'binance');
  assert.equal(r.symbol, 'BTCUSDT');
  assert.equal(r.averagingSeconds, 60);
  assert.deepEqual(priceSourceOf(market, 'BTC'), { venue: 'binance', symbol: 'BTCUSDT', asset: 'BTC', quote: 'USDT' });
});

test('market asli: order book & fee', () => {
  const b = bookTop(market, outcomeSides(market));
  assert.equal(b.up.bestBid, 0.96);
  assert.equal(b.down.bestAsk, 0.04); // ask efektif hasil cross-trade
  assert.equal(b.up.bestAsk, null);
  assert.equal(marketTakerFee(market), 0.05);
});

test('probabilityUpTwap: 50% saat semuanya sama dengan acuan', () => {
  const p = probabilityUpTwap({ spot: 100, threshold: 100, secondsLeft: 120, sigma: 1e-4 });
  assert.ok(Math.abs(p - 0.5) < 1e-9);
});

test('probabilityUpTwap: harga yang sudah diketahui mendominasi di akhir', () => {
  const base = { spot: 100.0, threshold: 100, sigma: 1e-4, secondsLeft: 10 };
  // 50 detik pertama rata-rata 100.05 -> hampir pasti UP walau spot = acuan
  assert.ok(probabilityUpTwap({ ...base, knownSum: 100.05 * 50, knownCount: 50 }) > 0.99);
  assert.ok(probabilityUpTwap({ ...base, knownSum: 99.95 * 50, knownCount: 50 }) < 0.01);
});

test('probabilityUpTwap: rata-rata mengurangi ketidakpastian dibanding harga sesaat', () => {
  const args = { spot: 100.02, threshold: 100, sigma: 1e-4 };
  const p60 = probabilityUpTwap({ ...args, secondsLeft: 60 });
  const p120 = probabilityUpTwap({ ...args, secondsLeft: 120 });
  assert.ok(p60 > p120 && p120 > 0.5);
});

test('probabilityUpTwap: waktu habis -> sama dengan acuan = UP', () => {
  assert.equal(probabilityUpTwap({ spot: 100, threshold: 100, secondsLeft: 0, knownSum: 6000, knownCount: 60, sigma: 1e-4 }), 1);
  assert.equal(probabilityUpTwap({ spot: 100, threshold: 100.01, secondsLeft: 0, knownSum: 6000, knownCount: 60, sigma: 1e-4 }), 0);
});

const cfg = { minEdge: 0.05, maxPrice: 0.92, minPrice: 0.05, kellyFraction: 0.25, maxOrderUsd: 5, hysteresis: 0.05 };

test('decideOrderBook: fee menurunkan harga maksimum', () => {
  const noFee = decideOrderBook({ pUp: 0.8, cfg, bankroll: 100, exposureLeftUsd: 20 });
  const fee = decideOrderBook({ pUp: 0.8, cfg, bankroll: 100, exposureLeftUsd: 20, feeRate: 0.05 });
  assert.equal(noFee.price, 0.75);
  assert.equal(fee.price, 0.71); // (0.80 - 0.05) / 1.05
});

test('decideOrderBook: terisi langsung bila ask <= harga', () => {
  const d = decideOrderBook({ pUp: 0.8, cfg, bankroll: 100, exposureLeftUsd: 20, feeRate: 0.05, book: { up: { bestAsk: 0.65 } } });
  assert.equal(d.fillsNow, true);
  assert.ok(d.edgeAtAsk > 0.1);
});

test('decideOrderBook: histeresis mencegah bolak-balik', () => {
  // p(DOWN)=0.57 cukup untuk order baru, tapi tidak untuk pindah dari UP
  assert.equal(decideOrderBook({ pUp: 0.43, cfg, bankroll: 100, exposureLeftUsd: 20 }).action, 'buy');
  assert.equal(decideOrderBook({ pUp: 0.43, cfg, bankroll: 100, exposureLeftUsd: 20, currentSide: 'up' }).action, 'skip');
});

test('completeSetArb', () => {
  assert.ok(completeSetArb({ up: { bestAsk: 0.45 }, down: { bestAsk: 0.48 } }, 0.05));
  assert.equal(completeSetArb({ up: { bestAsk: 0.5 }, down: { bestAsk: 0.5 } }, 0.05), null);
  assert.equal(completeSetArb({ up: { bestAsk: null }, down: { bestAsk: 0.04 } }, 0.05), null);
});
