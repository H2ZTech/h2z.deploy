import { withTranscode } from './zlm-config.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, chownSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATHS, DEFAULT_SECRETS } from './secrets.mjs';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s, { mode: 0o600 }); };
const random = () => randomBytes(32).toString('hex');
const sudoUid = process.platform === 'linux' && process.getuid() === 0 && process.env.SUDO_UID
  ? Number(process.env.SUDO_UID)
  : null;
const sudoGid = process.platform === 'linux' && process.getuid() === 0 && process.env.SUDO_GID
  ? Number(process.env.SUDO_GID)
  : null;
const hostUid = Number(process.env.HOST_UID || sudoUid || 0);
const hostGid = Number(process.env.HOST_GID || sudoGid || 0);
let env = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
// Keep existing site-specific credentials, but follow the published ARM64 image
// locations when re-running initialization on an already provisioned device.
const runtimeImages = {
  AI_IMAGE: 'ghcr.io/h2ztech/h2z-ai-server:latest',
  NODERED_IMAGE: 'ghcr.io/h2ztech/h2z-nodered:latest',
  POSTGRES_IMAGE: 'postgres:16-alpine',
  EMQX_IMAGE: 'emqx/emqx:5.8.8',
  ZLM_IMAGE: 'zlmediakit/zlmediakit:master',
};
const updatedImageKeys = new Set();
env = env.split(/\r?\n/).map(line => {
  const match = line.match(/^(AI_IMAGE|NODERED_IMAGE)=/);
  if (!match) return line;
  const key = match[1];
  updatedImageKeys.add(key);
  return `${key}=${runtimeImages[key]}`;
}).join('\n');
for (const [key, image] of Object.entries(runtimeImages)) {
  if (!updatedImageKeys.has(key)) env = `${env.trimEnd()}\n${key}=${image}\n`;
}
for (const k of ['POSTGRES_PASSWORD', 'MQTT_PASSWORD', 'EMQX_PASSWORD', 'EMQX_COOKIE', 'ZLM_SECRET', 'ZLM_HOOK_SECRET']) {
  env = env.replace(new RegExp(`^${k}=\\s*$`, 'm'), `${k}=${random()}`);
}
// DSH confines command writes with Landlock; kernels without it (Orange Pi rk35xx vendor kernels)
// make DSH refuse every command. init.sh passes the host's LSM list; record the explicit opt-out in
// .env only when the operator has not chosen a value.
const hostLsm = String(process.env.HOST_LSM || '').trim();
if (hostLsm && !hostLsm.split(',').includes('landlock') && /^DSH_SANDBOX_MODE=\s*$/m.test(env)) {
  env = env.replace(/^DSH_SANDBOX_MODE=\s*$/m, 'DSH_SANDBOX_MODE=danger-full-access');
  console.log(`Kernel has no Landlock (LSMs: ${hostLsm}); DSH_SANDBOX_MODE=danger-full-access written to .env.`);
} else if (hostLsm && !hostLsm.split(',').includes('landlock') && !/^DSH_SANDBOX_MODE=/m.test(env)) {
  env = `${env.trimEnd()}\nDSH_SANDBOX_MODE=danger-full-access\n`;
  console.log(`Kernel has no Landlock (LSMs: ${hostLsm}); DSH_SANDBOX_MODE=danger-full-access written to .env.`);
}
put('.env', env);
const e = Object.fromEntries(env.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0,i),l.slice(i+1)]; }));
const secretPaths = SECRET_PATHS;
const missingSecrets = secretPaths.filter(p => !existsSync('secrets/' + p));
// Only report an error when it cannot be written: secrets/ already exists but the current user has no write permission (common: it was created earlier by root / a container);
// when secrets/ does not exist yet, a regular user can create it as long as the parent directory is writable (CI runs as a regular user, and this used to always fail)
const canWriteSecrets = (() => { try { accessSync(existsSync('secrets') ? 'secrets' : '.', constants.W_OK); return true; } catch { return false; } })();
if (missingSecrets.length && process.platform === 'linux' && process.getuid() !== 0 && !canWriteSecrets) {
  const owner = existsSync('secrets') ? statSync('secrets').uid : -1;
  console.error(`Cannot create missing private secrets as uid ${process.getuid()} (secrets/ owner uid ${owner}). Fix ownership of secrets/ for the deployment user, then rerun this script.`);
  process.exit(1);
}
// Product defaults (DSH, IOC admin, device password): scripts/secrets.mjs. Existing files are never overwritten.
for (const p of missingSecrets) put('secrets/' + p, (DEFAULT_SECRETS[p] ?? random()) + '\n');
mkdirSync('runtime/ai-shared', { recursive: true });
mkdirSync('models', { recursive: true });
put('runtime/emqx-users.csv', `user_id,password,is_superuser\n${e.MQTT_USERNAME},${e.MQTT_PASSWORD},false\n`);
put('runtime/zlm.ini', withTranscode(`[api]\nsecret=${e.ZLM_SECRET}\napiDebug=0\n[general]\nmediaServerId=h2z-security\nenableVhost=0\n[http]\nport=80\nrootPath=/opt/media/www\n[rtsp]\nport=554\n[rtmp]\nport=1935\n[record]\nfilePath=/opt/media/www/record\n[hook]\nenable=1\non_record_mp4=http://backend:3001/security/zlm/hook/on_record_mp4?secret=${e.ZLM_HOOK_SECRET}\non_stream_changed=http://backend:3001/security/zlm/hook/on_stream_changed?secret=${e.ZLM_HOOK_SECRET}\non_stream_none_reader=http://backend:3001/security/zlm/hook/on_stream_none_reader?secret=${e.ZLM_HOOK_SECRET}\non_stream_not_found=http://backend:3001/security/zlm/hook/on_stream_not_found?secret=${e.ZLM_HOOK_SECRET}\n`));
if (process.platform === 'linux' && process.getuid() === 0) {
  chownSync('.env',hostUid,hostGid); chmodSync('.env',0o600);
  function protect(p) {
    const dir = statSync(p).isDirectory();
    chownSync(p,dir ? hostUid : 0,20001);
    chmodSync(p,dir ? 0o750 : 0o640);
    if (dir) for (const f of readdirSync(p)) protect(p+'/'+f);
  }
  protect('secrets');
  for (const p of ['runtime/emqx-users.csv','runtime/zlm.ini']) { chownSync(p,0,20001); chmodSync(p,0o640); }
  chownSync('runtime/ai-shared',hostUid,20001); chmodSync('runtime/ai-shared',0o770);
} else if (process.platform === 'linux') {
  // Container group ownership requires root; use scripts/init.sh for the
  // privileged permission pass while preserving the operator as file owner.
}
console.log(`Private configuration initialized; existing tokens preserved. ${Object.keys(runtimeImages).join(', ')} set to published GHCR images. No credentials printed.`);
