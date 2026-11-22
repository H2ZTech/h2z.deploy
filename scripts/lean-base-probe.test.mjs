// scripts/lean-base-probe.sh 的测试：用「假 docker」（scripts/testdata/fake-docker.sh）+ 本进程里的假 IOC 接口，
// 测脚本自己的逻辑——干跑不改东西、改栈的顺序、口令打码、刷屏 / 误报判断、失败和 --keep 时的恢复、报警演练。
// 这不是在真 Docker 上跑：真正的结论要在测试机上执行脚本（见 docs/LEAN-BASE-MEASURE.md），这里没验证任何容器行为。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./lean-base-probe.sh', import.meta.url));
const FAKE = fileURLToPath(new URL('./testdata/fake-docker.sh', import.meta.url));
const DEVICE_PASSWORD = 'devpass-123';
const haveTools = (() => { try { execFileSync('bash', ['-c', 'command -v jq curl >/dev/null'], { stdio: 'ignore' }); return true; } catch { return false; } })();

let root, bin, server, port;
const stub = { alarms: [], channels: 0, stateDir: '', hits: [], recorderDelayMs: 0 };

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'lean-probe-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, 'docker'));
  chmodSync(join(bin, 'docker'), 0o755);
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const key = req.headers['x-ioc-device-key'];
    stub.hits.push({ method: req.method, path: p, key });
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (p === '/healthz') return send(200, 'ok');
    if (p === '/ioc/local') return send(200, '<html></html>');
    if (p === '/api/ioc/health' || p === '/api/security/health') return send(200, { ok: true });
    if (p === '/api/ioc/device/network/brief') return send(200, { available: true, currentProject: 'local-1', lang: 'en' });
    if (p === '/api/ioc/device/recording' || p === '/api/ioc/device/channels/streams') return send(200, {});
    if (p.startsWith('/api/ioc/device/network')) {
      if (key !== DEVICE_PASSWORD) return send(403, { error: 'E_DEVICE_KEY' });
      if (p.endsWith('/login')) return send(200, { ok: true });
      if (p.endsWith('/system') || p.endsWith('/upgrade')) return send(200, { ok: true });
      return send(200, { ready: true, tailscale: { available: false, reason: 'Tailscale 服务没有运行' } });
    }
    if (p === '/api/ioc/projects/local-1/network/cameras') return send(200, { cameras: [] });
    if (p === '/api/ioc/projects/local-1/recorder') {
      const body = { online: true, channels: Array.from({ length: stub.channels }, (_, i) => ({ cameraId: i + 1 })) };
      return stub.recorderDelayMs ? void setTimeout(() => send(200, body), stub.recorderDelayMs) : send(200, body);
    }
    if (p === '/api/ioc/projects/local-1/recorder/storage') return send(200, { enabled: false });
    if (p === '/api/ioc/projects/local-1/alarms') {
      const list = [...stub.alarms];
      if (stub.stateDir && existsSync(join(stub.stateDir, 'recorder-stopped'))) list.push('SITEOPS_OFFLINE');
      return send(200, { alarms: list.map((code, i) => ({ id: i + 1, code, status: 'active' })) });
    }
    return send(404, { error: 'E_NOT_FOUND', path: p });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

/** 一次运行用的目录：项目目录（compose.yaml、.env、口令文件）、输出目录、假 docker 状态、看门狗目录 */
function setup(name) {
  const dir = join(root, name);
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, 'secrets/ioc'), { recursive: true });
  writeFileSync(join(proj, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(proj, '.env'), `HTTP_PORT=${port}\nPOSTGRES_PASSWORD=never-print-me\n`);
  writeFileSync(join(proj, 'secrets/ioc/device-password'), DEVICE_PASSWORD + '\n');
  for (const d of ['out', 'state', 'wd']) mkdirSync(join(dir, d));
  stub.alarms = []; stub.channels = 0; stub.hits = []; stub.recorderDelayMs = 0; stub.stateDir = join(dir, 'state');
  return { dir, proj, out: join(dir, 'out'), state: join(dir, 'state'), wd: join(dir, 'wd') };
}

