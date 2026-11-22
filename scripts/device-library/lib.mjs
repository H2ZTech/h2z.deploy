/**
 * 设备库的另外两部分：录像机库（recorders）和网络设备库（netdevs）。和摄像头库放在同一个目录（camera-library/），
 * 因为 compose 已经把这个目录只读挂进 backend，放一起不用改部署。
 *
 *   camera-library/data/recorders.json、netdevs.json   人写的数据（事实 + 证据 + 来源）
 *   camera-library/recorders.json、netdevs.json        产物：过了门禁的数据，backend 读它
 *   camera-library/device-library.ai.md                产物：给 AI 探索当依据的摘要（不含任何账号口令）
 *
 * 门禁和摄像头库同一套红线：来源必须登记并对应来源台账；禁用来源的字样不许出现；地址模板里不许带口令形态的内容；
 * 证据等级说的话要有对应的来源撑着（verified 要有自己的现场记录，documented 要有厂家文档或标准）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIB_DIR, SAFE_PATH, FORBIDDEN_TEXT } from '../camera-library/library.mjs';

export { LIB_DIR };
export const PARTS = { recorders: 'recorders.json', netdevs: 'netdevs.json' };
export const AI_DIGEST = 'device-library.ai.md';
const STATUSES = ['verified', 'documented', 'candidate'];
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_LIKE = /@|password=|passwd|pwd=|user=|\{user\}|\{pass\}|community=/i;
const OID = /^[0-9]+(\.[0-9]+){3,40}$/;
const OUI = /^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/;
const CLI_COMMAND = /^[A-Za-z/][A-Za-z0-9 /_.'-]{1,79}$/;
const PLAY_PLACEHOLDERS = ['ch', 'stream', 'start', 'end', 'date', 'time', 'seconds'];

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
export const loadData = (name, dir = LIB_DIR) => readJson(resolve(dir, 'data', PARTS[name]));
export const loadLedger = (dir = LIB_DIR) => readJson(resolve(dir, 'data', 'sources.json'));
export const serialize = (o) => JSON.stringify(o, null, 2) + '\n';

/** 把时间格式（YYYY MM DD hh mm ss 记号，或 unix）渲染成一个样例值，用来检查模板渲染后的字符是否安全 */
export function sampleTime(format) {
  if (format === 'unix') return '1794772800';
  return String(format).replace('YYYY', '2026').replace('MM', '11').replace('DD', '15').replace('hh', '21').replace('mm', '00').replace('ss', '00');
}

/** 渲染回放地址模板。缺占位符的值 / 有不认识的占位符 / 渲染结果不安全 → null */
export function renderPlayback(template, ctx) {
  let bad = false;
  const out = String(template).replace(/\{(\w+)\}/g, (_m, k) => {
    if (!PLAY_PLACEHOLDERS.includes(k) || ctx[k] === undefined || ctx[k] === null) bad = true;
    return String(ctx[k] ?? '');
  });
  return bad || !SAFE_PATH.test(out) ? null : out;
}

function sourceProblems(d, ledger, where) {
  const p = [];
  const ids = new Set();
  const allowed = new Map(ledger.sources.filter((s) => ledger.allowedUsage.includes(s.usage)).map((s) => [s.id, s]));
  for (const s of d.sources || []) {
    if (!ID.test(s?.id || '') || ids.has(s.id)) p.push(`${where}：来源 id 不合法或重复：${s?.id}`);
    ids.add(s?.id);
    if (!allowed.has(s?.ledger)) p.push(`${where}：来源 ${s?.id} 的 ledger（${s?.ledger}）不在来源台账的可用来源里`);
    if (typeof s?.title !== 'string' || s.title.length < 4) p.push(`${where}：来源 ${s?.id} 缺少标题`);
    if (s?.fromMemory === true) {
      if (typeof s.note !== 'string' || s.note.length < 10) p.push(`${where}：来源 ${s?.id} 标了 fromMemory，必须用 note 说明`);
    } else if (s?.ledger !== 'first-party') {
      if (!/^https:\/\/[^\s]+$/.test(s?.url || '')) p.push(`${where}：来源 ${s?.id} 不是自己的记录，必须有 https 链接`);
      if (!DATE.test(s?.accessed || '')) p.push(`${where}：来源 ${s?.id} 缺少取用日期 accessed（YYYY-MM-DD）`);
    }
  }
  return { problems: p, byId: new Map((d.sources || []).map((s) => [s.id, s])) };
}

