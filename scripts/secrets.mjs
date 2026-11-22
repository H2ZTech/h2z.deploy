// Private secret files of the deployment (never in Git). Shared by scripts/init.mjs (first install) and
// scripts/ensure-secrets.mjs (the `secrets-init` compose service, run before every `docker compose up`),
// so a `git pull` that adds a secret only needs `docker compose up`.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync, chownSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SECRET_PATHS = [
  'security/service-token', 'security/engine-token', 'security/camera-key', 'ioc/admin-token', 'h2z-api/token',
  'nodered-admin/token', 'nodered/operator-password', 'nodered/credential-secret', 'dsh-web/password',
  'ioc/device-password',
];

// The DSH Web operator password, the IOC admin password and the device password (IOC admin → 设备网络:
// LAN, hotspot, Tailscale) ship with documented product defaults so a new board can be signed in right
// away; change them in place on site. Existing files are never overwritten.
export const DEFAULT_SECRETS = { 'dsh-web/password': 'h2z2026', 'ioc/admin-token': 'h2z2026', 'ioc/device-password': 'h2z2026' };

export const randomSecret = () => randomBytes(32).toString('hex');

/**
 * Create the missing secret files below `dir` (existing ones are kept). When running as root on Linux,
 * new directories get the owner of `dir` and group 20001 (0750), new files root:20001 (0640), matching
 * scripts/init.mjs, so the non-root containers (group_add 20001) can read them.
 */
export function ensureSecrets(dir, { group = 20001 } = {}) {
  const created = [];
  const root = process.platform === 'linux' && process.getuid?.() === 0;
  const owner = existsSync(dir) ? statSync(dir).uid : 0;
  for (const p of SECRET_PATHS) {
    const file = join(dir, p);
    if (existsSync(file)) continue;
    const sub = dirname(file);
    if (!existsSync(sub)) {
      mkdirSync(sub, { recursive: true, mode: 0o750 });
      if (root) { chownSync(sub, owner, group); chmodSync(sub, 0o750); }
    }
    writeFileSync(file, (DEFAULT_SECRETS[p] ?? randomSecret()) + '\n', { mode: 0o640 });
    if (root) { chownSync(file, 0, group); chmodSync(file, 0o640); }
    created.push(p);
  }
  return created;
}
