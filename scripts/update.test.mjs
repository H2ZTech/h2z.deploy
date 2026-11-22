// 板子更新（scripts/update.sh）：用假的 docker / df / git 跑真脚本，核对查空间、顺序、只清我们自己的旧镜像（留上一版）、更新时暂停看门狗。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const R = 'ghcr.io/h2ztech'; // 我们自己的镜像命名空间

const fakes = {
  df: `#!/bin/sh
echo "Filesystem 1-blocks Used Available Capacity Mounted"
f=$FAKE_FREE_GB; grep -q "compose pull" "$FAKE_LOG" 2>/dev/null && f=\${FAKE_FREE_AFTER_GB:-$f}
dev=/dev/x; for last; do :; done
[ -n "$FAKE_ROOT_FREE_GB" ] && [ "$last" = / ] && { dev=/dev/root; f=$FAKE_ROOT_FREE_GB; }
echo "$dev 100000000000 0 $((f * 1000000000)) 50% /"`,
  git: `#!/bin/sh
echo "git $*" >> "$FAKE_LOG"
[ "$1" = pull ] && [ -n "$FAKE_CLOBBER" ] && printf 'echo CLOBBERED; exit 9\n%.0s' $(seq 200) > "$FAKE_CLOBBER"
[ "$1" = log ] && echo "abc123 新版本"; true`,
  du: '#!/bin/sh\ntrue',
  journalctl: '#!/bin/sh\necho "Archived and active journals take up 48.0M"',
  docker: `#!/bin/sh
up=0; grep -q "^compose up" "$FAKE_LOG" 2>/dev/null && up=1
case "$1" in
  info) echo /var/lib/docker;;
  system) echo "TYPE TOTAL SIZE";;
  ps) echo c1; echo c2;;
  inspect)
    for a; do x=$a; done
    case "$*" in
      *"{{.Image}}"*) [ $up = 1 ] && { echo sha256:new1; echo sha256:new2; } || { echo sha256:cur1; echo sha256:cur2; };;
      *"{{.Id}}"*) for a in $(cat); do :; done; echo sha256:cur1; echo sha256:cur2;;
    esac;;
  images)
    for a; do repo=$a; done
    case "$repo" in
      ${R}/backend) [ $up = 1 ] && echo "sha256:new1 ${R}/backend:latest"; echo "sha256:cur1 ${R}/backend:<none>"; echo "sha256:old1 ${R}/backend:<none>";;
      ${R}/h2z-recorder) [ $up = 1 ] && echo "sha256:new2 ${R}/h2z-recorder:latest"; echo "sha256:cur2 ${R}/h2z-recorder:<none>"; echo "sha256:old2 ${R}/h2z-recorder:<none>";;
      *) echo "sha256:node1 $repo:latest";;
    esac;;
  rmi) echo "rmi $2" >> "$FAKE_LOG";;
  compose)
    shift
    case "$*" in
      "config --images") echo "${R}/backend:latest"; echo "node:22-alpine"; echo "${R}/h2z-recorder:latest"; echo "postgres:16";;
      "config --quiet") ;;
      "images -q") echo cur1; echo cur2;;
      up*) p=no; [ -f "$WATCHDOG_STATE_DIR/pause" ] && p=yes; echo "compose $* paused=$p" >> "$FAKE_LOG";;
      *) echo "compose $*" >> "$FAKE_LOG";;
    esac;;
esac`,
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'repo', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(here, 'update.sh'), path.join(dir, 'repo', 'scripts', 'update.sh'));
  for (const [n, body] of Object.entries(fakes)) fs.writeFileSync(path.join(bin, n), body + '\n', { mode: 0o755 });
  const env = { PATH: bin + ':/usr/bin:/bin', FAKE_LOG: path.join(dir, 'log'), WATCHDOG_STATE_DIR: path.join(dir, 'wd'), FAKE_FREE_GB: '50' };
  fs.mkdirSync(env.WATCHDOG_STATE_DIR);
  fs.writeFileSync(env.FAKE_LOG, '');
  const run = (args = [], over = {}) => spawnSync('/bin/sh', [path.join(dir, 'repo', 'scripts', 'update.sh'), ...args], { env: { ...env, ...over }, encoding: 'utf8' });
  return { run, log: () => fs.readFileSync(env.FAKE_LOG, 'utf8'), dir, env };
}

