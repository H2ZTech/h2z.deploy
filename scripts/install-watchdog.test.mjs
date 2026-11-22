// 看门狗安装脚本（host/install-watchdog.sh）：在临时根目录里整个跑一遍（假 systemctl / uname / getent），
// 核对装了哪些文件、硬件看门狗设不设（普通板子 / 飞牛 / 虚拟机）、最后一行提示。2026-11-02 LA9 上最后一行写错（没引号的中文带空格）后补的测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, '..', 'host', 'install-watchdog.sh');

function run({ kernel = '6.1.0-rockchip', marks = [], osRelease = 'PRETTY_NAME="Ubuntu 24.04"', hwdog = false, linked = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-'));
  const root = path.join(dir, 'root'), bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'etc', 'os-release'), osRelease);
  for (const m of marks) { fs.mkdirSync(path.dirname(path.join(root, m)), { recursive: true }); fs.writeFileSync(path.join(root, m), ''); }
  if (hwdog) { fs.mkdirSync(path.join(root, 'dev'), { recursive: true }); fs.writeFileSync(path.join(root, 'dev', 'watchdog'), ''); }
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${log}"\ncase "$*" in "is-active h2z-watchdog.timer") echo active;; *RuntimeWatchdogUSec*) echo 1min;; esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${kernel}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'getent'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  if (linked) { // 先跑过 setup-host-network.sh：单元已 systemctl link 成指向仓库的符号链接
    fs.mkdirSync(path.join(root, 'etc/systemd/system'), { recursive: true });
    for (const u of ['h2z-watchdog.service', 'h2z-watchdog.timer']) fs.symlinkSync(path.join(path.dirname(script), 'systemd', u), path.join(root, 'etc/systemd/system', u));
  }
  fs.writeFileSync(log, '');
  const r = spawnSync('/bin/sh', [script], { env: { PATH: bin + ':/usr/bin:/bin', H2Z_INSTALL_ROOT: root }, encoding: 'utf8' });
  return { r, root, log: fs.readFileSync(log, 'utf8') };
}

test('普通板子（Orange Pi，有硬件看门狗）：装好文件、设硬件看门狗、启用定时器，最后一行提示正确', () => {
  const { r, root, log } = run({ hwdog: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  for (const f of ['usr/local/lib/h2z/watchdog.sh', 'etc/systemd/system/h2z-watchdog.service', 'etc/systemd/system/h2z-watchdog.timer', 'etc/h2z/watchdog.env']) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.match(fs.readFileSync(path.join(root, 'etc/h2z/watchdog.env'), 'utf8'), /^H2Z_DIR='.+'/);
  assert.match(fs.readFileSync(path.join(root, 'etc/systemd/system.conf.d/h2z-watchdog.conf'), 'utf8'), /RuntimeWatchdogSec=60/);
  assert.match(log, /daemon-reexec/);
  assert.match(log, /enable --now h2z-watchdog.timer/);
  assert.equal(r.stdout.trim(), 'watchdog: active; hardware watchdog: 1min; status: /var/lib/h2z/watchdog/status.json');
});

test('飞牛（LA9）：认出 NAS，不改硬件看门狗、不 daemon-reexec；最后一行写明', () => {
  for (const o of [{ marks: ['/usr/trim'] }, { kernel: '6.18.18.c1126-trim' }, { osRelease: 'NAME="fnOS"' }]) {
    const { r, root, log } = run(o);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system.conf.d/h2z-watchdog.conf')), false);
    assert.doesNotMatch(log, /daemon-reexec/);
    assert.match(r.stdout, /hardware watchdog: unchanged \(the NAS system manages it, /);
  }
});

test('虚拟机（LA18，没有 /dev/watchdog）：照样装，提示 systemd 跳过', () => {
  const { r } = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /hardware watchdog: none \(virtual machine or no driver, systemd skips it\)/);
});

test('单元已被 setup-host-network.sh link 成指向仓库的符号链接：不报「same file」，照常装完（LA18 旁挂补宿主时踩到）', () => {
  const { r, root, log } = run({ linked: true });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /same file/);
  assert.ok(fs.lstatSync(path.join(root, 'etc/systemd/system/h2z-watchdog.timer')).isSymbolicLink(), '符号链接保持不变');
  assert.match(log, /enable --now h2z-watchdog.timer/);
});
