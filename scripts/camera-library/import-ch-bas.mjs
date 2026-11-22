#!/usr/bin/env node
/**
 * 导入器：ch-bas/cctv-camera-database 的 data/rtsp-patterns.json → 我们自己的基础库数据（imported.json）。
 *
 * 来源与许可：该数据集声明 CC0-1.0（公有领域）。上游 methodology 写明：StrixCamDB 只当线索，每条路径都对照
 * 厂家自己的文档重新核实。上游是别人的声明，我们不盲信，导入规则宁可少收、不多收：
 *
 *  1. 只读白名单字段，其余一律丢弃：不带入 strix_lead（线索来源指针）、unverified_leads、notes（可能提到聚合站）、verified_on。
 *  2. 只收 verified === true 的模板。路径里带账号口令（{user}/{pass}、user=/password=）的整条丢弃——口令永不进地址。
 *  3. 来源/备注里提到聚合站或线索库（iSpy、Agent DVR、camlytics、ipcamlive、SmartRTSP、Strix、security.world、rtsp.me、
 *     VisioForge、ZoneMinder）的整条丢弃。
 *  4. 证据分级：来源 URL 的主机在「厂家官方主机」清单里（按主机名人工审定，默认拒绝）且文字里没有 OEM 推断 / 约定俗成等字样
 *     → documented；其余（转载站、论坛、未审主机、没有 URL、靠 OEM 推断）→ candidate。
 *  5. 路径必须通过安全字符集（会被原样写进 RTSP 请求行），否则丢弃。
 *  6. 不提交上游原始文件：只输出过滤后的结果，并记录上游 commit 和文件 SHA-256，要复现就按它们重新下载。
 *
 * 用法：
 *   node scripts/camera-library/import-ch-bas.mjs <上游 rtsp-patterns.json> --commit <sha> \
 *        [--retrieved YYYY-MM-DD] [--sha256 <期望的文件哈希>] [--out camera-library/data/imported.json]
 * 导入之后要跑 node scripts/camera-library/build.mjs 重新生成 camera-library/library.json（后端读的是它）。
 *
 * 输出只取决于输入和参数（无时间戳、无随机），重复运行结果逐字节一致。
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_ID = 'ch-bas/cctv-camera-database';
export const SOURCE_URL = 'https://github.com/ch-bas/cctv-camera-database';
export const SOURCE_FILE = 'data/rtsp-patterns.json';
export const SCHEMA = 1;

/** 渲染后的路径必须落在这个字符集里（与 camera-credentials 的 PATH_OK 同一口径） */
export const SAFE_PATH = /^\/[A-Za-z0-9/_.:%?&=+~-]{0,198}$/;

const CREDENTIALS_IN_PATH = /\{(?:user|username|pass|password|pwd)\}|[?&/](?:user|username|password|pass|pwd)=/i;
const AGGREGATOR = /ispy|agent\s?dvr|camlytics|ipcamlive|smartrtsp|strix|security\.world|rtsp\.me|visioforge|zoneminder/i;
/** 来源文字里出现这些，说明是推断 / 约定俗成 / 转述，不是厂家文档原话：最多当 candidate */
const WEAK_TEXT = /\bOEM\b|lineage|infer|by[- ]convention|unreachable|copy-?paste|assum|presum|likely|probably/i;

/**
 * 厂家官方主机（文档 / 支持站 / Wiki / 官方社区）。2026-11-04 对上游 commit 7616a0a 里出现的 93 个主机逐个按主机名审定；
 * 只看主机名，没有逐页打开。默认拒绝：新出现的主机一律先当 candidate，并在导入报告里列出来等人审。
 */
