// Tests of scripts/camera-discovery.mjs (camera discovery of the host agent, FM-134).
// This file is the same in h2z.security and h2z.deploy; so is camera-discovery.mjs, whose digest is pinned below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as CD from './camera-discovery.mjs';
import * as HA from './host-agent.mjs';

// Both repositories must carry the same bytes. When camera-discovery.mjs changes, copy it to the other
// repository and update this constant in BOTH copies of this test.
const PINNED_SHA256 = '07eb805ef7c1c5b07451c98753d398a5a26d940bedff1fefdf7ee861caaea64c';

test('camera-discovery.mjs is the pinned copy (h2z.security and h2z.deploy must stay byte-identical)', () => {
  const digest = createHash('sha256').update(readFileSync(new URL('./camera-discovery.mjs', import.meta.url))).digest('hex');
  assert.equal(digest, PINNED_SHA256, 'camera-discovery.mjs changed: copy it to the other repository and update PINNED_SHA256 in both tests');
});

// ---- hostile input shared by every parser ------------------------------------------------------------
const HOSTILE = [
  Buffer.alloc(0),
  Buffer.from([0]),
  Buffer.from([0xff, 0xfe, 0xfd]),
  Buffer.from('c3285c80ffc0af', 'hex'), // invalid UTF-8
  Buffer.alloc(64, 0xff),
  Buffer.alloc(300, 0x41),
  Buffer.alloc(9000, 0x7b), // oversized
  Buffer.from('{"a":'.repeat(500)),
  Buffer.from('<ProbeMatch><XAddrs>http://[::1'.repeat(50)),
];

test('registry: well-formed entries, unique ids, every implemented probe builds a request and survives hostile replies', () => {
  const ids = new Set();
  for (const p of CD.PROBES) {
    assert.ok(/^[a-z0-9-]+$/.test(p.id) && !ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(['A', 'B', 'C', 'D'].includes(p.channel), p.id);
    assert.ok(['multicast', 'broadcast', 'unicast', 'passive'].includes(p.kind), p.id);
    assert.ok(['verified', 'documented', 'candidate'].includes(p.evidence.level) && p.evidence.source, p.id);
    assert.equal(typeof p.unicastCapable, 'boolean', p.id);
    assert.equal(typeof p.vendorHint, 'string', p.id);
    assert.equal(typeof p.buildRequest, 'function', p.id);
    assert.equal(typeof p.parseReply, 'function', p.id);
    if (!p.implemented) {
      assert.ok(p.note && p.note.length > 20, `${p.id}: a placeholder says what is missing and what covers the brand`);
      assert.deepEqual(p.buildRequest({}), [], `${p.id}: a placeholder never sends`);
    }
    if (p.implemented && (p.kind === 'multicast' || p.kind === 'broadcast')) {
      assert.ok(p.targets.length && p.targets.every((t) => t.port > 0 && CD.ipToInt(t.address) !== null), p.id);
      const built = p.buildRequest({ uuid: () => 'u-1', seq: 7, followUps: 0 });
      const list = Array.isArray(built) ? built : [built];
      assert.ok(list.length && list.every((b) => Buffer.isBuffer(b) && b.length > 0 && b.length < 1500), `${p.id}: request fits one datagram`);
      // our own request looped back is never a device
      for (const b of list) assert.deepEqual(p.parseReply(b, { address: '10.0.0.9', port: 1, localPort: 0 }, { uuid: () => 'u-1' }).filter((x) => !x.skip), [], `${p.id}: own request`);
    }
    if (p.kind === 'passive' && p.implemented) assert.ok(p.listen.length, p.id);
    for (const h of HOSTILE) {
      const out = p.parseReply(h, { address: '10.0.0.9', port: 1, localPort: p.listen?.[0]?.port || 0 }, { uuid: () => 'u' });
      assert.ok(Array.isArray(out), `${p.id}: hostile input gives an array`);
    }
  }
  // everything the plan lists is in the table, implemented or as a placeholder
  for (const id of ['onvif', 'sadp', 'mdns', 'ssdp', 'gige-vision', 'dahua-dhdiscover', 'hanwha', 'bosch', 'vivotek', 'sony', 'arecont', 'ubiquiti', 'xiongmai-dvrip', 'tplink-kasa', 'tplink-tapo', 'reolink', 'pppp', 'vstarcam',
    'axis-proprietary', 'panasonic', 'foscam', '360vision', 'nicevision', 'uniview-proprietary', 'tvt', 'tiandy', 'jovision', 'milesight', 'geovision', 'acti', 'tuya-beacon', 'dhcp-fingerprint', 'lldp-listen', 'factory-arp', 'ipv6-all-nodes']) assert.ok(ids.has(id), id);
});

test('WS-Discovery and SADP moved without change: same bytes and same parse results as host-agent.mjs', () => {
  assert.equal(CD.wsDiscoveryProbe('m-1'), HA.wsDiscoveryProbe('m-1'));
  assert.equal(CD.wsDiscoveryProbe('m-2', 'tds:Device'), HA.wsDiscoveryProbe('m-2', 'tds:Device'));
  assert.equal(CD.sadpProbe('ab-cd'), HA.sadpProbe('ab-cd'));
  assert.match(CD.wsDiscoveryProbe('m-3', ''), /<d:Probe\/>/, 'the untyped probe has no Types element');
  const wsd = '<e:Envelope><e:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:3fa1fe68-b915-4053-a3e1-c8de11223344</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/MAC/c8:de:11:22:33:44 onvif://www.onvif.org/hardware/DS-2CD2143 onvif://www.onvif.org/name/HIK onvif://www.onvif.org/Profile/Streaming</d:Scopes><d:XAddrs>http://172.21.20.101/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>';
  const sadp = '<ProbeMatch><Uuid>X</Uuid><Types>inquiry</Types><DeviceDescription>DS-2CD2143G2-I</DeviceDescription><DeviceSN>SN1</DeviceSN><CommandPort>8000</CommandPort><HttpPort>80</HttpPort><MAC>c8-de-11-22-33-44</MAC><IPv4Address>172.21.20.101</IPv4Address><DHCP>false</DHCP><Activated>true</Activated></ProbeMatch>';
  assert.deepEqual(CD.parseWsDiscovery(wsd, '172.21.20.101'), HA.parseWsDiscovery(wsd, '172.21.20.101'));
  assert.deepEqual(CD.parseSadp(sadp), HA.parseSadp(sadp));
  assert.deepEqual(CD.mergeDiscovered(CD.parseWsDiscovery(wsd, '172.21.20.101'), [CD.parseSadp(sadp)]), HA.mergeDiscovered(HA.parseWsDiscovery(wsd, '172.21.20.101'), [HA.parseSadp(sadp)]));
  const ifs = { enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/24' }], wlan0: [{ family: 'IPv4', address: '192.168.234.1' }], docker0: [{ family: 'IPv4', address: '172.17.0.1' }], enp2s0: [{ family: 'IPv4', address: '192.168.234.7' }] };
  assert.deepEqual(CD.discoveryInterfaces(ifs, { excluded: ['192.168.234.0/24'] }), HA.discoveryInterfaces(ifs, { excluded: ['192.168.234.0/24'] }));
  assert.equal(CD.DISCOVERY_MAX_REPLY, HA.DISCOVERY_MAX_REPLY);
});

// ---- DNS codec -----------------------------------------------------------------------------------------
const u16 = (n) => Buffer.from([n >> 8, n & 255]);
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const rr = (name, type, rdata) => Buffer.concat([name, u16(type), u16(1), u32(120), u16(rdata.length), rdata]);
const dnsHead = (answers, { flags = 0x8400, qd = 0 } = {}) => Buffer.concat([u16(0), u16(flags), u16(qd), u16(answers), u16(0), u16(0)]);
const txtData = (...kv) => Buffer.concat(kv.map((s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])));

test('DNS codec: query encoding, decoding with name compression, strict bounds', () => {
  const q = CD.dnsEncodeQuery([{ name: '_services._dns-sd._udp.local', type: CD.DNS_TYPE.PTR, unicast: true }, { name: '_rtsp._tcp.local', type: 12 }]);
  const back = CD.dnsDecode(q);
  assert.equal(back.response, false);
  assert.deepEqual(back.questions, [{ name: '_services._dns-sd._udp.local', type: 12 }, { name: '_rtsp._tcp.local', type: 12 }]);
  assert.equal(q.readUInt16BE(q.indexOf(Buffer.from([0, 0, 12])) + 3), 0x8001, 'unicast-response bit on the first question');
  assert.throws(() => CD.dnsEncodeName('a'.repeat(64) + '.local'), /label/);
  assert.throws(() => CD.dnsEncodeName(Array(60).fill('abcde').join('.')), /too long/);

  // a response using compression: the PTR target "Cam._rtsp._tcp.local" points back to the owner name at offset 12
  const owner = CD.dnsEncodeName('_rtsp._tcp.local'); // at offset 12
  const ptrTarget = Buffer.concat([Buffer.from([3]), Buffer.from('Cam'), Buffer.from([0xc0, 12])]);
  const msg = Buffer.concat([dnsHead(4),
    rr(owner, 12, ptrTarget),
    rr(Buffer.from([0xc0, 12]), 16, txtData('path=/live', 'empty=')),
    rr(Buffer.from([0xc0, 12]), 33, Buffer.concat([u16(0), u16(0), u16(554), Buffer.from([4]), Buffer.from('host'), Buffer.from([0xc0, 12 + 6])])), // host._tcp.local
    rr(Buffer.from([0xc0, 12]), 1, Buffer.from([10, 0, 0, 5])),
  ]);
  const d = CD.dnsDecode(msg);
  assert.equal(d.response, true);
  assert.deepEqual(d.records.map((r) => r.type), [12, 16, 33, 1]);
  assert.equal(d.records[0].data.name, 'Cam._rtsp._tcp.local');
  assert.deepEqual(d.records[1].data, ['path=/live', 'empty=']);
  assert.deepEqual(d.records[2].data, { port: 554, target: 'host._tcp.local' });
  assert.equal(d.records[3].data, '10.0.0.5');

  // compression loops and forward pointers are refused, not followed
  const selfLoop = Buffer.concat([dnsHead(1), Buffer.from([0xc0, 12]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4])]);
  assert.equal(CD.dnsDecode(selfLoop), null, 'a pointer to itself');
  const pingPong = Buffer.concat([dnsHead(1), Buffer.from([0xc0, 14, 0xc0, 12]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4])]);
  assert.equal(CD.dnsDecode(pingPong), null, 'two pointers pointing at each other');
  const forward = Buffer.concat([dnsHead(1), Buffer.from([0xc0, 40]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4]), Buffer.alloc(30)]);
  assert.equal(CD.dnsDecode(forward), null, 'a forward pointer');
  // truncated in every position: never throws
  for (let n = 0; n < msg.length; n++) assert.doesNotThrow(() => CD.dnsDecode(msg.subarray(0, n)));
  assert.equal(CD.dnsDecode(msg.subarray(0, msg.length - 2)), null);
  assert.equal(CD.dnsDecode(Buffer.alloc(11)), null);
  // rdata length beyond the packet, label beyond the packet
  const badLen = Buffer.from(msg);
  badLen.writeUInt16BE(9999, 12 + owner.length + 8);
  assert.equal(CD.dnsDecode(badLen), null);
  assert.equal(CD.dnsDecode(Buffer.concat([dnsHead(1), Buffer.from([63, 1, 2])])), null);
  // record count is capped: the header claims 65535 records
  const many = Buffer.concat([dnsHead(0xffff), ...Array(100).fill(rr(Buffer.from([1, 0x61, 0]), 1, Buffer.from([10, 0, 0, 1])))]);
  assert.equal(CD.dnsDecode(many, { maxRecords: 64 }).records.length, 64);
});

