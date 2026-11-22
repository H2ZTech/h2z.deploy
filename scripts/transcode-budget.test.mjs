import test from 'node:test';
import assert from 'node:assert/strict';
import { transcodeBudget, applyBudget, isHw, readThreads, PER_STREAM_MB, ZLM_BASE_MB, CPU_PER_STREAM, CPU_USABLE } from './transcode-budget.mjs';

const GB = (n) => n * 1024;

test('不同整机内存的预算：8 / 16 / 32 GB', () => {
  const b8 = transcodeBudget(GB(8)), b16 = transcodeBudget(GB(16)), b32 = transcodeBudget(GB(32));
  assert.equal(b8.budgetMB, 3648); assert.equal(b8.streams, 65); assert.equal(b8.IOC_TRANSCODE_MAX, '64'); assert.equal(b8.IOC_TRANSCODE_THUMB_MAX, '57');
  assert.equal(b16.budgetMB, 7360); assert.equal(b16.streams, 142); assert.equal(b16.IOC_TRANSCODE_MAX, '64'); assert.equal(b16.IOC_TRANSCODE_THUMB_MAX, '134'); // 128 路缩略放得下
  assert.equal(b32.budgetMB, 8192); assert.equal(b32.ZLM_MEM_LIMIT, '8192m');
  assert.ok(Number(b16.IOC_TRANSCODE_THUMB_MAX) >= 128);
});

test('预算装得下它放行的路数：路数 × 每路内存 + ZLM 自身 ≤ ZLM 内存上限', () => {
  for (const g of [2, 4, 8, 16, 32, 64]) {
    const b = transcodeBudget(GB(g));
    assert.ok(Number(b.IOC_TRANSCODE_MAX) * PER_STREAM_MB + ZLM_BASE_MB <= b.budgetMB, g + ' GB 普通转码');
    assert.ok(Number(b.IOC_TRANSCODE_THUMB_MAX) * PER_STREAM_MB + ZLM_BASE_MB <= b.budgetMB || b.IOC_TRANSCODE_THUMB_MAX === '16', g + ' GB 缩略档');
  }
});

test('内存很小也不低于 1536m；读不到内存（0 / NaN）按最小预算', () => {
  assert.equal(transcodeBudget(GB(1)).ZLM_MEM_LIMIT, '1536m');
  assert.equal(transcodeBudget(0).ZLM_MEM_LIMIT, '1536m');
  assert.equal(transcodeBudget(NaN).ZLM_MEM_LIMIT, '1536m');
  assert.equal(transcodeBudget(GB(1)).IOC_TRANSCODE_MAX, '21');
});

test('硬件转码（rkmpp）普通转码也以 64 为上限，仍受内存限制', () => {
  assert.equal(transcodeBudget(GB(16), { hw: true }).IOC_TRANSCODE_MAX, '64');
  assert.equal(transcodeBudget(GB(4), { hw: true }).IOC_TRANSCODE_MAX, String(transcodeBudget(GB(4)).streams));
});

test('写 .env：追加自动块；重复运行结果不变；内存变了块里的值跟着变', () => {
  const env = 'A=1\nZLM_SECRET=x\n';
  const one = applyBudget(env, GB(16));
  assert.match(one, /# >>> h2z auto/); assert.match(one, /^ZLM_MEM_LIMIT=7360m$/m); assert.match(one, /^IOC_TRANSCODE_THUMB_MAX=134$/m);
  assert.equal(applyBudget(one, GB(16)), one);
  const two = applyBudget(one, GB(8));
  assert.match(two, /^ZLM_MEM_LIMIT=3648m$/m); assert.equal((two.match(/ZLM_MEM_LIMIT/g) || []).length, 1);
  assert.ok(two.startsWith('A=1\nZLM_SECRET=x\n'));
});

test('现场手工指定的键优先：块外面已有的键不写进自动块', () => {
  const env = 'A=1\nZLM_MEM_LIMIT=2048m\n';
  const out = applyBudget(env, GB(16));
  assert.equal((out.match(/^ZLM_MEM_LIMIT=/gm) || []).length, 1);
  assert.match(out, /^ZLM_MEM_LIMIT=2048m$/m);
  assert.match(out, /^IOC_TRANSCODE_MAX=64$/m);
  // 三个键都手工指定 → 不加块
  const all = 'ZLM_MEM_LIMIT=1g\nIOC_TRANSCODE_MAX=10\nIOC_TRANSCODE_THUMB_MAX=20\n';
  assert.ok(!applyBudget(all, GB(16)).includes('h2z auto'));
  // 手工值为空（.env.example 那种 KEY=）不算指定
  assert.match(applyBudget('ZLM_MEM_LIMIT=\n', GB(16)), /^ZLM_MEM_LIMIT=7360m$/m);
});

test('识别 rkmpp 板子：COMPOSE_FILE 含 zlm-rk3588 或 IOC_TRANSCODE_HW=rkmpp', () => {
  assert.equal(isHw('COMPOSE_FILE=compose.yaml:compose.zlm-rk3588.yaml\n'), true);
  assert.equal(isHw('IOC_TRANSCODE_HW=rkmpp\n'), true);
  assert.equal(isHw('A=1\n'), false);
});

test('CPU 项：线程少的机器普通转码路数被压低（现场 H2Z-66DC：5.9 GB / 8 线程）', () => {
  const b = transcodeBudget(5900, { threads: 8 });
  assert.equal(b.streams, 44);                                   // 只看内存是 44 路
  assert.equal(b.cpuStreams, Math.floor((8 * CPU_USABLE) / CPU_PER_STREAM));
  assert.equal(b.IOC_TRANSCODE_MAX, String(b.cpuStreams));       // 25（实测 0.19 线程/路）
  assert.equal(transcodeBudget(5900, { threads: 4 }).IOC_TRANSCODE_MAX, '12');
});

test('CPU 项：线程够多就不限，仍以 64 为上限；不传线程数 = 不算 CPU 项', () => {
  assert.equal(transcodeBudget(GB(16), { threads: 24 }).IOC_TRANSCODE_MAX, '64');
  assert.equal(transcodeBudget(5900).IOC_TRANSCODE_MAX, '44');
  assert.equal(transcodeBudget(5900).cpuStreams, null);
});

test('CPU 项：硬件转码（rkmpp）和缩略档不套 CPU 项；至少 1 路', () => {
  assert.equal(transcodeBudget(GB(16), { hw: true, threads: 2 }).IOC_TRANSCODE_MAX, '64');
  assert.equal(transcodeBudget(5900, { threads: 4 }).IOC_TRANSCODE_THUMB_MAX, transcodeBudget(5900).IOC_TRANSCODE_THUMB_MAX);
  assert.equal(transcodeBudget(GB(16), { threads: 1 }).IOC_TRANSCODE_MAX, '3');
  assert.ok(Number(transcodeBudget(GB(16), { threads: 0.1 }).IOC_TRANSCODE_MAX) >= 1);
});

test('CPU 项：写进 .env 的自动块带上限，手工值仍优先；读得到本机线程数', () => {
  const out = applyBudget('A=1\n', 5900, { threads: 8 });
  assert.match(out, /^IOC_TRANSCODE_MAX=25$/m);
  assert.match(applyBudget('IOC_TRANSCODE_MAX=50\n', 5900, { threads: 8 }), /^IOC_TRANSCODE_MAX=50$/m);
  assert.ok(readThreads() >= 1);
});
