// 品牌名 / 公司名：全局「隐藏配置」（为 OEM 预留，没有后台入口；约定见 docs/BRANDING-OEM.md）。
//
// 默认值只写在 config/brand.default.json 一个文件里（全仓库唯一出处，FM-1215 用 grep 守住）；
// 本模块、h2z-os-stack、开机画面都从那份 JSON 取默认值，代码里不出现品牌字面量。
// 来源：部署 .env 的 H2Z_BRAND_NAME / H2Z_COMPANY_NAME（留空 = 默认）→ 生成静态 /brand.json → nginx 提供。
import { readFileSync, writeFileSync, mkdirSync, statSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRAND_DEFAULTS_FILE = fileURLToPath(new URL('../config/brand.default.json', import.meta.url));
export const BRAND_DEFAULTS = Object.freeze(JSON.parse(readFileSync(BRAND_DEFAULTS_FILE, 'utf8')));
/** 与 h2z.ioc 的 brand.js 一致：只收非空字符串，最长 60 字 */
export const BRAND_MAX = 60;

const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, BRAND_MAX) : '');

/** env 形如 { H2Z_BRAND_NAME, H2Z_COMPANY_NAME }；空 / 缺省 = 默认值 */
export function resolveBrand(env = {}) {
  return {
    brandName: clean(env.H2Z_BRAND_NAME) || BRAND_DEFAULTS.brandName,
    companyName: clean(env.H2Z_COMPANY_NAME) || BRAND_DEFAULTS.companyName,
  };
}

/** /brand.json 的内容：只含这两项，不含别的（该文件免登录公开） */
export const brandJson = (env) => JSON.stringify(resolveBrand(env)) + '\n';

/** 解析 .env 文本（KEY=VALUE，忽略注释；值两端的引号去掉） */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** 写 brand.json（0644：nginx 容器里的非 root 用户要读） */
export function writeBrandJson(file, env) {
  mkdirSync(dirname(file), { recursive: true });
  // 文件不存在时 docker 的文件挂载会在原路径建出「同名空目录」，先清掉才写得进去
  try { if (statSync(file).isDirectory()) rmdirSync(file); } catch { /* 不存在 */ }
  writeFileSync(file, brandJson(env), { mode: 0o644 });
}

// 命令行：node scripts/brand.mjs <.env 路径> <输出 brand.json 路径>（.env 不存在 = 全默认）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [envFile, out] = process.argv.slice(2);
  if (!out) { console.error('usage: node scripts/brand.mjs <.env> <brand.json>'); process.exit(2); }
  let env = {};
  try { env = parseEnv(readFileSync(envFile, 'utf8')); } catch { /* 没有 .env = 默认 */ }
  writeBrandJson(out, env);
}
