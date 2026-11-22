// 旁挂机器页面更新的宿主脚本（host/git-update.sh）：假 runuser / git / docker / getent，真跑一遍，核对写进 state.json 的各阶段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, '..', 'host', 'git-update.sh');

function run({ updateRc = 0, postgres = true, dumpOk = true, setupPending = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-'));
  const bin = path.join(dir, 'bin'), repo = path.join(dir, 'repo'), upg = path.join(dir, 'upg');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(repo, 'host')); fs.mkdirSync(upg);
  const calls = path.join(dir, 'calls');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // runuser -u OWNER -- env HOME=x cmd …：丢掉前面的，直接跑后面的（记一笔是以谁的身份）
  stub('runuser', `echo "runuser $2" >> "${calls}"; shift 3; exec "$@"`);
  stub('getent', 'echo "x:x:1000:1000::/home/x:/bin/sh"');
  stub('git', 'case "$*" in *"rev-parse --short HEAD"*) if [ -f "' + path.join(dir, 'updated') + '" ]; then echo bbb2222; else echo aaa1111; fi;; esac');
  stub('docker', `case "$1" in ps) ${postgres ? 'echo cid1' : ''};; exec) ${dumpOk ? 'printf dump | gzip' : 'echo boom >&2; exit 1'};; esac`);
  fs.writeFileSync(path.join(repo, 'scripts/update.sh'), `echo "update.sh ran" ; touch "${path.join(dir, 'updated')}"; [ ${updateRc} -eq 0 ] || { echo "Not enough space"; exit ${updateRc}; }\n`);
  fs.writeFileSync(path.join(repo, 'host/setup-host.sh'), `echo "setup-host $*" >> "${calls}"; case "$1" in --check) exit ${setupPending ? 3 : 0};; esac\n`);
  const r = spawnSync('/bin/sh', [script, repo, 'jackie', upg], { env: { PATH: bin + ':/usr/bin:/bin' }, encoding: 'utf8' });
  const state = fs.existsSync(path.join(upg, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(upg, 'state.json'), 'utf8')) : null;
  return { r, state, upg, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', log: fs.readFileSync(path.join(upg, 'git-update.log'), 'utf8') };
}

test('成功：备份 → update.sh（以属主身份）→ done，状态里有前后提交和备份文件名', () => {
  const { r, state, upg, calls, log } = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(state.job, 'git');
  assert.equal(state.source, 'online');
  assert.equal(state.phase, 'done');
  assert.equal(state.from.commit, 'aaa1111');
  assert.equal(state.to.commit, 'bbb2222');
  assert.match(state.message, /Updated to bbb2222/);
  assert.ok(state.finishedAt);
  assert.match(state.backup, /^db-\d{8}-\d{6}\.sql\.gz$/);
  assert.ok(fs.existsSync(path.join(upg, 'backups', state.backup)));
  assert.match(log, /update\.sh ran/);
  assert.match(calls, /runuser jackie/, '以部署目录属主的身份跑 git / update.sh');
  assert.doesNotMatch(calls, /setup-host(?! --check)/, '没有待补项就不跑宿主补齐');
});

test('宿主层有待补项：更新后补齐（setup-host.sh 以 root 跑，不带参数）', () => {
  const { r, state, calls } = run({ setupPending: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.phase, 'done');
  assert.match(calls, /setup-host --check\nsetup-host \n/);
});

test('备份失败：不更新（update.sh 没跑），failed 并说明', () => {
  const { r, state, log } = run({ dumpOk: false });
  assert.equal(r.status, 1);
  assert.equal(state.phase, 'failed');
  assert.match(state.message, /Database backup failed; nothing was updated/);
  assert.doesNotMatch(log, /update\.sh ran/);
});

test('找不到数据库容器：不更新', () => {
  const { r, state } = run({ postgres: false });
  assert.equal(r.status, 1);
  assert.equal(state.phase, 'failed');
  assert.match(state.message, /Database container not found/);
});

test('update.sh 失败：failed，消息带退出码和日志末尾，没有 done', () => {
  const { r, state } = run({ updateRc: 1 });
  assert.equal(r.status, 1);
  assert.equal(state.phase, 'failed');
  assert.match(state.message, /update\.sh did not succeed \(exit code 1\)/);
  assert.match(state.message, /Not enough space/);
  assert.ok(state.finishedAt);
});

test('状态文件始终是合法 JSON，消息里的引号 / 反斜杠 / 换行不会弄坏它', () => {
  const { state } = run({ updateRc: 1 });
  assert.equal(typeof state.message, 'string');
  assert.equal(state.message.includes('\n'), false);
});
