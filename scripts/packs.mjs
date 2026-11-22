// 扩展包（瘦底座 + 扩展包，开发计划 DEV-PLAN-2026-11-04-LEAN-BASE-PACKS.md §M2；接口约定 docs/PACKS-API.md）：
// 状态文件 / 清单 / 依赖和版本规则 / 列表视图，以及 host-agent 的 /v1/packs* 要用的那一套（createPacks）。
// 真正装 / 卸 / 停用 / 启用的是宿主上的 h2z-os-pack（systemd-run 起，低优先级），它按同一份文件格式和规则做；这里只做检查、起任务、读进度。
//
// 文件（容器路径 → 宿主路径）：
//   /host/etc/h2z/packs.json → /etc/h2z/packs.json    本机包状态（只有 h2z-os-pack 写）：{ schema: 1, installed: { <名>: { version, installedAt, enabled, source, by, sizeBytes, minOs, images } } }
//   /host/etc/h2z/packs-settings.json                  设置（只有 host-agent 写）：{ autoInstall }。分开放是为了没人和 h2z-os-pack 抢着写同一个文件
//   /packs/<名>/state.json → /var/lib/h2z/packs/<名>/state.json   这个包的安装 / 卸载进度、失败原因（host-agent 开始时写一次，之后 h2z-os-pack）
//   /packs/incoming、/packs/staged                     上传中的临时文件 / 验过等着装的 <名>-<版本>.h2zpack
//   /agent/packs.catalog.json ← 仓库 config/packs.catalog.json   有哪些包：展示名、说明、依赖、服务、数据卷、compose 文件
// 扩展包文件 .h2zpack = ustar：manifest.json（format 1、kind pack、name、version、arch、minOs、depends、images、files{images.tar: sha256}）
//   + manifest.sig（Ed25519，和 .h2zup 同一把密钥）+ images.tar（docker save）。
import { createPublicKey, verify as cryptoVerify, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

export const PACK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const SEMVER = /^\d+\.\d+\.\d+$/;
export const SOURCES = ['usb', 'upload', 'online'];
/** 进行中的状态（state.json 的 state） */
export const RUNNING = ['installing', 'removing', 'disabling', 'enabling'];
const ACTION_OF = { installing: 'install', removing: 'remove', disabling: 'disable', enabling: 'enable' };
/** 进行中超过这么久没更新进度（且查不出任务还在不在）= 已经不在跑了（设备重启 / 断电） */
export const STALL_MS = 30 * 60_000;
/** 写完进度到宿主任务单元真正起来之间的宽限 */
export const UNIT_GRACE_MS = 20_000;
/** 安装共 4 步：检查签名和要求 → 导入镜像 → 启动服务 → 健康检查；第 3 步起不能取消 */
export const INSTALL_STEPS = 4;
export const LAST_CANCELLABLE_STEP = 2;

export const emptyState = () => ({ schema: 1, installed: {} });

/** packs.json → 干净的状态（坏数据 / 没有文件都当「没装任何包」） */
export function normalizeState(raw) {
  const out = emptyState();
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) return out;
  for (const [name, v] of Object.entries(raw.installed && typeof raw.installed === 'object' ? raw.installed : {})) {
    if (!PACK_NAME.test(name) || !v || typeof v !== 'object' || !SEMVER.test(String(v.version))) continue;
    out.installed[name] = {
      version: String(v.version),
      installedAt: typeof v.installedAt === 'string' ? v.installedAt : '',
      enabled: v.enabled !== false,
      source: SOURCES.includes(v.source) ? v.source : null,
      by: typeof v.by === 'string' ? v.by.slice(0, 64) : '',
      sizeBytes: Number.isFinite(v.sizeBytes) ? v.sizeBytes : null,
      minOs: SEMVER.test(String(v.minOs)) ? String(v.minOs) : '',
      images: v.images && typeof v.images === 'object' && !Array.isArray(v.images) ? v.images : {},
    };
  }
  return out;
}