export const OFFICIAL_HOSTS = new Set([
  // 主流品牌
  'supportusa.hikvision.com', 'enpinfo.hikvision.com',
  'dahuawiki.com',
  'global.uniview.com', 'www.uniview.com',
  'www.tp-link.com',
  'developer.axis.com', 'help.axis.com',
  'support.hanwhavision.com', 'support.hanwhavision.eu',
  'support.reolink.com',
  'support.amcrest.com',
  'download.vivotek.com', 'vivotek.zendesk.com',
  'i-pro.com', 'www.panasonic.com',
  'support.milesight.com', 'www.milesight.com',
  'support.pelco.com', 'www.pelco.com',
  'help.verkada.com',
  'support.ezviz.com', 'community.ezvizlife.com',
  'www.avigilon.com',
  'illustracameras.com', 'illustra.s3.us-east-1.amazonaws.com',
  'flir.custhelp.com',
  'global.download.synology.com',
  'gdlp01.c-wss.com',
  'wiki.2n.com', 'wiki.instar.com', 'knowledge.akuvox.com', 'knowledge.bolintechnology.com',
  'community.mobotix.com',
  'lilin.zendesk.com', 'meritlilin.com',
  'staticpro.comelitgroup.com',
  'support.een.com',
  'trassir.com', 'www.dssl.ru',
  'www.snapav.com',
  // 其它厂家自己的站点
  'avycon.freshdesk.com', 'costarvideo-wpimages.sfo3.digitaloceanspaces.com', 'datacenter.luminyscorp.com', 'wiki.luminyscorp.com',
  'digitalwatchdog.happyfox.com', 'download.sv3c.com', 'eneo-security.com', 'ernitec.com', 'fs.airlive.com', 'genieproducts.co.uk',
  'info.specotech.com', 'nuvico.com', 'rvigroup.ru', 'support.iegeek.com', 'support.oncamgrandeye.com', 'vicon-security.com',
  'vikylin.com', 'vitekcctv.com', 'www.360visiontechnology.com', 'www.allnet.de', 'www.avertx.com', 'www.beward.ru',
  'www.brickcom.com', 'www.camius.com', 'www.clarecontrols.com', 'www.dallmeier.com', 'www.escam.cn', 'www.holowits.com',
  'www.idisglobal.com', 'www.kedacom.com', 'www.longse.com', 'www.ltsecurityinc.com.au', 'www.lupus-electronics.de',
  'www.messoa.com', 'www.planet.com.tw', 'www.sricam.com', 'www.sunbatech.com', 'www.sunellsecurity.com', 'www.tendacn.com',
  'www.uniarch.cn', 'www.urmet.com', 'www2.acti.com',
  // web.archive.org 上的厂家旧文档：按内层主机判断
  'www.iqeye.com', 'toshibasecurity.com', 'www.zavio.com',
  // 来源文字里以裸域名（不带 https://）出现的厂家站点，同样按主机名审定
  'tp-link.com', 'uniview.com', 'help.ui.com', 'help.annke.com', 'lorex-help.freshdesk.com', 'lorextechnology.com',
  'community.boschsecurity.com', 'ipp.boschsecurity.com', 'www.boschsecurity.com', 'support.avigilon.com', 'support.flir.com',
  'foscam.com', 'dlink.com', 'downloads.trendnet.com', 'download.acti.com', 'download.level1.com', 'download.level1.info',
  'cdn.tycosp.com', 'costarvideo.com', 'cpplusworld.com', 'alibisecurity.com', 'backend.intelbras.com', 'interlogix.com',
  'firesecurityproducts.com', 'hbtmkto.honeywell.com', 'prod-edam.honeywell.com', 'hosafe.com', 'support.hosafe.com',
  'jidetech.com', 'kb.fanvil.com', 'pd.geovision.tw', 'sales.arecontvision.com', 'support.arecontvision.com', 'support.sannce.com',
  'supports.zositech.com', 'tkhsecurity.it', 'v380.org', 'vstarcam.com', 'www.dericam.com', 'www.hiseeu.com', 'www.nightowlsp.com',
  '3svision.com.tw',
]);