test('mDNS: service enumeration, Axis / HomeKit special cases, bounded follow-up queries', () => {
  const q = CD.dnsDecode(CD.mdnsRequest());
  assert.equal(q.questions[0].name, '_services._dns-sd._udp.local');
  for (const t of ['_axis-video._tcp.local', '_hap._tcp.local', '_rtsp._tcp.local', '_http._tcp.local', '_psia._tcp.local', '_onvif._tcp.local', '_ndi._tcp.local']) assert.ok(q.questions.some((x) => x.name === t && x.type === 12), t);

  // meta answer: one known type, one new type -> exactly one follow-up PTR query, asked once
  const meta = CD.dnsEncodeName('_services._dns-sd._udp.local');
  const metaMsg = Buffer.concat([dnsHead(2), rr(meta, 12, CD.dnsEncodeName('_rtsp._tcp.local')), rr(meta, 12, CD.dnsEncodeName('_vendorcam._tcp.local'))]);
  const ctx = {};
  const [m1] = CD.parseMdns(metaMsg, { address: '10.0.0.5' }, ctx);
  assert.deepEqual(m1.fields.services.sort(), ['_rtsp._tcp.local', '_vendorcam._tcp.local']);
  assert.equal(m1.followUp.length, 1);
  assert.equal(CD.dnsDecode(m1.followUp[0]).questions[0].name, '_vendorcam._tcp.local');
  assert.equal(CD.parseMdns(metaMsg, { address: '10.0.0.5' }, ctx)[0].followUp.length, 0, 'not asked twice');

  // Axis: instance name carries model and serial (= MAC), TXT macaddress
  const axisType = CD.dnsEncodeName('_axis-video._tcp.local');
  const inst = CD.dnsEncodeName('AXIS P3245-LVE - ACCC8E123456._axis-video._tcp.local');
  const axisMsg = Buffer.concat([dnsHead(4), rr(axisType, 12, inst), rr(inst, 33, Buffer.concat([u16(0), u16(0), u16(80), CD.dnsEncodeName('axis-accc8e123456.local')])), rr(inst, 16, txtData('macaddress=ACCC8E123456')), rr(CD.dnsEncodeName('axis-accc8e123456.local'), 1, Buffer.from([10, 0, 0, 90]))]);
  const [a] = CD.parseMdns(axisMsg, { address: '10.0.0.90' }, {});
  assert.equal(a.vendor, 'Axis');
  assert.equal(a.model, 'P3245-LVE');
  assert.equal(a.mac, 'AC:CC:8E:12:34:56');
  assert.deepEqual(a.fields.instances[0], { type: '_axis-video._tcp.local', name: 'AXIS P3245-LVE - ACCC8E123456', port: 80, host: 'axis-accc8e123456.local' });
  assert.deepEqual(a.fields.addresses, ['10.0.0.90']);
  assert.equal(a.followUp.length, 0, 'SRV and TXT came along: nothing more to ask');

  // an instance without SRV / TXT: both are asked for
  const bare = Buffer.concat([dnsHead(1), rr(axisType, 12, inst)]);
  const [b] = CD.parseMdns(bare, { address: '10.0.0.90' }, {});
  assert.deepEqual(b.followUp.map((f) => CD.dnsDecode(f).questions[0].type).sort(), [16, 33]);

  // HomeKit camera: model and category from TXT
  const hapType = CD.dnsEncodeName('_hap._tcp.local');
  const hapInst = CD.dnsEncodeName('Front Door._hap._tcp.local');
  const [h] = CD.parseMdns(Buffer.concat([dnsHead(3), rr(hapType, 12, hapInst), rr(hapInst, 33, Buffer.concat([u16(0), u16(0), u16(51826), CD.dnsEncodeName('cam.local')])), rr(hapInst, 16, txtData('md=Cam X1', 'ci=17', 'id=AA:BB:CC:DD:EE:FF'))]), { address: '10.0.0.7' }, {});
  assert.equal(h.model, 'Cam X1');
  assert.equal(h.fields.hapCategory, 17);
  assert.equal(h.mac, undefined, 'the HomeKit id is not a MAC address');

  // a query (not a response) and garbage give nothing; the number of names asked is bounded
  assert.deepEqual(CD.parseMdns(CD.mdnsRequest(), { address: '10.0.0.5' }, {}), []);
  const flood = {};
  let asked = 0;
  for (let i = 0; i < 300; i++) {
    const msg = Buffer.concat([dnsHead(1), rr(meta, 12, CD.dnsEncodeName(`_t${i}._tcp.local`))]);
    asked += CD.parseMdns(msg, { address: '10.0.0.5' }, flood).reduce((n, o) => n + o.followUp.length, 0);
  }
  assert.ok(asked < 96, `follow-ups bounded (${asked})`);
});

test('SSDP: request, response and NOTIFY parsing, device description', () => {
  const req = CD.ssdpRequest().toString();
  assert.match(req, /^M-SEARCH \* HTTP\/1\.1\r\nHOST: 239\.255\.255\.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n$/);
  const [r] = CD.parseSsdp(Buffer.from('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://10.0.0.90:49152/rootdesc1.xml\r\nSERVER: Linux/4.9, UPnP/1.0, Portable SDK for UPnP devices/1.8.7\r\nST: upnp:rootdevice\r\nUSN: uuid:Upnp-BasicDevice-1_0-ACCC8E123456::upnp:rootdevice\r\n\r\n'));
  assert.deepEqual(r.fields, { server: 'Linux/4.9, UPnP/1.0, Portable SDK for UPnP devices/1.8.7', st: 'upnp:rootdevice', usn: 'uuid:Upnp-BasicDevice-1_0-ACCC8E123456::upnp:rootdevice', location: 'http://10.0.0.90:49152/rootdesc1.xml', notify: false });
  const [n] = CD.parseSsdp(Buffer.from('NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\nUSN: uuid:x::upnp:rootdevice\r\nLOCATION: javascript:alert(1)\r\n\r\n'));
  assert.equal(n.fields.notify, true);
  assert.equal(n.fields.location, '', 'only http(s) locations are kept');
  assert.deepEqual(CD.parseSsdp(Buffer.from('NOTIFY * HTTP/1.1\r\nNT: x\r\nNTS: ssdp:byebye\r\nUSN: y\r\n\r\n')), []);
  assert.deepEqual(CD.parseSsdp(CD.ssdpRequest()), [], 'an M-SEARCH (ours or anybody else\'s) is not a device');
  assert.deepEqual(CD.parseSsdp(Buffer.from('HTTP/1.1 404 Not Found\r\n\r\n')), []);
  assert.deepEqual(CD.parseUpnpDescription('<root><device><friendlyName>AXIS P3245 - ACCC8E123456</friendlyName><manufacturer>AXIS</manufacturer><modelName>AXIS P3245-LVE</modelName><modelNumber>P3245-LVE</modelNumber><serialNumber>ACCC8E123456</serialNumber><UDN>uuid:abc</UDN></device></root>'),
    { friendlyName: 'AXIS P3245 - ACCC8E123456', manufacturer: 'AXIS', modelName: 'AXIS P3245-LVE', modelNumber: 'P3245-LVE', serialNumber: 'ACCC8E123456', udn: 'uuid:abc' });
  assert.deepEqual(CD.parseUpnpDescription('garbage'), {});
});

// ---- vendor probes: fixtures are built here by hand from the documented layouts -------------------------
const put = (buf, off, text) => void Buffer.from(text, 'latin1').copy(buf, off);

test('Dahua DHDiscover: DHIP header + JSON', () => {
  const req = CD.dahuaRequest();
  assert.equal(req.subarray(0, 8).toString('hex'), '2000000044484950');
  const body = req.subarray(32).toString();
  assert.equal(body, '{"method":"DHDiscover.search","params":{"mac":"","uni":1}}\n');
  assert.equal(req.readUInt32LE(16), body.length);
  assert.equal(req.readUInt32LE(24), body.length);
  const reply = (json) => {
    const b = Buffer.from(JSON.stringify(json));
    const h = Buffer.alloc(32);
    h.writeUInt32LE(0x20, 0); h.write('DHIP', 4); h.writeUInt32LE(b.length, 16); h.writeUInt32LE(b.length, 24);
    return Buffer.concat([h, b]);
  };
  const ok = reply({ mac: '3c:ef:8c:aa:bb:cc', method: 'client.notifyDevInfo', params: { deviceInfo: { DeviceType: 'IPC-HFW2431S-S-S2', SerialNo: '6J0AAAAPAG00001', Vendor: 'Dahua', MachineName: 'cam1', Version: '2.800', HttpPort: 80, Port: 37777, Init: 166, IPv4Address: { IPAddress: '192.168.1.108', SubnetMask: '255.255.255.0', DefaultGateway: '192.168.1.1', DhcpEnable: false } } } });
  const [d] = CD.parseDahua(ok);
  assert.deepEqual([d.ip, d.mac, d.vendor, d.model, d.serial, d.name], ['192.168.1.108', '3C:EF:8C:AA:BB:CC', 'Dahua', 'IPC-HFW2431S-S-S2', '6J0AAAAPAG00001', 'cam1']);
  assert.deepEqual([d.fields.httpPort, d.fields.port, d.fields.init, d.fields.dhcp], [80, 37777, 166, false]);
  // hostile variants
  assert.deepEqual(CD.parseDahua(ok.subarray(0, 40)), [], 'truncated');
  const wrongMagic = Buffer.from(ok); wrongMagic.write('XXXX', 4);
  assert.deepEqual(CD.parseDahua(wrongMagic), []);
  const hugeLen = Buffer.from(ok); hugeLen.writeUInt32LE(0x7fffffff, 16);
  assert.deepEqual(CD.parseDahua(hugeLen), [], 'declared length beyond the packet');
  assert.deepEqual(CD.parseDahua(reply({ method: 'client.notifyDevInfo', params: 'x' })).length, 1, 'odd types do not throw');
  assert.equal(CD.parseDahua(reply({ method: 'client.notifyDevInfo', params: { deviceInfo: { IPv4Address: { IPAddress: '999.1.1.1' }, SerialNo: { a: 1 } } } }))[0].ip, '');
  assert.deepEqual(CD.parseDahua(reply({ method: 'other' })), []);
  assert.deepEqual(CD.parseDahua(reply([1, 2])), []);
});

test('Hanwha: 262-byte fixed structure, reply type 0x0b', () => {
  const req = CD.hanwhaRequest();
  assert.equal(req.length, 262);
  assert.equal(req[0], 0x01);
  assert.ok(req.subarray(1).every((x) => x === 0));
  const r = Buffer.alloc(262);
  r[0] = 0x0b;
  put(r, 0x13, '00:09:18:AA:BB:CC'); put(r, 0x25, '192.168.1.100'); put(r, 0x35, '255.255.255.0'); put(r, 0x45, '192.168.1.1'); put(r, 0x6d, 'XND-6080R'); put(r, 0x85, 'http://192.168.1.100/index.htm');
  assert.deepEqual(CD.parseHanwha(r), [{ ip: '192.168.1.100', mac: '00:09:18:AA:BB:CC', vendor: 'Hanwha', model: 'XND-6080R', fields: { subnetMask: '255.255.255.0', gateway: '192.168.1.1', url: 'http://192.168.1.100/index.htm' } }]);
  assert.deepEqual(CD.parseHanwha(r.subarray(0, 0x50)), [], 'truncated');
  const wrong = Buffer.from(r); wrong[0] = 0x02;
  assert.deepEqual(CD.parseHanwha(wrong), []);
  const junk = Buffer.alloc(262, 0xff); junk[0] = 0x0b;
  assert.deepEqual(CD.parseHanwha(junk), [], 'no usable MAC or address');
});

