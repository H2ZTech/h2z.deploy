// H2Z OS 在线更新（方案 docs/PLAN-2026-11-06-REMOTE-UPGRADE.md §3）：发布物格式的解析 / 校验，纯函数，host-agent 和发布脚本共用。
// 信任根是 Ed25519 签名（和 .h2zup 同一把密钥）：发布清单（index.json）和每个版本的 manifest.json 都有 .sig；
// 清单把每个镜像钉死到摘要（sha256），repo.bundle / os-files.tar 钉死到 sha256——传输（GHCR、docker pull）不是信任根。
//
// 发布物（ghcr.io/h2ztech/h2z-release:stable 里的 /release/）：
//   index.json + index.sig                      { format: 1, channel, created, os: { version, seq, path }, packs: [{ name, version, sizeBytes, path }] }
//   os/<版本>/manifest.json + manifest.sig      在线 OS 清单（format 2，kind 'online'，见 parseOnlineManifest）
//   os/<版本>/repo.bundle、os-files.tar         应用代码 / H2Z OS 文件（sha256 在清单里）
//   packs/<名>/<版本>/manifest.json + .sig      在线扩展包清单（mode 'pull'，见 packs.mjs）
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export class OnlineError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
// 镜像引用：[registry[:port]/]path[:tag]；不允许 @digest（摘要单独放），不允许空白和 shell 特殊字符
const IMAGE_REF = /^[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$|^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$|^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Ed25519 分离签名：sig 是 base64 文本（和 manifest.sig 一样）；公钥 PEM */
export function verifySigned(pem, body, sig) {
  try {
    return cryptoVerify(null, Buffer.from(body), createPublicKey(pem), Buffer.from(String(sig).trim(), 'base64'));
  } catch {
    return false;
  }
}

/** 镜像引用去掉 :tag（最后一个 / 之后的 :tag）。ghcr.io/h2ztech/h2z-backend:latest → ghcr.io/h2ztech/h2z-backend */
export const repoOf = (ref) => {
  const slash = String(ref).lastIndexOf('/');
  const colon = String(ref).indexOf(':', slash + 1);
  return colon < 0 ? String(ref) : String(ref).slice(0, colon);
};
/** 按摘要拉：repo@sha256:… */
export const pullRef = (img) => repoOf(img.ref) + '@' + img.digest;
/** 清单里的发布说明：字符串 / 数组 / { zh, en } 都收，统一成 { zh: [], en: [] }（界面按语言取） */
export function normNotes(raw) {
  const lines = (x) => (Array.isArray(x) ? x : typeof x === 'string' ? x.split(/\n+/) : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { zh: lines(raw.zh ?? raw['zh-CN']), en: lines(raw.en) };
  const l = lines(raw);
  return { zh: l, en: [] };
}
/** 这次升级会不会动录像服务：清单里 touches（构建时算出来，渲染后配置变了的服务）有 recorder* 就会 */
export const restartsRecorder = (touches) => (touches || []).some((s) => /^recorder/.test(s));

/** 发布索引 index.json（已验签的文本） */
export function parseIndex(text) {
  let x;
  try { x = JSON.parse(text); } catch { throw new OnlineError('E_ONLINE_MANIFEST', '发布索引不是 JSON'); }
  if (x?.format !== 1) throw new OnlineError('E_ONLINE_MANIFEST', '发布索引的格式这台设备不认识：先用 U 盘升级一次系统');
  const os = x.os;
  if (!os || !VERSION.test(String(os.version)) || !Number.isInteger(os.seq) || os.seq < 0 || !/^os\/[\w.-]{1,40}$/.test(String(os.path))) throw new OnlineError('E_ONLINE_MANIFEST', '发布索引里的系统版本不对');
  const packs = Array.isArray(x.packs) ? x.packs.filter((p) => /^[a-z][a-z0-9-]{0,31}$/.test(String(p?.name)) && VERSION.test(String(p?.version)) && /^packs\/[a-z][a-z0-9-]{0,31}\/[\w.-]{1,40}$/.test(String(p?.path))) : [];
  return { channel: String(x.channel || 'stable'), created: String(x.created || ''), os: { version: String(os.version), seq: os.seq, path: String(os.path) }, packs: packs.map((p) => ({ name: p.name, version: p.version, sizeBytes: Number(p.sizeBytes) || 0, path: p.path })) };
}

/** 在线 OS 清单（已验签的文本）。format 2 + kind 'online'：旧设备的 .h2zup 路径只认 format 1，遇到它会拒绝，不会误装 */
export function parseOnlineManifest(text, { arch = 'amd64' } = {}) {
  let m;
  try { m = JSON.parse(text); } catch { throw new OnlineError('E_ONLINE_MANIFEST', '更新清单不是 JSON'); }
  const bad = (why) => new OnlineError('E_ONLINE_MANIFEST', '更新清单不对：' + why);
  if (m?.format !== 2 || m.kind !== 'online' || m.product !== 'H2Z OS') throw bad('不是在线更新清单');
  if (m.arch !== arch) throw new OnlineError('E_ONLINE_MANIFEST', '这个更新是 ' + m.arch + ' 的，这台设备是 ' + arch);
  if (!VERSION.test(String(m.version))) throw bad('版本号');
  if (!Number.isInteger(m.seq) || m.seq < 0) throw bad('seq');
  if (m.fromMin != null && m.fromMin !== '' && !VERSION.test(String(m.fromMin))) throw bad('fromMin');
  if (!m.repo || !/^[0-9a-f]{7,40}$/.test(String(m.repo.commit)) || !/^[\w./-]{1,100}$/.test(String(m.repo.branch || ''))) throw bad('代码版本');
  for (const f of ['repo.bundle', 'os-files.tar']) if (!SHA256.test(String(m.files?.[f]))) throw bad(f + ' 的校验和');
  if (!Array.isArray(m.images) || m.images.length > 64) throw bad('镜像列表');
  const images = m.images.map((i) => {
    if (!i || typeof i.ref !== 'string' || !IMAGE_REF.test(i.ref) || i.ref.includes('@') || !DIGEST.test(String(i.digest))) throw bad('镜像 ' + String(i?.ref).slice(0, 60));
    return { ref: i.ref, digest: i.digest, id: /^sha256:[0-9a-f]{64}$/.test(String(i.id)) ? i.id : '', size: Number.isFinite(i.size) && i.size >= 0 ? i.size : 0, services: Array.isArray(i.services) ? i.services.filter((s) => /^[\w.-]{1,64}$/.test(String(s))).map(String) : [] };
  });
  const touches = Array.isArray(m.touches) ? m.touches.filter((s) => /^[\w.-]{1,64}$/.test(String(s))).map(String) : [];
  const migrations = ['none', 'compatible', 'irreversible'].includes(m.migrations) ? m.migrations : 'none';
  return {
    version: m.version, seq: m.seq, fromMin: m.fromMin || '', channel: String(m.channel || 'stable'), created: String(m.created || ''),
    notes: normNotes(m.notes), repo: { branch: m.repo.branch, commit: m.repo.commit }, files: { 'repo.bundle': m.files['repo.bundle'], 'os-files.tar': m.files['os-files.tar'] },
    images, touches, migrations, license: String(m.license || 'free'),
  };
}

/** 发布镜像 → 本地目录：docker pull → create → cp /release/. → rm。dest 是**宿主机**上的路径（docker cp 在宿主机上跑） */
export async function ghcrReleaseFetch({ host, image, destHost, timeout = 10 * 60_000 }) {
  await host('mkdir', ['-p', destHost], { timeout: 10_000 });
  await host('docker', ['pull', '--quiet', image], { timeout });
  const id = String(await host('docker', ['create', image], { timeout: 30_000 })).trim();
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw new OnlineError('E_ONLINE_UNREACHABLE', '取发布镜像失败：docker create 没有返回容器 ID');
  try {
    await host('docker', ['cp', id + ':/release/.', destHost], { timeout: 5 * 60_000 });
  } finally {
    await host('docker', ['rm', '-f', id], { timeout: 30_000 }).catch(() => {});
  }
}

/** 备份文件保留最近 keep 份（文件名里有时间，按名字排） */
export const backupsToDelete = (names, keep = 3) => names.filter((n) => /^db-\d{8}-\d{6}\.sql\.gz$/.test(n)).sort().slice(0, Math.max(0, names.filter((n) => /^db-\d{8}-\d{6}\.sql\.gz$/.test(n)).length - keep));
