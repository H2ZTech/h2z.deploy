#!/usr/bin/env node
/**
 * 设备库（摄像头 + 录像机 + 网络设备）的导出 / 导入：一个文件带走整库，另一台机器导入即升级。
 *
 *   node scripts/device-library/bundle.mjs export [输出文件]     导出当前库；默认 h2z-device-library-<版本>.json
 *   node scripts/device-library/bundle.mjs import <文件>         校验后替换本机的库（先把现有的备份到 runtime/device-library-backup/）
 *   node scripts/device-library/bundle.mjs import <文件> --dry-run   只校验、列出会变的文件，不写
 *   node scripts/device-library/bundle.mjs info [文件]           看一个包（或当前库）的版本和内容
 *
 * 包里是 camera-library/ 下的全部数据和产物（原样的字节 + 每个文件的 sha256）。版本号是内容的哈希，同样的库导出的包完全一样。
 * 导入不信任包：文件名只许白名单形态；先解到临时目录，跑和 build --check 同一套门禁（来源、口令形态、路径安全、产物与数据一致），
 * 全部通过才替换；任何一处不过就什么都不改。导入后重启 backend 生效（库在启动后第一次用到时读取）。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIB_DIR, checkDeviceLibraries } from './lib.mjs';
import { buildAiDigest } from './ai-digest.mjs';
import { checkCameraLibrary } from '../camera-library/library.mjs';

export const FORMAT = 'h2z-device-library';
const SAFE_NAME = /^(data\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.(json|md)$/;
const MAX_FILE = 5_000_000;
const MAX_FILES = 40;
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** 目录里属于库的文件（相对路径，排好序） */
export function libraryFiles(dir = LIB_DIR) {
  const out = [];
  for (const sub of ['', 'data']) {
    const d = resolve(dir, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      const rel = sub ? `${sub}/${n}` : n;
      if (SAFE_NAME.test(rel) && statSync(resolve(d, n)).isFile()) out.push(rel);
    }
  }
  return out.sort();
}

export function exportBundle(dir = LIB_DIR) {
  const files = libraryFiles(dir).map((name) => {
    const content = readFileSync(resolve(dir, name), 'utf8');
    return { name, sha256: sha(content), bytes: Buffer.byteLength(content), content };
  });
  const version = sha(files.map((f) => `${f.name}:${f.sha256}`).join('\n')).slice(0, 12);
  const count = (name, pick) => { try { return pick(JSON.parse(files.find((f) => f.name === name).content)); } catch { return null; } };
  return {
    format: FORMAT, schema: 1, version,
    summary: {
      cameraVendors: count('library.json', (a) => a.vendors.length),
      recorderFamilies: count('recorders.json', (a) => a.families.length), recorderModels: count('recorders.json', (a) => a.models.length),
      netdevFamilies: count('netdevs.json', (a) => a.families.length), netdevModels: count('netdevs.json', (a) => a.models.length),
    },
    files,
  };
}

/** 包本身的检查（结构、文件名、哈希）。返回问题列表 */
export function bundleProblems(b) {
  const p = [];
  if (!b || b.format !== FORMAT) return ['不是设备库的包（format 不对）'];
  if (b.schema !== 1) return [`包的 schema 是 ${b.schema}，这个版本只认 1`];
  if (!Array.isArray(b.files) || !b.files.length || b.files.length > MAX_FILES) return ['包里的文件列表不合法'];
  const seen = new Set();
  for (const f of b.files) {
    if (typeof f?.name !== 'string' || !SAFE_NAME.test(f.name) || f.name.includes('..') || seen.has(f.name)) { p.push(`文件名不合法或重复：${f?.name}`); continue; }
    seen.add(f.name);
    if (typeof f.content !== 'string' || Buffer.byteLength(f.content) > MAX_FILE) p.push(`${f.name}：内容缺失或过大`);
    else if (sha(f.content) !== f.sha256) p.push(`${f.name}：内容和哈希对不上（包被改过或传坏了）`);
  }
  for (const need of ['library.json', 'recorders.json', 'netdevs.json', 'data/sources.json']) if (!seen.has(need)) p.push(`包里缺少 ${need}`);
  if (!p.length && sha(b.files.map((f) => `${f.name}:${f.sha256}`).join('\n')).slice(0, 12) !== b.version) p.push('版本号和内容对不上');
  return p;
}

