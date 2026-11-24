// 摄像头画像库（camera-library/）：数据门禁、产物与数据一致、与库化之前写死的路径一致、渲染。
// 运行：node --test scripts/camera-library.test.mjs scripts/camera-library-import.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIB_DIR, ARTIFACT, loadRaw, validateRaw, mergeLibrary, toArtifact, buildArtifactText, validateArtifact, checkCameraLibrary, renderPath, SAFE_PATH, modelPatternProblem, MODEL_PATTERNS_MAX, contractDrift, FP_SIGNALS } from './camera-library/library.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** 库化之前 h2z.backend rtsp-probe.RTSP_CANDIDATES 的 8 对，逐字 */
const LEGACY_SWEEP = [
  ['/Streaming/Channels/101', '/Streaming/Channels/102'],
  ['/cam/realmonitor?channel=1&subtype=0', '/cam/realmonitor?channel=1&subtype=1'],
  ['/stream1', '/stream2'],
  ['/h264/ch1/main/av_stream', '/h264/ch1/sub/av_stream'],
  ['/media/video1', '/media/video2'],
  ['/h264Preview_01_main', '/h264Preview_01_sub'],
  ['/live/ch00_0', '/live/ch00_1'],
  ['/11', '/12'],
];
/** 库化之前 h2z.backend camera-credentials.streamPaths 的三条正则对应的固定路径 */
const LEGACY_TRIO = {
  tapo: { aliases: ['tapo', 'tp-link', 'tplink'], pair: ['/stream1', '/stream2'] },
  hikvision: { aliases: ['hikvision', '海康'], pair: ['/Streaming/Channels/101', '/Streaming/Channels/102'] },
  dahua: { aliases: ['dahua', '大华'], pair: ['/cam/realmonitor?channel=1&subtype=0', '/cam/realmonitor?channel=1&subtype=1'] },
};

const raw = () => structuredClone(loadRaw());
const artifact = () => JSON.parse(readFileSync(resolve(LIB_DIR, ARTIFACT), 'utf8'));
const vendorOf = (r, id) => r.imported.vendors.find((v) => v.id === id);
const problemsOf = (mutate) => {
  const r = raw();
  mutate(r);
  return validateRaw(r);
};
const has = (problems, re) => problems.some((p) => re.test(p));

// ---------------------------------------------------------------------------------------------------
test('数据过门禁，产物存在、合规，并且和数据一致（改了数据没重新生成会失败）', () => {
  assert.deepEqual(checkCameraLibrary(), []);
  assert.equal(readFileSync(resolve(LIB_DIR, ARTIFACT), 'utf8'), buildArtifactText(loadRaw()), '生成是确定的，和已提交的产物逐字节一致');
  assert.equal(buildArtifactText(loadRaw()), buildArtifactText(loadRaw()));
});

test('产物的来源记录和规模', () => {
  const a = artifact();
  assert.equal(a.schema, 1);
  assert.equal(a.upstream.id, 'ch-bas/cctv-camera-database');
  assert.equal(a.upstream.license, 'CC0-1.0');
  assert.match(a.upstream.commit, /^[0-9a-f]{40}$/);
  assert.match(a.upstream.sha256, /^[0-9a-f]{64}$/);
  assert.ok(a.counts.vendors >= 140 && a.counts.pairs >= 150 && a.counts.streams >= 400, JSON.stringify(a.counts));
  assert.deepEqual(a.counts.byStatus, { verified: 3, documented: 284, candidate: 124 });
  const ledger = loadRaw().sources.sources;
  assert.deepEqual(ledger.filter((s) => s.usage.startsWith('forbidden')).map((s) => s.id).sort(), ['ispyconnect', 'strixcamdb']);
});

