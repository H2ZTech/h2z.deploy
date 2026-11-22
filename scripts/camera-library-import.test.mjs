// 摄像头库导入器（scripts/camera-library/import-ch-bas.mjs）：用合成数据钉住每条过滤 / 分级 / 归一规则。
// 这里的夹具都是手写的，不含上游真实数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImported, normalizeRole, normalizePath, effectiveHost, urlsIn, classifyEvidence, bareOfficialRefs, SAFE_PATH } from './camera-library/import-ch-bas.mjs';

const META = { commit: 'a'.repeat(40), sha256: 'b'.repeat(64), retrievedAt: '2026-11-04' };
const up = (brands, license = 'CC0-1.0') => ({ _meta: { license, generated: '2026-10-28' }, brands });
const OFFICIAL = 'https://supportusa.hikvision.com/support/solutions/articles/1-example';
const tpl = (o) => ({ stream: 'main', path: '/x', verified: true, source: 'Vendor manual ' + OFFICIAL, ...o });
const brand = (id, templates, extra = {}) => ({ brand: id.toUpperCase(), brand_id: id, status: 'verified', default_port: 554, templates, ...extra });
const run = (brands) => buildImported(up(brands), META);

test('许可门禁：上游不是 CC0-1.0 就拒绝导入', () => {
  assert.throws(() => buildImported(up([], 'CC-BY-NC-4.0'), META), /CC0-1\.0/);
  assert.throws(() => buildImported({ brands: [] }, META), /CC0-1\.0/);
  assert.throws(() => buildImported({ _meta: { license: 'CC0-1.0' } }, META), /brands/);
});

test('只收 verified=true；口令占位、聚合站来源、不安全路径整条丢弃', () => {
  const { data, report } = run([
    brand('acme', [
      tpl({ stream: 'main', path: '/ok1' }),
      tpl({ stream: 'sub', path: '/ok2' }),
      tpl({ stream: 'third', path: '/nope1', verified: false }),
      tpl({ stream: 'main', path: '/user={user}&password={pass}&channel=<N>' }),
      tpl({ stream: 'main', path: '/a?pwd=1' }),
      tpl({ stream: 'main', path: '/agg', source: 'Seen on iSpyConnect and Agent DVR ' + OFFICIAL }),
      tpl({ stream: 'main', path: '/agg2', note: 'confirms StrixCamDB lead' }),
      tpl({ stream: 'main', path: '/bad path' }),
      tpl({ stream: 'main', path: '/crlf\r\nX: y' }),
      tpl({ stream: 'main', path: 'no-leading-slash' }),
      tpl({ stream: 'main', path: '/<ip>/x' }),
    ]),
  ]);
  const v = data.vendors[0];
  assert.equal(v.variants.length, 1);
  assert.deepEqual(Object.keys(v.variants[0].streams), ['main', 'sub']);
  assert.equal(report.templatesImported, 2);
  assert.equal(report.dropped['not-verified'], 1);
  assert.equal(report.dropped['credentials-in-path'], 2);
  assert.equal(report.dropped['aggregator-mention'], 2);
  assert.equal(report.dropped['unsafe-path'], 2); // 空格、回车换行
  assert.equal(report.dropped['bad-path'], 1);
  assert.equal(report.dropped['unknown-placeholder'], 1);
});

test('不把上游的线索指针 / 备注 / 未核实线索带进来', () => {
  const { data } = run([
    brand(
      'acme',
      [tpl({ strix_lead: 'strixcamdb:acme', series: 'S1', note: 'only HX series' })],
      { notes: 'seen in iSpy', unverified_leads: [{ path: '/lead', note: 'iSpy' }], verified_on: '2026-10-28' },
    ),
  ]);
  const text = JSON.stringify(data).toLowerCase();
  for (const w of ['strix', 'ispy', 'unverified_leads', 'verified_on', '/lead', 'seen in']) assert.ok(!text.includes(w), w);
  assert.equal(data.vendors[0].variants[0].series, 'S1');
});

test('占位符归一：<N>→{ch}，{NN}/Reolink {channel}→{ch2}，其它占位符进 params 且不自动渲染', () => {
  assert.deepEqual(normalizePath('/Streaming/Channels/<N>01'), { template: '/Streaming/Channels/{ch}01', params: [] });
  assert.deepEqual(normalizePath('/ch{NN}/0'), { template: '/ch{ch2}/0', params: [] });
  assert.deepEqual(normalizePath('/Preview_{channel}_main'), { template: '/Preview_{ch2}_main', params: [] });
  assert.deepEqual(normalizePath('/{codec}/ch<N>/main/av_stream'), { template: '/{codec}/ch{ch}/main/av_stream', params: ['codec'] });
  assert.deepEqual(normalizePath('/{streamToken}?enableSrtp'), { template: '/{streamToken}?enableSrtp', params: ['streamToken'] });
  assert.equal(normalizePath('/cam?x={channel}').template, '/cam?x={channel}'); // 不是 Reolink 形态：不猜补零
  assert.deepEqual(normalizePath('/a?user=admin'), { drop: 'credentials-in-path' });
  assert.deepEqual(normalizePath('rtsp://x/y'), { drop: 'bad-path' });
  assert.ok(SAFE_PATH.test('/cam/realmonitor?channel=1&subtype=0'));
  assert.ok(!SAFE_PATH.test('/a b'));
  assert.ok(!SAFE_PATH.test('/a\r\nb'));
});

