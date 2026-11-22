// 板子看门狗（host/watchdog.sh）：用假的 ip / ping / docker / df … 跑真脚本，核对动作、限频、暂停和 status.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, '..', 'host', 'watchdog.sh');

const fakes = {
  ip: `#!/bin/sh
case "$*" in
  "-o link show up") echo "1: lo: <LOOPBACK,UP,LOWER_UP>"; [ "$FAKE_LINK" = 1 ] && echo "2: eth0: <BROADCAST,UP,LOWER_UP> mtu 1500" || echo "2: eth0: <NO-CARRIER,BROADCAST,UP> mtu 1500"; echo "3: docker0: <UP,LOWER_UP>";;
  "-o link show eth0") [ "$FAKE_LINK" = 1 ] && echo "2: eth0: <BROADCAST,UP,LOWER_UP>" || echo "2: eth0: <NO-CARRIER,UP>";;
  "-o -4 addr show eth0") [ "$FAKE_IP" = 1 ] && echo "2: eth0    inet 10.0.0.5/24 brd 10.0.0.255";;
  "route show default") [ -n "$FAKE_GW" ] && echo "default via $FAKE_GW dev eth0";;
esac`,
  ping: `#!/bin/sh
for a; do t=$a; done
if [ "$t" = "$FAKE_GW" ]; then [ "$FAKE_GWOK" = 1 ]; else [ "$FAKE_INET" = 1 ]; fi`,
  getent: '#!/bin/sh\n[ "$FAKE_DNS" = 1 ] && echo "1.2.3.4 controlplane.tailscale.com"',
  timeout: '#!/bin/sh\nshift\nexec "$@"',
  logger: '#!/bin/sh\necho "logger $*" >> "$FAKE_LOG"',
  systemctl: `#!/bin/sh
echo "systemctl $*" >> "$FAKE_LOG"
case "$*" in "is-active --quiet NetworkManager") [ "$FAKE_NM" = 1 ];; *) true;; esac`,
  pgrep: '#!/bin/sh\nfor p in $FAKE_TSD_PIDS; do echo $p; done',
  netplan: '#!/bin/sh\necho "netplan $*" >> "$FAKE_LOG"',
  df: `#!/bin/sh
echo "Filesystem 1-blocks Used Available Capacity Mounted"
for a; do p=$a; done
[ "$p" = / ] && echo "/dev/sda2 $FAKE_DF_TOTAL 0 $FAKE_DF_FREE 50% /" || echo "/dev/sdb1 $FAKE_DF_TOTAL 0 $FAKE_DF_FREE 50% /var/lib/docker"`,
  docker: `#!/bin/sh
[ "$FAKE_DOCKER" = 1 ] || { [ "$1" = info ] && exit 1; }
case "$1" in
  info) case "$*" in *DockerRootDir*) echo /var/lib/docker;; esac; exit 0;;
  compose)
    shift 3   # --project-directory DIR
    case "$*" in
      "ps -aq") for s in $(echo "$FAKE_SVCS" | tr ',' ' '); do echo "id-\${s%%:*}"; done;;
      "ps -q tailscale") [ "$FAKE_TS" = none ] || echo id-ts;;
      "config --services") echo backend; [ "$FAKE_TS_DISABLED" = 1 ] || echo tailscale;;
      *) echo "compose $*" >> "$FAKE_LOG";;
    esac;;
  inspect)
    for a; do id=$a; done; n=\${id#id-}
    for s in $(echo "$FAKE_SVCS" | tr ',' ' '); do
      [ "\${s%%:*}" = "$n" ] || continue
      echo "$s" | awk -F: '{print $1, $2, $3, $4}'
    done;;
  exec)
    case "$FAKE_TS" in
      ok) echo '{"BackendState": "Running", "Self": {"Online": true}}';;
      offline) echo '{"BackendState": "Running", "Self": {"Online": false}}';;
      stopped) echo '{"BackendState": "NeedsLogin", "Self": {"Online": false}}';;
    esac;;
esac`,
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [n, body] of Object.entries(fakes)) fs.writeFileSync(path.join(bin, n), body + '\n', { mode: 0o755 });
  const base = {
    PATH: bin + ':/usr/bin:/bin', H2Z_DIR: '/opt/h2z.security', WATCHDOG_STATE_DIR: path.join(dir, 'state'), FAKE_LOG: path.join(dir, 'log'),
    FAKE_LINK: '1', FAKE_IP: '1', FAKE_GW: '10.0.0.1', FAKE_GWOK: '1', FAKE_DNS: '1', FAKE_INET: '1', FAKE_NM: '0', FAKE_DOCKER: '1', FAKE_TS: 'ok',
    FAKE_SVCS: 'backend:unless-stopped:running:healthy,recorder:unless-stopped:running:,secrets-init:no:exited:', FAKE_DF_TOTAL: '100000000000', FAKE_DF_FREE: '50000000000',
  };
  fs.writeFileSync(base.FAKE_LOG, '');
  // 假的 /proc：每个 tailscaled 进程的 cgroup（FAKE_TSD_PIDS 里的进程）
  const proc = path.join(dir, 'proc');
  for (const [pid, cg] of [['111', '0::/system.slice/docker-abc.scope'], ['222', '0::/system.slice/trim_app_center.service']]) { fs.mkdirSync(path.join(proc, pid), { recursive: true }); fs.writeFileSync(path.join(proc, pid, 'cgroup'), cg + '\n'); }
  base.WATCHDOG_PROC = proc;
  const run = (now, env = {}) => {
    execFileSync('/bin/sh', [script], { env: { ...base, ...env, WATCHDOG_NOW: String(now) }, stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(path.join(base.WATCHDOG_STATE_DIR, 'status.json'), 'utf8'));
  };
  const log = () => fs.readFileSync(base.FAKE_LOG, 'utf8');
  return { run, log, base };
}