test('导入数据里没有任何聚合站 / 线索库的痕迹，所有路径都能安全渲染、没有口令形态', () => {
  const r = loadRaw();
  const text = JSON.stringify(r.imported).toLowerCase();
  for (const w of ['ispy', 'strix', 'smartrtsp', 'camlytics', 'ipcamlive', 'agent dvr', 'security.world', 'rtsp.me', 'strix_lead', 'unverified_leads']) assert.ok(!text.includes(w), w);
  for (const v of artifact().vendors) {
    for (const pr of v.pairs) {
      assert.doesNotMatch(pr.main + pr.sub, /:\/\/|@|password|passwd|pwd=|user=/i, pr.id);
      for (const ch of [1, 2, 12]) {
        assert.ok(SAFE_PATH.test(renderPath(pr.main, { ch })), pr.id);
        assert.ok(SAFE_PATH.test(renderPath(pr.sub, { ch })), pr.id);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------
test('门禁：来源不在台账 / 属于禁用来源 / 许可不被允许 → 拒绝', () => {
  assert.ok(has(problemsOf((r) => (r.imported.source.id = 'strixcamdb')), /strixcamdb.*台账|用法/));
  assert.ok(has(problemsOf((r) => (r.imported.source.id = 'ispyconnect')), /ispyconnect/));
  assert.ok(has(problemsOf((r) => (r.imported.source.id = 'not-registered')), /not-registered/));
  assert.ok(has(problemsOf((r) => (r.imported.source.license = 'CC-BY-NC-4.0')), /不一致/));
  assert.ok(has(problemsOf((r) => (r.sources.sources.find((s) => s.id === 'ch-bas/cctv-camera-database').license = 'CC-BY-NC-4.0')), /许可不被允许|不在台账/));
  assert.ok(has(problemsOf((r) => (r.sources.sources.find((s) => s.id === 'ch-bas/cctv-camera-database').usage = 'forbidden')), /用法/));
  assert.ok(has(problemsOf((r) => r.sources.sources.push({ ...r.sources.sources[0] })), /重复/));
});

test('门禁：导入数据里混进聚合站名字、口令形态的路径、不安全字符 → 拒绝', () => {
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.evidence[0].title = 'seen on ispyconnect')), /聚合站/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.evidence[0].title = 'StrixCamDB lead')), /聚合站/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = '/x?user=admin')), /口令/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = '/x?password=1')), /口令/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = 'rtsp://h/x')), /以 \/ 开头/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = '/a b')), /安全字符集/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = '/a\r\nX: y')), /安全字符集/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = '/x/{codec}')), /占位符/));
});

test('门禁：证据与等级必须对得上；来源哈希 / 日期格式；note 长度', () => {
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.status = 'verified')), /verified 必须有真机/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.evidence = [{ type: 'citation', title: 'x' }])), /documented 必须有厂家文档/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.evidence = [])), /没有证据/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.evidence[0].url = 'javascript:alert(1)')), /链接/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'uniview').variants[0].streams.main.note = 'x'.repeat(301))), /note/));
  assert.ok(has(problemsOf((r) => (r.imported.source.commit = 'abc')), /commit/));
  assert.ok(has(problemsOf((r) => (r.imported.source.sha256 = 'zz')), /sha256/));
  assert.ok(has(problemsOf((r) => (r.imported.source.retrievedAt = 'yesterday')), /retrievedAt/));
});

test('门禁：手写层——autoFill 必须锁定变体且至少 documented；升 verified 必须带真机证据；sweep 必须可渲染', () => {
  assert.ok(has(problemsOf((r) => delete r.curated.vendors.tapo.pin), /pin|锁定/));
  assert.ok(has(problemsOf((r) => (r.curated.vendors.tapo.pin = 'nope.9')), /不存在/));
  assert.ok(has(problemsOf((r) => (r.curated.vendors.tapo.pin = 'axis.1')), /不属于该品牌/));
  assert.ok(
    has(
      problemsOf((r) => {
        const s = vendorOf(r, 'hikvision').variants[0].streams;
        for (const x of [s.main, s.sub]) { x.status = 'candidate'; x.evidence = [{ type: 'mirror-doc', url: 'https://example.org/x', host: 'example.org', title: 'x' }]; }
      }),
      /至少要是 documented/,
    ),
  );
  assert.ok(has(problemsOf((r) => (r.curated.promote[0].evidence.type = 'vendor-doc')), /真机证据/));
  assert.ok(has(problemsOf((r) => delete r.curated.promote[0].evidence.date), /真机证据/));
  assert.ok(has(problemsOf((r) => (r.curated.promote[0].variant = 'nope.1')), /不存在/));
  assert.ok(has(problemsOf((r) => r.curated.sweep.push('nope.1')), /sweep/));
  assert.ok(has(problemsOf((r) => (r.curated.generic.variants[0].main = '/a b')), /安全字符集|sweep/));
  assert.ok(has(problemsOf((r) => (r.curated.vendors.tapo.aliases = ['Tapo'])), /小写/));
  assert.ok(has(problemsOf((r) => (r.curated.onvifPorts = [0, 70000])), /端口/));
  assert.ok(has(problemsOf((r) => r.imported.vendors[1].variants.push({ ...r.imported.vendors[0].variants[0] })), /重复/));
});

test('门禁不合规时生成不出产物', () => {
  const r = raw();
  r.imported.source.id = 'strixcamdb';
  assert.throws(() => buildArtifactText(r), /数据不合规/);
});

// ---------------------------------------------------------------------------------------------------
test('与库化之前一致：无账号探测的候选顺序逐字相同', () => {
  assert.deepEqual(artifact().sweep, LEGACY_SWEEP);
});