/** '1.2.0' vs '1.10.0' → -1 / 0 / 1 */
export function cmpVer(a, b) {
  // 系统版本可以带构建后缀（0.1.0-202611041200）：只比 x.y.z
  const p = (v) => String(v || '0.0.0').split(/[-+]/)[0].split('.').map((x) => Number(x) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

/** 清单 manifest.json → 规整后的对象，不对就抛 Error（message 给人看） */
export function parsePackManifest(m) {
  const bad = (msg) => { throw new Error(msg); };
  if (!m || typeof m !== 'object') bad('manifest.json 不是对象');
  if (m.format !== 1 || m.kind !== 'pack' || m.product !== 'H2Z OS') bad('不是 H2Z OS 扩展包（format / kind / product 不对）');
  if (!PACK_NAME.test(String(m.name))) bad('manifest.json 里的包名不对');
  if (!SEMVER.test(String(m.version))) bad('manifest.json 里的版本号要是 x.y.z');
  if (m.minOs !== undefined && m.minOs !== '' && !SEMVER.test(String(m.minOs))) bad('manifest.json 里的 minOs 要是 x.y.z');
  const depends = Array.isArray(m.depends) ? m.depends.map(String) : [];
  if (depends.length > 8 || depends.some((d) => !PACK_NAME.test(d) || d === m.name)) bad('manifest.json 里的 depends 不对');
  const images = Array.isArray(m.images) ? m.images.map(String) : [];
  if (images.length > 40 || images.some((i) => !i || i.length > 200 || /\s/.test(i))) bad('manifest.json 里的镜像列表不对');
  const sha = m.files && m.files['images.tar'];
  if (!/^[0-9a-f]{64}$/.test(String(sha))) bad('manifest.json 里缺 images.tar 的 sha256');
  if (!['amd64', 'arm64'].includes(String(m.arch))) bad('manifest.json 里的 arch 不对');
  const size = m.sizes && Number.isFinite(m.sizes['images.tar']) ? m.sizes['images.tar'] : 0;
  return {
    name: m.name, version: m.version, arch: m.arch, minOs: m.minOs || '', depends, images,
    files: { 'images.tar': sha }, sizes: { 'images.tar': size },
    created: typeof m.created === 'string' ? m.created : '', notes: typeof m.notes === 'string' ? m.notes.slice(0, 500) : '',
  };
}

/** 展示名（缺英文用中文） */
export const titleOf = (entry, lang = 'zh-CN') => (entry && entry.title && (entry.title[lang] || entry.title['zh-CN'] || entry.title.en)) || (entry && entry.name) || '';
const quoted = (cat, n) => '「' + (titleOf(cat.get(n)) || n) + '」';
const gb = (n) => (n / 2 ** 30).toFixed(1);

/**
 * 装之前的检查（架构、系统版本、依赖、版本比较、磁盘）→ { checks, problem }
 * checks 给界面画四行（signature / os / depends / disk），带结构化的值，界面自己拼文字；
 * problem：第一条不过的（{ code, message, status }），null = 可以装。版本比较（降级 / 同版本）不在四行里，只出现在 problem。
 * state：本机包状态；cat：目录（Map 名 → 条目）；osVersion / freeBytes / hostArch（uname -m 或 amd64 / arm64）来自设备。
 */
export function planInstall({ manifest, state, cat, osVersion, freeBytes, hostArch }) {
  const fails = [];
  const fail = (code, message, status = 409) => fails.push({ code, message, status });
  const arch = hostArch ? ({ x86_64: 'amd64', aarch64: 'arm64' }[hostArch] || hostArch) : manifest.arch;
  const archOk = manifest.arch === arch;
  if (!archOk) fail('E_PACK_ARCH', `这个扩展包是 ${manifest.arch} 的，这台设备是 ${arch}`, 400);
  const osOk = !manifest.minOs || !osVersion || cmpVer(osVersion, manifest.minOs) >= 0;
  if (!osOk) fail('E_PACK_OS_VERSION', `这个扩展要求 H2Z OS ≥ ${manifest.minOs}，这台是 ${osVersion}。请先升级系统。`);
  // 依赖要装了、并且是启用的（停用的包它的服务不在 compose 的 profile 里，依赖它的包 docker compose 直接报「depends on undefined service」）
  const missing = manifest.depends.filter((d) => !state.installed[d] || !state.installed[d].enabled);
  if (missing.length) {
    const notInstalled = missing.filter((d) => !state.installed[d]);
    fail('E_PACK_DEPENDS', notInstalled.length
      ? `${quoted(cat, manifest.name)}需要先装${notInstalled.map((d) => quoted(cat, d)).join('、')}。`
      : `${quoted(cat, manifest.name)}需要先启用${missing.map((d) => quoted(cat, d)).join('、')}。`);
  }
  const cur = state.installed[manifest.name];
  if (cur) {
    const c = cmpVer(manifest.version, cur.version);
    if (c < 0) fail('E_PACK_DOWNGRADE', `已经装了更新的版本（${cur.version}），不能降级。`);
    else if (c === 0 && cur.enabled) fail('E_PACK_INSTALLED', `已经装了这个版本（${cur.version}）。`);
    // 同版本、停用着（镜像被清理过等）：允许重装一次 = 修复并启用，数据卷不动
  }
  const needBytes = Math.ceil(manifest.sizes['images.tar'] * 2.2) + 512 * 2 ** 20; // 包文件 + 导入后的镜像层 + 余量
  const diskOk = !Number.isFinite(freeBytes) || freeBytes >= needBytes;
  if (!diskOk) fail('E_PACK_DISK', `磁盘空间不够：要约 ${gb(needBytes)} GB，现在只剩 ${gb(freeBytes)} GB。`);
  const checks = [
    { id: 'signature', ok: true },
    { id: 'os', ok: osOk && archOk, minOs: manifest.minOs, osVersion: osVersion || '', arch: manifest.arch, hostArch: arch },
    { id: 'depends', ok: !missing.length, depends: manifest.depends, missing },
    { id: 'disk', ok: diskOk, freeBytes: Number.isFinite(freeBytes) ? freeBytes : null, needBytes },
  ];
  return { checks, problem: fails[0] || null };
}

/** 依赖这个包的、已经装了的包（卸载 / 停用前要先处理它们） */
export function installedDependents(name, state, cat, { onlyEnabled = false } = {}) {
  return Object.keys(state.installed).filter((n) => {
    const e = cat.get(n);
    return e && (e.depends || []).includes(name) && (!onlyEnabled || state.installed[n].enabled);
  });
}

/**
 * host-agent 的 /v1/packs* 实现。
 * d：{ AgentError, now, paths: { state, settings, dir, hostDir, catalog }, readJson, writeAtomic, remove, rename, mkdirp, readdir, stat,
 *      tarIndex(file), readPart(file, member), hashPart(file, member), hostCat(file), usbScan(ext) → { sticks },
 *      upgradeBusy()（整包升级在进行就不能装 / 卸扩展，缺省 = 不查）, osVersion() → '0.1.5', hostArch() → 'x86_64', freeBytes(dir), maxBytes, audit(event, detail), source（下载源，scripts/pack-source.mjs；缺省 = 没有）,
 *      launch(unit, args)（宿主上低优先级起 h2z-os-pack）, signal(unit) → 给任务发取消信号, unitActive(unit) → true | false | null }
 */
export function createPacks(d) {
  const { AgentError, paths: P } = d;
  const now = d.now || (() => Date.now());
  const err = (code, message, status = 409) => new AgentError(code, message, status);
  const iso = () => new Date(now()).toISOString();
  const statePath = (n) => join(P.dir, n, 'state.json');
  const unitOf = (n) => 'h2z-pack-' + n;
  const hostPath = (f) => (P.hostDir && f.startsWith(P.dir) ? P.hostDir + f.slice(P.dir.length) : f);
  const byOf = (b) => String(b?.by || 'unknown').replace(/[^\w -]/g, '').slice(0, 64) || 'unknown';
  const src = d.source || { online: false, reason: 'E_NO_SOURCE' };
  const jobs = new Set(); // 在 host-agent 进程里跑的后台任务（联网下载），没有 systemd 单元可查

  async function loadCatalog() {
    const raw = await d.readJson(P.catalog);
    const list = raw && Array.isArray(raw.packs) ? raw.packs.filter((p) => p && PACK_NAME.test(String(p.name))) : [];
    // restartsConsole 在目录里是 B / C 共用的值；这条部署线上接线不一样的包（C 的 ai：backend 常驻 H2Z 接线）由 d.noRestart 覆盖成 false
    const noRestart = new Set(d.noRestart || []);
    return new Map(list.map((p) => [p.name, { depends: [], services: [], volumes: [], ...p, ...(noRestart.has(p.name) ? { restartsConsole: false } : {}) }]));
  }
  const loadState = async () => normalizeState(await d.readJson(P.state));
  const loadSettings = async () => ({ autoInstall: (await d.readJson(P.settings))?.autoInstall === true });
  const entryOf = async (name) => {
    if (!PACK_NAME.test(String(name))) throw err('E_PARAM', '扩展包名不合法', 400);
    const e = (await loadCatalog()).get(name);
    if (!e) throw err('E_PACK_NOT_FOUND', `没有这个扩展包：${name}`, 404);
    return e;
  };

  /** 这个包的进度文件；进行中但任务已经不在（或很久没动）= 中断了（设备重启 / 断电）→ 当失败 */
  async function progressOf(name) {
    const s = await d.readJson(statePath(name));
    if (!s || typeof s !== 'object') return null;
    if (RUNNING.includes(s.state)) {
      const alive = jobs.has(name) ? true : await d.unitActive(unitOf(name));
      const age = now() - Date.parse(s.updatedAt || 0);
      // 任务单元不在了（刚写完进度、单元还没起来的几秒不算）；查不出单元（没有 systemd）就看多久没动
      if ((alive === false && age > UNIT_GRACE_MS) || (alive === null && age > STALL_MS)) {
        return { ...s, state: 'failed', error: { code: 'E_PACK_STALLED', message: '安装中断了（设备重启或断电？）。可以重试。' } };
      }
    }
    return s;
  }
  const running = (s) => !!s && RUNNING.includes(s.state);
  const cancellable = (s) => !!s && s.state === 'installing' && (s.step || 0) <= LAST_CANCELLABLE_STEP;

  const progressView = (name, pr) => !pr
    ? { name, version: null, state: 'idle', step: 0, steps: INSTALL_STEPS, percent: 0, message: '', cancellable: false, paused: false, error: null, updatedAt: null }
    : { name, version: pr.version || null, state: pr.state, step: pr.step || 0, steps: pr.steps || INSTALL_STEPS, percent: pr.percent || 0, message: pr.message || '', cancellable: cancellable(pr), paused: pr.paused === true && RUNNING.includes(pr.state), error: pr.error || null, updatedAt: pr.updatedAt || null };

  // ---------- 列表 ----------
  async function list() {
    const [cat, st, settings] = await Promise.all([loadCatalog(), loadState(), loadSettings()]);
    const packs = [];
    let busy = null;
    for (const [name, e] of cat) {
      const inst = st.installed[name] || null;
      const pr = await progressOf(name);
      let status = 'not-installed';
      let error = null;
      if (running(pr)) { status = 'installing'; busy = busy || { name, action: ACTION_OF[pr.state] }; }
      else if (inst) status = inst.enabled ? 'installed' : 'disabled';
      else if (pr && pr.state === 'failed') status = 'failed';
      if (pr && pr.state === 'failed') error = pr.error || { code: 'E_PACK', message: '操作失败' }; // 装着的包升级 / 停用失败：状态还是已安装，带上原因
      packs.push({
        name, title: e.title || {}, description: e.description || {}, services: e.services, depends: e.depends, volumes: e.volumes, restartsConsole: e.restartsConsole !== false,
        neededBy: installedDependents(name, st, cat),
        status, enabled: inst ? inst.enabled : false, version: inst ? inst.version : null, installedAt: inst ? inst.installedAt || null : null,
        source: inst ? inst.source : null,
        minOs: inst && inst.minOs ? inst.minOs : null,
        sizeBytes: (inst && inst.sizeBytes) || (pr && pr.sizeBytes) || e.sizeBytes || null,
        images: inst ? Object.entries(inst.images).map(([ref, id]) => ({ ref, id: String(id) })) : [],
        progress: status === 'installing' ? { step: pr.step || 0, steps: pr.steps || INSTALL_STEPS, percent: pr.percent || 0, message: pr.message || '', cancellable: cancellable(pr), paused: pr.paused === true } : null,
        error,
      });
    }
    return { packs, settings, source: { online: !!src.online, reason: src.online ? '' : src.reason || 'E_NO_SOURCE' }, busy, os: { version: await d.osVersion() } };
  }

  async function settings() { return loadSettings(); }
  async function setSettings(b) {
    if (typeof b?.autoInstall !== 'boolean') throw err('E_PARAM', 'autoInstall 要是 true / false', 400);
    await d.writeAtomic(P.settings, JSON.stringify({ autoInstall: b.autoInstall }, null, 1), 0o644);
    await d.audit('packs-settings', { autoInstall: b.autoInstall, by: b.by });
    return { autoInstall: b.autoInstall };
  }

  // ---------- 检查一个包文件 ----------
  /** 读清单 + 验签（+ 可选：整个 images.tar 的 sha256）。不对就抛 E_PACK_* */
  async function inspect(file, { hash = false } = {}) {
    let idx;
    try { idx = await d.tarIndex(file); } catch (e) { throw err('E_PACK_FORMAT', e instanceof AgentError ? e.message : '不是扩展包（读不出 tar 结构）', 400); }
    if (idx.duplicates && idx.duplicates.size) throw err('E_PACK_FORMAT', '不是正常的 H2Z OS 扩展包（里面有重名的文件：' + [...idx.duplicates].slice(0, 3).join('、') + '）', 400);
    const man = idx.get('manifest.json'), sig = idx.get('manifest.sig'), img = idx.get('images.tar');
    if (!man || !sig || !img || man.size > 1 << 20 || sig.size > 4096) throw err('E_PACK_FORMAT', '不是 H2Z OS 扩展包（缺少 manifest.json / manifest.sig / images.tar）', 400);
    const manBuf = await d.readPart(file, man);
    const sigBuf = await d.readPart(file, sig);
    const pem = await d.hostCat('/usr/share/h2z/update-pubkey.pem');
    if (!pem) throw err('E_PACK_NO_KEY', '设备上没有签名公钥（/usr/share/h2z/update-pubkey.pem）：用新版安装盘重装一次后才能装扩展', 409);
    let ok = false;
    try { ok = cryptoVerify(null, manBuf, createPublicKey(pem), Buffer.from(sigBuf.toString('utf8').trim(), 'base64')); } catch { ok = false; }
    if (!ok) throw err('E_PACK_SIGNATURE', '签名不对：这个文件不是给这台设备做的，或者被改过。什么都没装。', 400);
    let manifest;
    try { manifest = parsePackManifest(JSON.parse(manBuf.toString('utf8'))); } catch (e) { throw err('E_PACK_FORMAT', String(e.message), 400); }
    if (hash && (await d.hashPart(file, img)) !== manifest.files['images.tar']) throw err('E_PACK_CHECKSUM', `「${manifest.name}」的镜像文件校验对不上：文件可能损坏，重新拷一次。什么都没装。`, 400);
    return { manifest, sizeBytes: man.size + sig.size + img.size };
  }

  // ---------- U 盘 ----------
  async function usbScan() {
    const { sticks } = await d.usbScan('h2zpack');
    const out = [];
    for (const s of sticks) {
      const files = [];
      for (const f of s.files) {
        try {
          const { manifest } = await inspect(f.path);
          files.push({ name: f.name, path: f.path, sizeBytes: f.sizeBytes, pack: { name: manifest.name, version: manifest.version, depends: manifest.depends, minOs: manifest.minOs }, signatureOk: true });
        } catch (e) {
          files.push({ name: f.name, path: f.path, sizeBytes: f.sizeBytes, pack: null, signatureOk: e.code === 'E_PACK_SIGNATURE' ? false : null, problem: { code: e.code || 'E_PACK', message: String(e.message || e) } });
        }
      }
      out.push({ device: s.device, label: s.label || '', sizeBytes: s.sizeBytes || 0, files });
    }
    return { sticks: out };
  }

  // ---------- 上传（请求体就是包本身，流式写盘）----------
  let upOp = false;
  async function upload(req) {
    if (upOp) throw err('E_CONFLICT', '另一个扩展包正在上传，请稍后再试');
    upOp = true;
    const dir = join(P.dir, 'incoming');
    const part = join(dir, 'incoming-' + randomUUID() + '.part');
    try {
      await d.mkdirp(dir);
      await d.mkdirp(join(P.dir, 'staged'));
      await new Promise((resolve, reject) => {
        let n = 0;
        const out = createWriteStream(part, { mode: 0o644, flags: 'wx' });
        const stop = (e) => { req.unpipe(out); out.destroy(); reject(e); }; // 出错 / 客户端断开：文件句柄要关掉，不然删掉的 .part 一直占着盘
        out.on('error', reject).on('finish', resolve);
        req.on('data', (c) => {
          n += c.length;
          if (n > d.maxBytes) stop(err('E_PARAM', '扩展包太大（超过 ' + Math.round(d.maxBytes / 2 ** 30) + ' GB）', 413));
        });
        req.on('error', stop);
        req.on('aborted', () => stop(err('E_PARAM', '上传中断', 400)));
        req.pipe(out);
      });
      const { manifest } = await inspect(part, { hash: true });
      const [cat, st] = await Promise.all([loadCatalog(), loadState()]);
      if (!cat.has(manifest.name)) throw err('E_PACK_NOT_FOUND', `这台设备不认识扩展「${manifest.name}」`, 404);
      const plan = planInstall({ manifest, state: st, cat, osVersion: await d.osVersion(), freeBytes: d.freeBytes(P.dir), hostArch: await d.hostArch() });
      for (const f of await d.readdir(join(P.dir, 'staged'))) if (f.startsWith(manifest.name + '-') && f.endsWith('.h2zpack')) await d.remove(join(P.dir, 'staged', f));
      const staged = join(P.dir, 'staged', `${manifest.name}-${manifest.version}.h2zpack`);
      await d.rename(part, staged);
      const size = (await d.stat(staged)).size;
      await d.audit('pack-staged', { name: manifest.name, version: manifest.version, bytes: size });
      return { staged: { name: manifest.name, version: manifest.version, sizeBytes: size, depends: manifest.depends, minOs: manifest.minOs, notes: manifest.notes, created: manifest.created, checks: plan.checks, problem: plan.problem } };
    } catch (e) {
      await d.remove(part);
      throw e;
    } finally {
      upOp = false;
    }
  }
  async function stagedFile(name) {
    const f = (await d.readdir(join(P.dir, 'staged')).catch(() => [])).filter((x) => x.startsWith(name + '-') && x.endsWith('.h2zpack')).sort((a, b) => {
      const va = a.slice(name.length + 1, -'.h2zpack'.length), vb = b.slice(name.length + 1, -'.h2zpack'.length);
      return cmpVer(va, vb);
    }).pop();
    if (!f) throw err('E_PACK_NOT_STAGED', `还没有上传「${name}」的扩展包：先上传文件。`);
    return join(P.dir, 'staged', f);
  }
  const usbFile = (p) => {
    const m = /^\/run\/h2z-usb\/([\w-]+)\/([^/]+\.h2zpack)$/i.exec(String(p || ''));
    if (!m || m[2].startsWith('-')) throw err('E_PARAM', '只能从 U 盘根目录安装 .h2zpack 扩展包', 400);
    return m[0];
  };

  // ---------- 操作：同一时间只做一个（任务在宿主上后台跑，靠 state.json 判断有没有在忙）----------
  let op = '';
  /** 有没有扩展包操作在进行（整包升级开始前要问：两边都会 docker compose up，不能同时） */
  async function busy() {
    if (op || upOp) return true;
    for (const name of (await loadCatalog()).keys()) if (running(await progressOf(name))) return true;
    return false;
  }
  async function exclusive(label, fn) {
    if (op) throw err('E_CONFLICT', `另一个扩展包操作正在进行（${op}），请等它做完。`);
    if (d.upgradeBusy && (await d.upgradeBusy())) throw err('E_CONFLICT', '正在升级系统，等升级做完再操作扩展。');
    op = label;
    try {
      const cat = await loadCatalog();
      for (const name of cat.keys()) if (running(await progressOf(name))) throw err('E_CONFLICT', `正在处理${quoted(cat, name)}，等它做完再操作。`);
      return await fn(cat);
    } finally {
      op = '';
    }
  }

  /** 写进度文件 → 起宿主任务；起不来就把进度改成失败再抛 */
  async function launchJob(name, st, args) {
    const t = iso();
    await d.mkdirp(join(P.dir, name));
    await d.writeAtomic(statePath(name), JSON.stringify({ name, version: null, step: 0, steps: 1, percent: 0, message: '', sizeBytes: null, source: null, error: null, ...st, startedAt: t, updatedAt: t }, null, 1), 0o644);
    try {
      await d.launch(unitOf(name), args);
    } catch (e) {
      const msg = String(e.stderr || e.message || e).slice(0, 200);
      await d.writeAtomic(statePath(name), JSON.stringify({ name, ...st, state: 'failed', startedAt: t, updatedAt: iso(), error: { code: 'E_PACK_LAUNCH', message: '没能在设备上启动任务：' + msg } }, null, 1), 0o644);
      throw err('E_PACK_LAUNCH', '没能在设备上启动任务：' + msg, 500);
    }
    return progress(name);
  }

  /** 文件已经在本机（暂存 / U 盘 / 下载好的）：再验一遍、查要求、写进度、起宿主任务 */
  async function startInstall(name, file, source, by, cat) {
    const { manifest, sizeBytes } = await inspect(file, { hash: false }); // 整个镜像文件的校验在装的时候（宿主脚本，边解包边算）做，免得读两遍
    if (manifest.name !== name) throw err('E_PACK_NAME', `这个文件是${quoted(cat, manifest.name)}的包，不是${quoted(cat, name)}的。`);
    const st = await loadState();
    const plan = planInstall({ manifest, state: st, cat, osVersion: await d.osVersion(), freeBytes: d.freeBytes(P.dir), hostArch: await d.hostArch() });
    if (plan.problem) throw err(plan.problem.code, plan.problem.message, plan.problem.status);
    await d.audit('pack-install', { name, version: manifest.version, source, by });
    return launchJob(name, { version: manifest.version, state: 'installing', step: 1, steps: INSTALL_STEPS, message: '检查签名和要求', sizeBytes, source, by }, ['install', hostPath(file), '--name', name, '--source', source, '--by', by]);
  }

  /** 联网安装：先在 host-agent 里把包下载到暂存目录（进度写第 1 步），下载完和上传的包走同一条验证 / 安装路径 */
  async function installOnline(name, b, cat) {
    const by = byOf(b);
    const pick = (await src.list()).filter((x) => x.name === name).sort((x, y) => cmpVer(x.version, y.version)).pop();
    if (!pick) throw err('E_PACK_NOT_FOUND', `下载源上没有${quoted(cat, name)}。`, 404);
    const t = iso();
    await d.mkdirp(join(P.dir, name));
    await d.mkdirp(join(P.dir, 'incoming'));
    const write = (patch) => d.writeAtomic(statePath(name), JSON.stringify({ name, version: pick.version, state: 'installing', step: 1, steps: INSTALL_STEPS, percent: 0, message: '', sizeBytes: pick.sizeBytes || null, source: 'online', by, error: null, startedAt: t, updatedAt: iso(), ...patch }, null, 1), 0o644);
    await write({ message: '正在下载' });
    jobs.add(name);
    const part = join(P.dir, 'incoming', `online-${randomUUID()}.part`);
    (async () => {
      try {
        let last = 0;
        await src.fetch(pick.name, pick.version, part, (done, total) => {
          if (Date.now() - last < 1000) return; // 进度文件一秒写一次就够
          last = Date.now();
          write({ percent: total ? Math.min(2, Math.floor((2 * done) / total)) : 0, message: `正在下载 — ${Math.round(done / 2 ** 20)} MB / ${Math.round((total || pick.sizeBytes || 0) / 2 ** 20)} MB` }).catch(() => {});
        });
        const { manifest } = await inspect(part, { hash: true }); // 传输不是信任根：下载来的和上传的验证一样
        if (manifest.name !== name || manifest.version !== pick.version) throw err('E_PACK_NAME', '下载下来的包和下载源上写的对不上。');
        await d.mkdirp(join(P.dir, 'staged'));
        for (const f of await d.readdir(join(P.dir, 'staged'))) if (f.startsWith(name + '-') && f.endsWith('.h2zpack')) await d.remove(join(P.dir, 'staged', f));
        const staged = join(P.dir, 'staged', `${name}-${manifest.version}.h2zpack`);
        await d.rename(part, staged);
        jobs.delete(name);
        await startInstall(name, staged, 'online', by, cat); // 起宿主任务（接管进度文件）
      } catch (e) {
        jobs.delete(name);
        await d.remove(part);
        await write({ state: 'failed', error: { code: e.code || 'E_PACK_FETCH', message: String(e.message || e).slice(0, 300) } }).catch(() => {});
      }
    })();
    return progress(name);
  }

  async function install(name, b) {
    const source = String(b?.source ?? '');
    if (!SOURCES.includes(source)) throw err('E_PARAM', "source 只能是 'usb'、'upload' 或 'online'", 400);
    await entryOf(name);
    if (source === 'online' && !src.online) throw err('E_NO_SOURCE', '还没有下载源：现在只能从文件或 U 盘安装。', 422);
    return exclusive('安装 ' + name, async (cat) => {
      if (source === 'online') return installOnline(name, b, cat);
      const file = source === 'usb' ? usbFile(b.path) : await stagedFile(name);
      return startInstall(name, file, source, byOf(b), cat);
    });
  }

  async function progress(name) {
    await entryOf(name);
    return progressView(name, await progressOf(name));
  }

  async function cancel(name, b) {
    const cat = await loadCatalog();
    if (!cat.has(name)) throw err('E_PACK_NOT_FOUND', `没有这个扩展包：${name}`, 404);
    const pr = await progressOf(name);
    if (!pr || pr.state !== 'installing') throw err('E_PACK_NOT_CANCELLABLE', `${quoted(cat, name)}现在没有在安装，不用取消。`);
    if (!cancellable(pr)) throw err('E_PACK_NOT_CANCELLABLE', '已经进入「启动服务」，不能取消了。');
    await d.audit('pack-cancel', { name, by: byOf(b) });
    const sent = await d.signal(unitOf(name)); // 宿主脚本收到后清理、把 state.json 写成 cancelled；进入第 3 步后它自己忽略
    if (!sent) await d.writeAtomic(statePath(name), JSON.stringify({ ...pr, state: 'cancelled', updatedAt: iso(), message: '已取消', error: { code: 'E_PACK_CANCELLED', message: '已取消' } }, null, 1), 0o644);
    return progress(name);
  }

  async function change(name, b, action) {
    await entryOf(name);
    const label = { disable: '停用', enable: '启用', remove: '卸载' }[action];
    return exclusive(`${label} ${name}`, async (cat) => {
      const st = await loadState();
      const inst = st.installed[name];
      if (!inst) throw err('E_PACK_NOT_INSTALLED', `${quoted(cat, name)}还没装。`);
      if (action === 'disable' || action === 'remove') {
        const need = installedDependents(name, st, cat, { onlyEnabled: action === 'disable' });
        if (need.length) throw err('E_PACK_NEEDED_BY', `不能${label}：${need.map((n) => quoted(cat, n)).join('、')}需要它。先${label}${need.length > 1 ? '它们' : '它'}。`);
      }
      if (action === 'enable') {
        const off = (cat.get(name).depends || []).filter((x) => !st.installed[x] || !st.installed[x].enabled);
        if (off.length) throw err('E_PACK_DEPENDS', `不能启用：先启用${off.map((n) => quoted(cat, n)).join('、')}。`);
        if (inst.enabled) return progressView(name, { name, version: inst.version, state: 'done', step: 1, steps: 1, percent: 100, message: '已经是启用状态', updatedAt: iso() });
      }
      if (action === 'disable' && !inst.enabled) return progressView(name, { name, version: inst.version, state: 'done', step: 1, steps: 1, percent: 100, message: '已经是停用状态', updatedAt: iso() });
      const by = byOf(b);
      await d.audit('pack-' + action, { name, by });
      const state = { disable: 'disabling', enable: 'enabling', remove: 'removing' }[action];
      return launchJob(name, { version: inst.version, state, step: 1, steps: 1, message: { disabling: '正在停用', enabling: '正在启用', removing: '正在卸载' }[state], by }, [action, name, '--by', by]);
    });
  }
  const disable = (name, b) => change(name, b, 'disable');
  const enable = (name, b) => change(name, b, 'enable');
  const remove = (name, b) => change(name, b, 'remove');

  /** 启动时清掉上次留下的上传临时文件（host-agent 重启 / 崩溃时留下的 incoming/*.part；这时不可能有上传在进行） */
  async function cleanIncoming() {
    const dir = join(P.dir, 'incoming');
    for (const f of await d.readdir(dir).catch(() => [])) if (/^(incoming|online)-[\w-]+\.part$/.test(f)) await d.remove(join(dir, f));
  }

  return { list, settings, setSettings, usbScan, upload, install, progress, cancel, disable, enable, remove, inspect, busy, cleanIncoming };
}