function run(t, extra = [], scenario = 'ok') {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, '--project-dir', t.proj, '--out', t.out, '--settle', '0', ...extra], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: t.state, FAKE_SCENARIO: scenario, WATCHDOG_STATE_DIR: t.wd, H2Z_PROBE_LOOP: '0.2', H2Z_PROBE_POLL: '0.2' },
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}
const calls = (t) => (existsSync(join(t.state, 'calls.log')) ? readFileSync(join(t.state, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
const reportOf = (t) => readFileSync(join(t.out, readdirSync(t.out).find((f) => /^report-.*\.txt$/.test(f))), 'utf8');

test('脚本本身：语法没问题', () => {
  execFileSync('bash', ['-n', SCRIPT]);
});

test('干跑（没加 --yes）：只列出要做的事，不删容器、不重建、不写覆盖文件', { skip: !haveTools }, async () => {
  const t = setup('dry');
  const r = await run(t);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /没加 --yes：只是列出来，什么都没动/);
  assert.match(r.stdout, /emqx/);
  const c = calls(t);
  assert.ok(!c.some((l) => l.startsWith('rm ')), '干跑不能删容器');
  assert.ok(!c.some((l) => /^compose up /.test(l)), '干跑不能 up');
  assert.ok(!existsSync(join(t.out, 'lean-base.override.yaml')), '干跑不写覆盖文件');
  assert.ok(!existsSync(join(t.wd, 'pause')), '干跑不动看门狗');
});

test('--images-only：只量体积（按组加起来），不动任何容器', { skip: !haveTools }, async () => {
  const t = setup('images');
  const r = await run(t, ['--images-only']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 镜像体积/);
  assert.match(r.stdout, /700MB\ttd:1/, 'docker images 原始输出要在');
  assert.match(r.stdout, /底座：800 MB（8 个镜像）/);
  assert.match(r.stdout, /ai（ai-server…nodered）：400 MB（2 个镜像）/);
  assert.match(r.stdout, /要删除的（tdengine）：700 MB（1 个镜像）/);
  assert.ok(!calls(t).some((l) => l.startsWith('rm ') || /^compose up /.test(l)));
});

test('正常跑：删扩展容器 → 用覆盖文件重建 → 检查 → 恢复；口令不进报告，看门狗暂停后撤销', { skip: !haveTools }, async () => {
  const t = setup('ok');
  const r = await run(t, ['--yes']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const c = calls(t);
  const rm = c.filter((l) => l.startsWith('rm ')).join(' ');
  for (const s of ['emqx', 'h2z-api', 'ai-server', 'nodered', 'nodered-bridge', 'recorder-motion', 'tdengine']) assert.match(rm, new RegExp('id-' + s + '\\b'), s + ' 要被删');
  assert.doesNotMatch(rm, /tailscale/, '默认不删 tailscale');
  const ups = c.filter((l) => /^compose up /.test(l));
  assert.equal(ups.length, 2, '一次瘦底座 up + 一次恢复 up');
  assert.match(ups[0], /lean=1/);
  assert.match(ups[0], /--wait .*backend/);
  assert.match(ups[1], /lean=0/, '恢复用原来的 compose（不带覆盖文件）');
  // 覆盖文件：去掉 emqx / h2z-api 依赖、MQTT / H2Z 变量、tailscale-cli 依赖
  const ov = readFileSync(join(t.out, 'lean-base.override.yaml'), 'utf8');
  assert.match(ov, /depends_on: !override \{[^\n]*"postgres"/);
  assert.doesNotMatch(ov.match(/depends_on: !override [^\n]*/)[0], /emqx|h2z-api/, '覆盖后的 backend 依赖里不能有 emqx / h2z-api');
  for (const k of ['IOC_MQTT_URL', 'MQTT_BROKER_URL', 'MQTT_USERNAME', 'MQTT_PASSWORD', 'IOC_H2Z_URL', 'IOC_H2Z_TOKEN_FILE', 'RECORDER_MOTION_URL', 'RECORDER_SITE']) assert.match(ov, new RegExp(k + ': !reset null'));
  assert.match(ov, /depends_on: !reset \{\}/);
  // 输出
  assert.match(r.stdout, /PASS {2}底座 only 起来了/);
  assert.match(r.stdout, /PASS {2}设备口令登录/);
  assert.match(r.stdout, /tailscale 字段.*"available":false/);
  assert.match(r.stdout, /backend 在没有 emqx \/ h2z-api \/ MQTT 时能起来并保持健康：是/);
  assert.match(r.stdout, /已恢复/);
  assert.doesNotMatch(r.stdout, /^FAIL /m, '正常情况下一条 FAIL 都不该有');
  assert.match(r.stdout, /PASS \d+　WARN \d+　FAIL 0/);
  // 打码：URL 口令、Bearer、token=…；设备口令 / .env 里的口令不出现
  const rep = reportOf(t) + r.stdout;
  for (const secret of ['topsecretpw', 'abc.def.ghi', 'hunter2', DEVICE_PASSWORD, 'never-print-me']) assert.ok(!rep.includes(secret), `报告 / 输出里不能出现 ${secret}`);
  assert.match(rep, /mqtt:\/\/\*\*\*@emqx/);
  assert.ok(rep.includes('MQTT_BROKER_URL 未配置'), '启动期那条错误要原样列出来给人看');
  // 口令只在 600 权限的头文件里
  assert.equal(statSync(join(t.out, '.hdr-dev')).mode & 0o777, 0o600);
  assert.ok(stub.hits.some((h) => h.path === '/api/ioc/device/network/login' && h.key === DEVICE_PASSWORD));
  assert.ok(!existsSync(join(t.wd, 'pause')), '看门狗暂停要撤销');
});

test('backend 起不来：标 FAIL、结论说「按计划停在这里」，退出码非 0，而且照样恢复原来的栈', { skip: !haveTools }, async () => {
  const t = setup('upfails');
  const r = await run(t, ['--yes'], 'up-fails');
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /FAIL {2}docker compose up --wait 没成功/);
  assert.match(r.stdout, /FAIL {2}backend 状态是 running\/unhealthy/);
  assert.match(r.stdout, /按计划停在这里/);
  assert.doesNotMatch(r.stdout, /upfailsecret/, 'up 失败的输出里的口令要打码');
  const ups = calls(t).filter((l) => /^compose up /.test(l));
  assert.match(ups[ups.length - 1], /lean=0/, '失败也要恢复');
  assert.ok(!existsSync(join(t.wd, 'pause')));
});

test('报错刷屏：同一条错误重复很多次 → FAIL', { skip: !haveTools }, async () => {
  const t = setup('flood');
  const r = await run(t, ['--yes'], 'flood');
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /FAIL {2}backend 疑似报错刷屏/);
  assert.match(r.stdout, /ECONNREFUSED N\.N\.N\.N:N/, '数字换成 N 后再合并计数');
});

test('报警里出现和被去掉的扩展有关的告警（TAILSCALE_DOWN）→ FAIL；只有别的告警不算', { skip: !haveTools }, async () => {
  let t = setup('alarm-bad');
  stub.alarms = ['SITEOPS_BOARD_TAILSCALE_DOWN'];
  let r = await run(t, ['--yes']);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /出现了和被去掉的扩展服务有关的报警/);
  t = setup('alarm-fine');
  stub.alarms = ['SITEOPS_DISK_LOW'];
  r = await run(t, ['--yes']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /没有和被去掉的扩展服务有关的报警/);
});

test('--keep：不恢复，打印恢复命令，看门狗暂停保留', { skip: !haveTools }, async () => {
  const t = setup('keep');
  const r = await run(t, ['--yes', '--keep']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(calls(t).filter((l) => /^compose up /.test(l)).length, 1, '只有瘦底座那一次 up');
  assert.match(r.stdout, /--keep：没恢复/);
  assert.match(r.stdout, /docker compose up -d --wait/);
  assert.ok(existsSync(join(t.wd, 'pause')), '--keep 时看门狗暂停保留（1 小时后自己过期）');
});

test('覆盖文件和 compose 合不上：什么都不动，退出码 2', { skip: !haveTools }, async () => {
  const t = setup('badoverride');
  const r = await run(t, ['--yes'], 'override-invalid');
  assert.equal(r.code, 2);
  assert.match(r.stdout, /覆盖文件和 compose 合不上/);
  assert.ok(!calls(t).some((l) => l.startsWith('rm ')), '合不上就不能删容器');
});

test('--stop-tailscale：把 tailscale 也删掉（默认不删）', { skip: !haveTools }, async () => {
  const t = setup('ts');
  const r = await run(t, ['--yes', '--stop-tailscale']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(calls(t).filter((l) => l.startsWith('rm ')).join(' '), /id-tailscale\b/);
});

test('报警演练：停 recorder → SITEOPS_OFFLINE 出来 → 启动后自己消失；没有录像摄像头时说明没做成', { skip: !haveTools }, async () => {
  let t = setup('drill-none');
  stub.channels = 0;
  let r = await run(t, ['--yes', '--alarm-drill']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /WARN {2}没做成：本地录像机里一台摄像头都没有/);
  assert.ok(!calls(t).some((l) => l.startsWith('stop ')), '没有摄像头时不停 recorder');
  t = setup('drill');
  stub.channels = 2;
  r = await run(t, ['--yes', '--alarm-drill']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /PASS {2}停 recorder 后 \d+ 秒，SITEOPS_OFFLINE 报出来了/);
  assert.match(r.stdout, /PASS {2}恢复后 \d+ 秒，报警自己消失了/);
  const c = calls(t);
  assert.ok(c.some((l) => l.startsWith('stop id-recorder')) && c.some((l) => l.startsWith('start id-recorder')));
});

test('录像机状态响应慢（后端在等已经不存在的 recorder-motion）→ WARN，指出原因', { skip: !haveTools }, async () => {
  const t = setup('slow');
  stub.recorderDelayMs = 2800;
  const r = await run(t, ['--yes']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /WARN {2}本地录像机状态响应 2\.\d+ 秒，偏慢.*recorder-motion/);
});

test('--print-override：只把覆盖文件打印出来就退出，不碰 Docker（compose-matrix 靠它核对和 compose.lean.yaml 一致）', { skip: !haveTools }, async () => {
  const t = setup('print');
  const r = await run(t, ['--print-override']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /depends_on: !override \{/);
  assert.match(r.stdout, /RECORDER_MOTION_URL: !reset null/);
  assert.doesNotMatch(r.stdout, /== 环境 ==/, '打印完就退出，不跑后面的步骤');
  assert.deepEqual(calls(t).filter((l) => l.startsWith('rm ') || /^compose up /.test(l)), []);
});