test('Bosch: 12-byte request, binary and XML replies', () => {
  assert.equal(CD.boschRequest(0x01020304).toString('hex'), '9939a42701020304ff0006de');
  const bin = Buffer.alloc(32);
  Buffer.from('9939a427', 'hex').copy(bin, 0);
  Buffer.from('000463aabbcc', 'hex').copy(bin, 8);
  Buffer.from([192, 168, 0, 1]).copy(bin, 0x10); Buffer.from([255, 255, 255, 0]).copy(bin, 0x14);
  assert.deepEqual(CD.parseBosch(bin), [{ ip: '192.168.0.1', mac: '00:04:63:AA:BB:CC', vendor: 'Bosch', fields: { subnetMask: '255.255.255.0', gateway: '0.0.0.0' } }]);
  const xml = Buffer.from('<device><friendlyName>DINION IP 4000</friendlyName><unitIPAddress>192.168.0.2</unitIPAddress><physAddress>00-04-63-11-22-33</physAddress><serialNumber>044512345</serialNumber></device>');
  assert.deepEqual(CD.parseBosch(xml), [{ ip: '192.168.0.2', mac: '00:04:63:11:22:33', vendor: 'Bosch', model: 'DINION IP 4000', serial: '044512345', fields: {} }]);
  const wrong = Buffer.from(bin); wrong[0] = 0;
  assert.deepEqual(CD.parseBosch(wrong), []);
  assert.deepEqual(CD.parseBosch(bin.subarray(0, 20)), []);
});

test('Vivotek: 5-byte header and type / length / value items', () => {
  assert.equal(CD.vivotekRequest(9).toString('hex'), '094a5d8f1c');
  const item = (t, v) => Buffer.concat([Buffer.from([t, v.length]), v]);
  const r = Buffer.concat([Buffer.from('094a5d8f1c', 'hex'), item(1, Buffer.from('Mega-Pixel Network Camera')), Buffer.from([0x04, 0x31]), item(2, Buffer.from('0002d1aabbcc', 'hex')), item(3, Buffer.from([192, 168, 1, 20])), item(9, Buffer.from('FD8169A'))]);
  assert.deepEqual(CD.parseVivotek(r), [{ vendor: 'Vivotek', fields: {}, name: 'Mega-Pixel Network Camera', mac: '00:02:D1:AA:BB:CC', ip: '192.168.1.20', model: 'FD8169A' }]);
  const overrun = Buffer.concat([Buffer.from('094a5d8f1c', 'hex'), Buffer.from([3, 200, 1, 2])]);
  assert.deepEqual(CD.parseVivotek(overrun), [], 'an item longer than the packet is not read');
  const wrong = Buffer.from(r); wrong[2] = 0;
  assert.deepEqual(CD.parseVivotek(wrong), []);
});

test('Sony: ENQ:allinfo and the key:value reply', () => {
  assert.equal(CD.sonyRequest().toString('hex'), '02' + Buffer.from('ENQ:allinfo').toString('hex') + 'ff03');
  const lines = ['Model:SNC-VB640', 'Serial:012345', 'Mac:08-00-46-AA-BB-CC', 'Ipadr:192.168.0.100'];
  const r = Buffer.concat([Buffer.from([2]), ...lines.map((l) => Buffer.concat([Buffer.from(l), Buffer.from([0xff])])), Buffer.from([3])]);
  assert.deepEqual(CD.parseSony(r), [{ ip: '192.168.0.100', mac: '08:00:46:AA:BB:CC', vendor: 'Sony', model: 'SNC-VB640', serial: '012345', fields: {} }]);
  assert.deepEqual(CD.parseSony(r.subarray(0, r.length - 1)), [], 'no end marker');
  assert.deepEqual(CD.parseSony(r.subarray(1)), [], 'no start marker');
});

test('Arecont: identification string + 0x01, fixed reply layout', () => {
  const req = CD.arecontRequest();
  assert.equal(req.length, 22);
  assert.equal(req.subarray(0, 21).toString(), 'Arecont_Vision-AV2000');
  assert.equal(req[21], 0x01);
  const r = Buffer.alloc(69);
  put(r, 0, 'Arecont_Vision-AV2000'); r[21] = 1;
  Buffer.from('001a07aabbcc', 'hex').copy(r, 22); Buffer.from([192, 168, 1, 77]).copy(r, 28); Buffer.from('ffa1', 'hex').copy(r, 32); Buffer.from('0c1c', 'hex').copy(r, 34); r[36] = 1; put(r, 37, 'Dock 3');
  assert.deepEqual(CD.parseArecont(r), [{ ip: '192.168.1.77', mac: '00:1A:07:AA:BB:CC', vendor: 'Arecont Vision', name: 'Dock 3', fields: { firmwareHex: 'ffa1', baseModelHex: '0c1c', ipLock: 1 } }]);
  assert.deepEqual(CD.parseArecont(r.subarray(0, 30)), []);
  const wrong = Buffer.from(r); wrong[0] = 0x42;
  assert.deepEqual(CD.parseArecont(wrong), []);
});

test('Ubiquiti: v1 request, type / length / value reply', () => {
  assert.equal(CD.ubiquitiRequest().toString('hex'), '01000000');
  const item = (t, v) => Buffer.concat([Buffer.from([t]), u16(v.length), v]);
  const items = Buffer.concat([item(0x02, Buffer.from('7483c2aabbcc0a000007', 'hex')), item(0x01, Buffer.from('7483c2aabbcc', 'hex')), item(0x0b, Buffer.from('G4 Bullet')), item(0x0c, Buffer.from('UVC G4 Bullet')), item(0x03, Buffer.from('UVC.S2L.v4.23.8.67')), item(0x15, Buffer.from('UVC-G4-BULLET')), item(0x16, Buffer.from('4.23.8'))]);
  const r = Buffer.concat([Buffer.from([1, 0]), u16(items.length), items]);
  assert.deepEqual(CD.parseUbiquiti(r), [{ vendor: 'Ubiquiti', fields: { product: 'UVC G4 Bullet', firmware: 'UVC.S2L.v4.23.8.67', version: '4.23.8' }, mac: '74:83:C2:AA:BB:CC', ip: '10.0.0.7', name: 'G4 Bullet', model: 'UVC-G4-BULLET' }]);
  const badLen = Buffer.from(r); badLen.writeUInt16BE(5, 2);
  assert.deepEqual(CD.parseUbiquiti(badLen), [], 'length field must match the datagram');
  const overrun = Buffer.concat([Buffer.from([1, 0]), u16(5), Buffer.from([0x02, 0xff, 0xff, 1, 2])]);
  assert.deepEqual(CD.parseUbiquiti(overrun), []);
});

test('XiongMai DVRIP: request bytes, JSON after a 20-byte header, reversed address', () => {
  assert.equal(CD.dvripRequest().toString('hex'), 'ff00000000000000000000000000fa0500000000');
  const json = { 'NetWork.NetCommon': { HostIP: '0x6E01A8C0', HostName: 'LocalHost', MAC: '00:12:16:aa:bb:cc', SN: 'abcdef0123456789', TCPPort: 34567, HttpPort: 80, Version: 'V4.03.R11', DeviceType: 1, ChannelNum: 1 }, Ret: 100, SessionID: '0x00000000' };
  const r = Buffer.concat([Buffer.alloc(20, 1), Buffer.from(JSON.stringify(json)), Buffer.from([0x0a, 0])]);
  const [d] = CD.parseDvrip(r);
  assert.deepEqual([d.ip, d.mac, d.vendor, d.name, d.serial, d.fields.tcpPort], ['192.168.1.110', '00:12:16:AA:BB:CC', 'XiongMai', 'LocalHost', 'abcdef0123456789', 34567]);
  assert.deepEqual(CD.parseDvrip(r.subarray(0, 60)), [], 'truncated JSON');
  assert.equal(CD.parseDvrip(Buffer.concat([Buffer.alloc(20), Buffer.from('{"NetWork.NetCommon":{"HostIP":"0xZZ","MAC":7}}')]))[0].ip, '');
  assert.deepEqual(CD.parseDvrip(Buffer.concat([Buffer.alloc(20), Buffer.from('{"NetWork.NetCommon":5}')])), []);
});

test('TP-Link Kasa (9999): XOR autokey cipher, sysinfo reply', () => {
  // known vector: 171 ^ '{' (0x7b) = 0xd0, 0xd0 ^ '"' (0x22) = 0xf2
  assert.equal(CD.kasaRequest().subarray(0, 2).toString('hex'), 'd0f2');
  assert.equal(CD.kasaDecrypt(CD.kasaRequest()), '{"system":{"get_sysinfo":{}}}');
  const reply = CD.kasaEncrypt(JSON.stringify({ system: { get_sysinfo: { sw_ver: '2.3.6', hw_ver: '1.0', model: 'KC120(US)', type: 'IOT.IPCAMERA', alias: 'Front', deviceId: '8012AB', mic_mac: 'B0BE76AABBCC' } } }));
  assert.deepEqual(CD.parseKasa(reply), [{ mac: 'B0:BE:76:AA:BB:CC', vendor: 'TP-Link', model: 'KC120(US)', name: 'Front', serial: '8012AB', fields: { type: 'IOT.IPCAMERA', hwVersion: '1.0', swVersion: '2.3.6' } }]);
  assert.deepEqual(CD.parseKasa(reply.subarray(0, 20)), []);
  assert.deepEqual(CD.parseKasa(CD.kasaEncrypt('{"system":{"get_sysinfo":"x"}}')), []);
});

test('TP-Link Tapo (20002): fixed query, JSON after a 16-byte header', () => {
  assert.equal(CD.tapoRequest().toString('hex'), '020000010000000000000000463cb5d3');
  const r = Buffer.concat([Buffer.alloc(16, 2), Buffer.from(JSON.stringify({ result: { device_id: 'abc123', owner: 'x', device_type: 'SMART.IPCAMERA', device_model: 'C320WS', ip: '172.21.20.120', mac: '5C-62-8B-00-00-01', factory_default: false, mgt_encrypt_schm: { is_support_https: true, encrypt_type: 'AES' } }, error_code: 0 }))]);
  assert.deepEqual(CD.parseTapo(r), [{ ip: '172.21.20.120', mac: '5C:62:8B:00:00:01', vendor: 'TP-Link', model: 'C320WS', name: '', serial: 'abc123', fields: { deviceType: 'SMART.IPCAMERA', owner: true, factoryDefault: false, encrypt: 'AES' } }]);
  assert.deepEqual(CD.parseTapo(r.subarray(0, 40)), []);
  assert.deepEqual(CD.parseTapo(Buffer.concat([Buffer.alloc(16), Buffer.from('{"result":[1]}')])).length, 1);
  assert.deepEqual(CD.parseTapo(Buffer.concat([Buffer.alloc(16), Buffer.from('{"error_code":-1}')])), []);
});

test('Reolink: request bytes; only datagrams on the reply port count, layout is not interpreted', () => {
  assert.equal(CD.reolinkRequest().toString('hex'), 'aaaa0000');
  const r = Buffer.concat([Buffer.from([0xaa, 0xaa, 0, 0, 1, 2, 3]), Buffer.from('RLC-810A\0\0\0'), Buffer.from('95270000ABCDEFGH\0')]);
  assert.deepEqual(CD.parseReolink(r, { localPort: 3000 }), [{ fields: { vendorHint: 'Reolink', strings: ['RLC-810A', '95270000ABCDEFGH'] } }]);
  assert.deepEqual(CD.parseReolink(r, { localPort: 2000 }), [], 'not the reply port');
  assert.deepEqual(CD.parseReolink(Buffer.from('aaaa0000', 'hex'), { localPort: 3000 }), []);
});

