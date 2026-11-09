import test from 'node:test';
import assert from 'node:assert/strict';
import { decideOrderBook, decideParimutuel, floorCents } from '../src/strategy.js';
import { classifyMarket, flattenFeed, outcomeSides, extractStrike } from '../src/markets.js';

const cfg = {
  minEdge: 0.05,
  maxPrice: 0.92,
  minPrice: 0.05,
  kellyFraction: 0.25,
  maxOrderUsd: 5,
};

test('floorCents', () => {
  assert.equal(floorCents(0.679), 0.67);
  assert.equal(floorCents(0.7), 0.7);
});

test('decideOrderBook: beli sisi yang diunggulkan di harga p - edge', () => {
  const d = decideOrderBook({ pUp: 0.8, cfg, bankroll: 100, exposureLeftUsd: 20 });
  assert.equal(d.action, 'buy');
  assert.equal(d.side, 'up');
  assert.equal(d.price, 0.75);
  assert.ok(d.quantity >= 1 && d.quantity * d.price <= cfg.maxOrderUsd + 1e-9);

  const d2 = decideOrderBook({ pUp: 0.1, cfg, bankroll: 100, exposureLeftUsd: 20 });
  assert.equal(d2.side, 'down');
  assert.equal(d2.price, 0.85);
});

test('decideOrderBook: lewati bila model ragu atau exposure habis', () => {
  assert.equal(decideOrderBook({ pUp: 0.52, cfg, bankroll: 100, exposureLeftUsd: 20 }).action, 'skip');
  assert.equal(decideOrderBook({ pUp: 0.9, cfg, bankroll: 100, exposureLeftUsd: 0 }).action, 'skip');
});

test('decideOrderBook: harga dibatasi MAX_PRICE', () => {
  const d = decideOrderBook({ pUp: 0.995, cfg, bankroll: 1000, exposureLeftUsd: 20 });
  assert.equal(d.price, 0.92);
});

test('decideParimutuel: pilih sisi dengan EV positif', () => {
  const d = decideParimutuel({
    pUp: 0.7,
    pools: { up: 100, down: 100, total: 200 },
    cfg,
    bankroll: 100,
    exposureLeftUsd: 20,
  });
  assert.equal(d.action, 'bet');
  assert.equal(d.side, 'up');
  assert.ok(d.ev >= cfg.minEdge);
});

const now = Date.now();
const sampleFeed = [
  {
    type: 'market',
    market: {
      id: 'm1',
      question: 'BTC Up or Down - 5 min',
      status: 'ACTIVE',
      marketType: 'ORDER_BOOK',
      startTime: new Date(now - 60_000).toISOString(),
      endTime: new Date(now + 240_000).toISOString(),
      outcomes: [
        { index: 0, label: 'UP', engineId: 'out_0' },
        { index: 1, label: 'DOWN', engineId: 'out_1' },
      ],
    },
  },
  {
    type: 'binary_group',
    group: {
      title: 'Solana 5 minute',
      markets: [
        {
          id: 'm2',
          question: 'Will SOL be above $185.20 in 5 minutes?',
          status: 'ACTIVE',
          endTime: new Date(now + 200_000).toISOString(),
          outcomes: [
            { index: 0, label: 'Yes' },
            { index: 1, label: 'No' },
          ],
        },
      ],
    },
  },
  {
    type: 'market',
    market: {
      id: 'm3',
      question: 'Will BTC hit $150k by December?',
      status: 'ACTIVE',
      endTime: new Date(now + 30 * 86400_000).toISOString(),
      outcomes: [
        { index: 0, label: 'Yes' },
        { index: 1, label: 'No' },
      ],
    },
  },
];

test('flattenFeed + classifyMarket', () => {
  const markets = flattenFeed(sampleFeed);
  assert.equal(markets.length, 3);
  const opts = { assets: ['BTC', 'ETH', 'SOL', 'CC'], durationSec: 300 };

  const c1 = classifyMarket(markets[0], opts);
  assert.ok(c1.ok, c1.reason);
  assert.equal(c1.asset, 'BTC');
  assert.equal(c1.sides.up.engineId, 'out_0');

  const c2 = classifyMarket(markets[1], opts);
  assert.ok(c2.ok, c2.reason);
  assert.equal(c2.asset, 'SOL');
  assert.equal(c2.sides.up.label, 'Yes');
  assert.equal(extractStrike(markets[1]).value, 185.2);

  const c3 = classifyMarket(markets[2], opts);
  assert.equal(c3.ok, false);
});

test('outcomeSides: pertanyaan "below" membalik Yes/No', () => {
  const s = outcomeSides({
    question: 'Will ETH be below $3,000 at 12:05?',
    outcomes: [
      { index: 0, label: 'Yes' },
      { index: 1, label: 'No' },
    ],
  });
  assert.equal(s.up.label, 'No');
  assert.equal(s.down.label, 'Yes');
});

test('extractStrike dari field & sufiks k', () => {
  assert.equal(extractStrike({ referencePrice: '84250.5000000000' }).value, 84250.5);
  assert.equal(extractStrike({ question: 'BTC above $84.2k?' }).value, 84200);
});