test('空间够：拉代码 → 拉镜像 → 启动（暂停看门狗）→ 只清我们自己的旧镜像，留上一版', () => {
  const { run, log, dir, env } = setup();
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const l = log();
  const order = ['git pull --ff-only', 'compose pull', 'compose up -d --build --wait'].map((s) => l.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], l);
  assert.match(l, /compose up .* paused=yes/);
  assert.equal(fs.existsSync(path.join(env.WATCHDOG_STATE_DIR, 'pause')), false, '更新完要恢复看门狗');
  assert.deepEqual(l.match(/^rmi .*/gm).sort(), ['rmi sha256:old1', 'rmi sha256:old2']); // 上一版 cur1 / cur2 留着；公共镜像不碰
  assert.equal(fs.readFileSync(path.join(dir, 'repo', '.h2z-update', 'previous-images'), 'utf8').trim(), 'sha256:cur1\nsha256:cur2');
  assert.match(r.stdout, /Update complete: abc123/);
});

test('空间不够：不拉代码、不拉镜像，列出空间被谁占了和能清的旧镜像', () => {
  const { run, log } = setup();
  const r = run([], { FAKE_FREE_GB: '6' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not enough space \(before update\): \/ has only 6 GB left, at least 10 GB needed/);
  assert.match(r.stdout, /What is using the space/);
  assert.match(r.stdout, /backend:<none> \(sha256:old1\)/);
  assert.doesNotMatch(r.stdout, /node:22|postgres/);
  assert.doesNotMatch(log(), /git pull|compose pull|compose up|rmi/);
});

test('H2Z OS：系统盘 / 只有几 GB、镜像在 /data 很宽裕——不拦（系统盘只要 1 GB）；系统盘真的快满了才拦', () => {
  const ok = setup().run([], { FAKE_FREE_GB: '274', FAKE_ROOT_FREE_GB: '2' });
  assert.doesNotMatch(ok.stdout, /Not enough space/);
  const full = setup().run([], { FAKE_FREE_GB: '274', FAKE_ROOT_FREE_GB: '0' });
  assert.equal(full.status, 1);
  assert.match(full.stdout, /Not enough space \(before update\): \/ has only 0 GB left, at least 1 GB needed/);
});

test('拉完镜像空间不够：不启动新版本（旧版本照跑）；--check 只查不更新；--prune-old 先清再查', () => {
  const a = setup();
  const r = a.run([], { FAKE_FREE_AFTER_GB: '4' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not enough space \(after pulling images\)/);
  assert.doesNotMatch(a.log(), /compose up/);
  const b = setup();
  assert.equal(b.run(['--check']).status, 0);
  assert.doesNotMatch(b.log(), /git pull|compose pull/);
  const c = setup();
  const rc = c.run(['--prune-old', '--check'], { FAKE_FREE_GB: '20' });
  assert.equal(rc.status, 0);
  assert.match(c.log(), /rmi sha256:old1/);
  assert.match(rc.stdout, /Removed \d+ of our old images/);
  assert.equal(c.run(['--bogus']).status, 2);
});

test('git pull 改了脚本本身：照样按原来的步骤跑完（从临时副本跑）', () => {
  const { run, log, dir } = setup();
  const r = run([], { FAKE_CLOBBER: path.join(dir, 'repo', 'scripts', 'update.sh') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /CLOBBERED/);
  assert.match(log(), /compose up/);
  assert.match(r.stdout, /Update complete/);
});

test('runtime/ 是 root 建的、写不了：不影响更新；上一版记在 .h2z-update/；记不下时不清旧镜像', () => {
  const a = setup();
  fs.mkdirSync(path.join(a.dir, 'repo', 'runtime'));
  fs.chmodSync(path.join(a.dir, 'repo', 'runtime'), 0o555);
  const r = a.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(a.dir, 'repo', '.h2z-update', 'previous-images')));
  const b = setup();
  fs.writeFileSync(path.join(b.dir, 'repo', '.h2z-update'), 'not a dir');
  const rb = b.run();
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.match(rb.stdout, /old images will not be pruned after the update/);
  assert.doesNotMatch(b.log(), /^rmi /m);
});