test('PPPP: LAN search and punch packet', () => {
  assert.equal(CD.ppppRequest().toString('hex'), 'f1300000');
  const r = Buffer.concat([Buffer.from('f1410014', 'hex'), Buffer.from('BATD\0\0\0\0'), u32(609531), Buffer.from('EXLVS\0\0\0')]);
  assert.deepEqual(CD.parsePppp(r), [{ serial: 'BATD-609531-EXLVS', cloudType: 'p2p-pppp', fields: { uid: 'BATD-609531-EXLVS' } }]);
  assert.deepEqual(CD.parsePppp(r.subarray(0, 20)), []);
  const wrongType = Buffer.from(r); wrongType[1] = 0x30;
  assert.deepEqual(CD.parsePppp(wrongType), []);
  const badLen = Buffer.from(r); badLen.writeUInt16BE(0x4000, 2);
  assert.deepEqual(CD.parsePppp(badLen), []);
  const binaryPrefix = Buffer.from(r); binaryPrefix.fill(0xfe, 4, 12);
  assert.deepEqual(CD.parsePppp(binaryPrefix), [], 'an obfuscated variant is not misread');
});

test('VStarcam: 4-byte request, 256-byte reply', () => {
  assert.equal(CD.vstarcamRequest().toString('hex'), '44480101');
  const r = Buffer.alloc(0x210);
  r.writeUInt32BE(0x44480108, 0);
  put(r, 4, '192.168.1.126'); put(r, 0x14, '255.255.255.0'); put(r, 0x24, '192.168.1.1');
  Buffer.from('48022aaabbcc', 'hex').copy(r, 0x54); put(r, 0x5c, 'VSTC123456ABCDE'); put(r, 0x7c, 'IPCAM'); put(r, 0xcc, '48.53.75.92');
  assert.deepEqual(CD.parseVstarcam(r), [{ ip: '192.168.1.126', mac: '48:02:2A:AA:BB:CC', vendor: 'VStarcam', serial: 'VSTC123456ABCDE', name: 'IPCAM', fields: { subnetMask: '255.255.255.0', gateway: '192.168.1.1', firmware: '48.53.75.92' }, cloudType: 'p2p-vstarcam' }]);
  assert.deepEqual(CD.parseVstarcam(r.subarray(0, 0xff)), []);
  const wrong = Buffer.from(r); wrong[3] = 0x01;
  assert.deepEqual(CD.parseVstarcam(wrong), []);
});

test('GigE Vision: DISCOVERY_CMD and DISCOVERY_ACK', () => {
  assert.equal(CD.gvcpRequest(0x1234).toString('hex'), '4211000200001234');
  assert.equal(CD.gvcpRequest(0).readUInt16BE(6), 1, 'request id is never 0');
  const r = Buffer.alloc(256);
  r.writeUInt16BE(0, 0); r.writeUInt16BE(3, 2); r.writeUInt16BE(248, 4); r.writeUInt16BE(0x1234, 6);
  Buffer.from('000f31aabbcc', 'hex').copy(r, 0x12); Buffer.from([169, 254, 10, 20]).copy(r, 0x2c);
  put(r, 0x50, 'FLIR'); put(r, 0x70, 'A700'); put(r, 0x90, '1.2.3'); put(r, 0xe0, '89900123'); put(r, 0xf0, 'dock');
  assert.deepEqual(CD.parseGvcp(r), [{ ip: '169.254.10.20', mac: '00:0F:31:AA:BB:CC', vendor: 'FLIR', model: 'A700', serial: '89900123', name: 'dock', fields: { deviceVersion: '1.2.3', gigeVision: true } }]);
  assert.deepEqual(CD.parseGvcp(r.subarray(0, 200)), []);
  const nack = Buffer.from(r); nack.writeUInt16BE(0x8001, 0);
  assert.deepEqual(CD.parseGvcp(nack), []);
  const badLen = Buffer.from(r); badLen.writeUInt16BE(9, 4);
  assert.deepEqual(CD.parseGvcp(badLen), []);
});

test('passive: Tuya beacon is flagged as cloud type and not decoded; DHCP request fingerprint', () => {
  const tuya = Buffer.concat([Buffer.from('000055aa', 'hex'), Buffer.alloc(40, 9), Buffer.from('0000aa55', 'hex')]);
  assert.deepEqual(CD.parseTuya(tuya, { localPort: 6667 }), [{ cloudType: 'tuya', fields: { port: 6667, frame: '55aa' } }]);
  assert.deepEqual(CD.parseTuya(Buffer.alloc(48, 1), { localPort: 6667 }), [], 'wrong prefix');
  assert.deepEqual(CD.parseTuya(tuya.subarray(0, 10), { localPort: 6666 }), []);

  const dhcp = Buffer.alloc(240);
  dhcp[0] = 1; dhcp[1] = 1; dhcp[2] = 6;
  Buffer.from('c8de11223344', 'hex').copy(dhcp, 28);
  dhcp.writeUInt32BE(0x63825363, 236);
  const opt = (c, v) => Buffer.concat([Buffer.from([c, v.length]), v]);
  const full = Buffer.concat([dhcp, opt(53, Buffer.from([3])), opt(12, Buffer.from('DS-2CD2143G2-I')), opt(60, Buffer.from('udhcp 1.19.3')), opt(55, Buffer.from([1, 3, 6, 15])), opt(50, Buffer.from([172, 21, 20, 101])), Buffer.from([255])]);
  assert.deepEqual(CD.parseDhcp(full), [{ mac: 'C8:DE:11:22:33:44', ip: '172.21.20.101', fields: { messageType: 3, hostname: 'DS-2CD2143G2-I', vendorClass: 'udhcp 1.19.3', params: [1, 3, 6, 15] }, name: 'DS-2CD2143G2-I' }]);
  const reply = Buffer.from(full); reply[0] = 2;
  assert.deepEqual(CD.parseDhcp(reply), [], 'server replies are ignored');
  const noCookie = Buffer.from(full); noCookie[236] = 0;
  assert.deepEqual(CD.parseDhcp(noCookie), []);
  const overrun = Buffer.concat([dhcp, Buffer.from([12, 200, 0x41])]);
  assert.deepEqual(CD.parseDhcp(overrun), [{ mac: 'C8:DE:11:22:33:44', ip: '', fields: {} }], 'an option longer than the packet is not read');
});

test('layer 2 helpers: arping output, EUI-64, IPv6 neighbours', () => {
  assert.equal(CD.parseArping('ARPING 192.168.1.64 from 172.21.20.250 enp1s0\nUnicast reply from 192.168.1.64 [C8:DE:11:22:33:44]  0.691ms\nSent 1 probes (1 broadcast(s))\nReceived 1 response(s)\n'), 'C8:DE:11:22:33:44');
  assert.equal(CD.parseArping('ARPING 192.168.1.64\n60 bytes from c8:de:11:22:33:44 (192.168.1.64): index=0 time=1.2 msec\n'), 'C8:DE:11:22:33:44');
  assert.equal(CD.parseArping('ARPING 192.168.1.64 from 172.21.20.250 enp1s0\nSent 1 probes (1 broadcast(s))\nReceived 0 response(s)\n'), '');
  assert.equal(CD.parseArping(null), '');
  assert.equal(CD.macFromEui64('fe80::cade:11ff:fe22:3344'), 'C8:DE:11:22:33:44');
  assert.equal(CD.macFromEui64('fe80::cade:11ff:fe22:3344%enp1s0'), 'C8:DE:11:22:33:44');
  assert.equal(CD.macFromEui64('fe80::1234:5678:9abc:def0'), '', 'a privacy address carries no MAC');
  assert.equal(CD.macFromEui64('2001:db8::cade:11ff:fe22:3344'), '', 'link-local only');
  assert.equal(CD.macFromEui64('fe80:::1'), '');
  const neigh = 'fe80::cade:11ff:fe22:3344 lladdr c8:de:11:22:33:44 REACHABLE\nfe80::1 lladdr 00:11:22:33:44:55 router STALE\nfe80::dead FAILED\nfe80::2 lladdr 00:00:00:00:00:00 INCOMPLETE\n2001:db8::5 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n';
  const ping = '64 bytes from fe80::5e62:8bff:fe00:1%enp1s0: icmp_seq=1 ttl=64 time=0.4 ms\n64 bytes from fe80::cade:11ff:fe22:3344%enp1s0: icmp_seq=1 ttl=64 time=0.9 ms (DUP!)\n';
  assert.deepEqual(CD.parseIp6Neighbours(neigh, ping), [
    { ipv6: 'fe80::cade:11ff:fe22:3344', mac: 'C8:DE:11:22:33:44' },
    { ipv6: 'fe80::1', mac: '00:11:22:33:44:55' },
    { ipv6: 'fe80::5e62:8bff:fe00:1', mac: '5C:62:8B:00:00:01' },
  ]);
});

