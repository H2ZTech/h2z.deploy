// 旁挂宿主补齐脚本（host/setup-host.sh）的 --check：在临时根目录里用假命令跑，核对「缺什么 / 什么时候不碰网口」。
// 只测 --check（不改系统）；apply 要 apt / systemd，在真机上验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, '..');
const script = path.join(repo, 'host', 'setup-host.sh');

const NETPLAN_DHCP = 'network:\n  ethernets:\n    enp7s0:\n      dhcp4: true\n  version: 2\n';
const NETPLAN_STATIC = 'network:\n  ethernets:\n    enp7s0:\n      addresses: [10.0.0.5/24]\n      dhcp4: false\n  version: 2\n';
const NETPLAN_NM = 'network:\n  renderer: NetworkManager\n  ethernets:\n    enp7s0:\n      dhcp4: true\n  version: 2\n';

/** 假系统：docker / cloudflared / 网口初始化 / 看门狗各自装了没有，netplan 内容，默认路由，networkd 在不在 */
function run({ docker = true, cloudflared = true, hostEnv = true, watchdog = true, netplan = NETPLAN_DHCP, route = 'default via 10.0.0.1 dev enp7s0 proto dhcp src 10.0.0.9', networkd = true, manual = null, args = ['--check'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const root = path.join(dir, 'root'), bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // 只放脚本用到的真命令，免得开发机上真有 docker / netplan 影响结果
  for (const c of ['dirname', 'id', 'ls', 'cat', 'sed', 'grep', 'cmp', 'rm', 'mkdir']) {
    const p = ['/usr/bin', '/bin'].map((d) => path.join(d, c)).find((f) => fs.existsSync(f));
    assert.ok(p, `缺少命令 ${c}`);
    fs.symlinkSync(p, path.join(bin, c));
  }
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (docker) stub('docker', 'exit 0');
  if (cloudflared) fs.mkdirSync(path.join(root, 'usr/bin'), { recursive: true }), fs.writeFileSync(path.join(root, 'usr/bin/cloudflared'), '#!/bin/sh\n', { mode: 0o755 });
  stub('systemctl', `case "$*" in *systemd-networkd*) exit ${networkd ? 0 : 3};; *is-enabled*) exit ${watchdog ? 0 : 1};; esac; exit 0`);
  stub('ip', `echo "${route}"`);
  stub('netplan', 'exit 0');
  fs.mkdirSync(path.join(root, 'etc/netplan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/netplan/00-installer-config.yaml'), netplan);
  if (hostEnv) fs.mkdirSync(path.join(root, 'etc/h2z'), { recursive: true }), fs.writeFileSync(path.join(root, 'etc/h2z/host.env'), '');
  if (manual) fs.mkdirSync(path.join(root, 'etc/h2z'), { recursive: true }), fs.writeFileSync(path.join(root, 'etc/h2z/setup-host.manual'), manual + '\n');
  if (watchdog) {
    fs.mkdirSync(path.join(root, 'usr/local/lib/h2z'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'host/watchdog.sh'), path.join(root, 'usr/local/lib/h2z/watchdog.sh'));
  }
  const r = spawnSync('/bin/sh', [script, ...args], { env: { PATH: bin, H2Z_INSTALL_ROOT: root }, encoding: 'utf8' });
  return { r, out: r.stdout + r.stderr, root };
}

test('什么都齐：退出 0，说宿主都已就绪', () => {
  const { r, out } = run();
  assert.equal(r.status, 0, out);
  assert.match(out, /Host layer is complete/);
  assert.doesNotMatch(out, /\[pending\]/);
});

test('一台全新的旁挂机器（DHCP + networkd）：docker / cloudflared / 网口 / 看门狗都列为待补，退出 3', () => {
  const { r, out } = run({ docker: false, cloudflared: false, hostEnv: false, watchdog: false });
  assert.equal(r.status, 3, out);
  for (const w of ['docker + compose not installed', 'cloudflared not installed', 'NICs / hotspot not initialized yet', 'board watchdog missing']) assert.match(out, new RegExp(w.replace(/[+/]/g, '\\$&')), w);
  assert.match(out, /Pending:\s+docker cloudflared network watchdog/);
});

test('只缺 cloudflared：只列它', () => {
  const { r, out } = run({ cloudflared: false });
  assert.equal(r.status, 3, out);
  assert.match(out, /Pending:\s+cloudflared\b/);
  assert.doesNotMatch(out, /\[pending\] (docker|NICs|board watchdog)/);
});

test('看门狗脚本和仓库里的不一样：算待补（更新后自动换新）', () => {
  const { root } = run();
  fs.appendFileSync(path.join(root, 'usr/local/lib/h2z/watchdog.sh'), '# 旧版本\n');
  const r = spawnSync('/bin/sh', [script, '--check'], { env: { PATH: path.join(root, '..', 'bin'), H2Z_INSTALL_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /board watchdog missing or outdated/);
});

test('网口保护：静态地址 / NetworkManager / 不是 DHCP / networkd 没跑 —— check 下仍待补（要 apply 时才决定跳过），有 manual 标记就只提示不待补', () => {
  for (const c of [{ netplan: NETPLAN_STATIC, why: 'static address' }, { netplan: NETPLAN_NM, why: 'NetworkManager' }, { route: 'default via 10.0.0.1 dev enp7s0 src 10.0.0.9', why: 'default route' }, { networkd: false, why: 'networkd' }]) {
    const { why, ...opt } = c;
    // 没有 manual 标记：还没判断过 → 待补（apply 时会判断并写标记）
    const a = run({ hostEnv: false, ...opt });
    assert.equal(a.r.status, 3, `${why}\n${a.out}`);
    assert.match(a.out, /NICs \/ hotspot not initialized yet \(automatic takeover would be blocked: /, `${why}\n${a.out}`);
    assert.match(a.out, new RegExp(why), `${why}\n${a.out}`);
    // 有 manual 标记：判断过了，不再每次催
    const b = run({ hostEnv: false, manual: `reason: ${why}`, ...opt });
    assert.equal(b.r.status, 0, `${why}\n${b.out}`);
    assert.match(b.out, /\[manual\] NICs \/ hotspot were not taken over automatically: reason: /, why);
    assert.match(b.out, /--network=force/);
  }
});

test('DHCP + networkd 的正常机器：待补但没有「被拦下」的原因', () => {
  const { r, out } = run({ hostEnv: false });
  assert.equal(r.status, 3, out);
  assert.match(out, /\[pending\] NICs \/ hotspot not initialized yet$/m);
  assert.doesNotMatch(out, /would be blocked/);
});

test('--network=skip：不碰网口', () => {
  const { r, out } = run({ hostEnv: false, args: ['--check', '--network=skip'] });
  assert.equal(r.status, 0, out);
  assert.match(out, /\[skipped\] NICs/);
});

test('网口已初始化（host.env 在）：不管 netplan 是什么样都算 ok', () => {
  const { r, out } = run({ netplan: NETPLAN_STATIC });
  assert.equal(r.status, 0, out);
  assert.match(out, /\[ok\]   NICs/);
});

test('不认识的参数：退出 2', () => {
  const { r } = run({ args: ['--bogus'] });
  assert.equal(r.status, 2);
});
