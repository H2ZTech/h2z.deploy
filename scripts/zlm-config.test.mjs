import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MARK, SECTION, withTranscode } from './zlm-config.mjs';

const BASE = '[api]\nsecret=abc\n[rtsp]\nport=554\n[hook]\nenable=1\n';

test('appends the transcode section once, keeps everything else', () => {
  const a = withTranscode(BASE);
  assert.ok(a.startsWith(BASE));
  assert.ok(a.includes('cmd_h264='));
  assert.ok(a.includes(MARK));
  assert.equal(withTranscode(a), a, '再跑一次不变');
});
test('command has three placeholders in order: ffmpeg, input, output; H.264 out, no audio', () => {
  const cmd = SECTION.split('\n').find((l) => l.startsWith('cmd_h264='));
  assert.equal((cmd.match(/%s/g) || []).length, 3);
  assert.ok(/^cmd_h264=%s .* -i %s .* %s$/.test(cmd));
  assert.ok(cmd.includes('libx264') && cmd.includes('-an') && cmd.includes('-threads 1') && cmd.includes('-f flv'));
});
test('an old unmarked [ffmpeg] section is replaced, other sections untouched', () => {
  const old = '[api]\nsecret=abc\n[ffmpeg]\ncmd=old\nbin=x\n[hook]\nenable=1\n';
  const r = withTranscode(old);
  assert.ok(!r.includes('cmd=old'));
  assert.ok(r.includes('[hook]\nenable=1'));
  assert.equal((r.match(/^\[ffmpeg\]/gm) || []).length, 1);
});
test('empty / missing file content still produces a valid section', () => {
  assert.ok(withTranscode('').includes('[ffmpeg]'));
  assert.ok(withTranscode(undefined).includes('cmd_h264='));
});
test('v2 adds the playback command (scaled to 640 wide); a v1 section is upgraded, old marker dropped', () => {
  const pb = SECTION.split('\n').find((l) => l.startsWith('cmd_h264_pb='));
  assert.equal((pb.match(/%s/g) || []).length, 3);
  assert.ok(/^cmd_h264_pb=%s .* -i %s .* %s$/.test(pb));
  assert.ok(pb.includes('scale=640:-2') && pb.includes('libx264') && pb.includes('-f flv'));
  const v1 = '[api]\nsecret=abc\n; h2z-transcode v1\n[ffmpeg]\nbin=/usr/bin/ffmpeg\ncmd_h264=old\nlog=/tmp/ffmpeg.log\n[hook]\nenable=1\n';
  const r = withTranscode(v1);
  assert.ok(r.includes('cmd_h264_pb=') && !r.includes('cmd_h264=old') && !r.includes('h2z-transcode v1'));
  assert.ok(r.includes('[hook]\nenable=1'));
  assert.equal((r.match(/^\[ffmpeg\]/gm) || []).length, 1);
  assert.equal(withTranscode(r), r);
});
test('v3 hardware templates: rkmpp decode + h264_rkmpp encode, no libx264, 3 placeholders, 1 s keyframes', () => {
  for (const k of ['cmd_h264_hw_sub', 'cmd_h264_hw_small', 'cmd_h264_hw_main']) {
    const c = SECTION.split('\n').find((l) => l.startsWith(k + '='));
    assert.ok(c, k);
    assert.equal((c.match(/%s/g) || []).length, 3, k);
    assert.ok(new RegExp('^' + k + '=%s .* -i %s .* %s$').test(c), k);
    assert.ok(c.includes('-hwaccel rkmpp') && c.includes('h264_rkmpp') && c.includes('-g 25') && c.includes('-bf 0') && c.includes('-f flv'), k);
    assert.ok(!c.includes('libx264'), k + ' must not use software encoding');
  }
  assert.ok(SECTION.includes('scale_rkrga=w=640:h=-2'));
  assert.ok(!/cmd_h264_hw_(sub|main)=.*scale/.test(SECTION), 'sub / main keep the source resolution');
  const v2 = '[api]\nsecret=abc\n; h2z-transcode v2\n[ffmpeg]\nbin=/usr/bin/ffmpeg\ncmd_h264=old\nlog=/tmp/ffmpeg.log\n';
  assert.ok(withTranscode(v2).includes('cmd_h264_hw_main='), 'a v2 section is upgraded');
});
test('v4 adds stream-copy playback commands for the local recorder (1/2/4/8×, RTSP push, no transcode)', () => {
  for (const [k, sc] of [['cmd_copy_pb', null], ['cmd_copy_pb_x2', '0.5'], ['cmd_copy_pb_x4', '0.25'], ['cmd_copy_pb_x8', '0.125']]) {
    const l = SECTION.split('\n').find((x) => x.startsWith(k + '='));
    assert.ok(l, k);
    assert.equal((l.match(/%s/g) || []).length, 3);
    assert.ok(/ -re .* -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s$/.test(l), l);
    assert.ok(sc ? l.includes('-itsscale ' + sc + ' ') : !l.includes('itsscale'));
  }
  const v3 = '[api]\nsecret=abc\n; h2z-transcode v3\n[ffmpeg]\nbin=/usr/bin/ffmpeg\ncmd_h264=old\n[hook]\nenable=1\n';
  const r = withTranscode(v3);
  assert.ok(r.includes('cmd_copy_pb_x8=') && !r.includes('cmd_h264=old') && !r.includes('h2z-transcode v3'));
});
test('v5: speed commands keep timestamps (-readrate) like NVR playback; -itsscale kept as fallback', () => {
  for (const n of [2, 4, 8]) {
    const l = SECTION.split('\n').find((x) => x.startsWith('cmd_copy_pb_r' + n + '='));
    assert.ok(l && l.includes(' -readrate ' + n + ' ') && !l.includes('itsscale') && / -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s$/.test(l), l);
    assert.ok(SECTION.includes('cmd_copy_pb_x' + n + '='));
  }
});