/** 已知的第三方转载 / 博客 / 论坛 / 经销商主机：只用于报告里分类，它们永远是 candidate（用户论坛即使是厂家办的也不算官方文档） */
export const KNOWN_THIRD_PARTY = new Set([
  'www.manualslib.com', 'manualslib.com', 'manuals.plus', 'www.readkong.com', 'readkong.com', 'www.camtuber.com', 'www.hostifi.com',
  'www.visioforge.com', 'github.com', 'community.geniusvision.net', 'download.catalogosicurezza.com', 'support.y3k.com',
  'web.archive.org', 'forum.intelbras.com.br', 'forum.tenvis.com', 'help.streamieapp.com', 'surveillance-video.com',
  'images10.newegg.com',
]);

/**
 * 人工抽检结果（2026-11-04）：打开上游引用的来源页面核对后，页面里查不到这条路径的，降为 candidate 并写明原因。
 * key = brand_id + ' ' + 上游原始 path。新增抽检结论也加在这里，导入是确定性的，重复导入不会丢。
 */
export const REVIEW_OVERRIDES = new Map([
  ['uniview /unicast/c<N>/s0/live', '抽检 2026-11-04：引用的宇视官方 PDF（V1.1，Product: IPC）里只有摄像头的 /media/videoN，没有录像机的 /unicast 写法'],
  ['uniview /unicast/c<N>/s1/live', '抽检 2026-11-04：引用的宇视官方 PDF（V1.1，Product: IPC）里只有摄像头的 /media/videoN，没有录像机的 /unicast 写法'],
]);

// ---------------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;
const clean = (v, max = 400) => (typeof v === 'string' ? v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const slug = (v) => clean(v, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * 来源文字里的 http(s) 地址（去掉尾部标点，最多 3 个）。
 * 撇号：后面还是链接字符就算链接的一部分（宇视的文件名里有 Camera's），否则（引号收尾）不算。
 */
export function urlsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/(?:[^\s)>\]"'，。；]|'(?=[^\s)>\]"'，。；]))+/g)) {
    const u = m[0].replace(/[.,;:!?…]+$/, '');
    if (!out.includes(u)) out.push(u);
    if (out.length >= 3) break;
  }
  return out;
}

/** web.archive.org 的地址取内层原始地址的主机；其它取自身主机；解析不了返回 '' */
export function effectiveHost(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'web.archive.org') {
      const m = /\/web\/\d+[a-z_]*\/(https?:\/\/.+)$/i.exec(u.pathname + u.search);
      if (m) return new URL(m[1]).hostname.toLowerCase();
    }
    return host;
  } catch {
    return '';
  }
}

/** 上游 stream 标签 → { role, variant }。role ∈ main|sub|third|fourth|other */
export function normalizeRole(label) {
  const s = clean(label, 120).toLowerCase();
  let m = /^(main|sub|third|fourth)$/.exec(s);
  if (m) return { role: m[1], variant: '' };
  m = /^(main|sub|third|fourth)\s*\((.+)\)$/.exec(s);
  if (m) return { role: m[1], variant: slug(m[2]) };
  m = /^(main|sub|third|fourth)[\s_-]+(.+)$/.exec(s);
  if (m) return { role: m[1], variant: slug(m[2]) };
  m = /^(.+?)[\s_-]+(main|sub|third|fourth)$/.exec(s);
  if (m) return { role: m[2], variant: slug(m[1]) };
  return { role: 'other', variant: slug(s) || 'other' };
}

/**
 * 上游路径 → 我们的模板。<N> → {ch}（通道，从 1 起）；{NN} 和 Reolink 的 {channel} → {ch2}（两位补零）；
 * 其它占位符（{codec}、{token}…）原样保留并列入 params（渲染时没有值就拒绝渲染，不会自动填）。
 * 返回 { template, params } 或 { drop: 原因 }。
 */
