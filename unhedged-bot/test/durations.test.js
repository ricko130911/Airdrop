import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyMarket, durationLabel } from '../src/markets.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/btc-5min.json', import.meta.url)));
const opts = { assets: ['BTC', 'ETH', 'SOL', 'CC'], durations: [300, 900, 3600] };

function withWindow(sec, question) {
  const m = structuredClone(fx);
  const end = Date.parse(m.endTime);
  m.autoResolution.resolverConfig.windowStartTime = new Date(end - sec * 1000).toISOString();
  if (question) m.question = question;
  return m;
}

test('classifyMarket: 5 menit, 15 menit, dan 1 jam dikenali dari waktu mulai resmi', () => {
  assert.equal(classifyMarket(withWindow(300), opts).durationSec, 300);
  const m15 = classifyMarket(withWindow(900, 'BTC Up or Down - 15 Min'), opts);
  assert.ok(m15.ok, m15.reason);
  assert.equal(m15.durationSec, 900);
  const h1 = classifyMarket(withWindow(3600, 'BTC Up or Down - 1 Hour'), opts);
  assert.ok(h1.ok, h1.reason);
  assert.equal(h1.durationSec, 3600);
});

test('classifyMarket: durasi lain ditolak, dan bisa dibatasi lewat konfigurasi', () => {
  const m4h = classifyMarket(withWindow(4 * 3600, 'BTC Up or Down - 4 Hour'), opts);
  assert.equal(m4h.ok, false);
  assert.match(m4h.reason, /durasi/);
  // Hanya 5 menit
  assert.equal(classifyMarket(withWindow(900), { ...opts, durations: [300] }).ok, false);
});

test('classifyMarket: tanpa data resolver, durasi dibaca dari judul', () => {
  const m = structuredClone(fx);
  delete m.autoResolution;
  m.question = 'ETH Up or Down - 1 Hour';
  m.slug = 'abc123-eth-up-or-down-1-hour';
  m.createdAt = null;
  const c = classifyMarket(m, opts);
  assert.ok(c.ok, c.reason);
  assert.equal(c.durationSec, 3600);
  assert.equal(c.window.endMs - c.window.startMs, 3600_000);
});

test('durationLabel', () => {
  assert.equal(durationLabel(300), '5 mnt');
  assert.equal(durationLabel(900), '15 mnt');
  assert.equal(durationLabel(3600), '1 jam');
});
