import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, escapeHtml } from '../src/notify.js';

test('escapeHtml', () => {
  assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

test('Telegram nonaktif tanpa token/chat id', () => {
  let called = false;
  const tg = new Telegram({ token: '', chatId: '', fetchImpl: async () => { called = true; } });
  tg.send('x');
  assert.equal(tg.enabled, false);
  assert.equal(called, false);
});

test('Telegram error tidak pernah melempar & pesan dibuang setelah 3 gagal', async () => {
  let n = 0;
  const tg = new Telegram({
    token: 't',
    chatId: '1',
    log: { warn() {} },
    fetchImpl: async () => { n++; return { ok: false, status: 500, json: async () => ({ ok: false, description: 'down', parameters: { retry_after: 0.01 } }) }; },
  });
  tg.send('halo');
  await tg.flush(5000);
  assert.equal(n, 3);
  assert.equal(tg.queue.length, 0);
});