test('一切正常：不动；状态文件是合法 JSON，有网络 / Tailscale / Docker / 服务 / 磁盘', () => {
  const { run, log } = setup();
  const s = run(1000);
  assert.equal(s.version, 1);
  assert.deepEqual([s.net.link, s.net.ip, s.net.gateway, s.net.gatewayOk, s.net.internet], [true, true, '10.0.0.1', true, true]);
  assert.deepEqual([s.tailscale.state, s.tailscale.online, s.docker.ok], ['Running', true, true]);
  assert.deepEqual(s.services.down, []); // 一次性的 secrets-init 退出是正常的
  assert.equal(s.disks.length, 2);
  assert.equal(s.disks[0].freePct, 50);
  assert.deepEqual(s.actions, []);
  assert.doesNotMatch(log(), /compose|systemctl restart/);
});

test('外网通、Tailscale 不在线：5 分钟后重启 tailscale 容器，15 分钟内不再重启', () => {
  const { run, log } = setup();
  run(1000, { FAKE_TS: 'offline' });
  assert.doesNotMatch(log(), /restart tailscale/);
  run(1299, { FAKE_TS: 'offline' });
  assert.doesNotMatch(log(), /restart tailscale/);
  const s = run(1300, { FAKE_TS: 'offline' });
  assert.equal(log().match(/compose restart tailscale/g).length, 1);
  assert.equal(s.actions[0].action, 'restart-tailscale');
  assert.match(s.actions[0].detail, /offline for 5 min/);
  run(1400, { FAKE_TS: 'offline' });
  assert.equal(log().match(/compose restart tailscale/g).length, 1);
  run(2200, { FAKE_TS: 'offline' });
  assert.equal(log().match(/compose restart tailscale/g).length, 2);
  // 没有 tailscale 容器：up -d tailscale
  const b = setup();
  b.run(1000, { FAKE_TS: 'none' });
  b.run(1300, { FAKE_TS: 'none' });
  assert.match(b.log(), /compose up -d tailscale/);
});

test('现场断网（外网不通）：不重启 Tailscale，也不重启网络（网关通）', () => {
  const { run, log } = setup();
  for (const t of [1000, 1400, 2000, 4000]) run(t, { FAKE_TS: 'offline', FAKE_INET: '0' });
  const s = run(5000, { FAKE_TS: 'offline', FAKE_INET: '0' });
  assert.doesNotMatch(log(), /restart tailscale|systemctl restart|netplan/);
  assert.equal(s.net.internet, false);
  assert.equal(s.net.internetDownSec, 4000);
});

