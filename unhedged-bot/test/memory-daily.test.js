import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast, SSE_STUCK_MS } from '../src/dashboard/server.js';
import { Bot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { RECORD_VERSION } from '../src/analytics.js';

function fakeClient(needDrain = false) {
  return {
    writableNeedDrain: needDrain,
    destroyed: false,
    writableEnded: false,
    sent: [],
    write(s) {
      this.sent.push(s);
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test('dashboard: layar yang tidak membaca dilewati lalu diputus, layar sehat tetap dapat data', () => {
  const ok = fakeClient();
  const stuck = fakeClient(true); // mis. Smart TV standby
  const clients = new Map([
    [ok, { admin: false, stuckSince: null }],
    [stuck, { admin: false, stuckSince: null }],
  ]);
  let renders = 0;
  const render = () => {
    renders++;
    return 'data: {}\n\n';
  };
  broadcast(clients, render, 1000);
  assert.equal(ok.sent.length, 1);
  assert.equal(stuck.sent.length, 0); // tidak ditumpuk di memori
  assert.equal(renders, 1);
  broadcast(clients, render, 1000 + SSE_STUCK_MS + 1);
  assert.equal(stuck.destroyed, true);
  assert.equal(clients.has(stuck), false);
  assert.equal(ok.sent.length, 2);
});

function settle(ts, { trade = false, won = true } = {}) {
  return {
    kind: 'settle',
    v: RECORD_VERSION,
    live: true,
    ts: new Date(ts).toISOString(),
    marketId: 'm' + ts + Math.random(),
    asset: 'BTC',
    endMs: ts,
    durationSec: 300,
    outcomeUp: 1,
    checkpoints: [],
    paper: trade ? { side: won ? 'up' : 'down', price: 0.97, quantity: 30, fee: 0.04, strategy: 'sniper', fill: { secondsLeft: 20 } } : null,
  };
}

test('rem harian: kekalahan pagi tetap terhitung walau sudah ada ratusan market sesudahnya', () => {
  process.env.DRY_RUN = 'false';
  const cfg = { ...loadConfig(), dryRun: false };
  const bot = new Bot({ cfg, api: {}, prices: {}, log: { info() {}, warn() {}, error() {}, debug() {}, journal() {} } });
  const now = Date.now();
  const day0 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const t1 = day0 + 1;
  const step = Math.max(1, Math.floor((now - t1) / 700));
  bot.applySettleRecord(settle(t1, { trade: true, won: false })); // kalah pertama, pagi
  for (let i = 1; i <= 600; i++) bot.applySettleRecord(settle(t1 + i * step)); // 600 market tanpa posisi
  bot.applySettleRecord(settle(Math.min(now, t1 + 650 * step), { trade: true, won: false })); // kalah kedua
  assert.equal(bot.history.length, 500); // riwayat dashboard tetap dibatasi
  assert.equal(bot.todayStats().snipeLosses, 2); // tapi rem harian melihat keduanya
});
