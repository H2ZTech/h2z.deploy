// Deployment check: every service's logs must have a size cap (a 39 GB td-log once filled a system disk).
//  1. Container stdout: every service needs logging json-file / local with max-size + max-file (or driver none).
//  2. Services that write log files themselves (log volume / directory mounted): must be registered in FILE_LOG_RULES with all limit parameters;
//     unregistered log volumes always fail, which forces whoever adds a service to decide how its logs rotate.
// Usage: node scripts/log-limits.mjs (reads docker compose config, all profiles); smoke calls it too.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Services that write log files: matched by image name, with the required environment variables (values must be positive / non-empty). */
export const FILE_LOG_RULES = [
  // The official entrypoint ignores TAOS_LOG_* variables: it must be started through config/tdengine-start.sh (which writes the caps into taos.cfg and turns monitoring off)
  { name: 'TDengine', image: /tdengine/i, logPaths: ['/var/log/taos'], env: ['TAOS_LOG_KEEP_DAYS', 'TAOS_NUM_OF_LOG_LINES', 'TAOS_ADAPTER_LOG_KEEP_DAYS', 'TAOS_ADAPTER_LOG_ROTATION_COUNT', 'TAOS_ADAPTER_LOG_ROTATION_SIZE'], entrypoint: /tdengine-start\.sh/ },
  // edge-link writes /data/audit.jsonl (audit) itself: rotates at H2Z_AUDIT_MAX_BYTES, keeps H2Z_AUDIT_KEEP old files, disk use <= (KEEP+1) x MAX (default 10 MB);
  // container stdout has its own json-file cap. The parameters take effect in edge-link/src/auth.rs (Audit::log); cargo test has rotation cases.
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

/** config = the result of docker compose config --format json. Returns a list of problems (empty = pass). */
export function checkLogLimits(config) {
  const problems = [];
  for (const [name, svc] of Object.entries((config && config.services) || {})) {
    const lg = svc.logging || {};
    const drv = lg.driver || 'json-file';
    const opt = lg.options || {};
    if (drv !== 'none') {
      if (!['json-file', 'local'].includes(drv)) problems.push(`${name}: log driver ${drv} is not allowed (json-file / local / none)`);
      else if (!opt['max-size'] || !opt['max-file']) problems.push(`${name}: container logs have no cap (logging.options needs max-size and max-file)`);
    }
    const logVols = targetsOf(svc).filter((t) => LOG_PATH.test(t));
    const rule = FILE_LOG_RULES.find((r) => r.image.test(svc.image || ''));
    if (rule) {
      const env = envOf(svc);
      const ep = [].concat(svc.entrypoint || []).join(' ');
      if (rule.entrypoint && !rule.entrypoint.test(ep)) problems.push(`${name} (${rule.name}): must be started through config/tdengine-start.sh (the official entrypoint does not write log caps into the config)`);
      for (const k of rule.env) {
        const v = env[k];
        if (v === undefined || v === null || String(v).trim() === '' || /^0+$/.test(String(v).trim())) problems.push(`${name} (${rule.name}): file logging is missing the cap parameter ${k}`);
      }
    }
    for (const t of logVols) {
      if (!rule || !rule.logPaths.some((p) => t === p || t.startsWith(p + '/'))) problems.push(`${name}: mounts the log directory ${t}, but no rotation rule is registered in scripts/log-limits.mjs`);
    }
  }
  return problems;
}

/**
 * Read the rendered docker compose result (all profiles). opts.dir = project directory (default: current directory), opts.files = compose files (default: found by compose's own rules).
 * Try --no-interpolate first (no .env needed); newer compose versions check volume syntax literally when variables are not expanded,
 * so the colon in the default of `${RECORDER_POOL_DIR:-recorder-pool}:/pool:ro` counts as an extra colon and fails with too many colons (seen in CI),
 * and then variables are expanded instead: values come from that directory's .env.example (empty ones get x, equivalent to the .env init generates), --env-file points to an empty file so the developer machine's own .env does not leak in.
 */
export function composeConfig({ dir, files = [] } = {}) {
  const base = ['compose', ...(dir ? ['--project-directory', dir] : []), ...files.flatMap((f) => ['-f', f])];
  const clean = { ...process.env }; delete clean.COMPOSE_FILE; delete clean.COMPOSE_PROFILES;   // do not let the developer machine's own COMPOSE_FILE / COMPOSE_PROFILES leak in
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
      throw new Error('docker compose config failed: ' + String(e.stderr || e.message).trim() + '\n(retry with expanded variables also failed: ' + String(e2.stderr || e2.message).trim() + ')');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  const problems = checkLogLimits(composeConfig());
  for (const p of problems) console.log('FAIL', p);
  console.log(problems.length ? `Log cap check: ${problems.length} problem(s)` : 'Log cap check: every service has a cap');
  process.exitCode = problems.length ? 1 : 0;
}