test('网口通、网关不通：5 分钟后重启网络服务（NetworkManager / netplan），30 分钟最多一次；网线拔了不动', () => {
  const { run, log } = setup();
  run(1000, { FAKE_GWOK: '0', FAKE_NM: '1' });
  run(1300, { FAKE_GWOK: '0', FAKE_NM: '1' });
  assert.match(log(), /systemctl restart NetworkManager/);
  run(1900, { FAKE_GWOK: '0', FAKE_NM: '1' });
  assert.equal(log().match(/restart NetworkManager/g).length, 1);
  const b = setup();
  b.run(1000, { FAKE_IP: '0' });
  const s = b.run(1300, { FAKE_IP: '0' });
  assert.match(b.log(), /netplan apply/);
  assert.match(s.actions[0].detail, /no address/);
  const c = setup(); // 网线拔了（没有 LOWER_UP）：不是我们能修的
  c.run(1000, { FAKE_LINK: '0', FAKE_IP: '0' });
  c.run(1400, { FAKE_LINK: '0', FAKE_IP: '0' });
  assert.doesNotMatch(c.log(), /netplan|systemctl restart/);
});

test('我们的容器退出 / 不健康：连续 2 次才 docker compose up -d，10 分钟最多一次', () => {
  const { run, log } = setup();
  const env = { FAKE_SVCS: 'backend:unless-stopped:running:unhealthy,recorder:unless-stopped:exited:,secrets-init:no:exited:' };
  let s = run(1000, env);
  assert.deepEqual(s.services.down, ['backend', 'recorder']);
  assert.doesNotMatch(log(), /compose up -d/);
  s = run(1060, env);
  assert.equal(log().match(/^compose up -d$/gm).length, 1);
  assert.match(s.actions[0].detail, /backend recorder/);
  run(1120, env);
  assert.equal(log().match(/^compose up -d$/gm).length, 1);
  run(1700, env);
  assert.equal(log().match(/^compose up -d$/gm).length, 2);
});

test('暂停（更新时）：照样写状态，不做任何动作；到期自动恢复', () => {
  const { run, log, base } = setup();
  fs.mkdirSync(base.WATCHDOG_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(base.WATCHDOG_STATE_DIR, 'pause'), '2000');
  const env = { FAKE_TS: 'offline', FAKE_SVCS: 'backend:unless-stopped:exited:' };
  for (const t of [1000, 1100, 1400]) run(t, env);
  const s = run(1500, env);
  assert.equal(s.paused, true);
  assert.doesNotMatch(log(), /compose (restart|up)/);
  const after = run(2100, env);
  assert.equal(after.paused, false);
  assert.match(log(), /compose restart tailscale/);
});

test('Docker 卡死：只记录，不重启 Docker、不动容器；磁盘少于 5% 标出来', () => {
  const { run, log } = setup();
  run(1000, { FAKE_DOCKER: '0' });
  const s = run(1700, { FAKE_DOCKER: '0', FAKE_DF_FREE: '3000000000' });
  assert.deepEqual([s.docker.ok, s.docker.downSec], [false, 700]);
  assert.doesNotMatch(log(), /systemctl restart docker|compose/);
  assert.equal(s.disks[0].low, true);
  assert.equal(s.disks[0].freePct, 3);
});

test('本机已有别的 Tailscale（飞牛自带，不在容器里）：不管 Tailscale，不拉起 / 重启我们的容器', () => {
  const { run, log } = setup();
  for (const t of [1000, 1300, 2200]) run(t, { FAKE_TS: 'none', FAKE_TSD_PIDS: '222' });
  const s = run(2300, { FAKE_TS: 'none', FAKE_TSD_PIDS: '222' });
  assert.equal(s.tailscale.state, 'HostTailscale');
  assert.doesNotMatch(log(), /tailscale/);
  assert.deepEqual(s.actions, []);
  // 进程在我们的容器里（docker cgroup）：照常管
  const b = setup();
  b.run(1000, { FAKE_TS: 'offline', FAKE_TSD_PIDS: '111' });
  b.run(1300, { FAKE_TS: 'offline', FAKE_TSD_PIDS: '111' });
  assert.match(b.log(), /compose restart tailscale/);
});

test('本机禁用了 tailscale 服务（compose.override.yaml profiles）：不 up -d tailscale（点名会绕过 profiles）', () => {
  const { run, log } = setup();
  for (const t of [1000, 1300, 2200]) run(t, { FAKE_TS: 'none', FAKE_TS_DISABLED: '1' });
  const s = run(2300, { FAKE_TS: 'none', FAKE_TS_DISABLED: '1' });
  assert.equal(s.tailscale.state, 'Disabled');
  assert.doesNotMatch(log(), /up -d tailscale|restart tailscale/);
});
