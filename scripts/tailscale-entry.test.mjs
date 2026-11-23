// config/tailscale-entry.sh: a leftover tailscale0 (operstate down, nothing uses it) must not stop our own Tailscale
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sh = readFileSync(new URL('../config/tailscale-entry.sh', import.meta.url), 'utf8');

test('a live foreign tailscale0 is left alone, a down one is removed', () => {
  const guard = sh.slice(sh.indexOf('if [ -e /sys/class/net/tailscale0 ]'), sh.indexOf('out=/tmp/h2z-serve.json'));
  assert.match(guard, /= down \] && ip link delete tailscale0/, 'only a down interface is deleted');
  assert.match(guard, /exec sleep/, 'otherwise the container still yields to the host Tailscale');
});