export function normalizePath(raw) {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p.startsWith('/')) return { drop: 'bad-path' };
  if (CREDENTIALS_IN_PATH.test(p)) return { drop: 'credentials-in-path' };
  let t = p.replace(/<N>/g, '{ch}').replace(/\{NN\}/g, '{ch2}');
  if (/^\/Preview_\{channel\}_(?:main|sub)$/.test(t)) t = t.replace('{channel}', '{ch2}');
  const params = [...new Set([...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k !== 'ch' && k !== 'ch2'))];
  if (/[<>]/.test(t)) return { drop: 'unknown-placeholder' };
  // 用占位值替换后检查安全字符集（params 用字母占位，避免误判）
  const probe = t.replace(/\{ch2\}/g, '01').replace(/\{ch\}/g, '1').replace(/\{\w+\}/g, 'x');
  if (!SAFE_PATH.test(probe)) return { drop: 'unsafe-path' };
  return { template: t, params };
}

const targetOf = (deviceType) => {
  const s = clean(deviceType, 40).toLowerCase();
  if (/nvr|dvr|xvr|recorder/.test(s)) return 'nvr';
  if (/ipc|camera|ip cam/.test(s)) return 'camera';
  return 'any';
};

const intOrNull = (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null);
const codecOf = (v) => clean(v, 60).replace(/[^A-Za-z0-9 .,/|()+_-]/g, '') || undefined;

/** 来源文字里不带 https:// 的裸域名（只认已审定的官方主机，其它不收，避免把文件名、版本号当域名） */
export function bareOfficialRefs(text) {
  const out = [];
  const s = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  for (const m of s.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|eu|de|ru|cn|tw|uk|au|io|co|fr|it|es|jp|kr|br|ca|tv|info|us))\b(\/[^\s)'"，。；]*)?/gi)) {
    const host = m[1].toLowerCase();
    const hit = [host, 'www.' + host].find((h) => OFFICIAL_HOSTS.has(h));
    if (!hit) continue;
    const url = 'https://' + hit + (m[2] || '').replace(/[.,;:!?…]+$/, '');
    if (!out.some((o) => o.host === hit)) out.push({ host: hit, url });
    if (out.length >= 2) break;
  }
  return out;
}

/** 来源文字 → 证据列表 + 状态（documented / candidate） */
export function classifyEvidence(source, note, reviewHosts) {
  const src = clean(source, 1200);
  const text = `${src} ${clean(note, 400)}`;
  const title = clean(src.replace(/https?:\/\/\S+/g, ''), 160);
  let official = false;
  const evidence = urlsIn(source)
    .map((url) => ({ url, host: effectiveHost(url) }))
    .filter((u) => u.host) // http://<ip>/… 这类占位示例不是真链接，不当证据
    .map(({ url, host }) => {
      const isOfficial = OFFICIAL_HOSTS.has(host);
      if (isOfficial) official = true;
      else if (!KNOWN_THIRD_PARTY.has(host) && reviewHosts) reviewHosts.add(host);
      return { type: isOfficial ? 'vendor-doc' : 'mirror-doc', url, host, title };
    });
  // 同一个站点（含子域名）已经有完整链接的，不再重复加一个只有域名的证据
  const sameSite = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
  for (const ref of bareOfficialRefs(source)) {
    if (evidence.some((e) => e.host && sameSite(e.host, ref.host))) continue;
    official = true;
    evidence.push({ type: 'vendor-doc', url: ref.url, host: ref.host, title });
  }
  if (!evidence.length) evidence.push({ type: 'citation', title: clean(src, 160) });
  const weak = WEAK_TEXT.test(text);
  return { evidence, status: official && !weak ? 'documented' : 'candidate', text };
}

const ALIAS_STOP = new Set(['generic', 'camera', 'cameras', 'cctv', 'video', 'network', 'digital', 'security', 'systems', 'system', 'technology', 'vision', 'smart', 'global', 'home', 'ip']);