test('与库化之前一致：Tapo / 海康 / 大华 的识别词、识别顺序、锁定的固定路径', () => {
  const a = artifact();
  assert.deepEqual(a.autoFill, ['tapo', 'hikvision', 'dahua'], '旧正则的先后顺序：tapo → hikvision → dahua');
  for (const [id, legacy] of Object.entries(LEGACY_TRIO)) {
    const v = a.vendors.find((x) => x.id === id);
    assert.equal(v.autoFill, true, id);
    assert.equal(v.match, 'substring', id + '：旧正则是包含匹配');
    for (const al of legacy.aliases) assert.ok(v.aliases.includes(al), `${id} 缺识别词 ${al}`);
    assert.equal(v.pairs[0].id, v.pin, id + '：锁定的写法排最前');
    assert.deepEqual([renderPath(v.pairs[0].main), renderPath(v.pairs[0].sub)], legacy.pair, id);
    assert.ok(['verified', 'documented'].includes(v.pairs[0].status), `${id} ${v.pairs[0].status}`);
  }
  assert.ok(a.vendors.filter((v) => v.autoFill).length === 3, '只有现场验证过的三家开 autoFill');
  assert.deepEqual(a.onvifPorts, [80, 8000, 8080, 2020], '合并了原来 onvif.ts 与 camera-probe 两份不一致的端口表');
  assert.deepEqual(a.vendors.find((v) => v.id === 'tapo').onvifPorts, [2020]);
});

test('等级：升为 verified 的只有现场测过的那几路；宇视录像机写法按抽检降为 candidate 并留原因', () => {
  const lib = mergeLibrary(loadRaw());
  const tapo = lib.variants.get('tapo.1').variant.streams;
  assert.equal(tapo.main.status, 'verified');
  assert.equal(tapo.sub.status, 'verified');
  assert.ok(tapo.sub.evidence.some((e) => e.type === 'device' && e.model === 'Tapo C210' && /CAMERA-BINDING/.test(e.ref)));
  const dahua = lib.variants.get('dahua.1').variant.streams;
  assert.equal(dahua.sub.status, 'verified', '现场只测过子码流');
  assert.equal(dahua.main.status, 'documented');
  assert.equal(lib.variants.get('hikvision.1').variant.streams.main.status, 'documented');
  assert.equal(lib.stats.byStatus.verified, 3);
  const nvr = lib.variants.get('uniview.2').variant;
  assert.equal(nvr.target, 'nvr');
  for (const s of [nvr.streams.main, nvr.streams.sub]) {
    assert.equal(s.status, 'candidate');
    assert.match(s.note, /抽检.*IPC/);
  }
  assert.equal(lib.variants.get('uniview.1').variant.streams.main.status, 'documented');
});

test('产物内容：Tapo 的限制与前提、宇视摄像头 / 录像机分开、Reolink 两位补零、需要 token 的不进配对', () => {
  const a = artifact();
  const get = (id) => a.vendors.find((v) => v.id === id);
  const tapo = get('tapo');
  assert.deepEqual(tapo.requires, ['camera-account']);
  assert.ok(tapo.quirks.some((q) => q.id === 'stream-limit' && !/\b10\.\d+\.\d+\.\d+\b/.test(q.note)), '备注里不带现场 IP');
  const uni = get('uniview');
  assert.deepEqual(uni.pairs.map((p) => [p.id, p.target, p.status]), [['uniview.1', 'camera', 'documented'], ['uniview.2', 'nvr', 'candidate']]);
  assert.equal(renderPath(get('reolink').pairs[0].main, { ch: 2 }), '/Preview_02_main');
  assert.equal(renderPath(get('hikvision').pairs[0].main, { ch: 10 }), '/Streaming/Channels/1001');
  assert.deepEqual(get('unifi').pairs, [], '/{streamToken} 需要人给值，不自动渲染');
  assert.equal(get('generic').aliases.length, 0, '通用兜底不是品牌，认不出来');
});

