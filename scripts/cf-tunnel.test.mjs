// node --test scripts/cf-tunnel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { parseTunnelToken, parseHostname, classifyLogs, describeUrlStatus, parseShow, renderUnit, createTunnel, UNIT_NAME, UNIT_PATH } from './cf-tunnel.mjs';
import { createAgent, createServer } from './host-agent.mjs';

// 测试用的假令牌（不是任何真实隧道的）
const ACCOUNT = 'a'.repeat(32);
const TUNNEL = '4a94bc83-cdda-4a31-b8c1-009f122ed62a';
const mkToken = (o = {}) => Buffer.from(JSON.stringify({ a: ACCOUNT, t: TUNNEL, s: 'c2VjcmV0LXNlY3JldA==', ...o })).toString('base64');
const TOKEN = mkToken();

test('令牌：裸令牌、整条 service install 命令、tunnel run --token 都能解析', () => {
  for (const input of [TOKEN, `sudo cloudflared service install ${TOKEN}`, `cloudflared tunnel run --token ${TOKEN}\n`, `  ${TOKEN}  `]) {
    const r = parseTunnelToken(input);
    assert.equal(r.token, TOKEN);
    assert.equal(r.accountTag, ACCOUNT);
    assert.equal(r.tunnelId, TUNNEL);
  }
});

test('令牌：空 / 没有令牌 / 解不开 / 内容不全都拒绝，错误信息里不带令牌', () => {
  for (const bad of ['', '   ', 'hello world', 'eyJhbm90LWpzb24tYXQtYWxsLW5vdC1qc29u', mkToken({ t: 'not-a-uuid' }), Buffer.from('{"a":"x"}').toString('base64')]) {
    assert.throws(() => parseTunnelToken(bad), (e) => e.code === 'E_PARAM' && !e.message.includes('c2VjcmV0') && !e.message.includes(ACCOUNT));
  }
});

test('对外网址：带协议 / 路径都能归一；IP、端口、没有点的拒绝', () => {
  assert.equal(parseHostname('https://Web.C2HTech.com/'), 'web.c2htech.com');
  assert.equal(parseHostname('web.c2htech.com/ioc/?x=1'), 'web.c2htech.com');
  for (const bad of ['', 'localhost', '10.0.0.1', 'web.c2htech.com:8443', 'a b.com', '-x.com', 'x..com']) {
    assert.throws(() => parseHostname(bad), (e) => e.code === 'E_PARAM', bad);
  }
});

test('日志分类：令牌无效 / 网络不通 / 其他；日志里的令牌被遮住', () => {
  assert.equal(classifyLogs('ERR Unauthorized: Invalid tunnel secret').code, 'E_TUNNEL_TOKEN');
  const net = classifyLogs('ERR Unable to establish connection with Cloudflare edge: dial tcp: lookup region1.v2.argotunnel.com: no such host');
  assert.equal(net.code, 'E_TUNNEL_NETWORK');
  assert.match(net.message, /7844/);
  const other = classifyLogs(`something odd ${TOKEN}`);
  assert.equal(other.code, 'E_TUNNEL_START');
  assert.ok(!JSON.stringify(other).includes(TOKEN));
});

test('网址应答：530 = 隧道没连上；502 = 隧道通、本机服务不通；200 / 302 / 403 = 通', () => {
  assert.equal(describeUrlStatus(530).ok, false);
  assert.equal(describeUrlStatus(502).ok, true);
  assert.match(describeUrlStatus(502).note, /本机服务/);
  for (const s of [200, 302, 401, 403]) assert.deepEqual([describeUrlStatus(s).ok, describeUrlStatus(s).note], [true, '']);
  assert.equal(describeUrlStatus(0).ok, false);
});

test('systemctl show 解析：不存在 = null；在跑 / 重启中 / 失败各自识别', () => {
  assert.equal(parseShow('LoadState=not-found\nActiveState=inactive\n'), null);
  assert.deepEqual(parseShow('LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nResult=success\nActiveEnterTimestampMonotonic=5000000\n'), { active: 'active', sub: 'running', restarts: 0, result: 'success', activeSinceMono: 5000000 });
  assert.equal(parseShow('LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nNRestarts=2\n').sub, 'auto-restart');
});

test('服务单元：令牌走 LoadCredential，不在命令行 / 单元里；随机用户、收紧权限、有令牌才启动', () => {
  const u = renderUnit({ bin: '/usr/bin/cloudflared', metricsPort: 20241, hostDir: '/etc/h2z/cloudflared' });
  assert.match(u, /LoadCredential=token:\/etc\/h2z\/cloudflared\/token/);
  assert.match(u, /ExecStart=\/usr\/bin\/cloudflared --no-autoupdate tunnel --metrics 127\.0\.0\.1:20241 run --token-file %d\/token/);
  assert.match(u, /ConditionPathExists=\/etc\/h2z\/cloudflared\/token/);
  assert.match(u, /DynamicUser=yes/);
  assert.match(u, /NoNewPrivileges=yes/);
  assert.match(u, /Restart=always/);
  assert.ok(!/eyJ/.test(u) && !/--token /.test(u), '单元里没有令牌也没有 --token 参数');
});