test('banners: HTTP and RTSP signals', () => {
  assert.deepEqual(CD.httpSignal(80, { status: 401, headers: { server: 'webserver', 'www-authenticate': 'Digest realm="IP Camera(C1234)", nonce="x"' }, body: '<html><head><title> Login \n page</title></head></html>' }),
    { port: 80, status: 401, server: 'webserver', auth: 'Digest', realm: 'IP Camera(C1234)', title: 'Login page' });
  assert.deepEqual(CD.httpSignal(443, { status: 200, headers: { 'axis-setup': '' }, body: '', cert: { cn: 'axis-accc8e123456', o: 'Axis Communications AB' } }), { port: 443, status: 200, axisSetup: true, tls: { cn: 'axis-accc8e123456', o: 'Axis Communications AB' } });
  assert.deepEqual(CD.httpSignal(80, {}), { port: 80, status: 0 });
  assert.deepEqual(CD.rtspSignal(554, 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: Dahua Rtsp Server\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n'), { port: 554, status: 200, server: 'Dahua Rtsp Server', public: 'OPTIONS, DESCRIBE' });
  assert.equal(CD.rtspSignal(554, 'HTTP/1.1 400 Bad Request\r\n\r\n'), null);
  assert.match(CD.onvifDateRequest(), /GetSystemDateAndTime/);
});

// ---- options and planning -------------------------------------------------------------------------------
test('request options: defaults, validation, limits', () => {
  assert.deepEqual(CD.validateOptions({}), { seconds: 3, exclude: [], extraCidrs: [], factoryIps: null, channels: ['A', 'B', 'C', 'D'], ports: null });
  assert.deepEqual(CD.validateOptions(null).seconds, 3);
  const v = CD.validateOptions({ seconds: '5', exclude: ['10.50.0.0/24', 'nope'], extraCidrs: ['10.9.0.0/24'], factoryIps: ['192.168.1.64', '192.168.1.64'], channels: ['a', 'D'], ports: [554, '80'] });
  assert.deepEqual(v, { seconds: 5, exclude: ['10.50.0.0/24'], extraCidrs: ['10.9.0.0/24'], factoryIps: ['192.168.1.64'], channels: ['A', 'D'], ports: [554, 80] });
  const rejects = [
    { seconds: 0 }, { seconds: 11 }, { seconds: 'x' },
    { extraCidrs: 'x' }, { extraCidrs: ['10.0.0.0'] }, { extraCidrs: Array(9).fill('10.0.0.0/24') },
    { factoryIps: ['127.0.0.1'] }, { factoryIps: ['224.0.0.1'] }, { factoryIps: ['0.0.0.0'] }, { factoryIps: ['a'] }, { factoryIps: Array(65).fill('192.168.1.64') },
    { channels: ['E'] }, { channels: 'A' },
    { ports: [0] }, { ports: [70000] }, { ports: [1.5] }, { ports: Array(33).fill(80) },
  ];
  for (const body of rejects) assert.throws(() => CD.validateOptions(body), (e) => e instanceof CD.DiscoveryError && e.code === 'E_PARAM', JSON.stringify(body));
});

test('sweep plan: same limits as the L2 scan, excluded networks never planned', () => {
  const ifaces = [{ iface: 'enp1s0', ip: '172.21.20.250', cidr: '172.21.20.250/23' }, { iface: 'enp2s0', ip: '10.0.0.2', cidr: '10.0.0.2/16' }];
  const p = CD.planSweep({ ifaces, extraCidrs: ['10.9.0.0/24', '192.168.234.0/25', '172.21.21.0/24', '10.200.0.0/16', '10.9.1.0/24'], excluded: ['192.168.234.0/24'] });
  assert.deepEqual(p.onLink, [{ cidr: '172.21.20.0/23', net: CD.ipToInt('172.21.20.0'), size: 512, iface: 'enp1s0' }]);
  assert.deepEqual(p.routed.map((t) => t.cidr), ['10.9.0.0/24', '10.9.1.0/24']);
  assert.deepEqual(p.skipped, [{ cidr: '10.0.0.0/16', reason: 'too-large' }, { cidr: '192.168.234.0/25', reason: 'excluded' }, { cidr: '172.21.21.0/24', reason: 'on-link' }, { cidr: '10.200.0.0/16', reason: 'too-large' }]);
  // total address cap
  const big = CD.planSweep({ ifaces: [], extraCidrs: ['10.1.0.0/22', '10.2.0.0/22', '10.3.0.0/22'] });
  assert.deepEqual(big.routed.map((t) => t.cidr), ['10.1.0.0/22', '10.2.0.0/22']);
  assert.deepEqual(big.skipped, [{ cidr: '10.3.0.0/22', reason: 'request-too-large' }]);
});

// ---- merge ----------------------------------------------------------------------------------------------
test('merge: MAC, then UUID, then IP; legacy sources stay in devices, the rest are candidates; bounded raw', () => {
  const wsd = (ip, mac, uuid) => ({ probe: 'onvif', channel: 'A', ip, legacy: { proto: 'wsd', parsed: { uuid, xaddrs: [`http://${ip}/onvif/device_service`], ip, name: 'n', hardware: 'HW', manufacturer: '', mac, location: '', types: [], onvifType: [], profiles: [] } }, raw: { encoding: 'utf8', data: '<x/>', truncated: false } });
  const sadp = (ip, mac) => ({ probe: 'sadp', channel: 'A', ip, legacy: { proto: 'sadp', parsed: { ip, mac, model: 'DS-1', serial: 'S1', httpPort: 80, commandPort: 8000, activated: true, dhcp: false, softwareVersion: 'V5' } } });
  const obs = [
    wsd('10.0.0.5', '', 'uuid-5'),
    sadp('10.0.0.5', 'C8:DE:11:00:00:05'),
    // same device again through mDNS (by MAC, different address reported), an open-port sweep (by IP) and DHCP (MAC only)
    { probe: 'mdns', channel: 'A', ip: '10.0.0.55', mac: 'C8:DE:11:00:00:05', fields: { services: ['_rtsp._tcp.local'], instances: [], txt: {}, addresses: [] }, raw: { encoding: 'base64', data: 'AAA=', truncated: false } },
    { probe: 'tcp-ports', channel: 'B', ip: '10.0.0.5', mac: '', signal: { ports: [80, 554] } },
    { probe: 'dhcp-fingerprint', channel: 'C', ip: '', mac: 'C8:DE:11:00:00:05', fields: { hostname: 'cam5' } },
    // a UUID match: WS-Discovery Hello with the same endpoint from a new address
    { probe: 'wsd-hello', channel: 'C', ip: '10.0.0.77', uuid: 'uuid-5', fields: { types: [] } },
    // a Dahua camera nobody else saw -> candidate
    { probe: 'dahua-dhdiscover', channel: 'A', ip: '10.0.0.108', mac: '3C:EF:8C:00:01:08', vendor: 'Dahua', model: 'IPC-1', serial: 'SN', fields: { httpPort: 80 } },
    { probe: 'arp-sweep', channel: 'B', ip: '10.0.0.108', mac: '3C:EF:8C:00:01:08', signal: { iface: 'enp1s0' } },
    // MAC-only sightings: one stays unaddressed, the excluded network is dropped
    { probe: 'ipv6-all-nodes', channel: 'D', mac: 'AA:BB:CC:00:00:01', signal: { ipv6: ['fe80::1'] }, fields: { iface: 'enp1s0' } },
    { probe: 'tuya-beacon', channel: 'C', ip: '192.168.234.9', cloudType: 'tuya', fields: {} },
    { probe: 'tuya-beacon', channel: 'C', ip: '10.0.0.200', cloudType: 'tuya', fields: { port: 6667 } },
  ];
  const r = CD.mergeObservations(obs, { excluded: ['192.168.234.0/24'], arp: [{ ip: '10.0.0.200', mac: 'D4:A6:51:00:02:00' }] });
  assert.equal(r.devices.length, 1);
  const d = r.devices[0];
  assert.deepEqual([d.ip, d.mac, d.vendor, d.model, d.serial], ['10.0.0.5', 'C8:DE:11:00:00:05', 'Hikvision', 'DS-1', 'S1']);
  assert.deepEqual(d.sources, ['sadp', 'onvif', 'mdns', 'tcp-ports', 'wsd-hello', 'dhcp-fingerprint']);
  assert.deepEqual(d.channels, ['A', 'B', 'C']);
  assert.deepEqual(d.signals.ports, [80, 554]);
  assert.deepEqual(d.signals.mdns.services, ['_rtsp._tcp.local']);
  assert.equal(d.signals.probes['dhcp-fingerprint'].hostname, 'cam5');
  assert.equal(d.signals.oui, 'C8DE11');
  assert.deepEqual(d.raw.map((x) => x.probe), ['onvif', 'mdns']);
  assert.deepEqual(d.onvif, { uuid: 'uuid-5', xaddrs: ['http://10.0.0.5/onvif/device_service'] });
  assert.equal(d.sadp.activated, true);
  assert.deepEqual(r.candidates.map((c) => [c.ip, c.mac, c.sources.join('+'), c.cloudType || '']), [['10.0.0.108', '3C:EF:8C:00:01:08', 'dahua-dhdiscover+arp-sweep', ''], ['10.0.0.200', 'D4:A6:51:00:02:00', 'tuya-beacon', 'tuya']]);
  assert.equal(r.candidates[1].macFrom, 'arp');
  assert.deepEqual(r.candidates[0].onvif, null);
  assert.deepEqual(r.unaddressed, [{ mac: 'AA:BB:CC:00:00:01', sources: ['ipv6-all-nodes'], channels: ['D'], signals: { oui: 'AABBCC', ipv6: ['fe80::1'] } }]);
  // raw replies per device are capped
  const many = Array.from({ length: 30 }, (_, i) => ({ probe: 'ssdp', channel: 'A', ip: '10.0.0.9', fields: { st: 'st' + i, usn: 'u' + i }, raw: { encoding: 'utf8', data: 'r' + i, truncated: false } }));
  const m = CD.mergeObservations(many).candidates[0];
  assert.equal(m.raw.length, CD.LIMITS.rawPerDevice);
  assert.equal(m.signals.ssdp.st.length, 16);
});

// ---- engine with a fake network -------------------------------------------------------------------------
function fakeNetwork({ onSend = () => [], failBind = () => false } = {}) {
  const sockets = [];
  const deliver = (sock, data, from) => setImmediate(() => !sock.closed && sock.emit('message', data, from));
  const createSocket = (opts) => {
    const s = new EventEmitter();
    Object.assign(s, {
      opts, bound: null, sent: [], members: [], closed: false, broadcast: false, mcastIf: '',
      bind(port, address, cb) {
        if (typeof address === 'function') { cb = address; address = undefined; }
        if (failBind(port, address)) return void setImmediate(() => s.emit('error', new Error(`bind EADDRINUSE 0.0.0.0:${port}`)));
        s.bound = { port, address };
        setImmediate(cb);
      },
      send(buf, port, address, cb) {
        if (s.closed) throw new Error('closed');
        s.sent.push({ buf: Buffer.from(buf), port, address, via: s.mcastIf || s.bound?.address || '' });
        for (const r of onSend({ sock: s, buf, port, address }) || []) {
          if (r.toPort) sockets.filter((x) => x.bound?.port === r.toPort && !x.closed).forEach((x) => deliver(x, r.data, r.from));
          else deliver(s, r.data, r.from);
        }
        cb?.();
      },
      setBroadcast(v) { s.broadcast = v; },
      setMulticastInterface(ip) { s.mcastIf = ip; },
      setMulticastTTL() {},
      addMembership(group, ip) { s.members.push(group + '@' + ip); },
      close() { s.closed = true; },
    });
    sockets.push(s);
    return s;
  };
  return { sockets, createSocket, inject: (port, data, from) => sockets.filter((x) => x.bound?.port === port && !x.closed).forEach((x) => deliver(x, data, from)) };
}
const tick = () => new Promise((r) => setImmediate(r));
const fastSleep = async () => { await tick(); await tick(); };
const IFS = () => ({
  enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/24' }],
  wlan0: [{ family: 'IPv4', address: '192.168.234.1', cidr: '192.168.234.1/24' }],
  docker0: [{ family: 'IPv4', address: '172.17.0.1', cidr: '172.17.0.1/16' }],
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
});
const dahuaReply = (ip, mac) => {
  const b = Buffer.from(JSON.stringify({ mac, method: 'client.notifyDevInfo', params: { deviceInfo: { DeviceType: 'IPC-X', SerialNo: 'SN-' + ip, Vendor: 'Dahua', IPv4Address: { IPAddress: ip } } } }));
  const h = Buffer.alloc(32);
  h.writeUInt32LE(0x20, 0); h.write('DHIP', 4); h.writeUInt32LE(b.length, 16); h.writeUInt32LE(b.length, 24);
  return Buffer.concat([h, b]);
};

test('engine, channel A: every implemented probe is sent on the wired interface only; replies are parsed, bounded and filtered', async () => {
  const fetched = [];
  const net = fakeNetwork({
    onSend: ({ buf, port }) => {
      if (port === 37810) return [
        { data: dahuaReply('172.21.20.108', '3c:ef:8c:00:01:08'), from: { address: '172.21.20.108', port: 37810 } },
        { data: dahuaReply('192.168.234.50', '3c:ef:8c:00:02:50'), from: { address: '192.168.234.50', port: 37810 } }, // maintenance hotspot: dropped
        { data: dahuaReply('172.21.20.66', '3c:ef:8c:00:00:66'), from: { address: '172.21.20.250', port: 37810 } }, // from ourselves: dropped
        { data: Buffer.alloc(CD.LIMITS.maxReply + 1, 0x20), from: { address: '172.21.20.109', port: 37810 } }, // oversized: dropped unparsed
      ];
      if (port === 7701) return [{ toPort: 7711, data: (() => { const r = Buffer.alloc(262); r[0] = 0x0b; put(r, 0x13, '00:09:18:AA:BB:CC'); put(r, 0x25, '172.21.20.100'); put(r, 0x6d, 'XND-6080R'); return r; })(), from: { address: '172.21.20.100', port: 7701 } }];
      if (port === 1900 && /M-SEARCH/.test(buf.toString())) return [
        { data: Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://172.21.20.90:49152/desc.xml\r\nSERVER: Linux UPnP/1.0\r\nST: upnp:rootdevice\r\nUSN: uuid:a::upnp:rootdevice\r\n\r\n'), from: { address: '172.21.20.90', port: 1900 } },
        // LOCATION pointing at another host is never fetched
        { data: Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://10.99.99.99/secret.xml\r\nSERVER: evil\r\nST: upnp:rootdevice\r\nUSN: uuid:b::upnp:rootdevice\r\n\r\n'), from: { address: '172.21.20.91', port: 1900 } },
      ];
      if (port === 5353) {
        const q = CD.dnsDecode(buf);
        const meta = CD.dnsEncodeName('_services._dns-sd._udp.local');
        if (q.questions.some((x) => x.name === '_services._dns-sd._udp.local')) return [{ data: Buffer.concat([dnsHead(1), rr(meta, 12, CD.dnsEncodeName('_vendorcam._tcp.local'))]), from: { address: '172.21.20.77', port: 5353 } }];
        if (q.questions[0].name === '_vendorcam._tcp.local') {
          const inst = CD.dnsEncodeName('Cam 77._vendorcam._tcp.local');
          return [{ data: Buffer.concat([dnsHead(2), rr(CD.dnsEncodeName('_vendorcam._tcp.local'), 12, inst), rr(inst, 33, Buffer.concat([u16(0), u16(0), u16(8554), CD.dnsEncodeName('cam77.local')]))]), from: { address: '172.21.20.77', port: 5353 } }];
        }
      }
      return [];
    },
  });
  const cd = CD.createCameraDiscovery({
    netIfs: IFS, sleep: fastSleep, uuid: () => 'u-fixed', readArp: async () => 'IP address HW type Flags HW address Mask Device\n172.21.20.90 0x1 0x2 ac:cc:8e:12:34:56 * enp1s0\n',
    io: { createSocket: net.createSocket, httpGet: async (url) => { fetched.push(url); return { status: 200, headers: {}, body: '<root><device><friendlyName>AXIS P3245</friendlyName><manufacturer>AXIS</manufacturer><modelName>P3245-LVE</modelName><serialNumber>ACCC8E123456</serialNumber></device></root>' }; } },
    log: () => {},
  });
  const r = await cd.discover({ seconds: 1, channels: ['A'] });
  // nothing was ever sent through the hotspot / virtual interfaces, and every datagram left through enp1s0
  const sent = net.sockets.flatMap((s) => s.sent);
  assert.ok(sent.length > 30);
  assert.ok(sent.every((x) => x.via === '172.21.20.250' || x.address === '172.21.20.255'), 'only the wired interface: its address, or its directed broadcast');
  assert.ok(!sent.some((x) => /^192\.168\.234\./.test(x.address) || /^172\.17\./.test(x.address)));
  assert.ok(net.sockets.every((s) => s.closed), 'every socket is closed at the end');
  assert.ok(net.sockets.every((s) => s.members.every((m) => m.endsWith('@172.21.20.250'))));
  const ports = new Set(sent.map((x) => x.port));
  for (const p of [3702, 37020, 5353, 1900, 3956, 37810, 7701, 1757, 10000, 2380, 69, 10001, 34569, 9999, 20002, 2000, 32108, 8600]) assert.ok(ports.has(p), `port ${p} probed`);
  assert.equal(sent.filter((x) => x.port === 3702 && x.address === '239.255.255.250').length, 6, 'three WS-Discovery probes, sent twice');
  // placeholders are never sent
  assert.ok(![3600, 2007, 10669, 5050, 20015, 21112, 3705].some((p) => ports.has(p)));

  assert.deepEqual(r.devices, [], 'nothing answered ONVIF / SADP');
  const byIp = Object.fromEntries(r.candidates.map((c) => [c.ip, c]));
  assert.deepEqual(Object.keys(byIp).sort(), ['172.21.20.100', '172.21.20.108', '172.21.20.77', '172.21.20.90', '172.21.20.91']);
  assert.deepEqual([byIp['172.21.20.108'].vendor, byIp['172.21.20.108'].mac, byIp['172.21.20.108'].sources], ['Dahua', '3C:EF:8C:00:01:08', ['dahua-dhdiscover']]);
  assert.equal(byIp['172.21.20.108'].raw[0].encoding, 'base64');
  assert.deepEqual(CD.parseDahua(Buffer.from(byIp['172.21.20.108'].raw[0].data, 'base64'))[0].serial, 'SN-172.21.20.108', 'the raw reply is kept as received');
  assert.deepEqual([byIp['172.21.20.100'].vendor, byIp['172.21.20.100'].model], ['Hanwha', 'XND-6080R']);
  // SSDP: description fetched from the replying host only; MAC filled from the ARP table
  assert.deepEqual(fetched, ['http://172.21.20.90:49152/desc.xml']);
  assert.deepEqual([byIp['172.21.20.90'].vendor, byIp['172.21.20.90'].model, byIp['172.21.20.90'].mac, byIp['172.21.20.90'].macFrom], ['AXIS', 'P3245-LVE', 'AC:CC:8E:12:34:56', 'arp']);
  assert.equal(byIp['172.21.20.90'].signals.ssdp.description.serialNumber, 'ACCC8E123456');
  assert.equal(byIp['172.21.20.90'].raw[0].encoding, 'utf8');
  assert.equal(byIp['172.21.20.91'].signals.ssdp.description, undefined);
  // mDNS: the new service type was followed up
  assert.deepEqual(byIp['172.21.20.77'].signals.mdns.instances, [{ type: '_vendorcam._tcp.local', name: 'Cam 77', port: 8554, host: 'cam77.local' }]);
  // summary
  const sum = Object.fromEntries(r.probes.map((p) => [p.id, p]));
  assert.equal(sum['dahua-dhdiscover'].replies, 2, 'one device reply per send round; hotspot, own and oversized replies are not counted');
  assert.ok(sum['dahua-dhdiscover'].sent >= 2);
  assert.equal(sum.panasonic.implemented, false);
  assert.equal(sum.panasonic.sent, 0);
  assert.equal(sum['tcp-ports'].skipped, 'channel not requested');
  assert.equal(r.dropped, 2, 'oversized replies are counted, not parsed');
  assert.deepEqual(r.channels, ['A']);
  assert.ok(r.discoveredAt && r.durationMs >= 0);
  assert.deepEqual(r.interfaces, [{ iface: 'enp1s0', ip: '172.21.20.250', cidr: '172.21.20.250/24' }]);
});

test('engine: a throwing parser, a failing bind and a reply flood never break the run', async () => {
  const flood = Array.from({ length: 400 }, (_, i) => ({ data: Buffer.from('ok'), from: { address: `172.21.20.${(i % 200) + 1}`, port: 9 } }));
  const net = fakeNetwork({ onSend: ({ port }) => (port === 7001 ? [{ data: Buffer.from('boom'), from: { address: '172.21.20.9', port: 7001 } }] : port === 7002 ? flood : []), failBind: (port) => port === 7003 });
  const entry = (id, port, parseReply, extra = {}) => ({ id, channel: 'A', kind: 'broadcast', targets: [{ address: '255.255.255.255', port }], vendorHint: '', unicastCapable: false, implemented: true, evidence: { level: 'candidate', source: 'test' }, buildRequest: () => Buffer.from('q'), parseReply, ...extra });
  const cd = CD.createCameraDiscovery({
    netIfs: IFS, sleep: fastSleep, log: () => {}, io: { createSocket: net.createSocket },
    probes: [
      entry('thrower', 7001, () => { throw new Error('parser bug'); }),
      entry('flooded', 7002, () => [{ fields: { ok: true } }]),
      entry('bound', 7004, () => [], { bindPort: 7003 }),
      entry('builder-throws', 7005, () => [], { buildRequest: () => { throw new Error('no request'); } }),
    ],
  });
  const r = await cd.discover({ seconds: 1, channels: ['A'] });
  const sum = Object.fromEntries(r.probes.map((p) => [p.id, p]));
  assert.equal(r.parseErrors, 4, 'two sockets, two send rounds: every reply reached the throwing parser and was counted');
  assert.equal(sum.flooded.replies, CD.LIMITS.maxRepliesPerProbe, 'replies per probe are capped');
  assert.ok(r.dropped >= 200);
  assert.match(sum.bound.error, /EADDRINUSE/);
  assert.match(sum['builder-throws'].error, /no request/);
  assert.ok(r.candidates.length <= 200);
  assert.ok(net.sockets.every((s) => s.closed));
});

test('engine, channel C: passive listeners collect announcements; DHCP is skipped while the hotspot network is up', async () => {
  const net = fakeNetwork();
  const dhcp = Buffer.alloc(240);
  dhcp[0] = 1; dhcp[1] = 1; dhcp[2] = 6; Buffer.from('c8de11223344', 'hex').copy(dhcp, 28); dhcp.writeUInt32BE(0x63825363, 236);
  const dhcpReq = Buffer.concat([dhcp, Buffer.from([12, 4]), Buffer.from('cam1'), Buffer.from([255])]);
  const hello = '<s:Envelope><s:Body><d:Hello><a:EndpointReference><a:Address>urn:uuid:aaaa-1</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/hardware/IPC-9</d:Scopes><d:XAddrs>http://172.21.20.44/onvif/device_service</d:XAddrs></d:Hello></s:Body></s:Envelope>';
  const run = async (ifs) => {
    const cd = CD.createCameraDiscovery({
      netIfs: ifs, log: () => {}, io: { createSocket: net.createSocket },
      sleep: async () => {
        net.inject(6667, Buffer.concat([Buffer.from('000055aa', 'hex'), Buffer.alloc(40, 7)]), { address: '172.21.20.61', port: 49154 });
        net.inject(3702, Buffer.from(hello), { address: '172.21.20.44', port: 3702 });
        net.inject(1900, Buffer.from('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\nUSN: uuid:n1\r\nSERVER: cam\r\n\r\n'), { address: '172.21.20.45', port: 1900 });
        net.inject(67, dhcpReq, { address: '0.0.0.0', port: 68 });
        await fastSleep();
      },
    });
    return cd.discover({ seconds: 1, channels: ['C'] });
  };
  const wired = () => ({ enp1s0: IFS().enp1s0 });
  const r = await run(wired);
  assert.equal(net.sockets.flatMap((s) => s.sent).length, 0, 'passive: nothing is ever sent');
  const dhcpSock = net.sockets.find((s) => s.bound?.port === 67);
  assert.equal(dhcpSock.bound.address, '255.255.255.255', 'bound to the broadcast address only: unicast DHCP of the host is not taken');
  // listeners on ports a host service may own are bound to the group address: unicast traffic of that service is never taken
  for (const [port, group] of [[5353, '224.0.0.251'], [1900, '239.255.255.250'], [3702, '239.255.255.250']]) assert.equal(net.sockets.find((s) => s.bound?.port === port).bound.address, group);
  assert.deepEqual(r.candidates.map((c) => [c.ip, c.sources.join('+'), c.cloudType || '']), [['172.21.20.44', 'wsd-hello', ''], ['172.21.20.45', 'ssdp-notify', ''], ['172.21.20.61', 'tuya-beacon', 'tuya']]);
  assert.deepEqual(r.candidates.map((c) => c.channels), [['C'], ['C'], ['C']]);
  assert.deepEqual(r.unaddressed.map((u) => [u.mac, u.sources.join('+'), u.signals.probes['dhcp-fingerprint'].hostname]), [['C8:DE:11:22:33:44', 'dhcp-fingerprint', 'cam1']]);
  // with the maintenance hotspot active, DHCP listening is off (its clients cannot be told apart)
  const before = net.sockets.length;
  const r2 = await run(IFS);
  assert.ok(!net.sockets.slice(before).some((s) => s.bound?.port === 67));
  assert.equal(r2.probes.find((p) => p.id === 'dhcp-fingerprint').skipped, 'excluded network active on this host');
  assert.deepEqual(r2.unaddressed, []);
});

test('engine, channel B: ARP sweep, port probe, unauthenticated banners, routed networks, unicast re-send', async () => {
  const net = fakeNetwork({
    onSend: ({ port, address }) => (port === 37810 && address === '10.9.0.20' ? [{ data: dahuaReply('10.9.0.20', '3c:ef:8c:09:00:20'), from: { address: '10.9.0.20', port: 37810 } }] : []),
  });
  const openPorts = { '172.21.20.101': [80, 554, 8000], '172.21.20.30': [443], '10.9.0.20': [80, 37777], '192.168.234.5': [80] };
  const probes = [];
  const http = [];
  const cd = CD.createCameraDiscovery({
    netIfs: IFS, sleep: fastSleep, log: () => {},
    readArp: async () => 'IP address HW type Flags HW address Mask Device\n172.21.20.101 0x1 0x2 c8:de:11:22:33:44 * enp1s0\n172.21.20.30 0x1 0x2 ac:cc:8e:00:00:30 * enp1s0\n172.21.20.31 0x1 0x0 00:00:00:00:00:00 * enp1s0\n192.168.234.5 0x1 0x2 aa:aa:aa:00:00:05 * wlan0\n172.17.0.2 0x1 0x2 02:42:ac:11:00:02 * docker0\n',
    io: {
      createSocket: net.createSocket,
      tcpProbe: async (ip, port) => { probes.push(ip + ':' + port); return (openPorts[ip] || []).includes(port) ? 'open' : ip === '10.9.0.21' ? 'refused' : 'timeout'; },
      rtspOptions: async () => 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: Hikvision RTSP\r\n\r\n',
      httpGet: async (url, opt = {}) => {
        http.push((opt.method || 'GET') + ' ' + url);
        if (/onvif\/device_service/.test(url)) {
          if (url.includes('172.21.20.101:80/')) return { status: 200, headers: {}, body: '<e><tds:GetSystemDateAndTimeResponse/></e>' };
          throw new Error('ECONNRESET');
        }
        if (url.startsWith('https://')) return { status: 200, headers: { 'axis-setup': '1' }, body: '<title>AXIS</title>', cert: { cn: 'axis-accc8e000030', o: 'Axis Communications AB' } };
        return { status: 401, headers: { server: 'App-webs/', 'www-authenticate': 'Digest realm="IPC"' }, body: '' };
      },
    },
  });
  const r = await cd.discover({ seconds: 1, channels: ['B'], extraCidrs: ['10.9.0.16/28', '192.168.234.0/24'] });
  // ARP triggers went to the on-link network only; the hotspot network was never touched by anything
  const arpTriggers = net.sockets.flatMap((s) => s.sent).filter((x) => x.port === 9);
  assert.equal(arpTriggers.length, 253, 'every host of 172.21.20.0/24 except ourselves');
  assert.ok(!probes.some((p) => p.startsWith('192.168.234.')) && !http.some((u) => u.includes('192.168.234.')), 'the excluded network is never probed');
  assert.ok(!probes.some((p) => p.startsWith('172.17.')), 'neighbours on virtual interfaces are not probed');
  assert.deepEqual(r.sweep.scanned, ['172.21.20.0/24', '10.9.0.16/28']);
  assert.deepEqual(r.sweep.skipped, [{ cidr: '192.168.234.0/24', reason: 'excluded' }]);
  assert.equal(r.sweep.alive, 4, 'two ARP neighbours + two routed hosts (one open, one refusing)');
  assert.equal(r.sweep.truncated, false);
  const byIp = Object.fromEntries(r.candidates.map((c) => [c.ip, c]));
  assert.deepEqual(Object.keys(byIp).sort(), ['10.9.0.20', '10.9.0.21', '172.21.20.101', '172.21.20.30']);
  const hik = byIp['172.21.20.101'];
  assert.equal(hik.mac, 'C8:DE:11:22:33:44');
  assert.deepEqual(hik.signals.ports, [80, 554, 8000]);
  assert.deepEqual(hik.signals.http, [{ port: 80, status: 401, server: 'App-webs/', auth: 'Digest', realm: 'IPC' }]);
  assert.deepEqual(hik.signals.rtsp, [{ port: 554, status: 200, server: 'Hikvision RTSP' }]);
  assert.deepEqual(hik.signals.onvifUnicast, [{ port: 80, xaddr: 'http://172.21.20.101:80/onvif/device_service' }]);
  assert.deepEqual(hik.sources.sort(), ['arp-sweep', 'http-banner', 'onvif-unicast', 'rtsp-options', 'tcp-ports']);
  assert.ok(!hik.sources.includes('onvif'), 'a unicast ONVIF answer is a candidate signal, not the legacy "onvif" source');
  assert.equal(hik.signals.oui, 'C8DE11');
  assert.deepEqual(byIp['172.21.20.30'].signals.http, [{ port: 443, status: 200, title: 'AXIS', axisSetup: '1', tls: { cn: 'axis-accc8e000030', o: 'Axis Communications AB' } }]);
  // routed host: no MAC, found by TCP, then answered the Dahua probe sent to it directly
  const routed = byIp['10.9.0.20'];
  assert.deepEqual([routed.vendor, routed.mac, routed.signals.ports], ['Dahua', '3C:EF:8C:09:00:20', [80, 37777]]);
  assert.ok(routed.sources.includes('dahua-dhdiscover') && routed.channels.includes('B'));
  assert.ok(net.sockets.flatMap((s) => s.sent).some((x) => x.port === 37810 && x.address === '10.9.0.20'));
  assert.ok(!net.sockets.flatMap((s) => s.sent).some((x) => x.port === 37020), 'SADP is multicast only: never re-sent unicast');
  assert.deepEqual(r.devices, []);
  // custom port list
  probes.length = 0;
  const r2 = await cd.discover({ seconds: 1, channels: ['B'], ports: [8000] });
  assert.ok(probes.length > 0 && probes.every((p) => p.endsWith(':8000')));
  assert.deepEqual(r2.candidates.find((c) => c.ip === '172.21.20.101').signals.ports, [8000]);
});

test('engine: channels B and D are rate limited for requests that do not name channels (the backend searches every minute)', async () => {
  const net = fakeNetwork();
  let t = 5_000_000;
  let arpings = 0;
  const cd = CD.createCameraDiscovery({
    netIfs: () => ({ enp1s0: IFS().enp1s0 }), log: () => {}, now: () => t, sleep: fastSleep,
    readArp: async () => 'h\n172.21.20.101 0x1 0x2 c8:de:11:22:33:44 * enp1s0\n',
    host: async (cmd) => { if (cmd === 'arping') arpings++; return ''; },
    io: { createSocket: net.createSocket, tcpProbe: async (ip, port) => (port === 554 ? 'open' : 'timeout'), rtspOptions: async () => 'RTSP/1.0 401 Unauthorized\r\n\r\n', httpGet: async () => { throw new Error('closed'); } },
  });
  const sweeps = () => net.sockets.flatMap((s) => s.sent).filter((x) => x.port === 9).length;
  const first = await cd.discover({ seconds: 1 });
  assert.equal(sweeps(), 253);
  assert.ok(arpings > 0);
  assert.deepEqual(first.candidates.map((c) => [c.ip, c.signals.ports]), [['172.21.20.101', [554]]]);
  assert.equal(first.sweep.cached, undefined);
  t += 60_000;
  const second = await cd.discover({ seconds: 1 });
  assert.equal(sweeps(), 253, 'a minute later: no new sweep');
  assert.equal(second.sweep.cached, true);
  assert.equal(second.sweep.ageMs, 60_000);
  assert.deepEqual(second.candidates.map((c) => [c.ip, c.signals.ports]), [['172.21.20.101', [554]]], 'the previous result is still reported');
  assert.equal(second.probes.find((p) => p.id === 'tcp-ports').skipped, 'rate limited: previous result reused');
  assert.ok(second.probes.find((p) => p.id === 'onvif').sent > 0, 'channels A and C run every time');
  const before = arpings;
  await cd.discover({ seconds: 1, channels: ['A', 'B', 'C', 'D'] });
  assert.equal(sweeps(), 506, 'naming the channels forces a fresh sweep');
  assert.ok(arpings > before);
  t += CD.LIMITS.heavyIntervalMs + 1;
  const later = await cd.discover({ seconds: 1 });
  assert.equal(sweeps(), 759, 'after the interval the sweep runs again');
  assert.equal(later.sweep.cached, undefined);
});

test('engine, channel B: the run is bounded by its deadline (large network, slow clock)', async () => {
  const net = fakeNetwork();
  let t = 1_000_000;
  const cd = CD.createCameraDiscovery({
    netIfs: () => ({ enp1s0: [{ family: 'IPv4', address: '10.4.0.2', cidr: '10.4.0.2/22' }] }), log: () => {}, now: () => t,
    sleep: async (ms) => { t += Math.max(ms, 1); await tick(); },
    readArp: async () => '', io: { createSocket: net.createSocket, tcpProbe: async () => 'timeout' },
  });
  const r = await cd.discover({ seconds: 1, channels: ['B'] });
  assert.equal(r.sweep.truncated, true, 'a /22 does not fit: reported, not silently skipped');
  assert.ok(r.sweep.arpProbed > 100 && r.sweep.arpProbed < 1022);
  assert.ok(r.durationMs <= 1000 + CD.LIMITS.extraBudgetMs, `ended within the budget (${r.durationMs} ms)`);
});

test('engine, channel D: factory addresses by arping or kernel ARP, IPv4 link-local, IPv6 all-nodes', async () => {
  const net = fakeNetwork();
  const calls = [];
  const host = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'arping') {
      const ip = args[args.length - 1];
      if (ip === '192.168.1.64') return 'ARPING 192.168.1.64 from 172.21.20.250 enp1s0\nUnicast reply from 192.168.1.64 [C8:DE:11:AA:00:64]  0.7ms\nReceived 1 response(s)\n';
      throw Object.assign(new Error('exit 1'), { stdout: `ARPING ${ip} from 172.21.20.250 enp1s0\nSent 1 probes (1 broadcast(s))\nReceived 0 response(s)\n` });
    }
    if (cmd === 'ping') return '64 bytes from fe80::cade:11ff:feaa:64%enp1s0: icmp_seq=1 ttl=64 time=0.4 ms\n';
    if (cmd === 'ip') return 'fe80::cade:11ff:feaa:64 lladdr c8:de:11:aa:00:64 REACHABLE\nfe80::aaaa lladdr 02:00:00:00:00:99 STALE\n';
    throw new Error('unexpected ' + cmd);
  };
  const ifs = () => ({ ...IFS(), enp2s0: [{ family: 'IPv4', address: '192.168.0.250', cidr: '192.168.0.250/24' }] });
  const cd = CD.createCameraDiscovery({
    netIfs: ifs, sleep: fastSleep, log: () => {}, host, io: { createSocket: net.createSocket },
    readArp: async () => 'IP address HW type Flags HW address Mask Device\n192.168.0.90 0x1 0x2 ac:cc:8e:00:00:90 * enp2s0\n169.254.7.7 0x1 0x2 00:40:8c:00:07:07 * enp1s0\n169.254.9.9 0x1 0x2 00:40:8c:00:09:09 * wlan0\n',
  });
  const r = await cd.discover({ seconds: 1, channels: ['D'], factoryIps: ['192.168.1.64', '192.168.1.108', '192.168.0.90', '192.168.234.64'] });
  // foreign subnets: arping on both wired interfaces; the on-link factory address by kernel ARP; the hotspot network never
  assert.ok(calls.includes('arping -c 1 -w 1 -I enp1s0 192.168.1.64') && calls.includes('arping -c 1 -w 1 -I enp2s0 192.168.1.108'));
  assert.ok(!calls.some((c) => c.includes('192.168.234.') || c.includes('wlan0') || c.includes('docker0')));
  assert.ok(!calls.some((c) => c.startsWith('arping') && c.includes('192.168.0.90')), 'an on-link factory address does not need arping');
  assert.deepEqual(net.sockets.flatMap((s) => s.sent).map((x) => x.address + ':' + x.port), ['192.168.0.90:9']);
  assert.ok(calls.includes('ping -6 -c 2 -w 2 -I enp1s0 ff02::1') && calls.includes('ip -6 neigh show dev enp2s0'));
  const rows = r.candidates.map((c) => [c.ip, c.mac, c.sources.join('+')]);
  assert.deepEqual(rows, [['169.254.7.7', '00:40:8C:00:07:07', 'link-local-v4'], ['192.168.0.90', 'AC:CC:8E:00:00:90', 'factory-arp'], ['192.168.1.64', 'C8:DE:11:AA:00:64', 'factory-arp+ipv6-all-nodes']]);
  const hik = r.candidates[2];
  assert.deepEqual(hik.signals.ipv6, ['fe80::cade:11ff:feaa:64', 'fe80::cade:11ff:feaa:64'].slice(0, hik.signals.ipv6.length));
  assert.equal(hik.signals.probes['factory-arp'].foreignSubnet, true);
  assert.deepEqual(hik.channels, ['D']);
  assert.deepEqual(r.unaddressed.map((u) => [u.mac, u.signals.ipv6[0]]), [['02:00:00:00:00:99', 'fe80::aaaa']]);
  assert.equal(r.layer2.arping, 'ok');
  // no arping on the host: reported, the rest still runs
  const cd2 = CD.createCameraDiscovery({
    netIfs: ifs, sleep: fastSleep, log: () => {}, io: { createSocket: net.createSocket }, readArp: async () => '',
    host: async (cmd) => { if (cmd === 'arping') throw Object.assign(new Error('nsenter: failed to execute arping: No such file or directory'), { stderr: 'nsenter: failed to execute arping: No such file or directory' }); return ''; },
  });
  const r3 = await cd2.discover({ seconds: 1, channels: ['D'] });
  assert.equal(r3.layer2.arping, 'not-installed');
  assert.match(r3.probes.find((p) => p.id === 'factory-arp').error, /arping is not installed/);
  // host tooling that fails in every possible way never fails the request
  const cd3 = CD.createCameraDiscovery({ netIfs: ifs, sleep: fastSleep, log: () => {}, io: { createSocket: net.createSocket }, readArp: async () => { throw new Error('EACCES'); }, host: async () => { throw new Error('boom'); } });
  const r4 = await cd3.discover({ seconds: 1, channels: ['D'] });
  assert.deepEqual([r4.devices, r4.candidates, r4.unaddressed], [[], [], []]);
});

test('default factory address list is conservative and documented', () => {
  assert.deepEqual([...CD.DEFAULT_FACTORY_IPS], ['192.168.1.64', '192.0.0.64', '192.168.1.13', '192.168.1.108', '192.168.1.100', '192.168.0.90']);
  assert.deepEqual([...CD.DEFAULT_PORTS], [554, 8554, 10554, 80, 443, 8080, 8000, 37777, 34567, 9000, 2020, 8899, 5000, 7447, 1935, 51826]);
});

// ---- backward compatibility of POST /v1/cameras/discover ----------------------------------------------
const WSD = (ip, mac, model, uuid) => `<?xml version="1.0"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><e:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:${uuid}</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>${mac ? 'onvif://www.onvif.org/MAC/' + mac + ' ' : ''}onvif://www.onvif.org/hardware/${model} onvif://www.onvif.org/name/${model}</d:Scopes><d:XAddrs>http://${ip}/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>`;
const SADP = (ip, mac) => `<?xml version="1.0"?><ProbeMatch><Uuid>9E3F</Uuid><Types>inquiry</Types><DeviceDescription>DS-2CD2143G2-I</DeviceDescription><DeviceSN>SN-${ip}</DeviceSN><CommandPort>8000</CommandPort><HttpPort>80</HttpPort><MAC>${mac}</MAC><IPv4Address>${ip}</IPv4Address><DHCP>false</DHCP><SoftwareVersion>V5.7.3</SoftwareVersion><Activated>true</Activated></ProbeMatch>`;

test('compatibility transport (old multicast hook): the device rows are what host-agent.mjs produced before, plus additive fields', async () => {
  const replies = [
    { proto: 'wsd', from: '172.21.20.101', data: WSD('172.21.20.101', 'c8:de:11:22:33:44', 'DS-2CD2143G2-I', '3fa1fe68-b915-4053-a3e1-c8de11223344') },
    { proto: 'sadp', from: '172.21.20.101', data: SADP('172.21.20.101', 'c8-de-11-22-33-44') },
    { proto: 'wsd', from: '172.21.20.20', data: WSD('172.21.20.20', '', 'Tapo+C320WS', '3fa1fe68-b915-4053-a3e1-5c628b000001') },
    { proto: 'sadp', from: '172.21.20.250', data: CD.sadpProbe('me') },
    { proto: 'sadp', from: '192.168.234.9', data: SADP('172.21.20.77', 'c8-de-11-22-33-77') },
    { proto: 'other', from: '172.21.20.9', data: 'x' },
  ];
  let call;
  const cd = CD.createCameraDiscovery({ netIfs: IFS, uuid: () => 'me', legacyMulticast: async (args) => { call = args; return replies; }, readArp: async () => 'h\n172.21.20.20 0x1 0x2 5c:62:8b:00:00:01 * enp1s0\n', host: async () => { throw new Error('host tools must not run in this mode'); }, io: { createSocket: () => { throw new Error('no sockets in this mode'); } } });
  const r = await cd.discover({ seconds: 2 }, { excluded: ['192.168.234.0/24'] });
  assert.deepEqual(Object.keys(call).sort(), ['ifaces', 'sadpProbe', 'seconds', 'wsdProbes']);
  assert.equal(call.wsdProbes.length, 2);
  assert.equal(call.seconds, 2);
  // what the old code returned for the same replies
  const usable = replies.filter((x) => x.from !== '172.21.20.250' && !x.from.startsWith('192.168.234.'));
  const old = HA.mergeDiscovered(usable.filter((x) => x.proto === 'wsd').flatMap((x) => HA.parseWsDiscovery(x.data, x.from)), usable.filter((x) => x.proto === 'sadp').map((x) => HA.parseSadp(x.data)).filter(Boolean), { excluded: ['192.168.234.0/24'] });
  old.find((d) => d.ip === '172.21.20.20').mac = '5C:62:8B:00:00:01';
  old.find((d) => d.ip === '172.21.20.20').macFrom = 'arp';
  const ADDED = ['channels', 'signals', 'raw', 'cloudType'];
  const strip = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !ADDED.includes(k)));
  assert.deepEqual(r.devices.map(strip), old, 'existing fields unchanged');
  for (const d of r.devices) {
    assert.deepEqual(d.channels, ['A']);
    assert.ok(d.raw.length >= 1 && d.raw.every((x) => x.encoding === 'utf8' && ['onvif', 'sadp'].includes(x.probe)));
    assert.equal(typeof d.signals, 'object');
  }
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.unaddressed, []);
  const sum = Object.fromEntries(r.probes.map((p) => [p.id, p]));
  assert.equal(sum.onvif.replies, 2);
  assert.equal(sum.sadp.replies, 1);
  assert.equal(sum.mdns.skipped, 'legacy-transport');
  for (const k of ['discoveredAt', 'durationMs', 'interfaces', 'devices']) assert.ok(k in r, k);
});