test('产物自身的结构检查拦得住坏产物', () => {
  const bad = (mutate) => {
    const a = artifact();
    mutate(a);
    return validateArtifact(a);
  };
  assert.deepEqual(validateArtifact(artifact()), []);
  assert.ok(bad((a) => (a.schema = 2)).length);
  assert.ok(bad((a) => (a.onvifPorts = [0])).length);
  const tapo = (a) => a.vendors.find((v) => v.id === 'tapo');
  assert.ok(bad((a) => (tapo(a).pairs[0].main = '/a b')).length);
  assert.ok(bad((a) => (tapo(a).pairs[0].sub = 'rtsp://x/y')).length);
  assert.ok(bad((a) => (tapo(a).pairs[0].main = '/x?password=1')).length);
  assert.ok(bad((a) => a.sweep.push(['/a b', '/c'])).length);
  assert.ok(bad((a) => (a.autoFill = ['tapo'])).length);
  assert.ok(bad((a) => delete a.vendors.find((v) => v.id === 'tapo').pin).length);
  assert.ok(bad((a) => (a.vendors.find((v) => v.id === 'tapo').aliases = ['Tapo'])).length);
  assert.ok(bad((a) => (a.vendors[1].id = a.vendors[0].id)).length);
  // IOC 直接要海康 / 大华的固定路径：产物里缺了就不合规
  assert.ok(bad((a) => (a.vendors.find((v) => v.id === 'hikvision').pairs = [])).some((x) => /hikvision/.test(x)));
  assert.ok(bad((a) => (a.vendors = a.vendors.filter((v) => v.id !== 'dahua'))).some((x) => /dahua/.test(x)));
  assert.ok(validateArtifact(null).length && validateArtifact('x').length);
});

test('渲染：{ch} / {ch2}；需要人给值的占位符、不安全结果都返回 null', () => {
  assert.equal(renderPath('/Streaming/Channels/{ch}01', { ch: 1 }), '/Streaming/Channels/101');
  assert.equal(renderPath('/Streaming/Channels/{ch}01', { ch: 10 }), '/Streaming/Channels/1001');
  assert.equal(renderPath('/Preview_{ch2}_main', { ch: 3 }), '/Preview_03_main');
  for (const bad of [0, -1, 1.5, 1000, NaN, 'x', undefined]) assert.equal(renderPath('/c{ch}', { ch: bad }), '/c1', String(bad));
  assert.equal(renderPath('/c{ch}'), '/c1');
  assert.equal(renderPath('/{codec}/ch{ch}'), null);
  assert.equal(renderPath('/{token}'), null);
  assert.equal(renderPath('/a b'), null);
  assert.equal(renderPath('no-slash'), null);
  assert.ok(toArtifact(mergeLibrary(loadRaw())).vendors.length >= 140);
});

// ---------------------------------------------------------------------------------------------------
// 只有型号的识别写法（modelPatterns）：Tapo 的 ONVIF 常只给 C210 / C510W / TC70，不带厂家
// ---------------------------------------------------------------------------------------------------
/** 与 IOC 查询一致的归一化：小写、非字母数字（保留中文）换成单个空格、首尾各一个空格 */
const normalize = (s) => ' ' + String(s).toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim() + ' ';
/** 库化之前写在 h2z.backend camera-credentials.streamPaths 里的那条正则（2026-11-04 真机修复），逐字 */
const LEGACY_TAPO_MODEL_ONLY = /(^|[\s_-])(?:tc\d{2}[a-z]?|c[1-9]\d{2}[a-z]{0,2})($|[\s_-])/;

test('modelPatterns：Tapo 带着只给型号的识别写法，结果和库化之前那条正则在一批样例上完全一致', () => {
  const tapo = artifact().vendors.find((v) => v.id === 'tapo');
  assert.ok(Array.isArray(tapo.modelPatterns) && tapo.modelPatterns.length === 1);
  const res = tapo.modelPatterns.map((x) => new RegExp(x));
  const hit = (t) => res.some((re) => re.test(normalize(t)));
  const samples = ['C210', 'C510W', 'Tapo C200', 'TC70', 'tp-link c320ws', 'c100', 'TC65', 'C225', 'c520ws', 'C2100', 'C21', 'Axis C1004-E', 'Hikvision C100', 'Foo-1', 'DS-2CD2143G2-I', 'IPC-HFW2431S', 'C1', 'tc7', 'tc700', 'xc210', 'C210 Pro', '', '  ', 'Tapo', 'model: c310'];
  for (const t of samples) assert.equal(hit(t), LEGACY_TAPO_MODEL_ONLY.test(String(t).toLowerCase()), JSON.stringify(t));
  for (const t of ['C210', 'C510W', 'TC70', 'tp-link c320ws']) assert.equal(hit(t), true, t);
  for (const t of ['Axis C1004-E', 'C21', 'C2100', 'Foo-1', '']) assert.equal(hit(t), false, t);
  // 其它品牌没有这类写法（只有现场验证过的才加）
  assert.deepEqual(artifact().vendors.filter((v) => v.modelPatterns).map((v) => v.id), ['tapo']);
});

