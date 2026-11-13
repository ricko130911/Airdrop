import test from 'node:test';
import assert from 'node:assert/strict';
import { closesFromPoints, mergePoints, PriceFeed } from '../src/prices.js';

test('closesFromPoints: penutupan per detik + carry-forward detik tanpa trade', () => {
  const pts = [
    { t: 500, p: 1.0 }, // sebelum jendela -> dipakai sebagai harga awal
    { t: 1200, p: 2.0 },
    { t: 1900, p: 3.0 }, // penutupan detik [1000,2000) = 3.0
    { t: 3500, p: 4.0 }, // detik [2000,3000) tanpa trade -> 3.0
  ];
  const r = closesFromPoints(pts, 1000, 5000);
  // detik: [1000)=3, [2000)=3, [3000)=4, [4000)=4
  assert.equal(r.count, 4);
  assert.equal(r.sum, 3 + 3 + 4 + 4);
});

test('closesFromPoints: detik sebelum ada data dilewati', () => {
  const r = closesFromPoints([{ t: 2500, p: 5 }], 1000, 4000);
  assert.equal(r.count, 2);
  assert.equal(r.sum, 10);
});

test('mergePoints mengurutkan', () => {
  assert.deepEqual(mergePoints([{ t: 3, p: 1 }], [{ t: 1, p: 2 }]).map((x) => x.t), [1, 3]);
});

test('PriceFeed: trade Bybit (format v5) dibentuk jadi penutupan per detik CC', async () => {
  const feed = new PriceFeed({ api: {} });
  const now = Math.floor(Date.now() / 1000) * 1000;
  const list = [
    { execId: 'a', price: '0.0880', size: '10', time: String(now - 5500) },
    { execId: 'b', price: '0.0882', size: '10', time: String(now - 3200) },
    { execId: 'c', price: '0.0884', size: '10', time: String(now - 1100) },
  ];
  feed.bybitGet = async () => ({ retCode: 0, result: { list } });
  feed.setAssetSource('CC', { venue: 'bybit', symbol: 'CCUSDT', asset: 'CC', quote: 'USDT' });
  const r = await feed.secondCloses('CC', now - 5000, now);
  assert.equal(r.source, 'bybit-trades');
  assert.equal(r.count, 5);
  // detik: [-5000)=0.0880, [-4000)=0.0882 (trade -3200), [-3000)=0.0882 (carry), [-2000)=0.0884 (trade -1100), [-1000)=0.0884
  assert.ok(Math.abs(r.sum - (0.088 + 0.0882 + 0.0882 + 0.0884 + 0.0884)) < 1e-12, String(r.sum));
});