test('stream 标签归一与变体分组：顺序 main/sub/third 重复出现就另起一个变体；带标签的按标签成对', () => {
  assert.deepEqual(normalizeRole('main'), { role: 'main', variant: '' });
  assert.deepEqual(normalizeRole('tele_sub'), { role: 'sub', variant: 'tele' });
  assert.deepEqual(normalizeRole('main-pro-series'), { role: 'main', variant: 'pro-series' });
  assert.deepEqual(normalizeRole('legacy-hikvision-sub'), { role: 'sub', variant: 'legacy-hikvision' });
  assert.deepEqual(normalizeRole('main (UniFi Protect — high quality)'), { role: 'main', variant: 'unifi-protect-high-quality' });
  assert.deepEqual(normalizeRole('onvif'), { role: 'other', variant: 'onvif' });

  const { data } = run([
    brand('seq', [
      tpl({ stream: 'main', path: '/h264/m' }), tpl({ stream: 'sub', path: '/h264/s' }),
      tpl({ stream: 'main', path: '/h265/m' }), tpl({ stream: 'sub', path: '/h265/s' }), tpl({ stream: 'third', path: '/h265/t' }),
      tpl({ stream: 'main-pro', path: '/pro/m' }), tpl({ stream: 'sub-pro', path: '/pro/s' }),
      tpl({ stream: 'onvif', path: '/onvif' }),
    ]),
    brand('dev', [
      tpl({ stream: 'main', path: '/ipc/1', device_type: 'IPC' }), tpl({ stream: 'sub', path: '/ipc/2', device_type: 'IPC' }),
      tpl({ stream: 'main', path: '/nvr/c<N>/s0', device_type: 'NVR' }), tpl({ stream: 'sub', path: '/nvr/c<N>/s1', device_type: 'NVR' }),
    ]),
  ]);
  const seq = data.vendors[0].variants;
  assert.deepEqual(seq.map((v) => [v.id, v.label, Object.keys(v.streams).join('+')]), [
    ['seq.1', '', 'main+sub'], ['seq.2', '', 'main+sub+third'], ['seq.3', 'pro', 'main+sub'], ['seq.4', '', ''],
  ]);
  assert.equal(seq[3].extras[0].path, '/onvif');
  const dev = data.vendors[1].variants;
  assert.deepEqual(dev.map((v) => v.target), ['camera', 'nvr']);
  assert.equal(dev[1].streams.main.path, '/nvr/c{ch}/s0');
});

test('证据分级：官方主机 → documented；转载站 / 未审主机 / 没有 URL / OEM 推断 → candidate；裸域名只认已审定的官方主机', () => {
  const hosts = new Set();
  assert.equal(classifyEvidence('Manual ' + OFFICIAL, '', hosts).status, 'documented');
  assert.equal(classifyEvidence('Manual https://www.manualslib.com/manual/1/x.html', '', hosts).status, 'candidate');
  assert.equal(classifyEvidence('Manual https://unknown.example.org/x', '', hosts).status, 'candidate');
  assert.ok(hosts.has('unknown.example.org') && !hosts.has('www.manualslib.com'), '未审主机进报告，已知转载站不进');
  assert.equal(classifyEvidence('Some manual page 12, no link', '', hosts).evidence[0].type, 'citation');
  assert.equal(classifyEvidence('Some manual page 12, no link', '', hosts).status, 'candidate');
  assert.equal(classifyEvidence('Manual ' + OFFICIAL + ' — published on OEM basis', '', hosts).status, 'candidate');
  assert.equal(classifyEvidence('Manual ' + OFFICIAL, 'by convention the sub stream', hosts).status, 'candidate');
  // web.archive.org 按内层主机判断
  assert.equal(effectiveHost('https://web.archive.org/web/20140719185557/http://www.zavio.com/downloads/x.pdf'), 'www.zavio.com');
  assert.equal(classifyEvidence('Doc https://web.archive.org/web/2014/http://www.zavio.com/d.pdf', '', hosts).status, 'documented');
  assert.equal(classifyEvidence('Doc https://web.archive.org/web/2014/http://evil.example.net/d.pdf', '', hosts).status, 'candidate');
  // 裸域名
  assert.equal(classifyEvidence('Annke KB — help.annke.com article 3', '', hosts).status, 'documented');
  assert.equal(classifyEvidence('see manualslib.com/manual/1/x', '', hosts).status, 'candidate');
  assert.deepEqual(bareOfficialRefs('v1.2 index.html and tp-link.com/us/support/faq/2680/.').map((r) => r.url), ['https://tp-link.com/us/support/faq/2680/']);
  assert.deepEqual(urlsIn('a https://x.io/p). b http://y.org/q, and https://x.io/p).'), ['https://x.io/p', 'http://y.org/q']);
});