/** 一块内容的证据等级要有来源撑着：verified → 有 first-party；documented → 有 vendor-doc / standards / first-party */
function evidenceProblem(level, sourceIds, byId) {
  if (!STATUSES.includes(level)) return `证据等级不合法：${level}`;
  const ledgers = (sourceIds || []).filter((id) => !byId.get(id)?.fromMemory).map((id) => byId.get(id)?.ledger); // 凭记忆写的来源只能撑 candidate
  if ((sourceIds || []).some((id) => !byId.has(id))) return `引用了没登记的来源：${(sourceIds || []).filter((id) => !byId.has(id)).join(', ')}`;
  if (level === 'verified' && !ledgers.includes('first-party')) return 'verified 必须有自己的现场记录（first-party 来源）';
  if (level === 'documented' && !ledgers.some((l) => ['vendor-doc', 'standards', 'first-party'].includes(l))) return 'documented 必须有厂家文档或标准来源';
  return '';
}

/**
 * 递归取出一个对象里所有名为 evidence / *Evidence 的值，连同撑它的来源：就近那一层自己写了 sources 就用它的，否则用上一层的。
 * 所以一块内容（比如某个平台的 cli）可以单独写来源，证据等级按这一块自己的来源来审。
 */
function evidencePairs(o, inherited, out = []) {
  if (Array.isArray(o)) o.forEach((x) => evidencePairs(x, inherited, out));
  else if (o && typeof o === 'object') {
    const src = Array.isArray(o.sources) ? o.sources : inherited;
    for (const [k, v] of Object.entries(o)) {
      if (/evidence$/i.test(k) && typeof v === 'string') out.push({ level: v, sources: src });
      else if (k !== 'sources') evidencePairs(v, src, out);
    }
  }
  return out;
}
const evidenceValues = (o) => evidencePairs(o, []).map((x) => x.level);