/** 把包解到一个目录并跑全部门禁。返回问题列表（空 = 可以用） */
export function verifyBundleInto(b, dir) {
  const p = bundleProblems(b);
  if (p.length) return p;
  mkdirSync(resolve(dir, 'data'), { recursive: true });
  for (const f of b.files) writeFileSync(resolve(dir, f.name), f.content);
  return [...checkCameraLibrary(dir), ...checkDeviceLibraries(dir, buildAiDigest)];
}

export function importBundle(b, { dir = LIB_DIR, backupDir = null, dryRun = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'h2z-devlib-'));
  try {
    const problems = verifyBundleInto(b, tmp);
    if (problems.length) return { ok: false, problems, changed: [] };
    const changed = b.files.filter((f) => !existsSync(resolve(dir, f.name)) || readFileSync(resolve(dir, f.name), 'utf8') !== f.content).map((f) => f.name);
    const stale = libraryFiles(dir).filter((n) => !b.files.some((f) => f.name === n));
    if (dryRun || !changed.length) return { ok: true, problems: [], changed, stale, written: false };
    let backup = null;
    if (backupDir && existsSync(resolve(dir, 'library.json'))) {
      const old = exportBundle(dir);
      mkdirSync(backupDir, { recursive: true });
      backup = resolve(backupDir, `h2z-device-library-${old.version}.json`);
      writeFileSync(backup, JSON.stringify(old));
    }
    mkdirSync(resolve(dir, 'data'), { recursive: true });
    for (const f of b.files) if (changed.includes(f.name)) writeFileSync(resolve(dir, f.name), f.content);
    return { ok: true, problems: [], changed, stale, written: true, backup };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const describe = (b) => `版本 ${b.version}：摄像头 ${b.summary.cameraVendors} 个品牌；录像机 ${b.summary.recorderFamilies} 个协议族 / ${b.summary.recorderModels} 个型号；网络设备 ${b.summary.netdevFamilies} 个平台 / ${b.summary.netdevModels} 个型号；${b.files.length} 个文件`;
  try {
    if (cmd === 'export') {
      const b = exportBundle();
      const out = resolve(file || `h2z-device-library-${b.version}.json`);
      writeFileSync(out, JSON.stringify(b));
      console.log(`已导出 ${out}\n${describe(b)}`);
    } else if (cmd === 'info') {
      console.log(describe(file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : exportBundle()));
    } else if (cmd === 'import' && file) {
      const b = JSON.parse(readFileSync(resolve(file), 'utf8'));
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      const r = importBundle(b, { backupDir: resolve(root, 'runtime/device-library-backup'), dryRun });
      if (!r.ok) {
        console.error('导入被拒绝，库没有改动：\n- ' + r.problems.join('\n- '));
        process.exit(1);
      }
      console.log(describe(b));
      if (!r.changed.length) console.log('和本机的库完全一样，没有改动');
      else console.log(`${dryRun ? '会更新' : '已更新'} ${r.changed.length} 个文件：${r.changed.join('、')}`);
      if (r.stale?.length) console.log(`本机有、包里没有的文件（没有动）：${r.stale.join('、')}`);
      if (r.backup) console.log(`原来的库备份在 ${r.backup}（要退回就导入它）`);
      if (r.written) console.log('重启 backend 后生效。');
    } else {
      console.error('用法：bundle.mjs export [文件] | import <文件> [--dry-run] | info [文件]');
      process.exit(2);
    }
  } catch (e) {
    console.error('失败：' + (e?.message || e));
    process.exit(1);
  }
}