test('门禁：modelPatterns 必须能安全执行——嵌套量词、反向引用、环视、大写、过长、不是正则、条数过多都拒绝', () => {
  const ok = ' (?:tc\\d{2}[a-z]?|c[1-9]\\d{2}[a-z]{0,2}) ';
  assert.equal(modelPatternProblem(ok), '');
  for (const bad of ['(a+)+x', '(ab)*c', '(ab){2,}c', '(a)\\1xx', '(?=x)yy', '(?<n>x)yy', 'C210 x', '\\w+abc', '[a-', 'a'.repeat(121), 'ab', 7, null]) assert.notEqual(modelPatternProblem(bad), '', String(bad));
  const bad = (list) => problemsOf((r) => { r.curated.vendors.tapo.modelPatterns = list; });
  assert.equal(has(bad([ok]), /modelPatterns/), false);
  assert.equal(has(bad(['(a+)+x']), /curated\.tapo\.modelPatterns 不合规.*嵌套量词/), true);
  assert.equal(has(bad('c210'), /curated\.tapo\.modelPatterns 不合规/), true, '必须是数组');
  assert.equal(has(bad([]), /curated\.tapo\.modelPatterns 不合规/), true, '空数组没意义');
  assert.equal(has(bad(Array.from({ length: MODEL_PATTERNS_MAX + 1 }, (_, i) => ' c' + (100 + i) + ' ')), /curated\.tapo\.modelPatterns 不合规/), true);
  // 坏数据生成不出产物
  const r = raw();
  r.curated.vendors.tapo.modelPatterns = ['(a+)+x'];
  assert.throws(() => buildArtifactText(r), /不合规/);
});

test('产物自身的结构检查也拦 modelPatterns 不合规', () => {
  const a = artifact();
  assert.deepEqual(validateArtifact(a), []);
  const mk = (list) => {
    const b = structuredClone(a);
    b.vendors.find((v) => v.id === 'tapo').modelPatterns = list;
    return validateArtifact(b);
  };
  assert.equal(has(mk(['(a+)+x']), /tapo：modelPatterns 不合规/), true);
  assert.equal(has(mk('c210'), /tapo：modelPatterns 不合规/), true);
});

// ---------------------------------------------------------------------------------------------------
// 出厂账号 / 激活 / 锁定阈值（factory，2026-11-08）
// ---------------------------------------------------------------------------------------------------
const factoryOf = (id) => artifact().vendors.find((v) => v.id === id)?.factory;

test('factory：海康 / 宇视 / TVT / 华三都在库里，字段齐全；产物不带证据和备注', () => {
  for (const id of ['hikvision', 'uniview', 'tvt', 'h3c']) {
    const f = factoryOf(id);
    assert.ok(f, id + ' 缺少 factory');
    assert.ok(Array.isArray(f.accounts) && f.activation && f.lock && Array.isArray(f.factoryIps), id);
    assert.ok(!JSON.stringify(f).match(/evidence|\"note\"/), id + ' 产物里不应带证据 / 备注');
  }
  assert.equal(factoryOf('hikvision').activation.required, 'new-firmware', '海康新固件没有默认口令，必须先激活');
  assert.deepEqual(factoryOf('uniview').accounts[0], { username: 'admin', password: '123456', scope: factoryOf('uniview').accounts[0].scope, status: 'documented' });
  assert.equal(factoryOf('h3c').accounts.length, 0, '华三没有可靠资料，不能编一个出厂账号');
  assert.equal(factoryOf('h3c').lock.maxAttempts, null);
  assert.equal(factoryOf('tvt').lock.maxAttempts, null);
});

test('factory 门禁：转载页只能是 candidate，documented 必须有厂家文档，verified 必须有真机证据，必须带链接和日期', () => {
  const hik = (r) => r.curated.vendors.hikvision.factory;
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].status = 'documented')), /documented 必须有厂家文档/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].status = 'verified')), /verified 必须有真机/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].evidence = [])), /没有证据/));
  assert.ok(has(problemsOf((r) => delete hik(r).accounts[0].evidence[0].url), /必须带链接/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].evidence[0].url = 'javascript:alert(1)')), /链接/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].evidence[0].date = 'today')), /日期/));
  assert.ok(has(problemsOf((r) => (hik(r).lock.evidence = [])), /没有证据/), '写了锁定次数就必须有证据');
});

test('factory 门禁：不是口令字典——最多 3 条、口令只许可见 ASCII、账号只许常规字符；路径里照旧不许有口令', () => {
  const hik = (r) => r.curated.vendors.hikvision.factory;
  const one = () => ({ username: 'admin', password: 'x', status: 'candidate', evidence: [{ type: 'mirror-doc', url: 'https://example.com/a', date: '2026-11-08' }] });
  assert.ok(has(problemsOf((r) => (hik(r).accounts = [one(), one(), one(), one()])), /最多 3 条/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].password = 'a b')), /password/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].password = 'x'.repeat(33))), /password/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].password = '')), /password/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts[0].username = 'ad min')), /username/));
  assert.ok(has(problemsOf((r) => (vendorOf(r, 'axis').variants[0].streams.main.path = '/a?password=1')), /口令/), '路径带口令仍然被拦');
});

