import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKv, calibrate, applyCalibration, fingerprintMatches, NATIVE_CAP } from './gpu-calibrate.mjs';

const kvOf = (o) => parseKv(Object.entries(o).map(([k, v]) => k + '=' + v).join('\n'));
const amd = { node: '/dev/dri/renderD128', vendor_id: '0x1002', driver: 'amdgpu', engine: 'drm-engine-dec', clip_wh: '640x360', ok: '1' };

test('H2Z-66DC-like numbers: 8 streams = 44.8% decode engine → ~5.6% each → 18 slots → browser 16, hw transcode 8', () => {
  const r = calibrate(kvOf({ ...amd, k4_pct: 22.4, k4_speed: 1, k4_alive: 4, k8_pct: 44.8, k8_speed: 1, k8_alive: 8, t4_dec_pct: 22.4, t4_enc_pct: 28.4, t4_speed: 1, t4_alive: 4 }));
  assert.deepEqual([r.known, r.vendor, r.slots, r.nativeMax, r.vaapiMax], [true, 'amd', 18, 16, 8]);
});

test('a weaker GPU gets a smaller browser cap; a much stronger one is capped at 16', () => {
  assert.equal(calibrate(kvOf({ ...amd, k4_pct: 50, k4_speed: 1, k4_alive: 4, k8_pct: 100, k8_speed: 1, k8_alive: 8 })).nativeMax, 6, '每路 12.5% → 8 槽 → 6');
  assert.equal(calibrate(kvOf({ ...amd, k4_pct: 8, k4_speed: 1, k4_alive: 4, k8_pct: 16, k8_speed: 1, k8_alive: 8 })).nativeMax, NATIVE_CAP);
});

test('8 streams not real-time → use the 4-stream number, slots at most 7', () => {
  const r = calibrate(kvOf({ ...amd, k4_pct: 60, k4_speed: 1, k4_alive: 4, k8_pct: 100, k8_speed: 0.6, k8_alive: 8 }));
  assert.equal(r.slots, 7);
  assert.equal(r.nativeMax, 5);
});

test('clip resolution is normalised to 640x360 pixels', () => {
  const r = calibrate(kvOf({ ...amd, clip_wh: '1280x720', k4_pct: 20, k4_speed: 1, k4_alive: 4, k8_pct: 40, k8_speed: 1, k8_alive: 8 }));
  assert.equal(r.slots, 80);
  assert.ok(Math.abs(r.costPct - 1.25) < 1e-9);
});

test('unreadable engine counter → conservative 8 slots (browser 6)', () => {
  const r = calibrate(kvOf({ ...amd, k4_pct: 0, k4_speed: 1, k4_alive: 4 }));
  assert.deepEqual([r.slots, r.nativeMax], [8, 6]);
});

test('measured: driver supported but GPU cannot hw-decode H.265 → browser native 0 (a conclusion, written)', () => {
  const r = calibrate(kvOf({ node: '/dev/dri/renderD128', vendor_id: '0x8086', driver: 'i915', engine: 'drm-engine-video', ok: 0, reason: '显卡不能硬解 H.265（VAAPI）：x' }));
  assert.deepEqual([r.known, r.nativeMax, r.vendor], [true, 0, 'intel']);
});

test('not measured (no GPU / nvidia / missing tools) → no conclusion, nothing written but the fingerprint', () => {
  for (const o of [{ ok: 0, reason: '没有 /dev/dri/renderD128', node: '/dev/dri/renderD128' }, { node: '/dev/dri/renderD128', vendor_id: '0x10de', driver: 'nvidia', ok: 0, reason: '驱动 nvidia 不在支持范围' }]) {
    const r = calibrate(kvOf(o));
    assert.equal(r.known, false);
    const env = applyCalibration('A=1\n', r, 'fp1');
    assert.doesNotMatch(env, /NATIVE_MAX|DECODE_SLOTS|IOC_VAAPI_MAX/);
    assert.match(env, /H2Z_GPU_FINGERPRINT=fp1/);
  }
});