export function validateRecorders(d, ledger) {
  const p = [];
  if (!d || d.schema !== 1) return ['recorders：schema 必须是 1'];
  if (FORBIDDEN_TEXT.test(JSON.stringify(d))) p.push('recorders：出现了禁用来源的字样');
  const { problems, byId } = sourceProblems(d, ledger, 'recorders');
  p.push(...problems);
  const fams = new Set();
  for (const f of d.families || []) {
    const w = `recorders.${f?.id}`;
    if (!ID.test(f?.id || '') || fams.has(f.id)) p.push(`${w}：协议族 id 不合法或重复`);
    fams.add(f?.id);
    if (!['supported', 'none'].includes(f?.productSupport)) p.push(`${w}：productSupport 只能是 supported / none`);
    if (![0, 1].includes(f?.channelBase)) p.push(`${w}：channelBase 只能是 0 或 1`);
    if (!['device-local', 'utc'].includes(f?.time?.zone)) p.push(`${w}：time.zone 只能是 device-local / utc`);
    if (!Array.isArray(f?.sources) || !f.sources.length) p.push(`${w}：没有来源`);
    for (const x of evidencePairs(f, [])) {
      const e = evidenceProblem(x.level, x.sources, byId);
      if (e) p.push(`${w}：${e}`);
    }
    const h = f?.identify?.http;
    if (h && h.expectContains !== undefined && (typeof h.expectContains !== 'string' || !SAFE_PATH.test(h.path || ''))) p.push(`${w}：identify.http 带 expectContains 时 path 必须是安全的本机路径`);
    for (const [name, it] of Object.entries(f?.interfaces || {})) if (SECRET_LIKE.test(String(it?.path || ''))) p.push(`${w}.interfaces.${name}：地址里有口令形态的内容`);
    const r = f?.rtsp || {};
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) p.push(`${w}：rtsp.port 不合法`);
    if (r.live) for (const k of ['main', 'sub']) {
      const t = String(r.live[k] || '');
      const out = t.replace(/\{ch2\}/g, '01').replace(/\{ch\}/g, '1');
      if (SECRET_LIKE.test(t) || /[{}]/.test(out) || !SAFE_PATH.test(out)) p.push(`${w}：rtsp.live.${k} 渲染后不满足安全字符集`);
    }
    const pb = r.playback;
    if (pb && !String(pb.template).startsWith('(')) {
      const ctx = { ch: '1', stream: pb.stream?.main ?? '1', start: sampleTime(pb.timeFormat || 'YYYY-MM-DD'), end: sampleTime(pb.timeFormat || 'YYYY-MM-DD'), date: sampleTime(pb.dateFormat || 'YYYY-MM-DD'), time: sampleTime(pb.clockFormat || 'hh:mm:ss'), seconds: '600' };
      if (SECRET_LIKE.test(pb.template) || renderPlayback(pb.template, ctx) === null) p.push(`${w}：rtsp.playback.template 渲染后不满足安全字符集，或用了不认识的占位符`);
    }
    if (f.productSupport === 'supported' && !evidenceValues(f.interfaces?.search).includes('verified')) p.push(`${w}：标成产品已支持的协议族，检索接口必须是 verified`);
  }
  if (!fams.size) p.push('recorders：没有协议族');
  const seen = new Set();
  for (const m of d.models || []) {
    const key = `${m?.vendor}/${m?.model}`;
    if (seen.has(key)) p.push(`recorders：型号重复：${key}`);
    seen.add(key);
    if (!fams.has(m?.family)) p.push(`recorders：型号 ${key} 的协议族 ${m?.family} 不存在`);
    if (!STATUSES.includes(m?.evidence)) p.push(`recorders：型号 ${key} 证据等级不合法`);
    if (!Number.isInteger(m?.channels) || m.channels < 1 || m.channels > 1024) p.push(`recorders：型号 ${key} 通道数不合法`);
  }
  return p;
}