test('factory 门禁：激活 / 锁定 / 出厂 IP 的取值范围；不清楚就要明说 unknown / null，不能编', () => {
  const hik = (r) => r.curated.vendors.hikvision.factory;
  assert.ok(has(problemsOf((r) => (hik(r).activation.required = 'maybe')), /required/));
  assert.ok(has(problemsOf((r) => (hik(r).activation.minPasswordLength = 0)), /minPasswordLength/));
  assert.ok(has(problemsOf((r) => (hik(r).lock.maxAttempts = 0)), /maxAttempts/));
  assert.ok(has(problemsOf((r) => (hik(r).lock.lockMinutes = 99999)), /lockMinutes/));
  assert.ok(has(problemsOf((r) => (hik(r).factoryIps = ['192.168.1.999'])), /factoryIps/));
  assert.ok(has(problemsOf((r) => delete hik(r).lock), /lock/));
  assert.ok(has(problemsOf((r) => (hik(r).accounts = 'admin')), /accounts/));
  assert.deepEqual(problemsOf((r) => (r.curated.vendors.h3c.factory.lock = { maxAttempts: null, lockMinutes: null, status: 'candidate' })), [], 'unknown 不需要证据');
  // 坏数据生成不出产物
  const r = raw();
  hik(r).accounts[0].password = 'bad password';
  assert.throws(() => buildArtifactText(r), /不合规/);
});

test('factory 门禁：激活配方（activation.recipes）—— id/method 格式、status 合法、candidate 也要有证据，产物里不带证据和备注', () => {
  const hik = (r) => r.curated.vendors.hikvision.factory;
  assert.ok(has(problemsOf((r) => (hik(r).activation.recipes = 'sadp')), /recipes/));
  assert.ok(has(problemsOf((r) => (hik(r).activation.recipes[0].id = 'not a valid id!')), /recipes\[0\]\.id/));
  assert.ok(has(problemsOf((r) => (hik(r).activation.recipes[0].method = 'Not Lowercase')), /recipes\[0\]\.method/));
  assert.ok(has(problemsOf((r) => (hik(r).activation.recipes[0].status = 'maybe')), /recipes\[0\]\.status/));
  assert.ok(has(problemsOf((r) => delete hik(r).activation.recipes[0].evidence), /没有证据/));
  assert.ok(has(problemsOf((r) => (hik(r).activation.recipes[0].note = 'x'.repeat(2000))), /recipes\[0\]\.note/));
  // 产物里只留 id / method / status，没有 note 和 evidence
  const out = artifact().vendors.find((v) => v.id === 'hikvision').factory.activation.recipes[0];
  assert.deepEqual(Object.keys(out).sort(), ['id', 'method', 'status']);
});

test('factory：产物自身的结构检查也拦坏数据', () => {
  const mk = (fn) => {
    const b = structuredClone(artifact());
    fn(b.vendors.find((v) => v.id === 'hikvision').factory);
    return validateArtifact(b);
  };
  assert.deepEqual(mk(() => {}), []);
  assert.ok(has(mk((f) => (f.accounts[0].password = 'a b')), /factory/));
  assert.ok(has(mk((f) => (f.lock.maxAttempts = -1)), /factory/));
  assert.ok(has(mk((f) => (f.activation.required = 'x')), /factory/));
  assert.ok(has(mk((f) => (f.factoryIps = ['nope'])), /factory/));
});

// ---------------------------------------------------------------------------------------------------
// 2026-11-23 (P2.10): family / access / factoryState / oui / fingerprints, the contract gate, evidence honesty
// ---------------------------------------------------------------------------------------------------
const FAMILIES = ['hikvision', 'dahua', 'uniview', 'tvt', 'axis', 'hanwha', 'bosch', 'tapo', 'kasa', 'xiongmai', 'reolink'];
const vendorArt = (id) => artifact().vendors.find((v) => v.id === id);
const curatedOf = (r, id) => r.curated.vendors[id];

test('identity: the eleven families carry family / factory state / oui / fingerprints / factoryIps in the artifact', () => {
  for (const id of FAMILIES) {
    const v = vendorArt(id);
    assert.ok(v, id);
    assert.equal(v.family, id, id);
    assert.ok(v.factoryState && ['probe-field', 'http-signal', 'unknown', 'none'].includes(v.factoryState.kind), id);
    assert.ok(v.oui && Array.isArray(v.oui.values), id);
    assert.ok(v.fingerprints && Array.isArray(v.fingerprints.rules), id);
    assert.ok(v.factory && Array.isArray(v.factory.factoryIps), id);
  }
  assert.equal(vendorArt('wisenet').family, 'hanwha', 'Wisenet is the Hanwha family');
});

