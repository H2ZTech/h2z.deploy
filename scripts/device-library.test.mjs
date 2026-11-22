// 设备库的另外两部分（录像机库、网络设备库）、AI 摘要、整库导出 / 导入。
// 运行：node --test scripts/device-library.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LIB_DIR, PARTS, AI_DIGEST, loadData, loadLedger, validateRecorders, validateNetdevs, checkDeviceLibraries, renderPlayback, sampleTime, buildProductText } from './device-library/lib.mjs';
import { buildAiDigest } from './device-library/ai-digest.mjs';
import { exportBundle, bundleProblems, importBundle, libraryFiles } from './device-library/bundle.mjs';

const ledger = loadLedger();
const rec = () => structuredClone(loadData('recorders'));
const net = () => structuredClone(loadData('netdevs'));
const has = (problems, re) => problems.some((p) => re.test(p));
const fam = (d, id) => d.families.find((f) => f.id === id);

test('数据过门禁，产物和 AI 摘要都是最新的（改了数据没重新生成会失败）', () => {
  assert.deepEqual(checkDeviceLibraries(LIB_DIR, buildAiDigest), []);
  for (const name of Object.keys(PARTS)) assert.equal(readFileSync(resolve(LIB_DIR, PARTS[name]), 'utf8'), buildProductText(name), '生成是确定的');
});

test('录像机库门禁：来源、证据等级、口令形态、模板安全', () => {
  let d = rec(); d.sources.find((s) => s.id === 'uniview-urls').ledger = 'ispyconnect';
  assert.ok(has(validateRecorders(d, ledger), /不在来源台账/), '禁用来源不能当来源');
  d = rec(); delete d.sources.find((s) => s.id === 'uniview-urls').url;
  assert.ok(has(validateRecorders(d, ledger), /必须有 https 链接/));
  d = rec(); fam(d, 'hanwha-sunapi').rtsp.playback.evidence = 'verified';
  assert.ok(has(validateRecorders(d, ledger), /verified 必须有自己的现场记录/), '没有现场记录不能标 verified');
  d = rec(); fam(d, 'unifi-protect').interfaces.channels.evidence = 'documented';
  assert.ok(has(validateRecorders(d, ledger), /documented 必须有厂家文档/), '只有第三方来源不能标 documented');
  d = rec(); fam(d, 'dahua-cgi').rtsp.live.main = '/cam/realmonitor?channel={ch}&user=admin';
  assert.ok(has(validateRecorders(d, ledger), /rtsp\.live\.main/), '模板里不许带账号');
  d = rec(); fam(d, 'dahua-cgi').rtsp.playback.template = '/cam/playback?channel={ch}&x={token}';
  assert.ok(has(validateRecorders(d, ledger), /playback\.template/), '不认识的占位符');
  d = rec(); fam(d, 'dahua-cgi').productSupport = 'supported';
  assert.ok(has(validateRecorders(d, ledger), /检索接口必须是 verified/), '没在真机验证过的协议族不能标成产品已支持');
  d = rec(); d.models.push({ vendor: 'x', model: 'y', family: 'nope', channels: 8, evidence: 'candidate' });
  assert.ok(has(validateRecorders(d, ledger), /协议族 nope 不存在/));
  d = rec(); fam(d, 'tvt-api').limits.push('see ispyconnect');
  assert.ok(has(validateRecorders(d, ledger), /禁用来源/));
});

test('回放模板按库渲染：每个可直接按时间回放的协议族都能渲染出安全的路径', () => {
  const want = {
    'hikvision-isapi': '/Streaming/tracks/302/?starttime=20261115T210000Z&endtime=20261115T210000Z',
    'dahua-cgi': '/cam/playback?channel=3&starttime=2026_11_15_21_00_00&endtime=2026_11_15_21_00_00',
    'uniview-lapi': '/c3/b1794772800/e1794772800/replay/',
    'vigi-rtsp': '/replay/3/2/avm?starttime=20261115t210000z&endtime=20261115t210000z',
  };
  for (const [id, path] of Object.entries(want)) {
    const pb = fam(rec(), id).rtsp.playback;
    const t = sampleTime(pb.timeFormat);
    assert.equal(renderPlayback(pb.template, { ch: 3, stream: pb.stream?.sub ?? '', start: t, end: t }), path, id);
  }
  assert.equal(renderPlayback('/x/{ch}/{start}', { ch: 1 }), null, '缺值不猜');
  assert.equal(renderPlayback('/x/{ch}', { ch: '1 2' }), null, '渲染结果不安全');
});

test('网络设备库门禁：企业号唯一、OID 合法、只读命令', () => {
  let d = net(); fam(d, 'cisco-ios').identify.enterprise.push(25506);
  assert.ok(has(validateNetdevs(d, ledger), /企业号 25506 已经属于/));
  d = net(); d.snmp.tables[0].oid = '1.3.x';
  assert.ok(has(validateNetdevs(d, ledger), /OID 不合法/));
  for (const bad of ['reload', 'write memory', 'reset saved-configuration', 'system-view', 'no shutdown', 'display version; reboot', 'configure terminal']) {
    d = net(); fam(d, 'h3c-comware').cli.commands.version = bad;
    assert.ok(has(validateNetdevs(d, ledger), /不是只读命令|命令不合法/), bad);
  }
  d = net(); fam(d, 'cisco-ios').cli.evidence = 'documented';
  assert.ok(has(validateNetdevs(d, ledger), /documented 必须有/), '凭记忆写的来源只能撑 candidate');
  d = net(); fam(d, 'ubiquiti-unifi').controller.path += '?password=x';
  assert.ok(has(validateNetdevs(d, ledger), /口令形态/));
});

