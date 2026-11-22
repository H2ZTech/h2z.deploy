// 部署检查：每个服务的日志都要有上限（2026-11-01 负责人要求；起因 LA18 td-log 39 GB 写满系统盘）。
//  1. 容器标准输出：每个服务都要 logging json-file / local，并设 max-size + max-file（或 driver none）。
//  2. 自己往文件写日志的服务（挂了日志卷 / 日志目录）：必须在 FILE_LOG_RULES 里登记、并带齐限制参数；
//     没登记的日志卷一律不通过——新加服务时逼着想清楚它的日志怎么轮转。
// 用法：node scripts/log-limits.mjs（读 docker compose config，所有 profile）；smoke 里也会调用。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 往文件写日志的服务：按镜像名认，要求的环境变量（值要是正数 / 非空）。 */
export const FILE_LOG_RULES = [
  // 官方入口不认 TAOS_LOG_* 变量：必须经 config/tdengine-start.sh 启动（它把上限写进 taos.cfg、关监控）
  { name: 'TDengine', image: /tdengine/i, logPaths: ['/var/log/taos'], env: ['TAOS_LOG_KEEP_DAYS', 'TAOS_NUM_OF_LOG_LINES', 'TAOS_ADAPTER_LOG_KEEP_DAYS', 'TAOS_ADAPTER_LOG_ROTATION_COUNT', 'TAOS_ADAPTER_LOG_ROTATION_SIZE'], entrypoint: /tdengine-start\.sh/ },
  // edge-link 自己写 /data/audit.jsonl（审计）：到 H2Z_AUDIT_MAX_BYTES 就轮转，保留 H2Z_AUDIT_KEEP 份旧文件，磁盘占用 ≤ (KEEP+1) × MAX（默认 10 MB）；
  // 容器标准输出另有 json-file 上限。参数在 edge-link/src/auth.rs（Audit::log）生效，cargo test 里有轮转用例。
  { name: 'edge-link', image: /h2z-edge-link/i, logPaths: ['/data'], env: ['H2Z_AUDIT_MAX_BYTES', 'H2Z_AUDIT_KEEP'] },
];

const LOG_PATH = /(^|\/)(log|logs)(\/|$)/i;

function envOf(svc) {
  const e = svc.environment || {};
  if (Array.isArray(e)) return Object.fromEntries(e.map((x) => { const i = String(x).indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }));
  return e;
}

function targetsOf(svc) {
  return (svc.volumes || []).map((v) => (typeof v === 'string' ? v.split(':')[1] || '' : v.target || '')).filter(Boolean);
}

/** config = docker compose config --format json 的结果。返回问题列表（空 = 通过）。 */
export function checkLogLimits(config) {
  const problems = [];
  for (const [name, svc] of Object.entries((config && config.services) || {})) {
    const lg = svc.logging || {};
    const drv = lg.driver || 'json-file';
    const opt = lg.options || {};
    if (drv !== 'none') {
      if (!['json-file', 'local'].includes(drv)) problems.push(`${name}：日志驱动 ${drv} 不在白名单（json-file / local / none）`);
      else if (!opt['max-size'] || !opt['max-file']) problems.push(`${name}：容器日志没设上限（logging.options 要有 max-size 和 max-file）`);
    }
    const logVols = targetsOf(svc).filter((t) => LOG_PATH.test(t));
    const rule = FILE_LOG_RULES.find((r) => r.image.test(svc.image || ''));
    if (rule) {
      const env = envOf(svc);
      const ep = [].concat(svc.entrypoint || []).join(' ');
      if (rule.entrypoint && !rule.entrypoint.test(ep)) problems.push(`${name}（${rule.name}）：要经 config/tdengine-start.sh 启动（官方入口不会把日志上限写进配置）`);
      for (const k of rule.env) {
        const v = env[k];
        if (v === undefined || v === null || String(v).trim() === '' || /^0+$/.test(String(v).trim())) problems.push(`${name}（${rule.name}）：文件日志缺少上限参数 ${k}`);
      }
    }
    for (const t of logVols) {
      if (!rule || !rule.logPaths.some((p) => t === p || t.startsWith(p + '/'))) problems.push(`${name}：挂了日志目录 ${t}，但没在 scripts/log-limits.mjs 登记轮转规则`);
    }
  }
  return problems;
}

/**
 * 读 docker compose 渲染结果（所有 profile）。opts.dir = 项目目录（缺省当前目录），opts.files = compose 文件（缺省按 compose 自己的规则找）。
 * 先用 --no-interpolate（不需要 .env）；新版 compose 在不展开变量时会按字面检查卷写法，
 * `${RECORDER_POOL_DIR:-recorder-pool}:/pool:ro` 里默认值的冒号被当成多一个冒号而报 too many colons（2026-11-09 CI），
 * 这时改成展开变量：值取该目录 .env.example 的（留空的塞 x，和 init 生成的 .env 等价），--env-file 指向空文件，开发机自己的 .env 不串进来。
 */
export function composeConfig({ dir, files = [] } = {}) {
  const base = ['compose', ...(dir ? ['--project-directory', dir] : []), ...files.flatMap((f) => ['-f', f])];
  const clean = { ...process.env }; delete clean.COMPOSE_FILE; delete clean.COMPOSE_PROFILES;   // 开发机自己的 COMPOSE_FILE / COMPOSE_PROFILES 不串进来
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, env: clean, ...(dir ? { cwd: dir } : {}) };
  try {
    return JSON.parse(execFileSync('docker', [...base, '--profile', '*', 'config', '--no-interpolate', '--format', 'json'], opts));
  } catch (e) {
    const example = join(dir || '.', '.env.example');
    const vars = existsSync(example)
      ? Object.fromEntries(readFileSync(example, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1) === '' ? 'x' : l.slice(i + 1)]; }))
      : {};
    const empty = join(mkdtempSync(join(tmpdir(), 'loglimits-')), 'empty.env');
    writeFileSync(empty, '');
    const env = { ...clean, ...vars };
    try {
      return JSON.parse(execFileSync('docker', [...base, '--env-file', empty, '--profile', '*', 'config', '--format', 'json'], { ...opts, env }));
    } catch (e2) {
      throw new Error('docker compose config 失败：' + String(e.stderr || e.message).trim() + '\n（展开变量重试也失败：' + String(e2.stderr || e2.message).trim() + '）');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  const problems = checkLogLimits(composeConfig());
  for (const p of problems) console.log('FAIL', p);
  console.log(problems.length ? `日志上限检查：${problems.length} 个问题` : '日志上限检查：全部服务都有上限');
  process.exitCode = problems.length ? 1 : 0;
}