function aliasesOf(id, name) {
  const out = new Set([id, id.replace(/-/g, ''), id.replace(/-/g, ' ')]);
  const lower = clean(name, 60).toLowerCase().replace(/\(.*?\)/g, '').trim();
  if (lower) out.add(lower);
  const first = lower.split(/\s+/)[0];
  if (lower.includes(' ') && first && first.length >= 5 && !ALIAS_STOP.has(first)) out.add(first);
  return [...out].filter((a) => a.length >= 3 && !ALIAS_STOP.has(a));
}

// ---------------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------------
export function buildImported(upstream, meta) {
  const m = upstream?._meta;
  if (!m || m.license !== 'CC0-1.0') throw new Error('上游 _meta.license 不是 CC0-1.0，拒绝导入（当前：' + JSON.stringify(m?.license) + '）');
  if (!Array.isArray(upstream.brands)) throw new Error('上游缺少 brands 数组');

  const report = {
    brands: upstream.brands.length,
    vendors: 0,
    variants: 0,
    templatesSeen: 0,
    templatesImported: 0,
    status: { documented: 0, candidate: 0 },
    dropped: {},
    droppedList: [],
    skippedBrands: [],
    reviewHosts: new Set(),
    otherRoles: 0,
    reviewed: 0,
  };
  const drop = (reason, brandId, t) => {
    report.dropped[reason] = (report.dropped[reason] || 0) + 1;
    report.droppedList.push(`${brandId} ${clean(t?.stream, 40)} ${clean(t?.path, 80)} [${reason}]`);
  };

  const vendors = [];
  for (const b of upstream.brands) {
    const id = typeof b?.brand_id === 'string' ? b.brand_id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) {
      report.skippedBrands.push(`${clean(b?.brand_id, 40)} [bad-id]`);
      continue;
    }
    const name = clean(b.brand, 60) || id;
    const raw = [...(Array.isArray(b.templates) ? b.templates : []), ...(Array.isArray(b.extra_templates) ? b.extra_templates : [])];
    const variants = [];
    let plain = null; // 当前「没有标签」的顺序变体
    const labeled = new Map();
    for (const t of raw) {
      report.templatesSeen++;
      if (!t || typeof t !== 'object') continue;
      if (t.verified !== true) { drop('not-verified', id, t); continue; }
      const np = normalizePath(t.path);
      if (np.drop) { drop(np.drop, id, t); continue; }
      const ev = classifyEvidence(typeof t.source === 'string' ? t.source : '', `${clean(t.note, 200)} ${clean(t.notes, 200)}`, report.reviewHosts);
      if (AGGREGATOR.test(ev.text)) { drop('aggregator-mention', id, t); continue; }
      const { role, variant } = normalizeRole(t.stream);
      const target = targetOf(t.device_type);
      const series = clean(t.series, 80);
      const scope = clean(t.scope, 80);
      const stream = { path: np.template, status: ev.status, evidence: ev.evidence };
      const review = REVIEW_OVERRIDES.get(`${id} ${clean(t.path, 120)}`);
      if (review) {
        stream.status = 'candidate';
        stream.note = review;
        report.reviewed++;
      }
      const codec = codecOf(t.codec);
      if (codec) stream.codec = codec;
      const port = intOrNull(t.port);
      if (port) stream.port = port;
      if (np.params.length) stream.params = np.params;

      let v;
      if (role === 'other') {
        report.otherRoles++;
        v = variants[variants.length - 1];
        if (!v || v.label) { v = { target, label: '', series, scope, streams: {}, extras: [] }; variants.push(v); }
        (v.extras ||= []).push({ label: variant, ...stream });
      } else if (variant) {
        const key = [variant, target, series, scope].join('|');
        v = labeled.get(key);
        if (!v || v.streams[role]) { v = { target, label: variant, series, scope, streams: {} }; labeled.set(key, v); variants.push(v); }
        v.streams[role] = stream;
      } else {
        if (!plain || plain.streams[role] || plain.target !== target || plain.series !== series || plain.scope !== scope) {
          plain = { target, label: '', series, scope, streams: {} };
          variants.push(plain);
        }
        plain.streams[role] = stream;
      }
      report.templatesImported++;
      report.status[stream.status]++;
    }
    if (!variants.length) {
      report.skippedBrands.push(`${id} [no-usable-template]`);
      continue;
    }
    variants.forEach((v, i) => {
      v.id = `${id}.${i + 1}`;
      if (!v.extras?.length) delete v.extras;
      if (!v.series) delete v.series;
      if (!v.scope) delete v.scope;
    });
    vendors.push({
      id,
      name,
      rtspPort: intOrNull(b.default_port),
      aliases: aliasesOf(id, name),
      variants: variants.map((v) => ({ id: v.id, target: v.target, label: v.label, ...(v.series ? { series: v.series } : {}), ...(v.scope ? { scope: v.scope } : {}), streams: v.streams, ...(v.extras ? { extras: v.extras } : {}) })),
    });
    report.variants += variants.length;
  }
  report.vendors = vendors.length;

  const data = {
    schema: SCHEMA,
    source: {
      id: SOURCE_ID,
      license: 'CC0-1.0',
      url: SOURCE_URL,
      file: SOURCE_FILE,
      commit: meta.commit,
      sha256: meta.sha256,
      upstreamGenerated: clean(m.generated, 20),
      retrievedAt: meta.retrievedAt,
    },
    vendors,
  };
  return { data, report };
}

