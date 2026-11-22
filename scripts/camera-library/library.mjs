/**
 * 摄像头画像库：合并、门禁校验、生成产物。h2z.security 是这份库的唯一来源。
 *
 * 数据（../../camera-library/data）：
 *   imported.json  导入层。import-ch-bas.mjs 从 CC0 数据集生成，不要手改
 *   curated.json   手写层。识别词、锁定变体、现场实测证据、旧代码里的兜底写法、ONVIF 默认端口
 *   sources.json   来源台账。库里每条数据的来源都必须在这里登记，用法和许可必须在允许范围内
 * 产物（../../camera-library/library.json）：build.mjs 把上面三份合并、校验、排好序生成的扁平文件。
 * backend 容器只读挂载它，h2z.backend IOC 读 IOC_CAMERA_LIBRARY_FILE 取用；h2z.backend 里不放这份数据。
 *
 * validateRaw 是许可 / 来源 / 口令 / 路径安全的门禁：数据不合规就生成不出产物，测试里用坏数据验证它真的拦得住。
 * 库只存「事实 + 证据」，不存口令、不存默认口令。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../camera-library');
export const ARTIFACT = 'library.json';
export const SCHEMA = 1;

const ROLES = ['main', 'sub', 'third', 'fourth'];
const STATUSES = ['verified', 'documented', 'candidate'];
const TARGETS = ['camera', 'nvr', 'any'];
const EVIDENCE_TYPES = ['vendor-doc', 'mirror-doc', 'citation', 'device', 'legacy-code'];
const RANK = { verified: 0, documented: 1, candidate: 2 };

export const statusRank = (s) => RANK[s];
export const worseStatus = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** 聚合站 / 线索库的名字：出现在导入数据里说明过滤没拦住，不能入库 */
export const FORBIDDEN_TEXT = /ispy|strix|smartrtsp|camlytics|ipcamlive|agent\s?dvr|security\.world|rtsp\.me/i;
/** 路径里不许有口令 / 地址形态的内容 */
const CREDENTIAL_LIKE = /:\/\/|@|password|passwd|pwd=|user=|\{user\}|\{pass\}/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const lower = (s) => String(s).toLowerCase();
const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

/**
 * 「只有型号」的识别写法：厂家字没认出来时，按型号的样子认品牌（例如 Tapo 的 ONVIF 常只给 C210 / C510W / TC70，不带厂家）。
 * 每条是一个正则源码，对「小写、非字母数字换成单个空格、首尾各一个空格」的文本做匹配，所以词边界就是空格：
 *   ` (?:tc\d{2}[a-z]?|c[1-9]\d{2}[a-z]{0,2}) `
 * 在所有品牌的识别词之后才用（别的厂家认出来就不走这条）。文件来自容器外，正则必须能安全执行：
 * 只许小写字母 / 数字 / 空格和少量元字符，反斜杠只许 \d \. \-；分组后面不许再跟 * + {（嵌套量词会指数回溯）；不许反向引用 / 环视；长度和个数有上限。
 * h2z.backend IOC 加载时做同一套检查（apps/ioc/src/camera-library/library.ts）。
 */