test('identity: access is an ordered list of rtsp / bridge:<protocol> with a grade per entry', () => {
  const want = { hikvision: ['rtsp'], dahua: ['rtsp'], uniview: ['rtsp'], tvt: ['rtsp'], axis: ['rtsp'], hanwha: ['rtsp'], bosch: ['rtsp'], tapo: ['rtsp', 'bridge:tapo'], kasa: ['bridge:kasa'], xiongmai: ['bridge:dvrip'], reolink: ['rtsp'] };
  for (const [id, access] of Object.entries(want)) {
    const v = vendorArt(id);
    assert.deepEqual(v.access, access, id);
    assert.equal(v.accessStatus.length, access.length, id);
  }
  // every bridge protocol named by the library exists in the bridge contract snapshot
  const protocols = loadRaw().contracts.bridge.protocols;
  for (const v of artifact().vendors) for (const a of v.access || []) if (a.startsWith('bridge:')) assert.ok(protocols.includes(a.slice(7)), a);
});

test('identity: evidence levels are honest (nothing is verified without a real-device record)', () => {
  const r = raw();
  const hik = curatedOf(r, 'hikvision').identity;
  assert.equal(hik.factoryState.status, 'verified');
  assert.ok(hik.factoryState.evidence.some((e) => e.type === 'device'));
  assert.equal(hik.access[0].status, 'documented', 'RTSP of Hikvision rests on vendor documents here, not on a device record in the library');
  for (const id of FAMILIES) {
    const idn = curatedOf(r, id).identity;
    const groups = [...(idn.access || []), idn.factoryState, idn.oui, ...(idn.fingerprints?.rules || [])].filter(Boolean);
    for (const g of groups) {
      if (g.status === 'verified') assert.ok(g.evidence.some((e) => e.type === 'device'), `${id}: verified without a device record`);
      if (g.status === 'documented') assert.ok(g.evidence.some((e) => e.type === 'vendor-doc' || e.type === 'registry'), `${id}: documented without a vendor document or registry`);
    }
  }
  // things that were not found stay unknown / empty instead of being invented
  assert.equal(vendorArt('tvt').factoryState.kind, 'unknown');
  assert.deepEqual(vendorArt('tvt').factory.factoryIps, []);
  assert.deepEqual(vendorArt('tapo').oui.values, [], 'TP-Link prefixes are shared by routers');
  assert.equal(vendorArt('tapo').factoryState.status, 'candidate');
});

test('identity: factoryIps of each family and the grade of every address', () => {
  const ips = (id) => vendorArt(id).factory.factoryIps;
  assert.deepEqual(ips('hikvision'), ['192.168.1.64', '192.0.0.64']);
  assert.deepEqual(ips('dahua'), ['192.168.1.108']);
  assert.deepEqual(ips('uniview'), ['192.168.1.13']);
  assert.deepEqual(ips('axis'), ['192.168.0.90']);
  assert.deepEqual(ips('hanwha'), ['192.168.1.100']);
  assert.deepEqual(ips('bosch'), ['192.168.0.1']);
  assert.deepEqual(ips('xiongmai'), ['192.168.1.10']);
  for (const id of ['tapo', 'kasa', 'reolink', 'tvt']) assert.deepEqual(ips(id), [], `${id} gets its address by DHCP or none was found`);
  assert.equal(vendorArt('hikvision').factory.factoryIpStatus['192.168.1.64'], 'verified');
  assert.equal(vendorArt('hikvision').factory.factoryIpStatus['192.0.0.64'], 'candidate');
  assert.equal(vendorArt('axis').factory.factoryIpStatus['192.168.0.90'], 'documented');
  assert.equal(vendorArt('hanwha').factory.factoryIpStatus['192.168.1.100'], 'documented');
  assert.equal(vendorArt('dahua').factory.factoryIpStatus['192.168.1.108'], 'candidate');
});

test('identity gate: a bridge protocol that h2z.bridge does not have, or an unknown activator driver, stops the build', () => {
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'tapo').identity.access[1].via = 'bridge:nosuch')), /protocols\.json 里没有协议 nosuch/));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'axis').identity.activationDriver = 'axis-nosuch')), /activationDriver/));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'tapo').identity.access[0].via = 'ftp')), /rtsp 或 bridge/));
  assert.ok(has(problemsOf((r) => curatedOf(r, 'tapo').identity.access.push({ via: 'rtsp', status: 'candidate', note: 'duplicate entry of rtsp' })), /重复/));
  assert.ok(has(problemsOf((r) => (r.contracts.bridge.protocols = [])), /contracts\.json/));
  assert.ok(has(problemsOf((r) => delete r.contracts), /contracts\.json/));
});