// ---- 假宿主：记录 systemctl 调用，模拟服务状态 ----
function makeHost(st, calls, logs) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'test') {
      if (!st.installed) throw new Error('not found');
      return '';
    }
    if (cmd === 'cat') {
      if (args[0] === '/proc/uptime') return `${st.upMs / 1000} 1.0\n`;
      if (args[0] === UNIT_PATH) {
        if (st.unit === null) throw new Error('no file');
        return st.unitText;
      }
      throw new Error('cat ' + args[0]);
    }
    if (cmd === 'sh') {
      const m = /echo (\S+) \| base64 -d/.exec(args[1] || '');
      if (m) {
        st.unit = 'new';
        st.unitText = Buffer.from(m[1], 'base64').toString('utf8');
      }
      return '';
    }
    if (cmd === 'journalctl') return logs;
    if (cmd !== 'systemctl') throw new Error('unexpected ' + cmd);
    const [sub] = args;
    if (sub === 'show') {
      if (st.unit === null) return 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n';
      return `LoadState=loaded\nActiveState=${st.active}\nSubState=${st.sub}\nNRestarts=0\nResult=success\nActiveEnterTimestampMonotonic=${(st.upMs - st.ranMs) * 1000}\n`;
    }
    if (sub === 'enable') {
      st.enabled = true;
      return '';
    }
    if (sub === 'start' || sub === 'restart') {
      if (st.startExits) {
        st.active = 'activating';
        st.sub = 'auto-restart';
      } else {
        st.active = 'active';
        st.sub = 'running';
      }
      return '';
    }
    if (sub === 'disable') {
      st.enabled = false;
      st.active = 'inactive';
      st.sub = 'dead';
      return '';
    }
    return '';
  };
}
function makeFetch(st, { readyAfter = 0, urlStatus = 200 } = {}) {
  return async (url) => {
    if (String(url).includes('127.0.0.1')) {
      st.polls++;
      const ok = st.active === 'active' && st.polls > readyAfter;
      return { status: ok ? 200 : 503, json: async () => (ok ? { status: 200, readyConnections: 4 } : {}) };
    }
    return { status: urlStatus };
  };
}
function box({ readyAfter = 0, installed = true, startExits = false, logs = '', urlStatus = 200 } = {}) {
  const etc = mkdtempSync(join(tmpdir(), 'h2z-cf-'));
  const calls = [];
  const audits = [];
  const clock = { t: Date.parse('2026-11-08T21:00:00Z') };
  const st = { installed, startExits, unit: null, unitText: '', active: 'inactive', sub: 'dead', enabled: false, polls: 0, upMs: 500_000, ranMs: 120_000 };
  const t = createTunnel({
    host: makeHost(st, calls, logs), fs: fsp, hostEtc: etc, fetch: makeFetch(st, { readyAfter, urlStatus }), now: () => clock.t,
    sleep: async () => { clock.t += 2000; }, audit: async (a, d) => audits.push({ a, ...d }), defaultHostname: 'web.c2htech.com',
  });
  return { t, st, calls, audits, etc, clock };
}
const tokenPath = (b) => join(b.etc, 'h2z/cloudflared/token');

test('绑定成功：写令牌（0600）、写单元、enable + 启动，返回已连接和网址；令牌不在任何命令 / 审计 / 返回里', async () => {
  const b = box();
  const s = await b.t.bind({ token: `sudo cloudflared service install ${TOKEN}`, hostname: 'https://web.c2htech.com/', by: 'admin' });
  assert.equal(s.state, 'connected');
  assert.equal(s.bound, true);
  assert.equal(s.url, 'https://web.c2htech.com/');
  assert.equal(s.connections, 4);
  assert.equal(s.tunnelId, TUNNEL);
  assert.equal(s.boundBy, 'admin');
  assert.equal(s.urlOk, true);
  assert.equal(readFileSync(tokenPath(b), 'utf8').trim(), TOKEN);
  if (process.platform !== 'win32') assert.equal(statSync(tokenPath(b)).mode & 0o777, 0o600);
  assert.equal(b.st.unit, 'new');
  assert.equal(b.st.unitText, b.t.unitText);
  assert.ok(b.calls.some((c) => c[0] === 'systemctl' && c[1] === 'daemon-reload'));
  assert.ok(b.calls.some((c) => c[0] === 'systemctl' && c[1] === 'enable' && c[2] === UNIT_NAME), '开机自启');
  assert.ok(b.calls.some((c) => c[0] === 'systemctl' && c[1] === 'restart' && c[2] === UNIT_NAME));
  assert.ok(!JSON.stringify(b.calls).includes(TOKEN), '令牌不在任何宿主命令里');
  assert.ok(!b.st.unitText.includes(TOKEN));
  assert.ok(!JSON.stringify(b.audits).includes(TOKEN) && !JSON.stringify(s).includes(TOKEN));
  assert.equal(b.audits[0].a, 'tunnel-bind');
  assert.equal(s.accountTag.includes(ACCOUNT), false, '账号 ID 只显示头尾');
});