export const MODEL_PATTERN_MAX = 120;
export const MODEL_PATTERNS_MAX = 20;
export function modelPatternProblem(p) {
  if (typeof p !== 'string' || p.length < 3 || p.length > MODEL_PATTERN_MAX) return `长度要在 3–${MODEL_PATTERN_MAX} 个字符`;
  if (!/^[a-z0-9 \\()[\]{}?*+|^$.,:-]+$/.test(p)) return '只许小写字母、数字、空格和 \\ ( ) [ ] { } ? * + | ^ $ . , : -';
  if (/\\(?![d.-])/.test(p)) return '反斜杠只许 \\d \\. \\-';
  if (/\)[*+{]/.test(p)) return '分组后面不许再跟 * + {（嵌套量词会指数回溯）';
  if (/\(\?(?!:)/.test(p)) return '不许环视 / 命名分组，只许 (?: )';
  try {
    new RegExp(p);
  } catch {
    return '不是合法的正则';
  }
  return '';
}
const modelPatternsProblem = (list) => {
  if (!Array.isArray(list) || list.length < 1 || list.length > MODEL_PATTERNS_MAX) return `必须是 1–${MODEL_PATTERNS_MAX} 条的数组`;
  for (const x of list) {
    const why = modelPatternProblem(x);
    if (why) return JSON.stringify(x) + '：' + why;
  }
  return '';
};

// ---------------------------------------------------------------------------------------------------
// 路径模板渲染
// ---------------------------------------------------------------------------------------------------
/**
 * 库里的路径最终会被原样拼进 RTSP 请求行（DESCRIBE），所以渲染结果必须落在这个字符集里：
 * 不许空白、回车换行、引号、尖括号等。h2z.backend IOC 的 SAFE_PATH 是同一条。
 */
export const SAFE_PATH = /^\/[A-Za-z0-9/_.:%?&=+~-]{0,198}$/;

/**
 * 渲染模板：{ch} = 通道（从 1 起），{ch2} = 两位补零的通道。
 * 还有别的占位符（{codec}、{token} 这类需要人给值的）、或渲染结果不安全 → 返回 null，绝不猜着填。
 */
export function renderPath(template, ctx = {}) {
  const ch = Number.isInteger(ctx.ch) && ctx.ch >= 1 && ctx.ch <= 999 ? ctx.ch : 1;
  let unresolved = false;
  const out = String(template).replace(/\{(\w+)\}/g, (_m, key) => {
    if (key === 'ch') return String(ch);
    if (key === 'ch2') return String(ch).padStart(2, '0');
    unresolved = true;
    return '';
  });
  return unresolved || !SAFE_PATH.test(out) ? null : out;
}

// ---------------------------------------------------------------------------------------------------
// 读原始数据
// ---------------------------------------------------------------------------------------------------
export function loadRaw(dir = LIB_DIR) {
  const read = (name) => JSON.parse(readFileSync(resolve(dir, 'data', name), 'utf8'));
  return { imported: read('imported.json'), curated: read('curated.json'), sources: read('sources.json') };
}

// ---------------------------------------------------------------------------------------------------
// 出厂账号 / 激活 / 锁定阈值（factory，2026-11-08 负责人决定：摄像头库里要有各品牌默认账号，做「通网即自动接入」）
//
// 红线调整：库里仍然**不许有路径带口令**（见 CREDENTIAL_LIKE），但允许厂家公开的**出厂默认账号**放在 vendors[].factory.accounts 里：
//   - 只收厂家文档 / 手册 / 可信转载里写明的出厂值；每条必须带证据和链接，等级规则和码流一致
//     （verified 必须有真机证据，documented 必须有厂家文档，转载页只能是 candidate）；
//   - 不收「别人设的口令」「常见弱口令字典」；每个品牌只列出厂值（通常 ≤ 2 条）；
//   - 后端只对「疑似出厂」的设备、在每台设备的尝试预算内使用，见 h2z.backend apps/ioc/src/network/camera-onboard.ts。
// ---------------------------------------------------------------------------------------------------
export const FACTORY_EVIDENCE_SOURCE = { 'vendor-doc': 'vendor-doc', 'mirror-doc': 'third-party-cite', device: 'first-party' };
const FACTORY_EVIDENCE_TYPES = Object.keys(FACTORY_EVIDENCE_SOURCE);
const ACTIVATION_REQUIRED = ['always', 'new-firmware', 'none', 'unknown'];
/**
 * 激活配方（activation.recipes，2026-11-21 负责人决定：平台自己激活，不引导用户去用厂家工具）：
 * 每条是「一种具体的激活协议实现」，method 对应 h2z.backend 里一段写死的客户端代码（例如 method: "sadp" → SADP UDP
 * 广播客户端），库里不存协议细节本身（报文格式、加密方式这些是代码，不是可声明的数据）。status 决定要不要自动跑：
 * 只有 verified / documented 会被后端自动尝试，candidate 必须人确认一次才跑（见 checkEvidence 的证据门槛，和码流路径一致）。
 */
const RECIPE_ID = /^[a-z][a-z0-9]*(\.[a-z0-9-]+){0,2}$/;
const RECIPE_METHOD = /^[a-z0-9-]{2,20}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const FACTORY_USER = /^[A-Za-z0-9._-]{1,32}$/;
const FACTORY_PASS = /^[\x21-\x7e]{1,32}$/;

function checkEvidence(p, where, status, evidence, usable) {
  if (!Array.isArray(evidence) || !evidence.length) {
    p.push(`${where}：没有证据`);
    return;
  }
  for (const e of evidence) {
    if (!FACTORY_EVIDENCE_TYPES.includes(e?.type)) p.push(`${where}：证据类型不合法：${e?.type}`);
    const src = FACTORY_EVIDENCE_SOURCE[e?.type];
    if (src && !usable(src)) p.push(`${where}：证据来源 ${src} 不在台账里，或用法 / 许可不被允许`);
    if (e?.url !== undefined && !/^https?:\/\/\S{1,500}$/.test(e.url)) p.push(`${where}：证据链接不合法`);
    if (e?.type !== 'device' && !e?.url) p.push(`${where}：厂家文档 / 转载页证据必须带链接`);
    if (e?.date !== undefined && !DATE.test(e.date)) p.push(`${where}：证据日期必须是 YYYY-MM-DD`);
  }
  if (status === 'verified' && !evidence.some((e) => e.type === 'device')) p.push(`${where}：verified 必须有真机（device）证据`);
  if (status === 'documented' && !evidence.some((e) => e.type === 'vendor-doc')) p.push(`${where}：documented 必须有厂家文档（vendor-doc）证据（转载页只能是 candidate）`);
}

/** curated 里一个品牌的 factory 校验；返回问题列表 */
export function factoryProblems(f, id, usable) {
  const p = [];
  const w = `curated.${id}.factory`;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return [`${w} 必须是对象`];
  if (!Array.isArray(f.accounts)) p.push(`${w}.accounts 必须是数组（没有出厂账号写空数组）`);
  else {
    if (f.accounts.length > 3) p.push(`${w}.accounts 最多 3 条（只收出厂值，不是口令字典）`);
    f.accounts.forEach((a, i) => {
      const at = `${w}.accounts[${i}]`;
      if (!FACTORY_USER.test(a?.username || '')) p.push(`${at}.username 不合法`);
      if (!FACTORY_PASS.test(a?.password || '')) p.push(`${at}.password 必须是 1–32 位可见 ASCII`);
      if (a?.scope !== undefined && (typeof a.scope !== 'string' || a.scope.length > 200)) p.push(`${at}.scope 必须是 200 字以内的字符串`);
      if (!STATUSES.includes(a?.status)) p.push(`${at}.status 不合法`);
      else checkEvidence(p, at, a.status, a.evidence, usable);
    });
  }
  const act = f.activation;
  if (!act || typeof act !== 'object') p.push(`${w}.activation 必须是对象（不清楚就写 required: "unknown"）`);
  else {
    if (!ACTIVATION_REQUIRED.includes(act.required)) p.push(`${w}.activation.required 只能是 ${ACTIVATION_REQUIRED.join(' / ')}`);
    if (!STATUSES.includes(act.status)) p.push(`${w}.activation.status 不合法`);
    if (act.methods !== undefined && !(Array.isArray(act.methods) && act.methods.every((m) => typeof m === 'string' && /^[a-z0-9-]{2,20}$/.test(m)))) p.push(`${w}.activation.methods 不合法`);
    if (act.minPasswordLength !== undefined && !(Number.isInteger(act.minPasswordLength) && act.minPasswordLength >= 1 && act.minPasswordLength <= 64)) p.push(`${w}.activation.minPasswordLength 不合法`);
    if (act.required !== 'unknown' && STATUSES.includes(act.status)) checkEvidence(p, `${w}.activation`, act.status, act.evidence, usable);
    if (act.recipes !== undefined) {
      if (!Array.isArray(act.recipes) || act.recipes.length > 5) p.push(`${w}.activation.recipes 必须是数组（最多 5 条）`);
      else
        act.recipes.forEach((r, i) => {
          const rt = `${w}.activation.recipes[${i}]`;
          if (typeof r?.id !== 'string' || !RECIPE_ID.test(r.id)) p.push(`${rt}.id 不合法`);
          if (typeof r?.method !== 'string' || !RECIPE_METHOD.test(r.method)) p.push(`${rt}.method 不合法`);
          if (r?.note !== undefined && (typeof r.note !== 'string' || r.note.length > 1000)) p.push(`${rt}.note 必须是 1000 字以内的字符串`);
          if (!STATUSES.includes(r?.status)) p.push(`${rt}.status 不合法`);
          else checkEvidence(p, rt, r.status, r.evidence, usable);
        });
    }
  }
  const lk = f.lock;
  if (!lk || typeof lk !== 'object') p.push(`${w}.lock 必须是对象（不清楚写 maxAttempts: null）`);
  else {
    const n = (v, max) => v === null || (Number.isInteger(v) && v >= 1 && v <= max);
    if (!n(lk.maxAttempts, 100)) p.push(`${w}.lock.maxAttempts 必须是 1–100 的整数或 null`);
    if (!n(lk.lockMinutes, 1440)) p.push(`${w}.lock.lockMinutes 必须是 1–1440 的整数或 null`);
    if (!STATUSES.includes(lk.status)) p.push(`${w}.lock.status 不合法`);
    if (lk.maxAttempts !== null && STATUSES.includes(lk.status)) checkEvidence(p, `${w}.lock`, lk.status, lk.evidence, usable);
  }
  if (f.factoryIps !== undefined && !(Array.isArray(f.factoryIps) && f.factoryIps.length <= 5 && f.factoryIps.every((x) => IPV4.test(x)))) p.push(`${w}.factoryIps 必须是 IPv4 数组（最多 5 个）`);
  return p;
}

/** 产物里的 factory：不带证据和备注（和码流路径一致，证据留在 data/ 里） */
function factoryOut(f) {
  const out = {
    accounts: f.accounts.map((a) => ({ username: a.username, password: a.password, ...(a.scope ? { scope: a.scope } : {}), status: a.status })),
    activation: {
      required: f.activation.required,
      ...(f.activation.methods ? { methods: [...f.activation.methods] } : {}),
      ...(f.activation.minPasswordLength ? { minPasswordLength: f.activation.minPasswordLength } : {}),
      ...(f.activation.recipes ? { recipes: f.activation.recipes.map((r) => ({ id: r.id, method: r.method, status: r.status })) } : {}),
      status: f.activation.status,
    },
    lock: { maxAttempts: f.lock.maxAttempts, lockMinutes: f.lock.lockMinutes, status: f.lock.status },
    factoryIps: [...(f.factoryIps || [])],
  };
  return out;
}

/** 产物里 factory 的结构检查（后端加载时做同一类检查） */
export function factoryArtifactProblems(f, id) {
  const p = [];
  const w = `${id}.factory`;
  if (!f || typeof f !== 'object') return [`${w} 必须是对象`];
  if (!Array.isArray(f.accounts) || f.accounts.length > 3) p.push(`${w}.accounts 不合法`);
  else
    for (const a of f.accounts) {
      if (!FACTORY_USER.test(a?.username || '') || !FACTORY_PASS.test(a?.password || '')) p.push(`${w}.accounts 里有不合法的账号 / 口令`);
      if (!STATUSES.includes(a?.status)) p.push(`${w}.accounts.status 不合法`);
    }
  if (!ACTIVATION_REQUIRED.includes(f.activation?.required) || !STATUSES.includes(f.activation?.status)) p.push(`${w}.activation 不合法`);
  if (f.activation?.recipes !== undefined) {
    if (!Array.isArray(f.activation.recipes)) p.push(`${w}.activation.recipes 不合法`);
    else
      for (const r of f.activation.recipes) {
        if (typeof r?.id !== 'string' || typeof r?.method !== 'string' || !STATUSES.includes(r?.status)) p.push(`${w}.activation.recipes 里有不合法的配方`);
      }
  }
  const n = (v, max) => v === null || (Number.isInteger(v) && v >= 1 && v <= max);
  if (!n(f.lock?.maxAttempts, 100) || !n(f.lock?.lockMinutes, 1440) || !STATUSES.includes(f.lock?.status)) p.push(`${w}.lock 不合法`);
  if (!Array.isArray(f.factoryIps) || !f.factoryIps.every((x) => IPV4.test(x))) p.push(`${w}.factoryIps 不合法`);
  return p;
}

// ---------------------------------------------------------------------------------------------------
// 合并：导入层 + 手写层 → 库
// ---------------------------------------------------------------------------------------------------
function mapStream(s, source) {
  const out = { path: s.path, status: s.status, evidence: (Array.isArray(s.evidence) ? s.evidence : []).map((e) => ({ ...e, source })) };
  if (s.codec) out.codec = s.codec;
  if (s.port) out.port = s.port;
  if (Array.isArray(s.params) && s.params.length) out.params = [...s.params];
  if (s.note) out.note = s.note;
  return out;
}

export function mergeLibrary(raw) {
  const src = raw.imported.source.id;
  const vendors = [];
  const byId = new Map();
  const add = (v) => {
    vendors.push(v);
    byId.set(v.id, v);
    return v;
  };

  for (const iv of raw.imported.vendors) {
    add({
      id: iv.id,
      name: iv.name,
      rtspPort: iv.rtspPort ?? null,
      aliases: (iv.aliases || []).map(lower),
      matchMode: 'word',
      autoFill: false,
      onvifPorts: [],
      variants: iv.variants.map((v) => {
        const streams = {};
        for (const role of ROLES) if (v.streams?.[role]) streams[role] = mapStream(v.streams[role], src);
        const out = { id: v.id, target: v.target, label: v.label || '', streams };
        if (v.series) out.series = v.series;
        if (v.scope) out.scope = v.scope;
        if (Array.isArray(v.extras) && v.extras.length) out.extras = v.extras.map((x) => ({ ...mapStream(x, src), label: x.label }));
        return out;
      }),
    });
  }

  // 手写层：给已有品牌补识别词 / 锁定变体 / 端口，或新建品牌
  const autoFillOrder = [];
  for (const [id, c] of Object.entries(raw.curated.vendors || {})) {
    const v = byId.get(id) || add({ id, name: c.name || id, rtspPort: c.rtspPort ?? null, aliases: [], matchMode: 'word', autoFill: false, onvifPorts: [], variants: [] });
    v.aliases = [...new Set([...v.aliases, ...(c.aliases || []).map(lower)])];
    if (c.matchMode) v.matchMode = c.matchMode;
    if (c.autoFill) {
      v.autoFill = true;
      autoFillOrder.push(id);
    }
    if (c.pin) v.pin = c.pin;
    if (Array.isArray(c.onvifPorts)) v.onvifPorts = [...c.onvifPorts];
    if (Array.isArray(c.requires)) v.requires = [...c.requires];
    if (Array.isArray(c.modelPatterns)) v.modelPatterns = [...c.modelPatterns];
    if (c.note) v.note = c.note;
    if (Array.isArray(c.quirks)) v.quirks = c.quirks.map((q) => ({ ...q }));
    if (c.factory) v.factory = JSON.parse(JSON.stringify(c.factory));
  }

  // 旧代码里的兜底写法：只当探测候选，永远是 candidate
  const g = raw.curated.generic;
  if (g) {
    const ev = { ...g.evidence, source: 'first-party' };
    add({
      id: g.id,
      name: g.name,
      rtspPort: null,
      aliases: [],
      matchMode: 'word',
      autoFill: false,
      onvifPorts: [],
      variants: g.variants.map((x) => ({
        id: x.id,
        target: 'any',
        label: '',
        streams: { main: { path: x.main, status: 'candidate', evidence: [ev] }, sub: { path: x.sub, status: 'candidate', evidence: [ev] } },
      })),
    });
  }

  const variants = new Map();
  for (const v of vendors) for (const variant of v.variants) variants.set(variant.id, { vendor: v, variant });

  // 现场实测证据：把指定的流升为 verified，并挂上真机证据
  for (const p of raw.curated.promote || []) {
    const hit = variants.get(p.variant);
    if (!hit) continue; // validateRaw 会报
    for (const role of p.streams || []) {
      const s = hit.variant.streams[role];
      if (!s) continue;
      s.status = 'verified';
      s.evidence.push({ ...p.evidence, source: 'first-party' });
    }
  }

  let streams = 0;
  const byStatus = { verified: 0, documented: 0, candidate: 0 };
  for (const { variant } of variants.values()) {
    for (const s of [...Object.values(variant.streams), ...(variant.extras || [])]) {
      if (!s) continue;
      streams++;
      byStatus[s.status]++;
    }
  }

  const i = raw.imported.source;
  return {
    vendors,
    byId,
    variants,
    autoFillOrder,
    sweep: Array.isArray(raw.curated.sweep) ? [...raw.curated.sweep] : [],
    onvifPorts: Array.isArray(raw.curated.onvifPorts) ? [...raw.curated.onvifPorts] : [],
    sources: raw.sources.sources || [],
    upstream: { id: i.id, license: i.license, commit: i.commit, sha256: i.sha256, upstreamGenerated: i.upstreamGenerated, retrievedAt: i.retrievedAt },
    stats: { vendors: vendors.length, variants: variants.size, streams, byStatus },
  };
}

// ---------------------------------------------------------------------------------------------------
// 门禁：返回问题列表，空 = 合规
// ---------------------------------------------------------------------------------------------------
function checkStream(p, where, s, usable) {
  if (typeof s?.path !== 'string' || !s.path.startsWith('/')) {
    p.push(`${where}：路径必须以 / 开头`);
    return;
  }
  if (CREDENTIAL_LIKE.test(s.path)) p.push(`${where}：路径里有口令 / 地址形态的内容：${s.path}`);
  if (!STATUSES.includes(s.status)) p.push(`${where}：status 不合法：${s.status}`);
  if (s.note !== undefined && (typeof s.note !== 'string' || s.note.length > 300)) p.push(`${where}：note 必须是 300 字以内的字符串`);
  if (!Array.isArray(s.evidence) || !s.evidence.length) {
    p.push(`${where}：没有证据`);
    return;
  }
  for (const e of s.evidence) {
    if (!EVIDENCE_TYPES.includes(e.type)) p.push(`${where}：证据类型不合法：${e.type}`);
    if (!usable(e.source)) p.push(`${where}：证据来源 ${e.source} 不在台账里，或用法 / 许可不被允许`);
    if (e.url !== undefined && !/^https?:\/\/\S{1,500}$/.test(e.url)) p.push(`${where}：证据链接不合法`);
  }
  if (s.status === 'verified' && !s.evidence.some((e) => e.type === 'device')) p.push(`${where}：verified 必须有真机（device）证据：${s.path}`);
  if (s.status === 'documented' && !s.evidence.some((e) => e.type === 'vendor-doc')) p.push(`${where}：documented 必须有厂家文档（vendor-doc）证据：${s.path}`);
  const declared = [...s.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k !== 'ch' && k !== 'ch2');
  const params = s.params || [];
  if (declared.length !== new Set(params).size || declared.some((k) => !params.includes(k))) p.push(`${where}：params 和路径里的占位符对不上：${s.path}`);
  if (!declared.length) for (const ch of [1, 2, 12]) if (renderPath(s.path, { ch }) === null) p.push(`${where}：通道 ${ch} 渲染后不满足安全字符集：${s.path}`);
}

export function validateRaw(raw) {
  const p = [];
  const need = (cond, msg) => {
    if (!cond) p.push(msg);
  };

  // 1) 台账
  const ledger = Array.isArray(raw.sources?.sources) ? raw.sources.sources : [];
  const okUsage = raw.sources?.allowedUsage || [];
  const okLicense = raw.sources?.allowedLicenses || [];
  need(okUsage.length && okLicense.length, '台账缺少 allowedUsage / allowedLicenses');
  const ids = new Set();
  for (const s of ledger) {
    need(s?.id && s?.usage && s?.license, `台账条目不完整：${JSON.stringify(s)}`);
    need(!ids.has(s.id), `台账 id 重复：${s.id}`);
    ids.add(s.id);
  }
  const usable = (id) => {
    const s = ledger.find((x) => x.id === id);
    return !!s && okUsage.includes(s.usage) && okLicense.includes(s.license);
  };

  // 2) 导入文件头与卫生检查
  const imp = raw.imported;
  need(imp?.schema === 1, 'imported.schema 必须是 1');
  const src = imp?.source || {};
  need(usable(src.id), `导入来源 ${src.id} 不在台账里，或用法 / 许可不被允许`);
  const entry = ledger.find((x) => x.id === src.id);
  need(!entry || entry.license === src.license, `导入来源的许可（${src.license}）和台账（${entry?.license}）不一致`);
  need(HEX40.test(src.commit || ''), 'imported.source.commit 必须是 40 位哈希');
  need(HEX64.test(src.sha256 || ''), 'imported.source.sha256 必须是 64 位哈希');
  need(DATE.test(src.retrievedAt || ''), 'imported.source.retrievedAt 必须是 YYYY-MM-DD');
  if (!Array.isArray(imp?.vendors)) {
    p.push('imported.vendors 必须是数组');
    return p;
  }
  need(!FORBIDDEN_TEXT.test(JSON.stringify(imp.vendors)), '导入数据里出现了聚合站 / 线索库的名字，按规则不能入库');

  // 3) 手写层形状
  const cur = raw.curated || {};
  need(cur.schema === 1, 'curated.schema 必须是 1');
  const portsOk = (a) => Array.isArray(a) && a.every(validPort);
  need(portsOk(cur.onvifPorts) && cur.onvifPorts.length, 'curated.onvifPorts 必须是端口数组');
  for (const [id, c] of Object.entries(cur.vendors || {})) {
    need(Array.isArray(c.aliases) && c.aliases.length && c.aliases.every((a) => typeof a === 'string' && lower(a) === a && a.length >= 2), `curated.${id}.aliases 必须是小写、至少 2 个字符的非空数组`);
    need(!c.matchMode || ['word', 'substring'].includes(c.matchMode), `curated.${id}.matchMode 不合法`);
    need(!c.onvifPorts || portsOk(c.onvifPorts), `curated.${id}.onvifPorts 必须是端口数组`);
    need(!c.autoFill || c.pin, `curated.${id} 开了 autoFill 就必须锁定变体（pin）`);
    if (c.modelPatterns !== undefined) need(!modelPatternsProblem(c.modelPatterns), `curated.${id}.modelPatterns 不合规：${modelPatternsProblem(c.modelPatterns)}`);
    if (c.factory !== undefined) p.push(...factoryProblems(c.factory, id, usable));
  }

  // 4) 合并后检查
  let lib;
  try {
    lib = mergeLibrary(raw);
  } catch (e) {
    p.push('合并失败：' + e.message);
    return p;
  }
  const seen = new Set();
  for (const v of lib.vendors) {
    need(/^[a-z0-9][a-z0-9-]{0,40}$/.test(v.id), `品牌 id 不合法：${v.id}`);
    need(typeof v.name === 'string' && v.name.length > 0, `${v.id}：缺少名称`);
    need(v.rtspPort === null || validPort(v.rtspPort), `${v.id}：rtspPort 不合法`);
    need(v.id === 'generic' || v.aliases.length > 0, `${v.id}：没有识别词`);
    need(v.variants.length > 0 || v.factory, `${v.id}：没有变体`);
    for (const variant of v.variants) {
      const where = `${variant.id}`;
      need(!seen.has(variant.id), `变体 id 重复：${variant.id}`);
      seen.add(variant.id);
      need(TARGETS.includes(variant.target), `${where}：target 不合法`);
      need(Object.keys(variant.streams).every((k) => ROLES.includes(k)), `${where}：streams 里有不认识的角色`);
      need(Object.keys(variant.streams).length > 0 || variant.extras?.length, `${where}：没有任何码流`);
      for (const role of ROLES) if (variant.streams[role]) checkStream(p, `${where}.${role}`, variant.streams[role], usable);
      for (const x of variant.extras || []) checkStream(p, `${where}.extra(${x.label})`, x, usable);
    }
  }
  for (const [id, c] of Object.entries(cur.vendors || {})) {
    const v = lib.byId.get(id);
    if (!v) continue;
    if (c.pin) {
      const hit = lib.variants.get(c.pin);
      need(hit && hit.vendor.id === id, `curated.${id}.pin 指向的变体 ${c.pin} 不存在或不属于该品牌`);
      if (hit && c.autoFill) {
        const { main, sub } = hit.variant.streams;
        need(main && sub, `curated.${id}：autoFill 的锁定变体必须同时有主、子码流`);
        need(['any', 'camera'].includes(hit.variant.target), `curated.${id}：autoFill 的锁定变体必须适用于摄像头`);
        for (const s of [main, sub]) {
          if (!s) continue;
          need(!s.params?.length && renderPath(s.path, { ch: 1 }) !== null, `curated.${id}：锁定变体的 ${s.path} 不能带需要人给值的占位符`);
          need(statusRank(s.status) <= statusRank('documented'), `curated.${id}：autoFill 的锁定变体至少要是 documented（当前 ${s.status}）`);
        }
      }
    }
  }
  for (const pr of cur.promote || []) {
    const hit = lib.variants.get(pr.variant);
    need(hit, `curated.promote 指向的变体 ${pr.variant} 不存在`);
    const e = pr.evidence || {};
    need(e.type === 'device' && DATE.test(e.date || '') && e.ref && e.result, `curated.promote(${pr.variant})：升为 verified 必须带真机证据（type=device、date、ref、result）`);
    for (const role of pr.streams || []) need(hit?.variant.streams[role], `curated.promote(${pr.variant})：没有 ${role} 这一路`);
  }
  for (const id of lib.sweep) {
    const hit = lib.variants.get(id);
    need(hit, `curated.sweep 里的变体 ${id} 不存在`);
    const { main, sub } = hit?.variant.streams || {};
    need(main && sub && renderPath(main.path, { ch: 1 }) !== null && renderPath(sub.path, { ch: 1 }) !== null, `curated.sweep 里的变体 ${id} 不能渲染成主 / 子码流路径`);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------------------------------
/** 一个变体的等级：主、子码流里最差的那个（没有主 / 子码流按 candidate） */
export function variantStatus(variant) {
  const parts = [variant.streams.main, variant.streams.sub].filter(Boolean).map((s) => s.status);
  if (!parts.length) return 'candidate';
  return parts.reduce((acc, s) => worseStatus(acc, s), 'verified');
}

/** 品牌的变体顺序：锁定的排最前，其次按等级（verified → documented → candidate），同级保持库里的顺序 */
export function orderedVariants(v) {
  return v.variants
    .map((variant, i) => ({ variant, i }))
    .sort((a, b) => (a.variant.id === v.pin ? -1 : b.variant.id === v.pin ? 1 : 0) || statusRank(variantStatus(a.variant)) - statusRank(variantStatus(b.variant)) || a.i - b.i)
    .map((x) => x.variant);
}

/** 变体 → [主, 子] 路径（渲染不了、缺主或子码流、带需要人给值的占位符 → null） */
export function pairOf(variant, ch = 1) {
  const { main, sub } = variant.streams;
  if (!main || !sub || main.params?.length || sub.params?.length) return null;
  const a = renderPath(main.path, { ch });
  const b = renderPath(sub.path, { ch });
  return a && b ? [a, b] : null;
}

/**
 * 合并后的库 → 扁平产物（后端读的就是它）：品牌按识别用的字段 + 已经排好序的 [主, 子] 路径模板。
 * 证据、备注、没有主 / 子配对的写法留在 data/ 里，不进产物。输出只取决于输入（无时间戳），重复生成逐字节一致。
 */
export function toArtifact(lib) {
  let pairs = 0;
  const vendors = lib.vendors.map((v) => {
    const list = [];
    for (const variant of orderedVariants(v)) {
      if (!pairOf(variant)) continue;
      list.push({ id: variant.id, target: variant.target, status: variantStatus(variant), label: variant.label, main: variant.streams.main.path, sub: variant.streams.sub.path });
    }
    pairs += list.length;
    const out = { id: v.id, name: v.name, rtspPort: v.rtspPort, aliases: [...v.aliases], match: v.matchMode, autoFill: v.autoFill };
    if (v.pin) out.pin = v.pin;
    if (v.modelPatterns) out.modelPatterns = [...v.modelPatterns];
    out.onvifPorts = [...v.onvifPorts];
    if (v.requires) out.requires = [...v.requires];
    if (v.quirks) out.quirks = v.quirks.map((q) => ({ id: q.id, note: q.note }));
    if (v.factory) out.factory = factoryOut(v.factory);
    out.pairs = list;
    return out;
  });
  const sweep = lib.sweep.map((id) => pairOf(lib.variants.get(id).variant)).filter(Boolean);
  return {
    schema: SCHEMA,
    upstream: lib.upstream,
    counts: { ...lib.stats, pairs },
    onvifPorts: [...lib.onvifPorts],
    autoFill: [...lib.autoFillOrder],
    sweep,
    vendors,
  };
}

export const serializeArtifact = (a) => JSON.stringify(a, null, 2) + '\n';

/** 校验原始数据后生成产物文本；数据不合规直接抛错 */
export function buildArtifactText(raw) {
  const problems = validateRaw(raw);
  if (problems.length) throw new Error('camera-library 数据不合规：\n- ' + problems.slice(0, 20).join('\n- ') + (problems.length > 20 ? `\n…共 ${problems.length} 条` : ''));
  return serializeArtifact(toArtifact(mergeLibrary(raw)));
}

/** 产物自身的结构与安全检查（后端加载时做的是同一类检查的子集） */
export function validateArtifact(a) {
  const p = [];
  const need = (c, m) => {
    if (!c) p.push(m);
  };
  if (!a || typeof a !== 'object') return ['产物不是对象'];
  need(a.schema === SCHEMA, `schema 必须是 ${SCHEMA}`);
  const portsOk = (x) => Array.isArray(x) && x.every(validPort);
  need(portsOk(a.onvifPorts) && a.onvifPorts.length > 0, 'onvifPorts 必须是非空端口数组');
  need(a.upstream && typeof a.upstream === 'object' && HEX40.test(a.upstream.commit || '') && HEX64.test(a.upstream.sha256 || '') && a.upstream.license, 'upstream 来源记录不完整');
  need(Array.isArray(a.vendors) && a.vendors.length > 0, 'vendors 必须是非空数组');
  if (!Array.isArray(a.vendors)) return p;
  const ids = new Set();
  const pairIds = new Set();
  const byId = new Map();
  for (const v of a.vendors) {
    need(typeof v?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(v.id), `品牌 id 不合法：${v?.id}`);
    need(!ids.has(v?.id), `品牌 id 重复：${v?.id}`);
    ids.add(v?.id);
    byId.set(v?.id, v);
    need(typeof v?.name === 'string' && v.name.length > 0, `${v?.id}：缺少名称`);
    need(Array.isArray(v?.aliases) && v.aliases.every((x) => typeof x === 'string' && lower(x) === x && x.length >= 2), `${v?.id}：aliases 必须是小写、至少 2 个字符的字符串数组`);
    need(['word', 'substring'].includes(v?.match), `${v?.id}：match 不合法`);
    if (v?.modelPatterns !== undefined) need(!modelPatternsProblem(v.modelPatterns), `${v?.id}：modelPatterns 不合规：${modelPatternsProblem(v.modelPatterns)}`);
    need(typeof v?.autoFill === 'boolean', `${v?.id}：autoFill 必须是布尔值`);
    need(v?.rtspPort === null || validPort(v?.rtspPort), `${v?.id}：rtspPort 不合法`);
    need(portsOk(v?.onvifPorts), `${v?.id}：onvifPorts 不合法`);
    need(Array.isArray(v?.pairs), `${v?.id}：pairs 必须是数组`);
    for (const pr of v?.pairs || []) {
      need(typeof pr.id === 'string' && !pairIds.has(pr.id), `写法 id 缺失或重复：${pr.id}`);
      pairIds.add(pr.id);
      need(TARGETS.includes(pr.target), `${pr.id}：target 不合法`);
      need(STATUSES.includes(pr.status), `${pr.id}：status 不合法`);
      need(typeof pr.main === 'string' && typeof pr.sub === 'string' && !CREDENTIAL_LIKE.test(pr.main + ' ' + pr.sub), `${pr.id}：路径缺失或带口令形态的内容`);
      if (typeof pr.main === 'string' && typeof pr.sub === 'string') for (const ch of [1, 2, 12]) need(renderPath(pr.main, { ch }) !== null && renderPath(pr.sub, { ch }) !== null, `${pr.id}：通道 ${ch} 渲染后不满足安全字符集`);
    }
    if (v?.factory !== undefined) p.push(...factoryArtifactProblems(v.factory, v.id));
    if (v?.autoFill) {
      const pin = (v.pairs || []).find((x) => x.id === v.pin);
      need(pin, `${v.id}：autoFill 的锁定写法 ${v.pin} 不在 pairs 里`);
      need(!pin || statusRank(pin.status) <= statusRank('documented'), `${v.id}：autoFill 的锁定写法至少要是 documented`);
    }
  }
  need(Array.isArray(a.autoFill) && a.autoFill.every((id) => byId.get(id)?.autoFill) && a.vendors.filter((v) => v.autoFill).length === a.autoFill?.length, 'autoFill 列表和品牌的 autoFill 标记对不上');
  // h2z.backend IOC 里有两处直接要海康 / 大华的固定路径（盲设备默认、厂家接口探测）：产物里必须有，否则 IOC 加载时会抛错
  for (const id of ['hikvision', 'dahua']) need(byId.get(id)?.pairs?.some((x) => x.target !== 'nvr'), `产物里缺少 ${id} 的摄像头码流写法（IOC 直接要用）`);
  need(Array.isArray(a.sweep) && a.sweep.length > 0 && a.sweep.every((pr) => Array.isArray(pr) && pr.length === 2 && pr.every((s) => typeof s === 'string' && SAFE_PATH.test(s))), 'sweep 必须是安全路径对的非空数组');
  return p;
}

/**
 * 整体检查（smoke 和 build --check 用）：数据过门禁、产物存在且结构合规、产物和数据对得上（改了数据没重新生成会被发现）。
 * 返回问题列表，空 = 通过。
 */
export function checkCameraLibrary(dir = LIB_DIR) {
  let raw;
  try {
    raw = loadRaw(dir);
  } catch (e) {
    return ['读不到库数据：' + e.message];
  }
  const problems = validateRaw(raw);
  if (problems.length) return problems;
  const file = resolve(dir, ARTIFACT);
  if (!existsSync(file)) return [`缺少 ${ARTIFACT}，运行 node scripts/camera-library/build.mjs 生成`];
  const text = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [`${ARTIFACT} 不是合法 JSON`];
  }
  const bad = validateArtifact(parsed);
  if (bad.length) return bad.map((x) => `${ARTIFACT}：${x}`);
  if (text !== buildArtifactText(raw)) return [`${ARTIFACT} 和 data/ 对不上（数据改了没重新生成），运行 node scripts/camera-library/build.mjs`];
  return [];
}
