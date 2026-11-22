// node --test scripts/secrets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecrets, SECRET_PATHS } from './secrets.mjs';

test('only missing secrets are created; existing ones and their values are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-'));
  mkdirSync(join(dir, 'ioc'));
  writeFileSync(join(dir, 'ioc/admin-token'), 'site-value\n');
  const created = ensureSecrets(dir);
  assert.equal(created.length, SECRET_PATHS.length - 1);
  assert.equal(readFileSync(join(dir, 'ioc/admin-token'), 'utf8'), 'site-value\n');
  assert.equal(readFileSync(join(dir, 'ioc/device-password'), 'utf8'), 'h2z2026\n');
  assert.equal(readFileSync(join(dir, 'dsh-web/password'), 'utf8'), 'h2z2026\n');
  assert.match(readFileSync(join(dir, 'h2z-api/token'), 'utf8'), /^[0-9a-f]{64}\n$/);
  assert.deepEqual(ensureSecrets(dir), [], 'second run: nothing to do');
});
