// Camera modules in the B-line stack: activator (camera activation) and bridge (camera protocol bridge).
// Plan: h2z.security docs/PLAN-2026-11-23-CAMERA-ONBOARDING.md section 11; dev plan P3.3b / P4.4b.
// Structure checks on the files a machine really uses (compose.yaml, .env.example, init.mjs, uninstall.sh, update.sh, fnOS wrapper);
// when the docker compose plugin is present the rendered config is checked too (no container is started).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageRefs } from './check-images.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const MODULES = { activator: ['ACTIVATOR_IMAGE', 'ghcr.io/h2ztech/h2z-activator:latest'], bridge: ['BRIDGE_IMAGE', 'ghcr.io/h2ztech/h2z-bridge:latest'] };
/** Text block of one top-level service in compose.yaml (up to the next service / top-level key). */
function block(text, name) {
  const m = new RegExp(`^  ${name}:\\n((?:(?: {4,}.*| *)\\n)*)`, 'm').exec(text);
  assert.ok(m, 'service ' + name);
  return m[1];
}

test('compose.yaml: activator and bridge exist, image variables have defaults, no published ports, no privileges, small limits, capped logs', () => {
  const text = read('compose.yaml');
  for (const [svc, [key, ref]] of Object.entries(MODULES)) {
    const b = block(text, svc);
    assert.ok(b.includes('image: ${' + key + ':-' + ref + '}'), svc + ' image default');
    assert.doesNotMatch(b, /^\s{4}ports:/m, svc + ' publishes no ports');
    assert.doesNotMatch(b, /privileged|pid: host|cap_add/, svc);
    assert.match(b, /^\s{4}cap_drop: \[ALL\]$/m);
    assert.match(b, /no-new-privileges:true/);
    assert.match(b, /^\s{4}mem_limit: \d+m$/m);
    assert.match(b, /^\s{4}cpu_shares: (256|512)$/m);
    assert.doesNotMatch(b, /^\s{4}depends_on:/m);
    assert.doesNotMatch(b, /^\s{4}profiles:/m, svc + ' is part of the base stack (no profile)');
    assert.ok(/<<: \*common/.test(b) || /logging:\n\s+driver: json-file\n\s+options: \{max-size: '\d+m', max-file: '\d+'\}/.test(b), svc + ' log cap');
  }
  const a = block(text, 'activator');
  assert.match(a, /^\s{4}network_mode: host$/m);
  assert.match(a, /^\s{4}read_only: true$/m);
  assert.match(a, /H2Z_ACTIVATOR_EXCLUDED_NETWORKS: \$\{MAINT_AP_NETWORK:-192\.168\.234\.0\/24\}/);
  assert.deepEqual(a.match(/^\s{6}- .*$/gm).map((l) => l.trim()), ['- activator-run:/run/h2z-activator'], 'activator mounts only its socket volume (no host path)');
  const br = block(text, 'bridge');
  assert.match(br, /<<: \*common/, 'bridge is on the stack network (same as zlm)');
  assert.match(block(text, 'zlm'), /<<: \*common/);
  assert.deepEqual(br.match(/^\s{6}- .*$/gm).map((l) => l.trim()), ['- bridge-data:/data']);
  assert.match(br, /H2Z_BRIDGE_PUBLIC_HOST: bridge/);
  assert.match(text, /^  activator-run: \{\}$/m);
  assert.match(text, /^  bridge-data: \{\}$/m);
});

test('compose.yaml: the backend is wired by environment and the socket volume only; no service depends on activator or bridge', () => {
  const text = read('compose.yaml');
  const b = block(text, 'backend');
  assert.match(b, /^\s{6}IOC_ACTIVATOR_SOCKET: \/run\/h2z-activator\/activator\.sock$/m);
  assert.match(b, /^\s{6}IOC_BRIDGE_URL: http:\/\/bridge:8600$/m);
  assert.match(b, /^\s{6}- activator-run:\/run\/h2z-activator:ro$/m);
  assert.match(text, /^x-common: &common\n(?:  .*\n)*?  group_add: \['20001'\]/m, 'backend (common) is in group 20001 = the socket group');
  // any "activator:" / "bridge:" key deeper than a service name would be a depends_on (or similar) entry
  assert.doesNotMatch(text, /^\s{6,}(activator|bridge):/m);
  for (const f of ['compose.lean.yaml', 'compose.pack-ai.yaml', 'compose.pack-iot.yaml', 'compose.pack-vision.yaml', 'compose.pack-remote.yaml']) {
    assert.doesNotMatch(read(f), /^\s+(activator|bridge):/m, f + ' leaves the two services alone (they come from compose.yaml in every form)');
  }
});

