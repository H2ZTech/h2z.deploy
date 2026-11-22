// Cloudflare Tunnel 对接（「远程访问」的穿透开关）。方案：project 文档 claude/plan-2026-11-08-cloudflare-tunnel-binding.md
//
// 做什么：用户给一条 Cloudflare 隧道令牌（token）和对外网址，host-agent 在宿主上启动 cloudflared 系统服务连出去（只出站）。
// 对外网址 → 本机服务的映射在 Cloudflare 控制台配置，设备端不管。可开关、可解绑，状态给界面看。
//
// cloudflared 程序本身随 H2Z OS 镜像安装（os2/x86/container/customize-system.sh 按 Cloudflare 官方 apt 源装，版本随整包锁定），
// 绑定时不联网装包。服务单元 h2z-os-cloudflared.service 由本模块在需要时写出（和这里的 renderUnit 一致），
// 所以已经装了 cloudflared 的老机器 / 试点机（比如手动 apt 装过的）也能直接用。
//
// 接口（host-agent 经 unix socket 暴露，IOC 后台转发）：
//   GET  /v1/tunnel                    状态
//   POST /v1/tunnel/bind {token, hostname, by?}   绑定并连接（token 可以直接粘整条 `cloudflared service install …` 命令）
//   POST /v1/tunnel/enable {enabled}   开 / 关（令牌保留）
//   POST /v1/tunnel/restart            重启连接器
//   POST /v1/tunnel/unbind             解绑：停服务、删令牌、删记录
//
// 安全：令牌只存在宿主 /etc/h2z/cloudflared/token（root 0600）。服务用 systemd 的 LoadCredential 把它交给
// cloudflared（DynamicUser = 随机非 root 用户，读的是 systemd 给的临时副本）：不进命令行（ps 看不到）、不进 unit 文件、
// 不进日志、不进审计、不进接口返回、不进镜像和 Git。
//
// 手动装过的老服务 cloudflared.service（`cloudflared service install <token>` 生成的）和这里互不相干：
// 用同一个令牌会多出一个连接器副本，不会冲突；本模块不会去动它。

import { join } from 'node:path';

export const UNIT_NAME = 'h2z-os-cloudflared.service';
export const UNIT_PATH = '/etc/systemd/system/' + UNIT_NAME;
export const DEFAULT_BIN = '/usr/bin/cloudflared';
export const DEFAULT_METRICS_PORT = 20241;
export const HOST_DIR = '/etc/h2z/cloudflared'; // 宿主上令牌目录（host-agent 容器里是 /host/etc/h2z/cloudflared）

/** systemd 单元：令牌走 LoadCredential（%d = 凭据目录），--no-autoupdate 版本随镜像，指标只听回环 */
export function renderUnit({ bin = DEFAULT_BIN, metricsPort = DEFAULT_METRICS_PORT, hostDir = HOST_DIR } = {}) {
  return `# 由 h2z host-agent（scripts/cf-tunnel.mjs）写出，手改会被覆盖
[Unit]
Description=H2Z OS Cloudflare tunnel connector
Wants=network-online.target
After=network-online.target
ConditionPathExists=${hostDir}/token

[Service]
Type=simple
DynamicUser=yes
LoadCredential=token:${hostDir}/token
ExecStart=${bin} --no-autoupdate tunnel --metrics 127.0.0.1:${metricsPort} run --token-file %d/token
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
MemoryMax=256M

[Install]
WantedBy=multi-user.target
`;
}

export class TunnelError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const bad = (msg) => new TunnelError('E_PARAM', msg);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 令牌：base64 的 JSON {a: 账号 ID, t: 隧道 ID, s: 密钥}。入参可以是裸令牌，也可以是整条
 * `sudo cloudflared service install eyJ…` / `cloudflared tunnel run --token eyJ…` 命令——从里面找出令牌。
 * 返回 { token, accountTag, tunnelId }；格式不对抛 E_PARAM（错误信息里不回显令牌内容）。
 */
