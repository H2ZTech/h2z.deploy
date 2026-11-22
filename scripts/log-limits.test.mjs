import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLogLimits } from './log-limits.mjs';

const capped = { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '3' } };
const td = (env, entrypoint = ['/tini', '--', '/bin/sh', '/h2z/tdengine-start.sh']) => ({ image: 'x/tdengine:3.3.2.0', logging: capped, entrypoint, environment: env, volumes: [{ type: 'volume', source: 'td-log', target: '/var/log/taos' }] });
const tdOk = { TAOS_LOG_KEEP_DAYS: '3', TAOS_NUM_OF_LOG_LINES: '1000000', TAOS_ADAPTER_LOG_KEEP_DAYS: '3', TAOS_ADAPTER_LOG_ROTATION_COUNT: '3', TAOS_ADAPTER_LOG_ROTATION_SIZE: '100MB' };

test('全部有上限 → 通过', () => {
  assert.deepEqual(checkLogLimits({ services: { web: { image: 'nginx', logging: capped }, tdengine: td(tdOk), off: { image: 'a', logging: { driver: 'none' } } } }), []);
});

test('容器日志没设上限 / 驱动不认识 → 不通过', () => {
  const p = checkLogLimits({ services: { a: { image: 'a' }, b: { image: 'b', logging: { driver: 'json-file', options: { 'max-size': '10m' } } }, c: { image: 'c', logging: { driver: 'syslog' } } } });
  assert.equal(p.length, 3);
  assert.match(p[0], /a: container logs have no cap/);
});

test('TDengine 少了文件日志参数（LA18 那次的情况）→ 不通过；值为 0 也不算', () => {
  const p = checkLogLimits({ services: { tdengine: td({ TAOS_FQDN: 'x', TAOS_LOG_KEEP_DAYS: '0' }) } });
  assert.equal(p.length, 5);
  assert.ok(p.every((x) => /tdengine \(TDengine\): file logging is missing the cap parameter/.test(x)));
  assert.equal(checkLogLimits({ services: { tdengine: td(Object.entries(tdOk).map(([k, v]) => k + '=' + v)) } }).length, 0, '数组写法也认');
});

test('没登记的日志卷 → 不通过（逼着新服务想清楚日志怎么轮转）', () => {
  const p = checkLogLimits({ services: { x: { image: 'vendor/thing', logging: capped, volumes: ['x-log:/var/log/thing', 'data:/data'] } } });
  assert.deepEqual(p, ['x: mounts the log directory /var/log/thing, but no rotation rule is registered in scripts/log-limits.mjs']);
});

test('TDengine 没经启动脚本（官方入口不认日志变量，LA18 第二次写满的原因）→ 不通过', () => {
  const p = checkLogLimits({ services: { tdengine: td(tdOk, null) } });
  assert.equal(p.length, 1);
  assert.match(p[0], /tdengine-start\.sh/);
});