test('链接里有撇号（宇视的文件名 Camera\'s）不能被截断；引号收尾的不算；同站点已有完整链接就不再加裸域名证据', () => {
  const full = "https://global.uniview.com/res/202310/26/How%20to%20Get%20a%20Uniview%20Camera's%20RTSP%20Stream_1.pdf";
  assert.deepEqual(urlsIn(`Uniview official guide "How to Get a Uniview Camera's RTSP Stream" (global.uniview.com, Oct 2023) — ${full}`), [full]);
  assert.deepEqual(urlsIn("see 'http://y.org/q' and 'https://x.io/p'"), ['http://y.org/q', 'https://x.io/p']);
  // http://<ip>/… 是占位示例，不是真链接：不当证据
  const ph = classifyEvidence("Sercomm API doc: curl 'http://<ip>/Streaming/channels/101/httpPreview'", '', new Set());
  assert.deepEqual(ph.evidence.map((x) => x.type), ['citation']);
  assert.equal(ph.status, 'candidate');
  const e = classifyEvidence(`Uniview guide (uniview.com, Oct 2023) — https://www.uniview.com/res/x/How%20to%20Get%20a%20Camera's%20Stream.pdf`, '', new Set());
  assert.equal(e.status, 'documented');
  assert.equal(e.evidence.length, 1, JSON.stringify(e.evidence.map((x) => x.url)));
  assert.equal(e.evidence[0].url, "https://www.uniview.com/res/x/How%20to%20Get%20a%20Camera's%20Stream.pdf");
});

test('抽检结论：来源页面里查不到的路径降为 candidate 并写明原因（即使来源是官方主机）', () => {
  const src = 'Uniview official guide — https://global.uniview.com/res/x/guide.pdf';
  const { data, report } = run([
    brand('uniview', [
      tpl({ stream: 'main', path: '/media/video1', source: src }),
      tpl({ stream: 'main', path: '/unicast/c<N>/s0/live', source: src, device_type: 'NVR' }),
      tpl({ stream: 'sub', path: '/unicast/c<N>/s1/live', source: src, device_type: 'NVR' }),
    ]),
  ]);
  const [cam, nvr] = data.vendors[0].variants;
  assert.equal(cam.streams.main.status, 'documented');
  assert.equal(cam.streams.main.note, undefined);
  for (const s of [nvr.streams.main, nvr.streams.sub]) {
    assert.equal(s.status, 'candidate');
    assert.match(s.note, /抽检/);
    assert.equal(s.evidence[0].type, 'vendor-doc', '证据原样保留，只降等级');
  }
  assert.equal(report.reviewed, 2);
  assert.equal(report.status.documented, 1);
  assert.equal(report.status.candidate, 2);
});

test('extra_templates 也按同样规则处理；没有可用模板的品牌和非法 id 的品牌被跳过', () => {
  const { data, report } = run([
    brand('ex', [tpl({ stream: 'main', path: '/a' })], { extra_templates: [tpl({ stream: 'main-telephoto', path: '/b' }), tpl({ stream: 'sub-telephoto', path: '/c' })] }),
    brand('empty', []),
    brand('Bad ID!', [tpl({})]),
    brand('allbad', [tpl({ verified: false })]),
  ]);
  assert.deepEqual(data.vendors.map((v) => v.id), ['ex']);
  assert.deepEqual(data.vendors[0].variants.map((v) => v.label), ['', 'telephoto']);
  assert.equal(report.skippedBrands.length, 3);
});

test('输出确定：同样输入逐字节相同；来源信息完整；不含时间戳', () => {
  const brands = [brand('acme', [tpl({}), tpl({ stream: 'sub', path: '/y' })])];
  const a = JSON.stringify(buildImported(up(brands), META).data);
  const b = JSON.stringify(buildImported(up(brands), META).data);
  assert.equal(a, b);
  const { source } = JSON.parse(a);
  assert.deepEqual(source, { id: 'ch-bas/cctv-camera-database', license: 'CC0-1.0', url: 'https://github.com/ch-bas/cctv-camera-database', file: 'data/rtsp-patterns.json', commit: META.commit, sha256: META.sha256, upstreamGenerated: '2026-10-28', retrievedAt: '2026-11-04' });
});