test('identity gate: evidence rules are the same as for stream paths', () => {
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'hikvision').identity.factoryState.evidence = [{ type: 'mirror-doc', url: 'https://example.com/x', date: '2026-11-23' }])), /verified 必须有真机/));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'hanwha').identity.access[0].evidence = [{ type: 'mirror-doc', url: 'https://example.com/x', date: '2026-11-23' }])), /documented 必须有厂家文档/));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'bosch').identity.access[0].note = 'short')), /note 里写明依据/));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'dahua').factory.factoryIpEvidence = {})), /缺少 192\.168\.1\.108 的证据/));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'axis').factory.factoryIpEvidence['10.0.0.1'] = { status: 'candidate', note: 'not a factory address' })), /不在 factoryIps/));
});

test('identity gate: fingerprints are plain comparisons over known signals (no regular expressions in the library)', () => {
  const rule = (extra) => ({ id: 'x-rule', status: 'candidate', note: 'made up for the gate test', ...extra });
  const add = (extra) => (r) => curatedOf(r, 'axis').identity.fingerprints.rules.push(rule(extra));
  assert.deepEqual(problemsOf(add({ signal: 'http.server', op: 'contains', value: 'axis' })), []);
  assert.ok(has(problemsOf(add({ signal: 'http.server', op: 'regex', value: '^a.*' })), /op 不合法/));
  assert.ok(has(problemsOf(add({ signal: 'http.body', op: 'contains', value: 'axis' })), /signal 不合法/));
  assert.ok(has(problemsOf(add({ signal: 'http.server', op: 'contains', value: 'AXIS' })), /小写/));
  assert.ok(has(problemsOf(add({ signal: 'port', op: 'present', value: '554' })), /port 特征/));
  assert.ok(has(problemsOf(add({ signal: 'probe', op: 'contains', value: 'sadp' })), /probe 特征/));
  assert.ok(FP_SIGNALS.includes('http.axisSetup'));
  assert.ok(has(problemsOf((r) => (curatedOf(r, 'hikvision').identity.oui.values[0] = 'c056e3')), /OUI|6 位/));
});

test('identity: every probe named by a fingerprint exists in scripts/camera-discovery.mjs (the signal names are the discovery output)', async () => {
  const { PROBES } = await import('./camera-discovery.mjs');
  const ids = new Set(PROBES.map((p) => p.id));
  for (const v of artifact().vendors) for (const r of v.fingerprints?.rules || []) if (r.signal === 'probe') assert.ok(ids.has(r.value), `${v.id}: ${r.value}`);
});

test('contract drift: the snapshot is compared with the sibling h2z.bridge / h2z.activator checkouts when they exist', () => {
  const r = raw();
  const dir = mkdtempSync(resolve(tmpdir(), 'h2z-contracts-'));
  mkdirSync(resolve(dir, 'bridge'));
  mkdirSync(resolve(dir, 'activator/src/drivers'), { recursive: true });
  writeFileSync(resolve(dir, 'bridge/protocols.json'), JSON.stringify({ protocols: r.contracts.bridge.protocols.map((id) => ({ id })) }));
  writeFileSync(resolve(dir, 'activator/src/drivers/x.mjs'), r.contracts.activator.drivers.map((id) => `{ id: '${id}' }`).join('\n'));
  const where = { bridgeDir: resolve(dir, 'bridge'), activatorDir: resolve(dir, 'activator') };
  assert.deepEqual(contractDrift(r, where), []);
  writeFileSync(resolve(dir, 'bridge/protocols.json'), JSON.stringify({ protocols: [...r.contracts.bridge.protocols, 'newproto'].filter((x) => x !== 'homekit').map((id) => ({ id })) }));
  const drift = contractDrift(r, where);
  assert.ok(has(drift, /缺少 h2z\.bridge 的协议 newproto/));
  assert.ok(has(drift, /homekit 已不在/));
  writeFileSync(resolve(dir, 'activator/src/drivers/x.mjs'), "{ id: 'hikvision-sadp' }");
  assert.ok(has(contractDrift(r, where), /驱动 axis-vapix 在 h2z\.activator/));
  assert.deepEqual(contractDrift(r, { bridgeDir: resolve(dir, 'none'), activatorDir: resolve(dir, 'none') }), [], 'nothing to compare with = no problem');
});