test('.env.example lists both images; init.mjs adds them to an older .env once and never overwrites a pinned tag', () => {
  const envText = read('.env.example');
  const init = read('scripts/init.mjs');
  for (const [key, ref] of Object.values(MODULES)) {
    assert.match(envText, new RegExp(`^${key}=${ref.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.ok(init.includes(`${key}: '${ref}'`));
  }
  assert.match(init, /moduleImages[\s\S]{0,400}if \(!new RegExp\(`\^\$\{key\}=`, 'm'\)\.test\(env\)\)/);
});

test('init.mjs really keeps a pinned module image and adds the missing one (run in a scratch copy)', () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'h2z-mod-init-'));
  for (const f of ['scripts', 'config', '.env.example']) fs.cpSync(path.join(root, f), path.join(w, f), { recursive: true });
  const pinned = 'ghcr.io/h2ztech/h2z-bridge:20261124-0238-b93e859';
  fs.writeFileSync(path.join(w, '.env'), read('.env.example').replace(/^ACTIVATOR_IMAGE=.*\n/m, '').replace(/^BRIDGE_IMAGE=.*$/m, 'BRIDGE_IMAGE=' + pinned));
  const r = spawnSync(process.execPath, [path.join(w, 'scripts/init.mjs')], { cwd: w, encoding: 'utf8', env: { ...process.env, HOST_LSM: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = fs.readFileSync(path.join(w, '.env'), 'utf8').split(/\r?\n/);
  assert.deepEqual(lines.filter((l) => l.startsWith('BRIDGE_IMAGE=')), ['BRIDGE_IMAGE=' + pinned]);
  assert.deepEqual(lines.filter((l) => l.startsWith('ACTIVATOR_IMAGE=')), ['ACTIVATOR_IMAGE=' + MODULES.activator[1]]);
  fs.rmSync(w, { recursive: true, force: true });
});

test('check-images: an old .env (no ACTIVATOR_IMAGE / BRIDGE_IMAGE) still gets both images checked, from the compose defaults; .env wins when set', () => {
  const compose = read('compose.yaml');
  const oldEnv = 'BACKEND_IMAGE=ghcr.io/h2ztech/h2z-backend:latest\nPOSTGRES_IMAGE=postgres:16-alpine\nHTTP_PORT=8096\n';
  const refs = imageRefs(oldEnv, [compose]);
  const by = Object.fromEntries(refs.map(([n, i, s]) => [n, [i, s]]));
  assert.deepEqual(by.ACTIVATOR_IMAGE, [MODULES.activator[1], 'compose default']);
  assert.deepEqual(by.BRIDGE_IMAGE, [MODULES.bridge[1], 'compose default']);
  assert.deepEqual(by.BACKEND_IMAGE, ['ghcr.io/h2ztech/h2z-backend:latest', '.env']);
  assert.equal(by.HTTP_PORT, undefined);
  // a pinned tag in .env replaces the default; an empty value falls back to the default (same as ${VAR:-default})
  const pinned = imageRefs(oldEnv + 'BRIDGE_IMAGE=ghcr.io/h2ztech/h2z-bridge:20261124-0238-b93e859\nACTIVATOR_IMAGE=\n', [compose]);
  const byPinned = Object.fromEntries(pinned.map(([n, i, s]) => [n, [i, s]]));
  assert.deepEqual(byPinned.BRIDGE_IMAGE, ['ghcr.io/h2ztech/h2z-bridge:20261124-0238-b93e859', '.env']);
  assert.deepEqual(byPinned.ACTIVATOR_IMAGE, [MODULES.activator[1], 'compose default']);
  // the current .env.example alone already covers both
  const fresh = Object.fromEntries(imageRefs(read('.env.example')).map(([n, i]) => [n, i]));
  assert.equal(fresh.ACTIVATOR_IMAGE, MODULES.activator[1]);
  assert.equal(fresh.BRIDGE_IMAGE, MODULES.bridge[1]);
  // no duplicates, no empty refs
  assert.equal(new Set(refs.map(([n]) => n)).size, refs.length);
  assert.ok(refs.every(([, i]) => i && !/\s/.test(i)));
});

test('check-images CLI: with a fake docker, an old .env reports PASS for both module images (compose default) and exits 0; a missing platform fails', { skip: process.platform === 'win32' ? 'needs sh' : false }, () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'h2z-mod-chk-'));
  fs.mkdirSync(path.join(w, 'scripts')); fs.mkdirSync(path.join(w, 'bin'));
  fs.copyFileSync(path.join(root, 'scripts/check-images.mjs'), path.join(w, 'scripts/check-images.mjs'));
  fs.copyFileSync(path.join(root, 'compose.yaml'), path.join(w, 'compose.yaml'));
  fs.writeFileSync(path.join(w, '.env'), 'POSTGRES_IMAGE=postgres:16-alpine\n');
  fs.writeFileSync(path.join(w, 'bin/docker'), `#!/bin/sh
for a; do ref=$a; done
case "$ref" in *"$FAKE_NO_ARM64"*) [ -n "$FAKE_NO_ARM64" ] && { echo '[{"Descriptor":{"platform":{"architecture":"amd64","os":"linux"}}}]'; exit 0; };; esac
echo '[{"Descriptor":{"platform":{"architecture":"amd64","os":"linux"}}},{"Descriptor":{"platform":{"architecture":"arm64","os":"linux"}}}]'
`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync(process.execPath, [path.join(w, 'scripts/check-images.mjs'), 'arm64'], { encoding: 'utf8', env: { ...process.env, PATH: path.join(w, 'bin') + ':' + process.env.PATH, ...extra } });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^PASS ACTIVATOR_IMAGE ghcr\.io\/h2ztech\/h2z-activator:latest arm64 \(compose default, not set in \.env\)$/m);
  assert.match(ok.stdout, /^PASS BRIDGE_IMAGE ghcr\.io\/h2ztech\/h2z-bridge:latest arm64 \(compose default, not set in \.env\)$/m);
  assert.match(ok.stdout, /^PASS POSTGRES_IMAGE postgres:16-alpine arm64$/m);
  const bad = run({ FAKE_NO_ARM64: 'h2z-bridge' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL BRIDGE_IMAGE ghcr\.io\/h2ztech\/h2z-bridge:latest registry or linux\/arm64 unavailable/m);
  fs.rmSync(w, { recursive: true, force: true });
});

test('uninstall.sh (and the fnOS copy): --purge removes every named volume of the project, so bridge-data and activator-run are covered without a list', () => {
  const text = read('compose.yaml');
  const project = /^name: (\S+)$/m.exec(text)[1];
  for (const f of ['uninstall.sh', 'fnos/app/uninstall.sh']) {
    const sh = read(f);
    assert.match(sh, new RegExp(`^PROJECT=${project}$`, 'm'), f + ' uses the compose project name');
    assert.match(sh, /--profile '\*' down --remove-orphans --volumes/, f + ': compose down --volumes (all declared named volumes)');
    assert.match(sh, /docker volume ls -q --filter "label=com\.docker\.compose\.project=\$PROJECT"/, f + ': label sweep for leftovers');
    assert.doesNotMatch(sh, /pg-data|backend-data|edge-link-data/, f + ' keeps no hard-coded volume list (a list would have to name bridge-data and activator-run)');
  }
  // both volumes are named volumes declared at the top level (compose labels them with the project, which is what the sweep matches)
  const vols = text.slice(text.search(/^volumes:$/m));
  assert.match(vols, /^  bridge-data: \{\}$/m);
  assert.match(vols, /^  activator-run: \{\}$/m);
  // safe mode (no --purge) keeps data: bridge channels survive an uninstall + reinstall
  assert.match(read('uninstall.sh'), /else\n\s+quiet docker compose --project-directory "\$DIR" -p "\$PROJECT" --profile '\*' down --remove-orphans\n/);
});

test('update.sh and the fnOS launcher bring the new services up with no extra command (whole-stack pull + up, images from compose)', () => {
  const up = read('scripts/update.sh');
  assert.match(up, /^git pull --ff-only$/m);
  assert.match(up, /^docker compose pull --ignore-pull-failures$/m);
  assert.match(up, /^docker compose up -d --build --wait --wait-timeout 300 --remove-orphans$/m);
  const at = (line) => up.indexOf('\n' + line + '\n');
  assert.ok(at('git pull --ff-only') < at('docker compose pull --ignore-pull-failures') && at('docker compose pull --ignore-pull-failures') < at('docker compose up -d --build --wait --wait-timeout 300 --remove-orphans'), 'order: code, images, start');
  assert.doesNotMatch(up, /docker compose (pull|up)[^\n]* (backend|web|zlm)\b/, 'no service list: every service of compose.yaml, new ones included');
  assert.match(up, /OUR_REGISTRY:-ghcr\.io\/h2ztech\//, 'old module images are pruned with the rest of our registry');
  const main = read('fnos/cmd/main');
  assert.match(main, /docker compose config --images/, 'fnOS: missing images are computed from compose (new services included)');
  assert.doesNotMatch(read('fnos/cmd/main') + read('fnos/build.sh'), /h2z-backend:|h2z-recorder:/, 'fnOS has no image list of its own');
  assert.match(read('install.sh'), /docker compose pull; do[\s\S]*docker compose up -d --wait/);
});

const haveCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
test('rendered config (docker compose config): old .env -> both services with default images; no hard dependency anywhere; same result with compose.lean.yaml', { skip: haveCompose ? false : 'no docker compose plugin' }, () => {
  const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h2z-mod-cfg-')), 'empty.env');
  fs.writeFileSync(empty, '');
  const env = { ...process.env, ...Object.fromEntries(read('.env.example').split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1) || 'x']; })), COMPOSE_PROFILES: 'recorder' };
  delete env.COMPOSE_FILE; delete env.ACTIVATOR_IMAGE; delete env.BRIDGE_IMAGE; env.RECORDER_POOL_DIR = '';
  for (const files of [['compose.yaml'], ['compose.yaml', 'compose.lean.yaml']]) {
    const r = spawnSync('docker', ['compose', '--project-directory', root, '--env-file', empty, ...files.flatMap((f) => ['-f', path.join(root, f)]), 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    const { activator, bridge, backend, zlm } = cfg.services;
    assert.equal(activator.image, MODULES.activator[1]);
    assert.equal(bridge.image, MODULES.bridge[1]);
    assert.equal(activator.ports, undefined); assert.equal(bridge.ports, undefined);
    assert.equal(activator.network_mode, 'host');
    assert.deepEqual(Object.keys(bridge.networks), Object.keys(zlm.networks));
    assert.equal(backend.environment.IOC_ACTIVATOR_SOCKET, '/run/h2z-activator/activator.sock');
    assert.equal(backend.environment.IOC_BRIDGE_URL, 'http://bridge:8600');
    assert.ok(backend.volumes.some((v) => v.source === 'activator-run' && v.target === '/run/h2z-activator' && v.read_only === true));
    for (const [name, s] of Object.entries(cfg.services)) for (const dep of Object.keys(s.depends_on || {})) assert.ok(!MODULES[dep], `${name} must not depend on ${dep}`);
    for (const s of [activator, bridge]) assert.ok(s.cpu_shares < zlm.cpu_shares && s.cpu_shares < cfg.services.recorder.cpu_shares, 'recording keeps the highest CPU weight');
    for (const name of ['recorder', 'recorder-playback', 'storage-agent', 'zlm']) assert.doesNotMatch(JSON.stringify(cfg.services[name]), /activator|bridge-data|h2z-bridge|IOC_BRIDGE/, name);
    assert.ok(cfg.volumes['activator-run'] && cfg.volumes['bridge-data']);
  }
});