export function validateNetdevs(d, ledger) {
  const p = [];
  if (!d || d.schema !== 1) return ['netdevs：schema 必须是 1'];
  if (FORBIDDEN_TEXT.test(JSON.stringify(d))) p.push('netdevs：出现了禁用来源的字样');
  const { problems, byId } = sourceProblems(d, ledger, 'netdevs');
  p.push(...problems);
  const tableIds = new Set();
  for (const t of d.snmp?.tables || []) {
    if (!OID.test(t?.oid || '') || tableIds.has(t?.id)) p.push(`netdevs.snmp：表 ${t?.id} 的 OID 不合法或 id 重复`);
    tableIds.add(t?.id);
  }
  const eSnmp = evidenceProblem(d.snmp?.evidence, d.snmp?.sources, byId);
  if (eSnmp) p.push(`netdevs.snmp：${eSnmp}`);
  const fams = new Set();
  const pen = new Map();
  for (const f of d.families || []) {
    const w = `netdevs.${f?.id}`;
    if (!ID.test(f?.id || '') || fams.has(f.id)) p.push(`${w}：平台 id 不合法或重复`);
    fams.add(f?.id);
    if (!Array.isArray(f?.sources) || !f.sources.length) p.push(`${w}：没有来源`);
    for (const x of evidencePairs(f, [])) {
      const e = evidenceProblem(x.level, x.sources, byId);
      if (e) p.push(`${w}：${e}`);
    }
    for (const n of f?.identify?.enterprise || []) {
      if (!Number.isInteger(n) || n < 1) p.push(`${w}：企业号不合法：${n}`);
      if (pen.has(n)) p.push(`${w}：企业号 ${n} 已经属于 ${pen.get(n)}`);
      pen.set(n, f.id);
    }
    for (const o of f?.identify?.ouis || []) if (!OUI.test(o)) p.push(`${w}：OUI 写法不合法：${o}`);
    for (const [k, c] of Object.entries(f?.cli?.commands || {})) if (typeof c !== 'string' || !CLI_COMMAND.test(c) || /(^|[\s/])(reboot|reload|reset|delete|erase|format|shutdown|write|save|undo|no|set|add|remove|configure|config|system-view|enable)(\s|$)/i.test(c)) p.push(`${w}.cli.${k}：命令不合法，或不是只读命令：${c}`);
    if (SECRET_LIKE.test(JSON.stringify(f?.controller || {}))) p.push(`${w}.controller：地址里有口令形态的内容`);
  }
  if (!fams.size) p.push('netdevs：没有平台');
  const seen = new Set();
  for (const m of d.models || []) {
    const key = `${m?.vendor}/${m?.model}`;
    if (seen.has(key)) p.push(`netdevs：型号重复：${key}`);
    seen.add(key);
    if (!fams.has(m?.family)) p.push(`netdevs：型号 ${key} 的平台 ${m?.family} 不存在`);
    if (!STATUSES.includes(m?.evidence)) p.push(`netdevs：型号 ${key} 证据等级不合法`);
  }
  return p;
}

const VALIDATORS = { recorders: validateRecorders, netdevs: validateNetdevs };

/** 数据 → 产物：去掉只给人看的字段，加上统计。同样的输入永远得到同样的字节 */
export function toProduct(name, d) {
  const { _doc, about, ...rest } = d;
  const levels = evidenceValues(d.families);
  const count = (lv) => levels.filter((x) => x === lv).length;
  return { ...rest, counts: { families: d.families.length, models: (d.models || []).length, evidence: { verified: count('verified'), documented: count('documented'), candidate: count('candidate') } } };
}

export function buildProductText(name, dir = LIB_DIR) {
  const d = loadData(name, dir);
  const problems = VALIDATORS[name](d, loadLedger(dir));
  if (problems.length) throw new Error(`${name} 数据没过门禁：\n- ` + problems.join('\n- '));
  return serialize(toProduct(name, d));
}

/** 整体检查（--check、smoke、测试、导入前都用它）：数据过门禁，产物存在并且和数据一致，AI 摘要是最新的 */
export function checkDeviceLibraries(dir = LIB_DIR, buildDigest = null) {
  const problems = [];
  let ledger;
  try { ledger = loadLedger(dir); } catch (e) { return [`读不到来源台账：${e.message}`]; }
  for (const name of Object.keys(PARTS)) {
    let d;
    try { d = loadData(name, dir); } catch (e) { problems.push(`读不到 data/${PARTS[name]}：${e.message}`); continue; }
    const pr = VALIDATORS[name](d, ledger);
    problems.push(...pr);
    if (pr.length) continue;
    const file = resolve(dir, PARTS[name]);
    if (!existsSync(file)) problems.push(`缺少产物 ${PARTS[name]}（跑一次 node scripts/device-library/build.mjs）`);
    else if (readFileSync(file, 'utf8') !== serialize(toProduct(name, d))) problems.push(`产物 ${PARTS[name]} 和数据对不上（改了数据后要重新生成）`);
  }
  if (buildDigest && !problems.length) {
    const file = resolve(dir, AI_DIGEST);
    if (!existsSync(file)) problems.push(`缺少 ${AI_DIGEST}`);
    else if (readFileSync(file, 'utf8') !== buildDigest(dir)) problems.push(`${AI_DIGEST} 不是最新的（重新生成）`);
  }
  return problems;
}