test('v6: thumb command decodes keyframes only, fixed 5 fps / 320 wide, software x264, one thread each, input options before -i', () => {
  const l = SECTION.split('\n').find((x) => x.startsWith('cmd_h264_thumb='));
  assert.ok(l, 'cmd_h264_thumb exists');
  assert.ok(/^cmd_h264_thumb=%s .* -i %s .* %s$/.test(l), 'ffmpeg path, input, output: three %s in order');
  const [pre, post] = l.split(' -i %s ');
  assert.ok(pre.includes(' -skip_frame nokey ') && pre.includes(' -threads 1 '), '关键帧模式和解码线程数是输入选项，必须在 -i 前面');
  assert.ok(post.includes('scale=320:-2') && post.includes('-r 5 -fps_mode cfr') && post.includes('-c:v libx264') && post.includes('-g 10') && post.includes('-bf 0') && post.includes('-f flv'));
  assert.ok(!/h264_(rkmpp|vaapi|nvenc|qsv)/.test(l), '缩略档所有硬件上都用软件模板');
  assert.equal(l.split('%s').length - 1, 3);
});
test('v7: a v5 section is upgraded (marker replaced, thumb and vaapi added, other commands kept)', () => {
  const v5 = '[api]\nsecret=abc\n; h2z-transcode v5\n[ffmpeg]\nbin=/usr/bin/ffmpeg\ncmd_h264=old\nlog=/tmp/ffmpeg.log\n[hook]\nenable=1\n';
  const r = withTranscode(v5);
  assert.ok(r.includes('cmd_h264_thumb=') && r.includes('; h2z-transcode v7') && r.includes('cmd_h264_vaapi_sub=') && !r.includes('h2z-transcode v5') && !r.includes('cmd_h264=old'));
  assert.ok(r.includes('[hook]\nenable=1'), '别的段原样保留');
  assert.equal(withTranscode(r), r, '已是 v7：原样返回');
  const v6 = '[api]\nsecret=abc\n; h2z-transcode v6\n[ffmpeg]\nbin=/usr/bin/ffmpeg\ncmd_h264_thumb=old\nlog=/tmp/ffmpeg.log\n';
  const r6 = withTranscode(v6);
  assert.ok(r6.includes('; h2z-transcode v7') && !r6.includes('h2z-transcode v6') && r6.includes('cmd_h264_vaapi_small=') && !r6.includes('cmd_h264_thumb=old'), 'v6 → v7');
});

// ---- x86 核显 VAAPI（v7）：模板、自检命令、镜像、覆盖文件要对得上（真硬件上的结论见 docs/VIDEO-PIPELINE-2026-10-28.md） ----
const lineOf = (key) => SECTION.split('\n').find((l) => l.startsWith(key + '='));
test('v7 vaapi：sub / small 是「硬解（帧留在显存）→ scale_vaapi → 硬编 h264_vaapi」，没有 main（主码流不转码的规则不变）', () => {
  for (const k of ['cmd_h264_vaapi_sub', 'cmd_h264_vaapi_small']) {
    const l = lineOf(k);
    assert.ok(l, k + ' 在');
    assert.equal(l.split('%s').length - 1, 3, '三个 %s：ffmpeg 路径、输入、输出');
    for (const must of ['-hwaccel vaapi', '-hwaccel_output_format vaapi', 'scale_vaapi', 'h264_vaapi', '-bf 0', '-g 25', '-rtsp_transport tcp', '-f flv']) assert.ok(l.includes(must), k + ' 缺 ' + must);
    assert.ok(!l.includes('libx264'), k + ' 不能退到 libx264');
  }
  assert.ok(lineOf('cmd_h264_vaapi_small').includes('scale_vaapi=w=640:h=-2'));
  assert.equal(lineOf('cmd_h264_vaapi_main'), undefined);
});
test('v7 vaapi：自检模板和 sub / small 用同一组硬件参数，输入是文件所以没有 -rtsp_transport，带 -re -stream_loop -1', () => {
  const pairs = [['cmd_h264_vaapi_sub', 'cmd_h264_vaapi_selftest'], ['cmd_h264_vaapi_small', 'cmd_h264_vaapi_selftest_small']];
  for (const [real, st] of pairs) {
    const a = lineOf(real), b = lineOf(st);
    assert.ok(b, st + ' 在');
    assert.ok(!b.includes('-rtsp_transport') && b.includes('-re -stream_loop -1'));
    const hw = (l) => l.slice(l.indexOf('-hwaccel vaapi'), l.indexOf('-f flv'));
    assert.equal(hw(a), hw(b), real + ' 和 ' + st + ' 的硬件参数要一致，不然自检通过不代表真转码能跑');
  }
});
test('v7 vaapi：镜像里的现场自检脚本和自检模板用同一条硬解硬编管线', () => {
  const sh = readFileSync(new URL('../docker/zlm-x86/h2z-vaapi-selftest', import.meta.url), 'utf8');
  const st = lineOf('cmd_h264_vaapi_selftest');
  const pipe = (s) => s.match(/-hwaccel vaapi.*?-qp 28 -bf 0 -g 25/)[0].replace('"$DEV"', '/dev/dri/renderD128');
  assert.equal(pipe(sh).replace(/ -i "\$CLIP" -an/, ' -i %s -an'), pipe(st));
});