export function parseTunnelToken(input) {
  const text = String(input ?? '').trim();
  if (!text) throw bad('请粘贴 Cloudflare 隧道令牌（或整条 cloudflared service install … 命令）');
  const m = /eyJ[A-Za-z0-9_\-+/]{16,}={0,2}/.exec(text);
  if (!m) throw bad('没有找到隧道令牌（应是以 eyJ 开头的一长串字符）');
  const token = m[0];
  let j;
  try {
    j = JSON.parse(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    throw bad('隧道令牌格式不对（解不开）：请重新从 Cloudflare 控制台复制');
  }
  if (!j || typeof j !== 'object' || typeof j.a !== 'string' || typeof j.t !== 'string' || typeof j.s !== 'string' || !UUID.test(j.t)) {
    throw bad('隧道令牌内容不完整：请重新从 Cloudflare 控制台复制');
  }
  return { token, accountTag: j.a, tunnelId: j.t.toLowerCase() };
}

/** 对外网址 → 主机名：接受 https://web.example.com/ 或 web.example.com；必须是带点的域名，不接受 IP / 端口 / 路径 */
export function parseHostname(input) {
  let h = String(input ?? '').trim().toLowerCase();
  if (!h) throw bad('请填写对外网址（例如 https://web.example.com）');
  h = h.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (h.includes(':')) throw bad('对外网址不要带端口');
  if (h.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(h)) throw bad('对外网址格式不对（应是域名，例如 web.example.com）');
  if (/^\d+(\.\d+){3}$/.test(h)) throw bad('对外网址要用域名，不能是 IP');
  return h;
}

/** cloudflared 日志末尾 → 常见原因（给界面显示 + 建议） */
export function classifyLogs(text) {
  const t = String(text || '');
  const last = t.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  const tail = last.replace(/eyJ[A-Za-z0-9_\-+/=]{16,}/g, '***').slice(0, 200);
  if (/unauthorized|invalid tunnel|tunnel not found|failed to unmarshal|decode.*token|token.*(invalid|not valid)|no tunnel|authentication/i.test(t)) {
    return { code: 'E_TUNNEL_TOKEN', message: '隧道令牌无效，或这条隧道已被删除 / 令牌已被轮换：请到 Cloudflare 控制台重新复制令牌', detail: tail };
  }
  if (/no such host|i\/o timeout|connection refused|network is unreachable|unable to establish connection|context deadline exceeded|failed to dial|tls handshake|7844|argotunnel/i.test(t)) {
    return { code: 'E_TUNNEL_NETWORK', message: '设备连不上 Cloudflare：检查设备能否上网，现场防火墙要放行出站 7844 端口（TCP / UDP）到 *.argotunnel.com', detail: tail };
  }
  return { code: 'E_TUNNEL_START', message: '连接器没有正常运行' + (tail ? '：' + tail : ''), detail: tail };
}

/** Cloudflare 边缘对一个网址的应答 → 提示（只在连接器已连上后用） */
export function describeUrlStatus(status) {
  if (!status) return { ok: false, note: '从设备上访问对外网址没有得到应答（可能是域名还没生效，或设备自己的 DNS / 网络有限制）' };
  if (status === 530 || status === 1033) return { ok: false, note: 'Cloudflare 说这条隧道没有连上（530）：稍等几秒，或检查控制台里该域名是否指向这条隧道' };
  if ([502, 504, 521, 522, 523, 524].includes(status)) return { ok: true, note: '隧道已通，但本机服务没有应答：检查 Cloudflare 控制台里该域名指向的本机服务地址和协议' };
  if (status >= 500) return { ok: false, note: `对外网址返回 ${status}` };
  return { ok: true, note: '' };
}

/** `systemctl show <unit> -p …` 的 KEY=VALUE 输出 → 服务状态；单元不存在 = null */
export function parseShow(text) {
  const kv = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  if (kv.LoadState === 'not-found') return null;
  return {
    active: kv.ActiveState || 'inactive', // active | activating | failed | inactive | deactivating
    sub: kv.SubState || '', // running | auto-restart | start | failed | dead …
    restarts: Number(kv.NRestarts) || 0,
    result: kv.Result || '',
    activeSinceMono: Number(kv.ActiveEnterTimestampMonotonic) || 0, // 微秒（开机以来）
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 工厂。依赖都可注入（测试用）：
 *   host(cmd, args, {timeout}) 在宿主上执行命令（nsenter）；fs（fs/promises 形状）；hostEtc（容器里 /host/etc）；
 *   serial(fn) 串行化；audit(action, detail)；fetch；sleep
 */
export function createTunnel(opts = {}) {
  const o = {
    bin: DEFAULT_BIN,
    metricsPort: DEFAULT_METRICS_PORT,
    hostDir: HOST_DIR,
    defaultHostname: '',
    bindWaitMs: 45_000,
    enableWaitMs: 12_000,
    pollMs: 2000,
    ...opts,
  };
  const { host, fs } = o;
  const serial = o.serial || ((fn) => fn());
  const audit = o.audit || (async () => {});
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || sleepMs;
  const doFetch = o.fetch || globalThis.fetch;
  const dir = join(o.hostEtc, 'h2z/cloudflared'); // 容器里看到的目录
  const P = { token: join(dir, 'token'), config: join(dir, 'tunnel.json') };
  const UNIT_TEXT = renderUnit({ bin: o.bin, metricsPort: o.metricsPort, hostDir: o.hostDir });

  const readJson = async (f) => {
    try {
      return JSON.parse(await fs.readFile(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const rm = async (f) => {
    try {
      await fs.unlink(f);
    } catch {
      /* 不在就算了 */
    }
  };
  async function writeFile600(f, text) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(f + '.tmp', text, { mode: 0o600 });
    await fs.rename(f + '.tmp', f);
  }
  const saveConfig = (cfg) => writeFile600(P.config, JSON.stringify(cfg, null, 2) + '\n');

  const sc = (args, timeout = 30_000) => host('systemctl', args, { timeout });

  /** cloudflared 程序在不在（镜像自带；旧系统可能没有） */
  async function installed() {
    try {
      await host('test', ['-x', o.bin], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  const notInstalled = () =>
    new TunnelError('E_TUNNEL_NOT_INSTALLED', `这台设备的系统里没有 cloudflared（${o.bin}）：新版 H2Z OS 镜像自带；旧系统先在设备上执行 apt-get install cloudflared（Cloudflare 官方源）`, 409);

  /** 写出（或修正）系统服务单元；有变化才写并 daemon-reload */
  async function ensureUnit() {
    let cur = '';
    try {
      cur = await host('cat', [UNIT_PATH], { timeout: 5000 });
    } catch {
      /* 还没有 */
    }
    if (cur === UNIT_TEXT) return;
    const b64 = Buffer.from(UNIT_TEXT).toString('base64');
    await host('sh', ['-c', `echo ${b64} | base64 -d > ${UNIT_PATH}.tmp && mv ${UNIT_PATH}.tmp ${UNIT_PATH}`], { timeout: 10_000 });
    await sc(['daemon-reload'], 30_000);
  }

  /** 服务状态；null = 单元不存在 */
  async function inspect() {
    try {
      return parseShow(await sc(['show', UNIT_NAME, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts', '-p', 'Result', '-p', 'ActiveEnterTimestampMonotonic', '--no-pager'], 15_000));
    } catch {
      return null;
    }
  }
  /** 服务启动至今多少毫秒（用单调时钟；取不到 = null） */
  async function runningMs(c) {
    if (!c || !c.activeSinceMono) return null;
    try {
      const up = Number((await host('cat', ['/proc/uptime'], { timeout: 5000 })).split(' ')[0]);
      return Math.max(0, up * 1000 - c.activeSinceMono / 1000);
    } catch {
      return null;
    }
  }
  async function tailLogs() {
    try {
      return await host('journalctl', ['-u', UNIT_NAME, '-n', '40', '--no-pager', '-o', 'cat'], { timeout: 15_000 });
    } catch (e) {
      return String(e.stdout || e.stderr || '');
    }
  }
  /** cloudflared 的 /ready：已建立的边缘连接数（>0 = 已连上） */
  async function ready() {
    try {
      const r = await doFetch(`http://127.0.0.1:${o.metricsPort}/ready`, { signal: AbortSignal.timeout(3000) });
      let j = {};
      try {
        j = await r.json();
      } catch {
        /* 503 时可能没有 body */
      }
      return { ok: r.status === 200, connections: Number(j.readyConnections) || 0 };
    } catch {
      return { ok: false, connections: 0 };
    }
  }
  let urlCache = { at: 0, host: '', result: null };
  async function checkUrl(hostname) {
    if (urlCache.host === hostname && now() - urlCache.at < 30_000) return urlCache.result;
    let status = 0;
    try {
      const r = await doFetch('https://' + hostname + '/', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      status = r.status;
    } catch {
      status = 0;
    }
    const result = { status, ...describeUrlStatus(status) };
    urlCache = { at: now(), host: hostname, result };
    return result;
  }

  /** 写单元 → 开机自启 + 马上启动（restart = 已在跑也重启，让它读新令牌） */
  async function startService({ restart = false } = {}) {
    try {
      await ensureUnit();
      await sc(['enable', UNIT_NAME], 30_000);
      await sc([restart ? 'restart' : 'start', UNIT_NAME], 30_000);
    } catch (e) {
      throw new TunnelError('E_TUNNEL_SERVICE', '启动连接器失败：' + String(e.stderr || e.message || '').replace(/\s+/g, ' ').slice(0, 200), 502);
    }
  }
  async function stopService() {
    await sc(['disable', '--now', UNIT_NAME], 30_000).catch(() => {});
  }

  /** 等到「已连上」或「服务挂了」或超时。返回 'ready' | 'exited' | 'timeout' */
  async function waitReady(ms) {
    const until = now() + ms;
    for (;;) {
      const c = await inspect();
      if (!c || c.active === 'failed' || c.active === 'inactive') return 'exited';
      if (c.active === 'activating' && c.sub === 'auto-restart') return 'exited'; // 起来就退出，systemd 在等着重启它
      if ((await ready()).ok) return 'ready';
      if (now() >= until) return 'timeout';
      await sleep(o.pollMs);
    }
  }

  async function status() {
    const cfg = await readJson(P.config);
    const base = { provider: 'cloudflare', defaultHostname: o.defaultHostname || '' };
    if (!cfg || !cfg.tunnelId) {
      const ok = await installed();
      return { ...base, installed: ok, ...(ok ? {} : { reason: notInstalled().message }), bound: false, state: 'unbound', enabled: false };
    }
    const out = {
      ...base,
      installed: true,
      bound: true,
      mode: cfg.mode || 'own',
      hostname: cfg.hostname,
      url: 'https://' + cfg.hostname + '/',
      tunnelId: cfg.tunnelId,
      accountTag: cfg.accountTag ? String(cfg.accountTag).slice(0, 4) + '…' + String(cfg.accountTag).slice(-4) : '',
      boundAt: cfg.boundAt || null,
      boundBy: cfg.boundBy || '',
      enabled: cfg.enabled !== false,
      lastConnectedAt: cfg.lastConnectedAt || null,
      connections: 0,
      error: null,
    };
    if (!out.enabled) return { ...out, state: 'disabled' };
    if (!(await installed())) return { ...out, installed: false, state: 'error', error: { code: 'E_TUNNEL_NOT_INSTALLED', message: notInstalled().message } };
    const c = await inspect();
    if (!c) return { ...out, state: 'error', error: { code: 'E_TUNNEL_SERVICE', message: '连接器服务不存在：稍等片刻会自动恢复，或点「重启」' } };
    if (c.active === 'active') {
      const r = await ready();
      if (r.ok) {
        const t = cfg.lastConnectedAt ? Date.parse(cfg.lastConnectedAt) : 0;
        if (!t || now() - t > 5 * 60_000) {
          cfg.lastConnectedAt = new Date(now()).toISOString();
          await saveConfig(cfg).catch(() => {});
          out.lastConnectedAt = cfg.lastConnectedAt;
        }
        const u = await checkUrl(cfg.hostname);
        return { ...out, state: 'connected', connections: r.connections, urlStatus: u.status || null, urlOk: u.ok, urlNote: u.note };
      }
      const ms = await runningMs(c);
      if (ms === null || ms < 90_000) return { ...out, state: 'connecting' };
      return { ...out, state: 'error', error: classifyLogs(await tailLogs()) };
    }
    if (c.active === 'activating' && c.sub !== 'auto-restart') return { ...out, state: 'connecting' };
    return { ...out, state: 'error', error: classifyLogs(await tailLogs()) };
  }

  /** 失败后清理成「没绑定」的样子 */
  async function wipe() {
    await stopService();
    await rm(P.token);
    await rm(P.config);
    urlCache = { at: 0, host: '', result: null };
  }

  function bind(body) {
    return serial(async () => {
      const { token, accountTag, tunnelId } = parseTunnelToken(body?.token);
      const hostname = parseHostname(body?.hostname || o.defaultHostname);
      const by = String(body?.by || '').slice(0, 80);
      if (!(await installed())) throw notInstalled();
      await writeFile600(P.token, token + '\n');
      await saveConfig({ schema: 1, provider: 'cloudflare', mode: 'own', hostname, tunnelId, accountTag, enabled: true, boundAt: new Date(now()).toISOString(), boundBy: by, lastConnectedAt: null });
      urlCache = { at: 0, host: '', result: null };
      try {
        await startService({ restart: true });
      } catch (e) {
        await wipe();
        throw e;
      }
      const w = await waitReady(o.bindWaitMs);
      if (w === 'exited') {
        const err = classifyLogs(await tailLogs());
        await wipe(); // 没连上就算绑定失败：回到未绑定，不留半成品
        await audit('tunnel-bind-failed', { hostname, tunnelId, code: err.code, by });
        throw new TunnelError(err.code, '绑定失败，已还原：' + err.message, 502);
      }
      await audit('tunnel-bind', { hostname, tunnelId, by, connected: w === 'ready' });
      return status();
    });
  }

  function setEnabled(body) {
    return serial(async () => {
      if (typeof body?.enabled !== 'boolean') throw bad('enabled 要是 true 或 false');
      const cfg = await readJson(P.config);
      if (!cfg?.tunnelId) throw new TunnelError('E_TUNNEL_NOT_BOUND', '还没有绑定隧道', 409);
      if (body.enabled && !(await installed())) throw notInstalled();
      cfg.enabled = body.enabled;
      await saveConfig(cfg);
      if (body.enabled) {
        await startService();
        await waitReady(o.enableWaitMs);
      } else {
        await stopService();
      }
      await audit(body.enabled ? 'tunnel-enable' : 'tunnel-disable', { hostname: cfg.hostname, by: String(body?.by || '').slice(0, 80) });
      return status();
    });
  }

  function restart() {
    return serial(async () => {
      const cfg = await readJson(P.config);
      if (!cfg?.tunnelId) throw new TunnelError('E_TUNNEL_NOT_BOUND', '还没有绑定隧道', 409);
      if (cfg.enabled === false) throw new TunnelError('E_TUNNEL_DISABLED', '隧道现在是关闭状态，先打开', 409);
      if (!(await installed())) throw notInstalled();
      await startService({ restart: true });
      await waitReady(o.enableWaitMs);
      return status();
    });
  }

  function unbind(body) {
    return serial(async () => {
      const cfg = await readJson(P.config);
      await wipe();
      if (cfg?.tunnelId) await audit('tunnel-unbind', { hostname: cfg.hostname, tunnelId: cfg.tunnelId, by: String(body?.by || '').slice(0, 80) });
      return status();
    });
  }

  /** 应该开着但服务没在跑（单元被删 / 被手动停了）→ 补回来；令牌文件没了或没装程序 → 不动，状态里会显示 */
  function reconcile() {
    return serial(async () => {
      const cfg = await readJson(P.config);
      if (!cfg?.tunnelId || cfg.enabled === false) return 'idle';
      const c = await inspect();
      if (c && (c.active === 'active' || c.active === 'activating')) return 'ok';
      try {
        await fs.access(P.token);
      } catch {
        return 'no-token';
      }
      if (!(await installed())) return 'not-installed';
      await startService();
      return 'recreated';
    });
  }

  return { status, bind, setEnabled, restart, unbind, reconcile, paths: P, unitText: UNIT_TEXT };
}