test('env block: regenerated every time, hand-set keys above the block win, other lines untouched', () => {
  const r = calibrate(kvOf({ ...amd, k4_pct: 22.4, k4_speed: 1, k4_alive: 4, k8_pct: 44.8, k8_speed: 1, k8_alive: 8 }));
  const one = applyCalibration('A=1\nIOC_VAAPI_MAX=5\n', r, 'fp1');
  assert.match(one, /^IOC_VAAPI_MAX=5$/m);
  assert.equal((one.match(/IOC_VAAPI_MAX=/g) || []).length, 1, '手写的优先，自动块不再写');
  assert.match(one, /H2Z_GPU_NATIVE_MAX=16/);
  const two = applyCalibration(one, { ...r, nativeMax: 10 }, 'fp2');
  assert.equal((two.match(/h2z auto: gpu calibration/g) || []).length, 1);
  assert.match(two, /H2Z_GPU_NATIVE_MAX=10/);
  assert.match(two, /^A=1$/m);
  assert.ok(fingerprintMatches(two, 'fp2') && !fingerprintMatches(two, 'fp1'));
});

test('the budget block and the gpu block do not eat each other', async () => {
  const { applyBudget } = await import('./transcode-budget.mjs');
  const r = calibrate(kvOf({ ...amd, k4_pct: 22.4, k4_speed: 1, k4_alive: 4, k8_pct: 44.8, k8_speed: 1, k8_alive: 8 }));
  let env = applyCalibration('A=1\n', r, 'fp1');
  env = applyBudget(env, 5900, { threads: 8 });
  assert.match(env, /H2Z_GPU_NATIVE_MAX=16/);
  assert.match(env, /IOC_TRANSCODE_MAX=/);
  env = applyCalibration(env, r, 'fp1');
  assert.match(env, /IOC_TRANSCODE_MAX=/);
});

test('clip frame rate is normalised to 25 fps (a 15 fps sample makes streams look cheaper than real 25 fps ones)', () => {
  const o = { ...amd, k4_pct: 11, k4_speed: 1, k4_alive: 4, k8_pct: 22, k8_speed: 1, k8_alive: 8 };
  const a = calibrate(kvOf({ ...o, clip_fps: 25 }));
  const b = calibrate(kvOf({ ...o, clip_fps: 15 }));
  assert.ok(b.slots < a.slots, '15 帧样片折算成 25 帧后每路更贵、槽位更少');
  assert.equal(calibrate(kvOf(o)).slots, a.slots, '没有 clip_fps 按 25 帧');
  assert.ok(Math.abs(b.costPct - 22 / 8 / (15 / 25)) < 1e-9);
});

test('hw transcode cap is measured, not hardcoded: min(90% of the encode engine, half of the decode engine) per measured cost', () => {
  const o = (t) => calibrate(kvOf({ ...amd, k4_pct: 22.4, k4_speed: 1, k4_alive: 4, k8_pct: 44.8, k8_speed: 1, k8_alive: 8, t4_speed: 1, t4_alive: 4, ...t }));
  assert.equal(o({ t4_dec_pct: 22.4, t4_enc_pct: 28.4 }).vaapiMax, 8, 'H2Z-66DC 量级：每路解 5.6% / 编 7.1% → 解码一半 = 8.9，编码 90% = 12.6 → 8');
  assert.equal(o({ t4_dec_pct: 8, t4_enc_pct: 12 }).vaapiMax, 25, '强一倍多的显卡：每路解 2% / 编 3% → min(30, 25) = 25（不再被写死的 8 卡住）');
  assert.equal(o({ t4_dec_pct: 20, t4_enc_pct: 80 }).vaapiMax, 4, '编码弱的显卡：每路编 20% → 90 ÷ 20 = 4');
  assert.equal(o({ t4_dec_pct: 200, t4_enc_pct: 200 }).vaapiMax, 1, '很弱：至少 1');
  // Intel：解码和编码共用一个引擎，两个读数相同
  assert.equal(o({ t4_dec_pct: 40, t4_enc_pct: 40 }).vaapiMax, 5);
});

test('hw transcode not measured (no encoder / did not keep real time / died) → IOC_VAAPI_MAX is not written, backend uses its fallback', () => {
  const base = { ...amd, k4_pct: 22.4, k4_speed: 1, k4_alive: 4, k8_pct: 44.8, k8_speed: 1, k8_alive: 8 };
  for (const t of [{}, { t4_alive: 2 }, { t4_dec_pct: 22, t4_enc_pct: 28, t4_speed: 0.7, t4_alive: 4 }]) {
    const r = calibrate(kvOf({ ...base, ...t }));
    assert.equal(r.vaapiMax, null);
    const env = applyCalibration('A=1\n', r, 'fp');
    assert.doesNotMatch(env, /IOC_VAAPI_MAX/);
    assert.match(env, /H2Z_GPU_NATIVE_MAX=16/);
  }
});