test('WS-Discovery: a non-ONVIF answer to the untyped probe is a "wsd-generic" candidate, never an "onvif" device', async () => {
  const printer = (relates) => `<s:Envelope><s:Header><a:RelatesTo>urn:uuid:${relates}</a:RelatesTo></s:Header><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:prn-1</a:Address></a:EndpointReference><d:Types>wsdp:Device wprt:PrintDeviceType</d:Types><d:XAddrs>http://172.21.20.60:5357/abc</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;
  let n = 0;
  const net = fakeNetwork({
    onSend: ({ buf, port }) => {
      if (port !== 3702) return [];
      const xml = buf.toString();
      const id = /MessageID>uuid:([^<]+)</.exec(xml)[1];
      if (!/<d:Types>/.test(xml)) return [{ data: Buffer.from(printer(id)), from: { address: '172.21.20.60', port: 3702 } }, { data: Buffer.from(WSD('172.21.20.102', '', 'IPC', 'cam-102').replace('<e:Body>', `<e:Header><a:RelatesTo>uuid:${id}</a:RelatesTo></e:Header><e:Body>`)), from: { address: '172.21.20.102', port: 3702 } }];
      return [];
    },
  });
  const cd = CD.createCameraDiscovery({ netIfs: IFS, sleep: fastSleep, log: () => {}, uuid: () => 'id-' + ++n, io: { createSocket: net.createSocket }, probes: CD.PROBES.filter((p) => p.id === 'onvif') });
  const r = await cd.discover({ seconds: 1, channels: ['A'] });
  assert.deepEqual(r.devices.map((d) => [d.ip, d.sources]), [['172.21.20.102', ['onvif']]], 'an ONVIF camera that only answers the untyped probe is still an ONVIF device');
  assert.deepEqual(r.candidates.map((d) => [d.ip, d.sources, d.signals.probes['wsd-generic'].types]), [['172.21.20.60', ['wsd-generic'], ['wsdp:Device', 'wprt:PrintDeviceType']]]);
});

test('host-agent hook-up: POST /v1/cameras/discover goes through this module and keeps its response shape', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'cd-'));
  // 1. existing callers (old hook injected): rows as before
  const legacy = HA.createAgent({
    hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x'), uuid: () => 'me', networkInterfaces: IFS,
    readArp: async () => '',
    multicast: async () => [{ proto: 'wsd', from: '172.21.20.101', data: WSD('172.21.20.101', 'c8:de:11:22:33:44', 'DS-2CD2143G2-I', 'u-101') }, { proto: 'sadp', from: '172.21.20.101', data: SADP('172.21.20.101', 'c8-de-11-22-33-44') }],
  });
  const a = await legacy.discoverCameras({ seconds: 1 });
  assert.deepEqual(a.devices.map((d) => [d.ip, d.mac, d.vendor, d.model, d.sources.join('+'), d.sadp.activated, d.onvif.uuid]), [['172.21.20.101', 'C8:DE:11:22:33:44', 'Hikvision', 'DS-2CD2143G2-I', 'sadp+onvif', true, 'u-101']]);
  assert.deepEqual(a.interfaces, [{ iface: 'enp1s0', ip: '172.21.20.250', cidr: '172.21.20.250/24' }]);
  assert.ok(Array.isArray(a.probes) && Array.isArray(a.candidates), 'additive top-level fields');
  // 2. the real path with a fake network: new options are validated by the agent as parameter errors
  const net = fakeNetwork({ onSend: ({ port }) => (port === 37810 ? [{ data: dahuaReply('172.21.20.108', '3c:ef:8c:00:01:08'), from: { address: '172.21.20.108', port: 37810 } }] : []) });
  const agent = HA.createAgent({ hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x'), networkInterfaces: IFS, readArp: async () => '', sleep: fastSleep, discoveryIo: { createSocket: net.createSocket } });
  const b = await agent.discoverCameras({ seconds: 1, channels: ['A'] });
  assert.deepEqual(b.devices, []);
  assert.deepEqual(b.candidates.map((c) => [c.ip, c.vendor]), [['172.21.20.108', 'Dahua']]);
  assert.ok(!net.sockets.flatMap((s) => s.sent).some((x) => /^192\.168\.234\./.test(x.address) || x.via === '192.168.234.1'), 'the maintenance hotspot stays excluded');
  await assert.rejects(agent.discoverCameras({ channels: ['Z'] }), (e) => e instanceof HA.AgentError && e.code === 'E_PARAM' && e.status === 400);
  await assert.rejects(agent.discoverCameras({ extraCidrs: ['nope'] }), (e) => e.code === 'E_PARAM');
});