test('AI 摘要：不含任何账号口令，三部分都在', () => {
  const md = buildAiDigest();
  assert.equal(readFileSync(resolve(LIB_DIR, AI_DIGEST), 'utf8'), md);
  for (const s of ['25506', 'display lldp neighbor-information list', 'lldpRemSysName', '/Streaming/tracks/', '/cam/playback', 'ACTION_REQUIRED', '/Streaming/Channels/']) assert.ok(md.includes(s), s);
  const cam = JSON.parse(readFileSync(resolve(LIB_DIR, 'library.json'), 'utf8'));
  for (const v of cam.vendors) for (const a of v.factory?.accounts || []) if (a.password.length >= 5) assert.ok(!md.includes(a.password), `摘要里出现了 ${v.id} 的出厂口令`);
  assert.ok(!/password\s*[:=]/i.test(md));
  assert.ok(md.length < 60_000, '摘要要小到能整份放进任务背景');
});

test('导出 / 导入：原样往返；被改过、带越界文件名、过不了门禁的包一律拒绝且不改库', () => {
  const b = exportBundle();
  assert.deepEqual(bundleProblems(b), []);
  assert.equal(exportBundle().version, b.version, '同样的库导出的版本号一样');
  assert.deepEqual(b.files.map((f) => f.name), libraryFiles());

  const dir = mkdtempSync(join(tmpdir(), 'devlib-test-'));
  const backups = mkdtempSync(join(tmpdir(), 'devlib-bak-'));
  try {
    // 空目录导入 = 全新安装
    let r = importBundle(b, { dir, backupDir: backups });
    assert.equal(r.ok, true);
    assert.equal(r.changed.length, b.files.length);
    assert.equal(exportBundle(dir).version, b.version);
    assert.equal(importBundle(b, { dir }).changed.length, 0, '再导一次没有改动');

    // 升级：包里多一个录像机型号（数据和产物一起变），导入后生效，并留下旧库的备份
    const src = mkdtempSync(join(tmpdir(), 'devlib-src-'));
    cpSync(LIB_DIR, src, { recursive: true });
    const data = JSON.parse(readFileSync(resolve(src, 'data/recorders.json'), 'utf8'));
    data.models.push({ vendor: 'dahua', model: 'TEST-NVR-8', family: 'dahua-cgi', channels: 8, evidence: 'candidate' });
    writeFileSync(resolve(src, 'data/recorders.json'), JSON.stringify(data, null, 2) + '\n');
    writeFileSync(resolve(src, 'recorders.json'), buildProductText('recorders', src));
    writeFileSync(resolve(src, AI_DIGEST), buildAiDigest(src));
    const next = exportBundle(src);
    assert.notEqual(next.version, b.version);
    r = importBundle(next, { dir, backupDir: backups, dryRun: true });
    assert.deepEqual([r.ok, r.written, r.changed.sort()], [true, false, ['data/recorders.json', 'recorders.json']]);
    assert.equal(exportBundle(dir).version, b.version, '--dry-run 不写');
    r = importBundle(next, { dir, backupDir: backups });
    assert.equal(r.written, true);
    assert.ok(JSON.parse(readFileSync(resolve(dir, 'recorders.json'), 'utf8')).models.some((m) => m.model === 'TEST-NVR-8'));
    assert.equal(JSON.parse(readFileSync(r.backup, 'utf8')).version, b.version, '旧库备份可以原样导回');
    rmSync(src, { recursive: true, force: true });

    // 拒绝的情况：库保持不变
    const before = exportBundle(dir).version;
    const tampered = structuredClone(b); tampered.files.find((f) => f.name === 'recorders.json').content += ' ';
    const evil = structuredClone(b); evil.files.push({ name: '../../etc/passwd.json', sha256: 'x', bytes: 1, content: '{}' });
    const stale = structuredClone(next); // 只换数据不换产物：产物和数据对不上
    const sf = stale.files.find((f) => f.name === 'recorders.json'); sf.content = b.files.find((f) => f.name === 'recorders.json').content; sf.sha256 = b.files.find((f) => f.name === 'recorders.json').sha256;
    stale.version = exportBundleVersion(stale);
    const noCam = structuredClone(b); noCam.files = noCam.files.filter((f) => f.name !== 'library.json');
    for (const [bad, re] of [[tampered, /哈希对不上/], [evil, /文件名不合法/], [stale, /对不上/], [noCam, /缺少 library\.json/], [{ format: 'x' }, /不是设备库的包/]]) {
      const x = importBundle(bad, { dir, backupDir: backups });
      assert.equal(x.ok, false);
      assert.ok(has(x.problems, re), String(re) + ' ← ' + x.problems.join(' | '));
      assert.equal(exportBundle(dir).version, before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(backups, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
function exportBundleVersion(b) { return createHash('sha256').update(b.files.map((f) => `${f.name}:${f.sha256}`).join('\n')).digest('hex').slice(0, 12); }
