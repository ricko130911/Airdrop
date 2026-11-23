import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { lockStability, snipeStake } from '../src/strategy.js';
import { tcpPing, LatencyMonitor } from '../src/latency.js';

const NOW = 1_000_000;
const hist = (zs, step = 1000) => zs.map((z, i) => ({ at: NOW - (zs.length - 1 - i) * step, z }));

test('lockStability: jarak aman bertahan & membesar -> dikonfirmasi, zHeld = z terendah', () => {
  const r = lockStability(hist([5.5, 6, 6.5, 7]), 'up', { now: NOW, confirmSec: 3 });
  assert.equal(r.confirmed, true);
  assert.equal(r.zHeld, 5.5);
  assert.equal(r.shrinking, false);
});

test('lockStability: jarak aman menyusut (harga mendekati batas) -> tidak dikonfirmasi', () => {
  const r = lockStability(hist([8, 7, 6, 5.2]), 'up', { now: NOW, confirmSec: 3 });
  assert.equal(r.confirmed, false);
  assert.equal(r.shrinking, true);
  assert.equal(r.zStart, 8);
  assert.equal(r.zNow, 5.2);
});

test('lockStability: belum cukup lama diamati -> tidak dikonfirmasi', () => {
  const r = lockStability(hist([9, 9]), 'up', { now: NOW, confirmSec: 3 });
  assert.equal(r.confirmed, false);
  assert.equal(r.zHeld, null);
});

test('lockStability: sisi DOWN memakai z terbalik; hasil pasti (Infinity) tetap terkunci', () => {
  const r = lockStability(hist([-6, -7, -8, -Infinity]), 'down', { now: NOW, confirmSec: 3 });
  assert.equal(r.confirmed, true);
  assert.equal(r.zHeld, 6);
  const inf = lockStability(hist([Infinity, Infinity, Infinity, Infinity]), 'up', { now: NOW, confirmSec: 3 });
  assert.equal(inf.confirmed, true);
  assert.equal(inf.zHeld, Infinity);
});

test('lockStability: data z hilang di jendela -> tidak dikonfirmasi', () => {
  const r = lockStability(hist([6, null, 7, 8]), 'up', { now: NOW, confirmSec: 3 });
  assert.equal(r.confirmed, false);
});

test('snipeStake: $20 minimum, $50 saat terkunci & dikonfirmasi', () => {
  const cfg = { snipeUsd: 20, snipeMaxUsd: 50, snipeLockedUsd: 50, snipeLockZ: 5, snipeKellyFraction: 0.05 };
  const base = { prob: 0.999, cost: 0.97, bankroll: 300, cfg, allowScale: false, allowBoost: true };
  assert.equal(snipeStake({ ...base, lockZ: null }).usd, 20); // tidak dikonfirmasi
  assert.equal(snipeStake({ ...base, lockZ: 4.2 }).usd, 35); // hampir terkunci
  assert.equal(snipeStake({ ...base, lockZ: 6 }).usd, 50); // terkunci
  assert.equal(snipeStake({ ...base, lockZ: 6, allowBoost: false }).usd, 20); // sudah kalah hari ini
});

test('tcpPing: mengukur connect ke server lokal; port tertutup -> null', async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const ok = await tcpPing('127.0.0.1', port);
  assert.ok(ok.ms !== null && ok.ms >= 0 && ok.ms < 1000);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  const bad = await tcpPing('127.0.0.1', port, 1000);
  assert.equal(bad.ms, null);
});

test('LatencyMonitor: ringkasan rata-rata/min/maks/gagal', async () => {
  const seq = [6, 8, null, 4];
  const m = new LatencyMonitor({ url: 'https://api.unhedged.gg', ping: async () => ({ ms: seq.shift(), address: '1.2.3.4' }) });
  for (let i = 0; i < 4; i++) await m.sample();
  const s = m.snapshot();
  assert.equal(s.host, 'api.unhedged.gg');
  assert.equal(s.lastMs, 4);
  assert.equal(s.avgMs, 6);
  assert.equal(s.minMs, 4);
  assert.equal(s.maxMs, 8);
  assert.equal(s.lossPct, 25);
  assert.equal(s.address, '1.2.3.4');
});
