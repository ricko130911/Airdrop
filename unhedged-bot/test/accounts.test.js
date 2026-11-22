import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFromEnvFile } from '../src/config.js';

test('nama akun dari nama file .env', () => {
  assert.equal(accountFromEnvFile('/root/bot/.env'), '');
  assert.equal(accountFromEnvFile('/root/bot/.env.akun2'), 'akun2');
  assert.equal(accountFromEnvFile('.env.istri'), 'istri');
});