test('单元已经是最新的：不重写、不 daemon-reload', async () => {
  const b = box();
  await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  const before = b.calls.length;
  await b.t.restart();
  const after = b.calls.slice(before);
  assert.ok(!after.some((c) => c[0] === 'sh'));
  assert.ok(!after.some((c) => c[1] === 'daemon-reload'));
});

test('没填网址：用缺省网址（试点由 .env 给）；缺省也没有就拒绝', async () => {
  const b = box();
  assert.equal((await b.t.bind({ token: TOKEN })).hostname, 'web.c2htech.com');
  const e = mkdtempSync(join(tmpdir(), 'h2z-cf-'));
  const t = createTunnel({ host: async () => '', fs: fsp, hostEtc: e });
  await assert.rejects(t.bind({ token: TOKEN }), (x) => x.code === 'E_PARAM' && /对外网址/.test(x.message));
});

test('系统里没有 cloudflared：绑定回 409 并说明怎么装；状态里 installed:false；不动任何文件', async () => {
  const b = box({ installed: false });
  const s0 = await b.t.status();
  assert.equal(s0.installed, false);
  assert.match(s0.reason, /apt-get install cloudflared/);
  await assert.rejects(b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' }), (e) => e.code === 'E_TUNNEL_NOT_INSTALLED' && e.status === 409);
  assert.equal(existsSync(tokenPath(b)), false);
  assert.ok(!b.calls.some((c) => c[0] === 'systemctl' && c[1] !== 'show'));
});

test('刚绑定还没连上（慢）：返回 connecting，不当失败；之后连上变 connected', async () => {
  const b = box({ readyAfter: 1000 });
  b.st.ranMs = 10_000; // 服务刚起 10 秒
  const s = await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  assert.equal(s.state, 'connecting');
  assert.equal(s.bound, true);
  b.st.polls = 5000;
  assert.equal((await b.t.status()).state, 'connected');
});

test('绑定失败（令牌无效，服务起来就退出）：整体还原成未绑定，令牌文件也删掉，错误说明原因', async () => {
  const b = box({ startExits: true, logs: 'ERR Unauthorized: Invalid tunnel secret' });
  await assert.rejects(b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' }), (e) => e.code === 'E_TUNNEL_TOKEN' && e.status === 502 && /已还原/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(existsSync(tokenPath(b)), false);
  assert.equal(b.st.enabled, false, '没有留下开机自启');
  assert.equal((await b.t.status()).state, 'unbound');
  assert.equal(b.audits.at(-1).a, 'tunnel-bind-failed');
});

test('令牌格式错：不动任何文件、不调 systemctl', async () => {
  const b = box();
  await assert.rejects(b.t.bind({ token: 'nope', hostname: 'web.c2htech.com' }), (e) => e.code === 'E_PARAM');
  assert.equal(b.calls.length, 0);
  assert.equal(existsSync(tokenPath(b)), false);
});

test('开关：关 = disable --now、令牌保留、状态 disabled；开 = 重新连上；没绑定时 409', async () => {
  const b = box();
  await assert.rejects(b.t.setEnabled({ enabled: true }), (e) => e.code === 'E_TUNNEL_NOT_BOUND' && e.status === 409);
  await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  await assert.rejects(b.t.setEnabled({ enabled: 'yes' }), (e) => e.code === 'E_PARAM');
  const off = await b.t.setEnabled({ enabled: false });
  assert.equal(off.state, 'disabled');
  assert.equal(off.enabled, false);
  assert.ok(b.calls.some((c) => c[0] === 'systemctl' && c[1] === 'disable' && c.includes('--now')));
  assert.equal(b.st.enabled, false, '关着时重启机器也不会自己连');
  assert.equal(existsSync(tokenPath(b)), true, '令牌保留');
  const on = await b.t.setEnabled({ enabled: true });
  assert.equal(on.state, 'connected');
  assert.equal(b.st.enabled, true);
});

test('解绑：服务、令牌、记录都没了；之后可以重新绑定', async () => {
  const b = box();
  await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  const s = await b.t.unbind({ by: 'admin' });
  assert.equal(s.state, 'unbound');
  assert.equal(b.st.active, 'inactive');
  assert.equal(b.st.enabled, false);
  assert.equal(existsSync(tokenPath(b)), false);
  assert.equal(b.audits.at(-1).a, 'tunnel-unbind');
  assert.equal((await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' })).state, 'connected');
});

test('状态：单元没了 → error 并说明；服务失败 → 按日志给原因；网址 530 → urlOk=false；程序被删 → E_TUNNEL_NOT_INSTALLED', async () => {
  const b = box({ logs: 'ERR failed to dial: i/o timeout' });
  await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  b.st.unit = null;
  assert.equal((await b.t.status()).error.code, 'E_TUNNEL_SERVICE');
  b.st.unit = 'new';
  b.st.active = 'failed';
  b.st.sub = 'failed';
  const s = await b.t.status();
  assert.equal(s.state, 'error');
  assert.equal(s.error.code, 'E_TUNNEL_NETWORK');
  b.st.installed = false;
  assert.equal((await b.t.status()).error.code, 'E_TUNNEL_NOT_INSTALLED');
  const c = box({ urlStatus: 530 });
  const r = await c.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  assert.equal(r.state, 'connected');
  assert.equal(r.urlOk, false);
  assert.match(r.urlNote, /530/);
});

test('reconcile：应该开着但服务没在跑 → 补回来；关着 / 没绑定 / 令牌没了 / 没装程序都不动', async () => {
  const b = box();
  assert.equal(await b.t.reconcile(), 'idle');
  await b.t.bind({ token: TOKEN, hostname: 'web.c2htech.com' });
  assert.equal(await b.t.reconcile(), 'ok');
  b.st.active = 'inactive';
  b.st.sub = 'dead';
  assert.equal(await b.t.reconcile(), 'recreated');
  assert.equal(b.st.active, 'active');
  b.st.unit = null; // 单元被删
  b.st.active = 'inactive';
  assert.equal(await b.t.reconcile(), 'recreated');
  assert.equal(b.st.unit, 'new', '单元被重新写出');
  await b.t.setEnabled({ enabled: false });
  assert.equal(await b.t.reconcile(), 'idle');
  await b.t.setEnabled({ enabled: true });
  b.st.active = 'inactive';
  b.st.installed = false;
  assert.equal(await b.t.reconcile(), 'not-installed');
  b.st.installed = true;
  await fsp.unlink(tokenPath(b));
  assert.equal(await b.t.reconcile(), 'no-token');
});

// ---- 接进 host-agent（HTTP 路由、错误形状）----
async function call(sock, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (x) => (d += x));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('host-agent 路由：/v1/tunnel* 可用；错误回 {error, message} 和对应状态码；令牌不出现在任何返回里', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'h2z-cf-'));
  const st = { installed: true, startExits: false, unit: null, unitText: '', active: 'inactive', sub: 'dead', enabled: false, polls: 0, upMs: 500_000, ranMs: 120_000 };
  const agent = createAgent({
    hostEtc: etc, host: makeHost(st, [], ''), tailscaleSocket: join(etc, 'x'), fetch: makeFetch(st),
    sleep: async () => {}, tunnelDefaultHostname: 'web.c2htech.com',
  });
  const sock = join(etc, 's.sock');
  const server = createServer(agent);
  await new Promise((r) => server.listen(sock, r));
  try {
    let r = await call(sock, 'GET', '/v1/tunnel');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.bound, r.body.state, r.body.defaultHostname], [false, 'unbound', 'web.c2htech.com']);
    r = await call(sock, 'POST', '/v1/tunnel/bind', { token: 'bad' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'E_PARAM');
    r = await call(sock, 'POST', '/v1/tunnel/enable', { enabled: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'E_TUNNEL_NOT_BOUND');
    r = await call(sock, 'POST', '/v1/tunnel/bind', { token: TOKEN, hostname: 'web.c2htech.com' });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'connected');
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
    r = await call(sock, 'POST', '/v1/tunnel/unbind', {});
    assert.equal(r.body.state, 'unbound');
    st.installed = false;
    r = await call(sock, 'POST', '/v1/tunnel/bind', { token: TOKEN, hostname: 'web.c2htech.com' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'E_TUNNEL_NOT_INSTALLED');
  } finally {
    server.close();
  }
});

test('没有 cf-tunnel 的部署（agent.tunnel = null）：路由回 404 E_NOT_FOUND', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'h2z-cf-'));
  const agent = createAgent({ hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x') });
  const stub = { ...agent, tunnel: null };
  const sock = join(etc, 's.sock');
  const server = createServer(stub);
  await new Promise((r) => server.listen(sock, r));
  try {
    const r = await call(sock, 'GET', '/v1/tunnel');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'E_NOT_FOUND');
  } finally {
    server.close();
  }
});