export function renderReport(report) {
  const lines = [];
  lines.push(`上游品牌 ${report.brands}，导入品牌 ${report.vendors}，变体 ${report.variants}`);
  lines.push(`模板：看到 ${report.templatesSeen}，导入 ${report.templatesImported}（documented ${report.status.documented} / candidate ${report.status.candidate}），其它角色 ${report.otherRoles}，按抽检结论降级 ${report.reviewed}`);
  lines.push('丢弃原因：' + (Object.entries(report.dropped).map(([k, v]) => `${k}=${v}`).join('，') || '无'));
  for (const d of report.droppedList) lines.push('  - ' + d);
  if (report.skippedBrands.length) lines.push('跳过的品牌：' + report.skippedBrands.join('；'));
  if (report.reviewHosts.size) lines.push('未审定的来源主机（已按 candidate 处理，需要人审后再决定是否加入 OFFICIAL_HOSTS）：' + [...report.reviewHosts].sort().join('，'));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
    else a._.push(argv[i]);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file || !args.commit) {
    console.error('用法：node scripts/camera-library/import-ch-bas.mjs <rtsp-patterns.json> --commit <sha> [--retrieved YYYY-MM-DD] [--sha256 <hex>] [--out <path>]');
    process.exit(2);
  }
  if (!/^[0-9a-f]{40}$/.test(args.commit)) throw new Error('--commit 要是完整的 40 位 commit 哈希');
  const size = statSync(file).size;
  if (size > 5_000_000) throw new Error('上游文件超过 5MB，拒绝处理');
  const buf = readFileSync(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (args.sha256 && args.sha256.toLowerCase() !== sha256) throw new Error(`文件哈希不符：期望 ${args.sha256}，实际 ${sha256}`);
  const retrievedAt = args.retrieved || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt)) throw new Error('--retrieved 要是 YYYY-MM-DD');
  const upstream = JSON.parse(buf.toString('utf8'));
  const { data, report } = buildImported(upstream, { commit: args.commit, sha256, retrievedAt });
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(args.out || resolve(here, '../../camera-library/data/imported.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  console.log(renderReport(report));
  console.log(`\n已写入 ${out}（上游 commit ${args.commit.slice(0, 7)}，sha256 ${sha256.slice(0, 12)}…）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('导入失败：' + (e?.message || e));
    process.exit(1);
  });
}
