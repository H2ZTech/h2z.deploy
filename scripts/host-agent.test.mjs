// node --test scripts/host-agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { wsDiscoveryProbe, sadpProbe, sadpExchangeCodeProbe, sadpActivateProbe, sadpUpdateProbe, parseSadpResult, parseWsDiscovery, parseSadp, normalizeMac, mergeDiscovered, discoveryInterfaces, parseCpuStat, parseMeminfo, parseNetDev, metricsFrom, planL2Scan, hostsOf, parseArpTable, parseIpAddrs, validateLan, validateVlans, renderNetplan, parseNetplan, renderNetplanPorts, parseNetplanPorts, deviceSerial, parseNtpServers, tarIndex, cmpVersion, osFileProblems, parseEnvFile, parseUnixTimestamp, summarizeTailscale, createAgent, createServer } from './host-agent.mjs';

test('host.env parsing strips quotes', () => {
  assert.deepEqual(parseEnvFile("LAN_IF='enP3p49s0'\nAP_PORTS='8096, 3096'\n# c\nAP_PSK=\"h2z@2026\"\nX=1"), {
    LAN_IF: 'enP3p49s0', AP_PORTS: '8096, 3096', AP_PSK: 'h2z@2026', X: '1',
  });
});

test('LAN validation', () => {
  assert.deepEqual(validateLan({ mode: 'dhcp', address: 'x' }), { mode: 'dhcp' });
  assert.deepEqual(validateLan({ mode: 'static', address: '10.20.1.15', prefix: '24', gateway: '10.20.1.1', dns: '10.20.1.1, 223.5.5.5' }), {
    mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.1.1', dns: ['10.20.1.1', '223.5.5.5'],
  });
  assert.deepEqual(validateLan({ mode: 'static', address: '10.20.1.15', prefix: 16 }).gateway, '', 'gateway optional');
  const no = (b, re) => assert.throws(() => validateLan(b, { apNetwork: '192.168.234.0/24' }), re);
  no({ mode: 'x' }, /dhcp 或 static/);
  no({ mode: 'static', address: '10.20.1.300', prefix: 24 }, /格式不对/);
  no({ mode: 'static', address: '10.20.1.15', prefix: 31 }, /8–30/);
  no({ mode: 'static', address: '10.20.1.0', prefix: 24 }, /网络地址或广播/);
  no({ mode: 'static', address: '10.20.1.255', prefix: 24 }, /网络地址或广播/);
  no({ mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.2.1' }, /不在/);
  no({ mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.1.15' }, /相同/);
  no({ mode: 'static', address: '10.20.1.15', prefix: 24, dns: '1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4' }, /最多 3/);
  no({ mode: 'static', address: '192.168.234.20', prefix: 24 }, /维护热点/);
  no({ mode: 'static', address: '192.168.1.20', prefix: 16 }, /维护热点/, 'supernet of the hotspot');
  no({ mode: 'static', address: '169.254.1.2', prefix: 16 }, /链路本地/);
});

test('netplan render / parse round trip', () => {
  const st = { mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.1.1', dns: ['10.20.1.1', '223.5.5.5'] };
  const y = renderNetplan('enP3p49s0', st);
  assert.match(y, /enP3p49s0:\n {6}dhcp4: false/);
  assert.match(y, /addresses: \[10\.20\.1\.15\/24\]/);
  assert.match(y, /- to: default\n {10}via: 10\.20\.1\.1/);
  assert.deepEqual(parseNetplan(y), st);
  assert.deepEqual(parseNetplan(renderNetplan('eth0', { mode: 'dhcp' })), { mode: 'dhcp' });
  assert.deepEqual(parseNetplan(renderNetplan('eth0', { mode: 'static', address: '10.1.1.2', prefix: 24, gateway: '', dns: [] })),
    { mode: 'static', address: '10.1.1.2', prefix: 24, gateway: '', dns: [] });
  assert.deepEqual(parseNetplan(''), { mode: 'unknown' });
});

test('helpers', () => {
  assert.equal(parseUnixTimestamp('@1760630400\n'), 1760630400000);
  assert.equal(parseUnixTimestamp(''), null);
  const s = summarizeTailscale({ BackendState: 'Running', Self: { HostName: 'orangepi5-max', DNSName: 'orangepi5-max.tail1.ts.net.', TailscaleIPs: ['100.90.1.2'], Online: true }, CurrentTailnet: { Name: 'x@y' } });
  assert.equal(s.loggedIn, true);
  assert.equal(s.dnsName, 'orangepi5-max.tail1.ts.net');
  assert.deepEqual(summarizeTailscale({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/1' }).authUrl, 'https://login.tailscale.com/a/1');
});

function board({ applyFails = false } = {}) {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='enP3p49s0'\nAP_IF='wlan0'\nAP_SSID='H2Z-0D4C'\nAP_NETWORK='192.168.234.0/24'\nAP_WINDOW_MIN='30'\n");
  writeFileSync(join(etc, 'netplan/20-h2z-lan.yaml'), renderNetplan('enP3p49s0', { mode: 'dhcp' }));
  const calls = [];
  let t = Date.parse('2026-10-16T12:00:00Z');
  const host = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'netplan' && applyFails) { const e = new Error('boom'); e.stderr = 'netplan: error'; throw e; }
    if (cmd === 'systemctl' && args[0] === 'is-active') return 'active\n';
    if (cmd === 'systemctl' && args[0] === 'show') return args.includes('h2z-maint-ap-off.timer') ? '@' + (t / 1000 + 600) + '\n' : '\n';
    if (cmd === 'iw') return 'Station aa\nStation bb\n';
    if (cmd === 'ip' && args.includes('addr')) return JSON.stringify([{ addr_info: [{ local: '10.0.0.236', prefixlen: 24 }] }]);
    if (cmd === 'ip' && args.includes('route')) return JSON.stringify([{ gateway: '10.0.0.1' }]);
    if (cmd === 'cat') return '1\n';
    if (cmd === 'hostname') return 'orangepi5-max\n';
    if (cmd === 'resolvectl') throw new Error('no resolved');
    return '';
  };
  const agent = createAgent({ hostEtc: etc, host, now: () => t, rollbackMs: 180_000, tailscaleSocket: join(etc, 'none.sock') });
  return { etc, agent, calls, advance: (ms) => { t += ms; } };
}

test('LAN change is rolled back unless confirmed before the deadline', async () => {
  const b = board();
  const p = await b.agent.applyLan({ mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.1.1' });
  assert.equal(p.deadline, '2026-10-16T12:03:00.000Z');
  assert.match(readFileSync(join(b.etc, 'netplan/20-h2z-lan.yaml'), 'utf8'), /10\.20\.1\.15\/24/);
  assert.ok(b.calls.includes('netplan apply'));
  await assert.rejects(b.agent.applyLan({ mode: 'dhcp' }), /等待确认/);
  b.advance(60_000);
  assert.equal(await b.agent.tick(), 'pending');
  b.advance(121_000);
  assert.equal(await b.agent.tick(), 'rolled-back');
  assert.deepEqual(parseNetplan(readFileSync(join(b.etc, 'netplan/20-h2z-lan.yaml'), 'utf8')), { mode: 'dhcp' });
  assert.equal(b.calls.filter((c) => c === 'netplan apply').length, 2);
  const st = await b.agent.status();
  assert.equal(st.lan.pending, null);
  assert.equal(st.lan.lastRollback.reason, 'timeout');
});

test('confirmed LAN change stays; manual rollback restores', async () => {
  const b = board();
  await b.agent.applyLan({ mode: 'static', address: '10.20.1.15', prefix: 24 });
  assert.deepEqual(await b.agent.confirmLan(), { confirmed: true });
  b.advance(10 * 60_000);
  assert.equal(await b.agent.tick(), 'idle');
  assert.equal(parseNetplan(readFileSync(join(b.etc, 'netplan/20-h2z-lan.yaml'), 'utf8')).address, '10.20.1.15');
  await b.agent.applyLan({ mode: 'dhcp' });
  await b.agent.rollbackLan();
  assert.equal(parseNetplan(readFileSync(join(b.etc, 'netplan/20-h2z-lan.yaml'), 'utf8')).address, '10.20.1.15');
  await assert.rejects(b.agent.confirmLan(), /没有待确认/);
});

test('failed netplan apply restores the previous file at once', async () => {
  const b = board({ applyFails: true });
  await assert.rejects(b.agent.applyLan({ mode: 'static', address: '10.20.1.15', prefix: 24 }), /已恢复原设置/);
  assert.deepEqual(parseNetplan(readFileSync(join(b.etc, 'netplan/20-h2z-lan.yaml'), 'utf8')), { mode: 'dhcp' });
  assert.equal(existsSync(join(b.etc, 'h2z/lan-pending.json')), false);
});

test('hotspot open schedules the close timer; status reports closing time and clients', async () => {
  const b = board();
  await b.agent.setAp('open');
  assert.ok(b.calls.includes('systemctl start h2z-maint-ap.service'));
  assert.ok(b.calls.some((c) => c.startsWith('systemd-run --quiet --unit=h2z-maint-ap-close --on-active=30min')), 'AP_WINDOW_MIN from host.env');
  assert.ok(b.calls.includes('systemctl stop h2z-maint-ap-off.timer'), 'boot window replaced by the chosen time');
  await b.agent.setAp('open', 10);
  assert.ok(b.calls.some((c) => c.includes('--on-active=10min')), 'shorten to 10 minutes');
  await assert.rejects(b.agent.setAp('open', 2), /5–480/);
  const st = await b.agent.status();
  assert.equal(st.ap.active, true);
  assert.equal(st.ap.clients, 2);
  assert.equal(st.ap.closesAt, '2026-10-16T12:10:00.000Z');
  assert.equal(st.lan.addresses[0], '10.0.0.236/24');
  assert.equal(st.tailscale.available, false);
  await b.agent.setAp('close');
  assert.ok(b.calls.includes('systemctl stop h2z-maint-ap.service'));
  await assert.rejects(b.agent.setAp('x'), /open 或 close/);
});

test('host/ changes after git pull are applied once via setup --auto', async () => {
  const b = board();
  const calls = [];
  let hash = 'aaa';
  const agent = createAgent({
    hostEtc: b.etc,
    tailscaleSocket: join(b.etc, 'none.sock'),
    host: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'readlink') return '/home/h2z/h2z.security/host/systemd/h2z-maint-ap.service\n';
      if (cmd === 'sh' && args[0] === '-c') return hash + '\n';
      if (cmd === 'sh') { writeFileSync(join(b.etc, 'h2z/setup.sha'), hash + '\n'); return 'host setup updated: hostapd-maint.conf.in\n'; }
      return '';
    },
  });
  assert.match(await agent.syncHostSetup(), /^updated/);
  assert.ok(calls.includes('sh /home/h2z/h2z.security/host/setup-host-network.sh --auto'));
  assert.equal(await agent.syncHostSetup(), 'up-to-date');
  hash = 'bbb';
  assert.match(await agent.syncHostSetup(), /^updated/);
  const fresh = createAgent({ hostEtc: mkdtempSync(join(tmpdir(), 'ha-')), host: async () => '' });
  assert.equal(await fresh.syncHostSetup(), 'not-installed', 'manual one-time setup still required');
});

test('local-display scripts after git pull: host-agent runs host/install-kiosk.sh from the repository', async () => {
  const calls = [];
  const agent = createAgent({
    hostEtc: mkdtempSync(join(tmpdir(), 'ha-')),
    tailscaleSocket: 'none.sock',
    host: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'readlink') return '/home/h2z/h2z.security/host/systemd/h2z-maint-ap.service\n';
      if (cmd === 'sh') return 'kiosk: 已更新 h2z-kiosk-browser，本地画面重启中\n';
      return '';
    },
  });
  assert.match(await agent.syncKiosk(), /已更新/);
  assert.ok(calls.includes('sh /home/h2z/h2z.security/host/install-kiosk.sh'));
  const none = createAgent({ hostEtc: mkdtempSync(join(tmpdir(), 'ha-')), host: async () => { throw new Error('no repo'); } });
  assert.equal(await none.syncKiosk(), 'not-installed');
});

test('not initialised: status says so and changes are refused', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  const agent = createAgent({ hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x') });
  assert.equal((await agent.status()).ready, false);
  await assert.rejects(agent.applyLan({ mode: 'dhcp' }), /setup-host-network/);
});

test('unix socket API', async () => {
  const b = board();
  const sock = join(b.etc, 'agent.sock');
  const server = createServer(b.agent);
  await new Promise((r) => server.listen(sock, r));
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await call('GET', '/v1/status')).body.ready, true);
  const bad = await call('POST', '/v1/lan', { mode: 'static', address: '1.2.3', prefix: 24 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'E_PARAM');
  assert.equal((await call('POST', '/v1/lan', { mode: 'dhcp' })).status, 200);
  assert.equal((await call('POST', '/v1/lan/confirm')).body.confirmed, true);
  assert.equal((await call('GET', '/nope')).status, 404);
  server.close();
});

const ARP = `IP address       HW type     Flags       HW address            Mask     Device
172.21.21.11     0x1         0x2         28:57:be:aa:bb:01     *        enP3p49s0
172.21.21.12     0x1         0x0         00:00:00:00:00:00     *        enP3p49s0
172.21.20.101    0x1         0x2         44:19:b6:aa:bb:02     *        enP3p49s0
172.17.0.2       0x1         0x2         02:42:ac:11:00:02     *        docker0
`;

test('L2 scan: arp table and address parsing', () => {
  assert.deepEqual(parseArpTable(ARP).map((n) => [n.ip, n.mac]), [
    ['172.21.21.11', '28:57:BE:AA:BB:01'], ['172.21.20.101', '44:19:B6:AA:BB:02'], ['172.17.0.2', '02:42:AC:11:00:02'],
  ]);
  assert.deepEqual(parseIpAddrs('2: enP3p49s0    inet 172.21.21.250/23 brd 172.21.21.255 scope global dynamic enP3p49s0\\       valid_lft 7000sec\n1: lo    inet 127.0.0.1/8 scope host lo\n'),
    [{ iface: 'enP3p49s0', ip: '172.21.21.250', prefix: 23 }, { iface: 'lo', ip: '127.0.0.1', prefix: 8 }]);
});

test('L2 scan planning: only attached networks, never the hotspot, size capped', () => {
  const onLink = [{ iface: 'enP3p49s0', ip: '172.21.21.250', prefix: 23 }, { iface: 'wlan0', ip: '192.168.234.1', prefix: 24 }];
  const apNetwork = '192.168.234.0/24';
  const p = planL2Scan(['172.21.20.0/23', '10.9.9.0/24', '192.168.234.0/24', '172.16.0.0/16'], { onLink, apNetwork });
  assert.deepEqual(p.targets.map((t) => t.cidr), ['172.21.20.0/23']);
  assert.deepEqual(p.skipped, [
    { cidr: '10.9.9.0/24', reason: 'not-on-link' }, { cidr: '192.168.234.0/24', reason: 'maintenance-hotspot' }, { cidr: '172.16.0.0/16', reason: 'too-large' },
  ]);
  // a sub-range of the attached network is scanned as given; a larger scope is cut to the attached part
  assert.deepEqual(planL2Scan(['172.21.21.0/24'], { onLink, apNetwork }).targets.map((t) => t.cidr), ['172.21.21.0/24']);
  assert.deepEqual(planL2Scan(['172.21.0.0/16'], { onLink, apNetwork }).skipped, [{ cidr: '172.21.0.0/16', reason: 'too-large' }]);
  assert.throws(() => planL2Scan([], { onLink }), /不能为空/);
  assert.throws(() => planL2Scan(['nope'], { onLink }), /格式不对/);
  const hs = hostsOf(p.targets[0], ['172.21.21.250']);
  assert.equal(hs.length, 510 - 1);
  assert.ok(!hs.includes('172.21.20.0') && !hs.includes('172.21.21.255') && !hs.includes('172.21.21.250'));
});

test('L2 scan: probes the addresses, reads back complete neighbours, rejects a concurrent scan', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='enP3p49s0'\nAP_IF='wlan0'\nAP_NETWORK='192.168.234.0/24'\n");
  const sent = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const agent = createAgent({
    hostEtc: etc,
    host: async (cmd) => (cmd === 'ip' ? '2: enP3p49s0    inet 172.21.21.250/23 brd 172.21.21.255 scope global\n' : ''),
    probe: () => ({ send: async (ip) => { sent.push(ip); if (sent.length === 3) await gate; }, close() {} }),
    sleep: async () => {}, readArp: async () => ARP, l2RatePerSec: 100, tailscaleSocket: join(etc, 'x'),
  });
  const first = agent.l2Scan({ cidrs: ['172.21.20.0/23'] });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(agent.l2Scan({ cidrs: ['172.21.20.0/23'] }), /正在进行/);
  release();
  const r = await first;
  assert.equal(sent.length, 509);
  assert.deepEqual(r.scanned, ['172.21.20.0/23']);
  assert.deepEqual(r.neighbors.map((n) => n.ip), ['172.21.20.101', '172.21.21.11', ]);
  assert.equal(r.neighbors[1].mac, '28:57:BE:AA:BB:01');
  assert.deepEqual(r.skipped, []);
  // the lock is released afterwards
  await agent.l2Scan({ cidrs: ['172.21.21.0/24'] });
});

// ---- VLAN sub-interfaces (trunk port: one IP per VLAN) -------------------------------------------------
test('VLAN validation: id range, duplicates, no overlap with the LAN / each other / hotspot, no gateway', () => {
  const lan = { mode: 'static', address: '172.21.21.250', prefix: 23 };
  assert.deepEqual(validateVlans([{ id: 1000, address: '172.21.31.1', prefix: 24 }], { lan, apNetwork: '192.168.234.0/24' }), [{ id: 1000, address: '172.21.31.1', prefix: 24 }]);
  assert.deepEqual(validateVlans([], { lan }), []);
  assert.throws(() => validateVlans([{ id: 1, address: '10.0.0.5', prefix: 24 }], { lan }), /2–4094/);
  assert.throws(() => validateVlans([{ id: 4095, address: '10.0.0.5', prefix: 24 }], { lan }), /2–4094/);
  assert.throws(() => validateVlans([{ id: 60, address: '10.0.0.5', prefix: 24 }, { id: 60, address: '10.0.1.5', prefix: 24 }], { lan }), /重复/);
  assert.throws(() => validateVlans([{ id: 60, address: '172.21.20.9', prefix: 24 }], { lan }), /重叠/, 'LAN 是 172.21.20.0/23');
  assert.throws(() => validateVlans([{ id: 70, address: '10.0.0.5', prefix: 24 }, { id: 71, address: '10.0.0.9', prefix: 25 }], { lan }), /重叠/);
  assert.throws(() => validateVlans([{ id: 70, address: '192.168.234.9', prefix: 24 }], { lan, apNetwork: '192.168.234.0/24' }), /维护热点/);
  assert.throws(() => validateVlans([{ id: 70, address: '10.0.0.0', prefix: 24 }], { lan }), /网络地址/);
  assert.throws(() => validateVlans([{ id: 70, address: 'abc', prefix: 24 }], { lan }), /格式/);
  assert.throws(() => validateVlans([{ id: 70, address: '10.0.0.5', prefix: 24, mode: 'dhcp' }], { lan }), /静态/);
  assert.throws(() => validateVlans(Array.from({ length: 9 }, (_, i) => ({ id: 100 + i, address: `10.${i}.0.5`, prefix: 24 })), { lan }), /最多/);
  assert.throws(() => validateVlans('x', { lan }), /数组/);
});

test('netplan with VLANs: render, parse back, no gateway on sub-interfaces, old shape unchanged without VLANs', () => {
  const lan = { mode: 'static', address: '172.21.21.250', prefix: 23, gateway: '172.21.21.254', dns: ['8.8.8.8'] };
  const y = renderNetplan('eth0', lan, [{ id: 1000, address: '172.21.31.1', prefix: 24 }]);
  assert.match(y, /vlans:\n {4}eth0\.1000:\n {6}id: 1000\n {6}link: eth0\n {6}dhcp4: false/);
  assert.match(y, /addresses: \[172\.21\.31\.1\/24\]/);
  assert.equal((y.match(/- to: default/g) || []).length, 1, '默认路由只在网口上');
  assert.deepEqual(parseNetplan(y), { ...lan, vlans: [{ id: 1000, address: '172.21.31.1', prefix: 24 }] });
  const d = renderNetplan('eth0', { mode: 'dhcp' }, [{ id: 60, address: '10.6.0.2', prefix: 24 }, { id: 1000, address: '172.21.31.1', prefix: 24 }]);
  assert.deepEqual(parseNetplan(d), { mode: 'dhcp', vlans: [{ id: 60, address: '10.6.0.2', prefix: 24 }, { id: 1000, address: '172.21.31.1', prefix: 24 }] });
  assert.deepEqual(parseNetplan(renderNetplan('eth0', lan)), lan);
});

test('apply VLANs only: LAN settings kept, rolled back like any LAN change, status lists the sub-interfaces', async () => {
  const b = board();
  rmSync(join(b.etc, 'netplan/20-h2z-lan.yaml'));
  await assert.rejects(b.agent.applyLan({ vlans: [{ id: 1000, address: '172.21.31.1', prefix: 24 }] }), /先保存一次网口设置/);
  await b.agent.applyLan({ mode: 'static', address: '172.21.21.250', prefix: 23, gateway: '172.21.21.254' });
  await b.agent.confirmLan();
  const p = await b.agent.applyLan({ vlans: [{ id: 1000, address: '172.21.31.1', prefix: 24 }] });
  assert.deepEqual(p.config, { mode: 'static', address: '172.21.21.250', prefix: 23, gateway: '172.21.21.254', dns: [], vlans: [{ id: 1000, address: '172.21.31.1', prefix: 24 }] });
  const file = join(b.etc, 'netplan/20-h2z-lan.yaml');
  assert.match(readFileSync(file, 'utf8'), /enP3p49s0\.1000:/);
  const st = await b.agent.status();
  assert.deepEqual(st.lan.vlans, [{ id: 1000, address: '172.21.31.1', prefix: 24 }]);
  assert.equal(st.lan.vlanLive[0].iface, 'enP3p49s0.1000');
  // 不确认 → 回滚到没有 VLAN
  b.advance(181_000);
  assert.equal(await b.agent.tick(), 'rolled-back');
  assert.equal(parseNetplan(readFileSync(file, 'utf8')).vlans, undefined);
});

test('changing only the LAN keeps the VLANs; an explicit empty list removes them', async () => {
  const b = board();
  await b.agent.applyLan({ mode: 'static', address: '172.21.21.250', prefix: 23, gateway: '172.21.21.254' }); await b.agent.confirmLan();
  await b.agent.applyLan({ vlans: [{ id: 1000, address: '172.21.31.1', prefix: 24 }] }); await b.agent.confirmLan();
  await b.agent.applyLan({ mode: 'static', address: '172.21.21.251', prefix: 23, gateway: '172.21.21.254' }); await b.agent.confirmLan();
  const file = join(b.etc, 'netplan/20-h2z-lan.yaml');
  assert.deepEqual(parseNetplan(readFileSync(file, 'utf8')).vlans, [{ id: 1000, address: '172.21.31.1', prefix: 24 }]);
  await b.agent.applyLan({ vlans: [] }); await b.agent.confirmLan();
  assert.equal(parseNetplan(readFileSync(file, 'utf8')).vlans, undefined);
  await assert.rejects(b.agent.applyLan({ vlans: [{ id: 60, address: '172.21.20.9', prefix: 24 }] }), /重叠/);
});

test('metrics: 解析 /proc 并算 CPU 与网速', () => {
  const a = parseCpuStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3');
  const b = parseCpuStat('cpu  200 0 200 750 150 0 0 0 0 0');
  assert.deepEqual(a, { idle: 800, total: 1000 });
  const mem = parseMeminfo('MemTotal:        8000000 kB\nMemFree: 1 kB\nMemAvailable:    2000000 kB\n');
  assert.deepEqual(mem, { total: 8000000 * 1024, used: 6000000 * 1024 });
  const net = parseNetDev('Inter-|\n face |\n lo: 999 0 0 0 0 0 0 0 999 0\n eth0: 1000 1 0 0 0 0 0 0 500 1\n docker0: 7 0 0 0 0 0 0 0 7 0\n');
  assert.deepEqual(net, { rx: 1000, tx: 500 });
  const m1 = metricsFrom(null, { at: 0, cpu: a, mem, disk: null, net, load: 0.5 });
  assert.equal(m1.cpu, null);
  assert.equal(m1.net.rxBps, null);
  const m2 = metricsFrom({ at: 0, cpu: a, net }, { at: 2000, cpu: b, mem, disk: null, net: { rx: 5000, tx: 1500 }, load: 0.5 });
  assert.equal(m2.cpu, 66.7); // idle（含 iowait）增 100，total 增 300 → 忙 2/3
  assert.equal(m2.net.rxBps, 2000);
  assert.equal(m2.net.txBps, 500);
});

// ---- 摄像头发现：ONVIF WS-Discovery + 海康 SADP ------------------------------------------------------------
const WSD_HIK = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:wsadis="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<env:Header><wsadis:MessageID>urn:uuid:aa</wsadis:MessageID><wsadis:RelatesTo>uuid:probe-1</wsadis:RelatesTo></env:Header>
<env:Body><d:ProbeMatches><d:ProbeMatch>
<wsadis:EndpointReference><wsadis:Address>urn:uuid:3fa1fe68-b915-4053-a3e1-c8DE11223344</wsadis:Address></wsadis:EndpointReference>
<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/MAC/c8:de:11:22:33:44 onvif://www.onvif.org/hardware/DS-2CD2143G2-I onvif://www.onvif.org/name/HIKVISION%20DS-2CD2143G2-I onvif://www.onvif.org/location/city/hangzhou</d:Scopes>
<d:XAddrs>http://172.21.20.101/onvif/device_service http://[fe80::cade:11ff:fe22:3344]/onvif/device_service</d:XAddrs>
<d:MetadataVersion>10</d:MetadataVersion>
</d:ProbeMatch></d:ProbeMatches></env:Body></env:Envelope>`;
const WSD_TAPO = `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsdd="http://schemas.xmlsoap.org/ws/2005/04/discovery"><SOAP-ENV:Body><wsdd:ProbeMatches><wsdd:ProbeMatch><wsa:EndpointReference><wsa:Address>uuid:3fa1fe68-b915-4053-a3e1-5c628b000001</wsa:Address></wsa:EndpointReference><wsdd:Types>tdn:NetworkVideoTransmitter</wsdd:Types><wsdd:Scopes>onvif://www.onvif.org/name/TP-IPC onvif://www.onvif.org/hardware/Tapo+C320WS</wsdd:Scopes><wsdd:XAddrs>http://172.21.20.120:2020/onvif/device_service</wsdd:XAddrs></wsdd:ProbeMatch></wsdd:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const SADP_HIK = `<?xml version="1.0" encoding="UTF-8"?><ProbeMatch><Uuid>9E3F0A2C-1111-2222-3333-444455556666</Uuid><Types>inquiry</Types><DeviceType>139029</DeviceType><DeviceDescription>DS-2CD2143G2-I</DeviceDescription><DeviceSN>DS-2CD2143G2-I20230101AACHL12345678</DeviceSN><CommandPort>8000</CommandPort><HttpPort>80</HttpPort><MAC>c8-de-11-22-33-44</MAC><IPv4Address>172.21.20.101</IPv4Address><IPv4SubnetMask>255.255.254.0</IPv4SubnetMask><IPv4Gateway>172.21.20.1</IPv4Gateway><DHCP>false</DHCP><SoftwareVersion>V5.7.3build 220112</SoftwareVersion><Activated>true</Activated><PasswordResetAbility>true</PasswordResetAbility></ProbeMatch>`;
const SADP_NEW = SADP_HIK.replace('c8-de-11-22-33-44', 'c8-de-11-00-00-09').replace('172.21.20.101', '192.168.1.64').replace('<Activated>true', '<Activated>false').replace('L12345678', 'L99');

test('camera discovery: probes are well-formed', () => {
  const p = wsDiscoveryProbe('m-1');
  assert.match(p, /<a:MessageID>uuid:m-1<\/a:MessageID>/);
  assert.match(p, /<d:Types>dn:NetworkVideoTransmitter<\/d:Types>/);
  assert.match(wsDiscoveryProbe('m-2', 'tds:Device'), /<d:Types>tds:Device<\/d:Types>/);
  assert.equal(sadpProbe('ab-cd'), '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>AB-CD</Uuid><Types>inquiry</Types></Probe>');
});

test('camera discovery: parse WS-Discovery and SADP replies', () => {
  const [h] = parseWsDiscovery(WSD_HIK, '172.21.20.101');
  assert.equal(h.uuid, '3fa1fe68-b915-4053-a3e1-c8de11223344');
  assert.equal(h.ip, '172.21.20.101');
  assert.deepEqual(h.xaddrs, ['http://172.21.20.101/onvif/device_service', 'http://[fe80::cade:11ff:fe22:3344]/onvif/device_service']);
  assert.equal(h.name, 'HIKVISION DS-2CD2143G2-I');
  assert.equal(h.hardware, 'DS-2CD2143G2-I');
  assert.equal(h.mac, 'C8:DE:11:22:33:44');
  const [t] = parseWsDiscovery(WSD_TAPO, '172.21.20.120');
  assert.equal(t.hardware, 'Tapo C320WS', '+ in scopes is a space');
  assert.equal(t.mac, '');
  assert.equal(t.uuid, '3fa1fe68-b915-4053-a3e1-5c628b000001');
  assert.deepEqual(parseWsDiscovery(wsDiscoveryProbe('x')), [], 'our own probe (multicast loopback) is not a match');

  const s = parseSadp(SADP_HIK);
  assert.deepEqual(s, { ip: '172.21.20.101', mac: 'C8:DE:11:22:33:44', model: 'DS-2CD2143G2-I', serial: 'DS-2CD2143G2-I20230101AACHL12345678', httpPort: 80, commandPort: 8000, activated: true, dhcp: false, softwareVersion: 'V5.7.3build 220112', salt: null });
  assert.equal(parseSadp(SADP_NEW).activated, false);
  assert.equal(parseSadp(sadpProbe('x')), null, 'our own inquiry has no IPv4Address');
  assert.equal(parseSadp('garbage'), null);
  assert.equal(normalizeMac('c8-de-11-22-33-44'), 'C8:DE:11:22:33:44');
  assert.equal(normalizeMac('00:00:00:00:00:00'), '');
  assert.equal(normalizeMac('xyz'), '');
});

test('camera discovery: merge by MAC / UUID / IP, drop the hotspot network, sort by IP', () => {
  const wsd = [...parseWsDiscovery(WSD_HIK, '172.21.20.101'), ...parseWsDiscovery(WSD_TAPO, '172.21.20.120'),
    { uuid: 'u-ap', xaddrs: ['http://192.168.234.50/onvif/device_service'], ip: '192.168.234.50', name: '', hardware: 'X', manufacturer: '', mac: '', types: [] }];
  const sadp = [parseSadp(SADP_HIK), parseSadp(SADP_NEW)];
  const d = mergeDiscovered(wsd, sadp, { excluded: ['192.168.234.0/24'] });
  assert.deepEqual(d.map((x) => x.ip), ['172.21.20.101', '172.21.20.120', '192.168.1.64']);
  const hik = d[0];
  assert.deepEqual(hik.sources, ['sadp', 'onvif'], 'one device, found by both');
  assert.equal(hik.vendor, 'Hikvision');
  assert.equal(hik.serial, 'DS-2CD2143G2-I20230101AACHL12345678');
  assert.equal(hik.onvif.uuid, '3fa1fe68-b915-4053-a3e1-c8de11223344');
  assert.equal(hik.sadp.activated, true);
  assert.deepEqual(d[1].sources, ['onvif']);
  assert.equal(d[1].model, 'Tapo C320WS');
  assert.equal(d[1].sadp, null);
  assert.equal(d[2].sadp.activated, false, 'not activated: only SADP sees it');
  assert.equal(d[2].onvif, null);
});

test('camera discovery: interfaces skip loopback, virtual ports, link-local and the hotspot', () => {
  const ifs = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/23' }, { family: 'IPv6', address: 'fe80::1' }],
    enp2s0: [{ family: 'IPv4', address: '169.254.10.2' }],
    wlan0: [{ family: 'IPv4', address: '192.168.234.1' }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1' }],
    tailscale0: [{ family: 'IPv4', address: '100.99.76.32' }],
  };
  assert.deepEqual(discoveryInterfaces(ifs, { excluded: ['192.168.234.0/24'] }), [{ iface: 'enp1s0', ip: '172.21.20.250', cidr: '172.21.20.250/23' }]);
});

test('camera discovery: agent sends both probes on every interface, ignores itself, one search at a time', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  let call;
  let release;
  const gate = new Promise((r) => (release = r));
  const agent = createAgent({
    hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x'),
    uuid: () => 'fixed-uuid',
    networkInterfaces: () => ({ enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/23' }] }),
    multicast: async (args) => {
      call = args;
      await gate;
      return [
        { proto: 'wsd', from: '172.21.20.101', data: WSD_HIK },
        { proto: 'wsd', from: '172.21.20.120', data: WSD_TAPO },
        { proto: 'sadp', from: '172.21.20.250', data: sadpProbe('fixed-uuid') }, // 自己的查询回环
        { proto: 'sadp', from: '172.21.20.101', data: SADP_HIK },
        { proto: 'sadp', from: '192.168.1.64', data: SADP_NEW },
      ];
    },
  });
  const first = agent.discoverCameras({});
  await new Promise((r) => setImmediate(r));
  await assert.rejects(agent.discoverCameras({}), /正在进行/);
  release();
  const r = await first;
  assert.equal(call.seconds, 3, 'default 3 s');
  assert.deepEqual(call.ifaces, [{ iface: 'enp1s0', ip: '172.21.20.250', cidr: '172.21.20.250/23' }]);
  assert.equal(call.wsdProbes.length, 2);
  assert.match(call.wsdProbes[1], /tds:Device/);
  assert.match(call.sadpProbe, /<Types>inquiry<\/Types>/);
  assert.deepEqual(r.devices.map((d) => [d.ip, d.sources.join('+')]), [['172.21.20.101', 'sadp+onvif'], ['172.21.20.120', 'onvif'], ['192.168.1.64', 'sadp']]);
  assert.ok(r.discoveredAt && r.durationMs >= 0);
  await assert.rejects(agent.discoverCameras({ seconds: 30 }), /1–10 秒/);
  // 没有可用网口：不报错，说明原因
  const none = createAgent({ hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x'), networkInterfaces: () => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), multicast: async () => { throw new Error('should not send'); } });
  const n = await none.discoverCameras({ seconds: 1 });
  assert.deepEqual(n.devices, []);
  assert.match(n.note, /没有可用的网口/);
});

test('camera discovery: route on the unix socket API', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  const sock = join(etc, 'agent.sock');
  const server = createServer({ discoverCameras: async (b) => ({ devices: [], seconds: b.seconds }) });
  await new Promise((r) => server.listen(sock, r));
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/cameras/discover', headers: { 'content-type': 'application/json' } }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => resolve({ status: rs.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ seconds: 2 }));
  });
  assert.deepEqual(res, { status: 200, body: { devices: [], seconds: 2 } });
  server.close();
});

test('camera discovery: MAC filled from the ARP table, excluded senders dropped, caller excludes applied, uplinks skipped', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  let call;
  const agent = createAgent({
    hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x'), uuid: () => 'u',
    readArp: async () => 'IP address       HW type     Flags       HW address            Mask     Device\n172.21.20.120    0x1         0x2         5c:62:8b:00:00:01     *        enp1s0\n',
    networkInterfaces: () => ({
      enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/23' }],
      enp2s0: [{ family: 'IPv4', address: '10.50.0.2', cidr: '10.50.0.2/24' }],
      wlp3s0: [{ family: 'IPv4', address: '192.168.8.20' }],
      ppp0: [{ family: 'IPv4', address: '100.64.1.2' }],
      wwan0: [{ family: 'IPv4', address: '10.200.0.2' }],
    }),
    multicast: async (args) => {
      call = args;
      return [
        { proto: 'wsd', from: '172.21.20.120', data: WSD_TAPO },
        // 发送方在热点网段，回复里却写了正常 IP：按发送方丢掉
        { proto: 'sadp', from: '192.168.234.9', data: SADP_HIK },
      ];
    },
  });
  const r = await agent.discoverCameras({ exclude: ['10.50.0.0/24', 'not-a-cidr'] });
  assert.deepEqual(call.ifaces.map((f) => f.iface), ['enp1s0'], '无线 / PPP / 4G / 调用方排除的网段都不发');
  assert.equal(r.devices.length, 1);
  assert.equal(r.devices[0].mac, '5C:62:8B:00:00:01');
  assert.equal(r.devices[0].macFrom, 'arp');
});


import { createPublicKey, publicEncrypt, createDecipheriv, createHash, constants } from 'node:crypto';

test('camera activate: exchangecode / activate probe XML and result parsing', () => {
  assert.equal(
    sadpExchangeCodeProbe('a1-b2', '08-54-11-b6-c5-30', 'Zm9v'),
    '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>A1-B2</Uuid><MAC>08-54-11-b6-c5-30</MAC><Types>exchangecode</Types><Code>Zm9v</Code></Probe>',
  );
  assert.equal(
    sadpActivateProbe('a1-b2', '08-54-11-b6-c5-30', 'YmFy'),
    '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>A1-B2</Uuid><MAC>08-54-11-b6-c5-30</MAC><Types>activate</Types><Password>YmFy</Password></Probe>',
  );
  const r = parseSadpResult(sadpExchangeCodeProbe('x', 'y', 'z').replace('<Probe>', '<ProbeMatch>').replace('</Probe>', '<Result>success</Result></ProbeMatch>'));
  assert.equal(r.uuid, 'X');
  assert.equal(r.types, 'exchangecode');
  assert.equal(r.result, 'success');
  assert.equal(r.code, 'z');
  assert.equal(parseSadpResult('garbage'), null);
  assert.equal(parseSadpResult('<Probe><Uuid>x</Uuid></Probe>'), null, '没有 Types 的不算');
});

test('camera activate: SADP activation round-trip (candidate recipe, fake transport exercises our own RSA/AES code end to end)', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  const seen = {};
  // 假的"设备"：收到 exchangecode 请求里我们的 RSA 公钥后，用它加密一个假会话密钥回去；
  // 收到 activate 请求后，用同一把会话密钥的 AES-128-CBC 解出密码，核对是否和我们发的一致。
  const fakeSessionSecret = Buffer.alloc(16, 7); // 前 16 字节会被当 AES key
  const agent = createAgent({
    hostEtc: etc, host: async () => '', tailscaleSocket: join(etc, 'x'),
    uuid: (() => { let n = 0; return () => 'UUID-' + n++; })(),
    networkInterfaces: () => ({ enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/23' }] }),
    sadpRequest: async (xml) => {
      const type = /<Types>(\w+)<\/Types>/.exec(xml)[1];
      if (type === 'exchangecode') {
        const pubDer = Buffer.from(/<Code>([^<]+)<\/Code>/.exec(xml)[1], 'base64');
        const pub = createPublicKey({ key: pubDer, format: 'der', type: 'pkcs1' });
        const enc = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, fakeSessionSecret);
        seen.exchangecode = true;
        return { types: 'exchangecode', result: 'success', code: enc.toString('base64') };
      }
      if (type === 'activate') {
        const b64 = /<Password>([^<]+)<\/Password>/.exec(xml)[1];
        const buf = Buffer.from(b64, 'base64');
        const iv = buf.subarray(0, 16);
        const decipher = createDecipheriv('aes-128-cbc', fakeSessionSecret, iv);
        seen.decryptedPassword = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
        return { types: 'activate', result: 'success' };
      }
      throw new Error('unexpected type ' + type);
    },
  });
  const r = await agent.activateCamera({ mac: '08-54-11-b6-c5-30', password: 'h2z2026test' });
  assert.deepEqual(r, { activated: true, method: 'sadp' });
  assert.equal(seen.exchangecode, true);
  assert.equal(seen.decryptedPassword, 'h2z2026test', '设备侧（假的）解出来的密码要和我们发的一致，证明我们自己的 RSA 解密 + AES 加密是自洽的（不代表真机协议一定是这个算法，见证据文档）');

  await assert.rejects(agent.activateCamera({ mac: '08-54-11-b6-c5-30', password: '123' }), /8–16 位/);
  await assert.rejects(agent.activateCamera({ mac: 'not-a-mac', password: 'h2z2026test' }), /mac 不合法/);
  await assert.rejects(agent.activateCamera({ mac: '08-54-11-b6-c5-30', password: 'h2z2026test', method: 'onvif' }), /不支持的激活方式/);
});

test('camera activate: update (改 IP) probe XML, and MAC-filtered response matching', () => {
  const net = { ipv4Address: '192.168.1.100', commandPort: 8000, ipv4SubnetMask: '255.255.255.0', ipv4Gateway: '192.168.1.1', ipv6Address: '', ipv6Gateway: '', ipv6MaskLen: 0, dhcp: false, httpPort: 80 };
  assert.equal(
    sadpUpdateProbe('a1-b2', '08-54-11-b6-c5-30', 'ZGlnZXN0', net),
    '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>A1-B2</Uuid><Types>update</Types><PWErrorParse>true</PWErrorParse><MAC>08-54-11-b6-c5-30</MAC><Password bSalt="true">ZGlnZXN0</Password><IPv4Address>192.168.1.100</IPv4Address><CommandPort>8000</CommandPort><IPv4SubnetMask>255.255.255.0</IPv4SubnetMask><IPv4Gateway>192.168.1.1</IPv4Gateway><IPv6Address></IPv6Address><IPv6Gateway></IPv6Gateway><IPv6MaskLen>0</IPv6MaskLen><DHCP>false</DHCP><HttpPort>80</HttpPort></Probe>',
  );
  // parseSadpResult 现在也带 mac，方便多台设备同时在激活时按 MAC 过滤广播回复
  const withMac = parseSadpResult('<ProbeMatch><Uuid>x</Uuid><Types>update</Types><MAC>08-54-11-B6-C5-30</MAC><Result>success</Result></ProbeMatch>');
  assert.equal(withMac.mac, '08-54-11-B6-C5-30');
});

test('camera activate: update (改 IP，候选实现) —— 4 个候选摘要公式按顺序试，命中就停；没有 Salt 或全部失败都报错', async () => {
  const saltHex = '2eeff9e0d6bc50f295f065053d7a1cf';
  const password = 'h2z2026test';
  const correctDigest = createHash('sha512').update(Buffer.concat([Buffer.from('admin'), Buffer.from(saltHex, 'hex'), Buffer.from(password, 'utf8')])).digest();
  const tried = [];
  function makeAgent(extra = {}) {
    return createAgent({
      hostEtc: mkdtempSync(join(tmpdir(), 'ha-')), host: async () => '', tailscaleSocket: join(tmpdir(), 'x'),
      uuid: (() => { let n = 0; return () => 'UUID-' + n++; })(),
      networkInterfaces: () => ({ enp1s0: [{ family: 'IPv4', address: '172.21.20.250', cidr: '172.21.20.250/23' }] }),
      sadpRequest: async (xml, opts) => {
        const type = /<Types>(\w+)<\/Types>/.exec(xml)[1];
        if (type === 'exchangecode') {
          const pubDer = Buffer.from(/<Code>([^<]+)<\/Code>/.exec(xml)[1], 'base64');
          const pub = createPublicKey({ key: pubDer, format: 'der', type: 'pkcs1' });
          const enc = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, Buffer.alloc(16, 7));
          return { types: 'exchangecode', result: 'success', code: enc.toString('base64') };
        }
        if (type === 'activate') {
          return { types: 'activate', result: 'success' };
        }
        if (type === 'inquiry') {
          if (extra.noSalt) return { ip: '192.168.1.64', mac: '08:54:11:B6:C5:30', commandPort: 8000, httpPort: 80, dhcp: false };
          return { ip: '192.168.1.64', mac: '08:54:11:B6:C5:30', commandPort: 8000, httpPort: 80, dhcp: false, salt: saltHex };
        }
        if (type === 'update') {
          const b64 = /<Password bSalt="true">([^<]+)<\/Password>/.exec(xml)[1];
          tried.push(b64);
          const ok = Buffer.from(b64, 'base64').equals(correctDigest);
          return { types: 'update', result: ok ? 'success' : 'fail' };
        }
        throw new Error('unexpected type ' + type);
      },
    });
  }
  const agent = makeAgent();
  const r = await agent.activateCamera({
    mac: '08-54-11-b6-c5-30', password: 'h2z2026test',
    network: { ipv4Address: '192.168.1.100', ipv4SubnetMask: '255.255.255.0', ipv4Gateway: '192.168.1.1', dhcp: false },
  });
  assert.equal(r.network.updated, true);
  assert.equal(r.network.viaFormula, 'sha512(username+salt+password)', '前两个候选公式应该先失败，第三个（含用户名）命中');
  assert.equal(tried.length, 3, '命中就不再往后试');

  const noSalt = makeAgent({ noSalt: true });
  const r2 = await noSalt.activateCamera({ mac: '08-54-11-b6-c5-30', password: 'h2z2026test', network: { dhcp: true } });
  assert.equal(r2.network.updated, false);
  assert.match(r2.network.error, /Salt/, '没有 Salt 就没法算摘要，应该是这个原因报错，而不是 4 个公式都失败');
});

test('camera activate: route on the unix socket API', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  const sock = join(etc, 'agent.sock');
  const server = createServer({ activateCamera: async (b) => ({ activated: true, mac: b.mac }) });
  await new Promise((r) => server.listen(sock, r));
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/cameras/activate', headers: { 'content-type': 'application/json' } }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => resolve({ status: rs.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ mac: '08-54-11-b6-c5-30', password: 'h2z2026test' }));
  });
  assert.deepEqual(res, { status: 200, body: { activated: true, mac: '08-54-11-b6-c5-30' } });
  server.close();
});

// ---------------------------------------------------------------------------------------------------
// 2026-11-03 H2Z OS：多网口、没有无线网卡、设备信息 / 时间 / 电源 / 设备名称
// ---------------------------------------------------------------------------------------------------
function x86({ synced = false, ntpBackend = 'chrony', extra = {} } = {}) {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='enp1s0'\nLAN_IFS='enp1s0 enp2s0'\nAP_IF=''\n");
  writeFileSync(join(etc, 'netplan/20-h2z-lan.yaml'), renderNetplanPorts([{ iface: 'enp1s0', cfg: { mode: 'dhcp' } }, { iface: 'enp2s0', cfg: { mode: 'dhcp' } }], { primary: 'enp1s0' }));
  const calls = [];
  const t = Date.parse('2026-11-03T15:00:00Z');
  const host = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'cat') {
      const f = args[0];
      if (f.endsWith('/carrier')) return f.includes('enp2s0') ? '0\n' : '1\n';
      if (f.endsWith('/speed')) return f.includes('enp2s0') ? '-1\n' : '1000\n';
      if (f.endsWith('/address')) return f.includes('enp2s0') ? '00:e0:4c:68:12:02\n' : '00:e0:4c:68:12:01\n';
      if (f === '/usr/share/h2z/os-release') return 'H2ZOS_VERSION=0.1.3\nH2ZOS_BUILD_DATE=2026-11-03T01:00:00Z\nH2ZOS_REPO_COMMIT=9f2c1ab\nH2ZOS_KERNEL=6.12.48-amd64\n';
      if (f.endsWith('product_serial')) return 'To be filled by O.E.M.\n';
      if (f.endsWith('sys_vendor')) return 'Intel Corporation\n';
      if (f.endsWith('product_name')) return 'NUC12WSHi5\n';
      if (f === '/proc/uptime') return '1051200.5 100\n';
      if (f === '/proc/cpuinfo') return 'processor : 0\nmodel name\t: 12th Gen Intel(R) Core(TM) i5-1240P\n';
      if (f === '/proc/meminfo') return 'MemTotal:       16000000 kB\n';
      if (f.endsWith('h2z.sources')) return '# Managed\nserver 10.20.1.1 iburst\n';
      throw new Error('no such file');
    }
    if (cmd === 'ip' && args.includes('addr')) return args.includes('enp1s0') ? JSON.stringify([{ addr_info: [{ local: '10.20.1.15', prefixlen: 24, dynamic: true, label: 'enp1s0' }] }]) : '[]';
    if (cmd === 'ip' && args.includes('route')) return args.includes('enp1s0') ? JSON.stringify([{ gateway: '10.20.1.1' }]) : '[]';
    if (cmd === 'hostname') return 'H2Z-1201\n';
    if (cmd === 'readlink') throw new Error('not linked');
    if (cmd === 'test') return '';
    if (cmd === 'git') return '9f2c1ab\n2026-11-03T08:00:00+00:00\nHEAD -> claude/h2zos-system, origin/claude/h2zos-system\n';
    if (cmd === 'sh' && args[1] === 'command -v chronyc') { if (ntpBackend === 'chrony') return '/usr/bin/chronyc\n'; throw new Error('none'); }
    if (cmd === 'systemctl' && args[0] === 'cat') { if (ntpBackend === 'timesyncd') return ''; throw new Error('none'); }
    if (cmd === 'systemctl' && args[0] === 'is-active') return 'active\n';
    if (cmd === 'timedatectl' && args[0] === 'show') return `Timezone=America/Chicago\nNTP=yes\nNTPSynchronized=${synced ? 'yes' : 'no'}\n`;
    if (cmd === 'timedatectl' && args[0] === 'list-timezones') return 'America/Chicago\nAsia/Shanghai\nUTC\n';
    if (cmd === 'chronyc' && args[1] === 'tracking') return 'A9FEA9FE,10.20.1.1,3,1762182000.1,0.000003210,0.000001,0.00002,1.2,0.1,0.01,0.001,0.002,64.0,Normal\n';
    if (cmd === 'resolvectl') throw new Error('no resolved');
    return '';
  };
  const agent = createAgent({ hostEtc: etc, host, now: () => t, rollbackMs: 180_000, tailscaleSocket: join(etc, 'none.sock'), ...extra });
  return { etc, agent, calls, file: () => readFileSync(join(etc, 'netplan/20-h2z-lan.yaml'), 'utf8') };
}

test('netplan with two ports: only the primary carries a default route; single port renders as before', () => {
  const ports = [
    { iface: 'enp1s0', cfg: { mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.1.1', dns: ['10.20.1.1'] } },
    { iface: 'enp2s0', cfg: { mode: 'dhcp' } },
  ];
  const y = renderNetplanPorts(ports, { primary: 'enp1s0' });
  assert.match(y, /# h2z-primary: enp1s0/);
  assert.match(y, /enp2s0:\n {6}dhcp4: true\n {6}dhcp6: true\n {6}optional: true\n {6}dhcp4-overrides:\n {8}use-routes: false/);
  assert.deepEqual(parseNetplanPorts(y), { ports, primary: 'enp1s0', vlans: [] });
  const moved = renderNetplanPorts([{ iface: 'enp1s0', cfg: { mode: 'off' } }, { iface: 'enp2s0', cfg: { mode: 'static', address: '192.168.10.250', prefix: 24, gateway: '192.168.10.1', dns: [] } }], { primary: 'enp2s0' });
  assert.equal(parseNetplanPorts(moved).primary, 'enp2s0');
  assert.deepEqual(parseNetplanPorts(moved).ports[0].cfg, { mode: 'off' });
  assert.match(moved, /via: 192\.168\.10\.1/);
  // 单网口（Orange Pi）输出和以前逐字节一样：没有 primary 注释、没有 optional
  assert.equal(renderNetplan('eth0', { mode: 'dhcp' }), '# Managed by H2Z host-agent (IOC admin → 设备网络). Original files: /etc/h2z/netplan-orig/\nnetwork:\n  version: 2\n  renderer: networkd\n  ethernets:\n    eth0:\n      dhcp4: true\n      dhcp6: true\n');
  assert.deepEqual(parseNetplan(y), ports[0].cfg, 'parseNetplan = first port');
});

test('two ports: per-port apply, gateway only on the primary, moving the default route, no overlap, status lists ports', async () => {
  const b = x86();
  const st = await b.agent.status();
  assert.equal(st.ready, true, 'no WiFi is fine');
  assert.equal(st.ap.available, false);
  assert.deepEqual(st.lan.ports.map((p) => [p.label, p.iface, p.carrier, p.speed, p.primary, p.mac]), [['网口 1', 'enp1s0', true, 1000, true, '00:E0:4C:68:12:01'], ['网口 2', 'enp2s0', false, null, false, '00:E0:4C:68:12:02']]);
  assert.equal(st.lan.ports[0].dynamic, true);
  await assert.rejects(b.agent.setAp('open'), /没有无线网卡/);
  await assert.rejects(b.agent.applyLan({ iface: 'enp2s0', mode: 'static', address: '192.168.10.250', prefix: 24, gateway: '192.168.10.1' }), /网关只能设在默认网关网口上/);
  await assert.rejects(b.agent.applyLan({ iface: 'enp1s0', mode: 'off' }), /默认网关网口不能停用/);
  await assert.rejects(b.agent.applyLan({ iface: 'eth9', mode: 'dhcp' }), /没有这个网口/);
  const p = await b.agent.applyLan({ iface: 'enp2s0', mode: 'static', address: '192.168.10.250', prefix: 24, note: '摄像头网' });
  assert.equal(p.iface, 'enp2s0');
  let plan = parseNetplanPorts(b.file());
  assert.deepEqual(plan.ports[1].cfg, { mode: 'static', address: '192.168.10.250', prefix: 24, gateway: '', dns: [] });
  assert.deepEqual(plan.ports[0].cfg, { mode: 'dhcp' }, 'other port untouched');
  await b.agent.confirmLan();
  assert.equal((await b.agent.status()).lan.ports[1].note, '摄像头网');
  // 网口 1 静态带网关，然后把默认网关挪到网口 2：网口 1 保留地址、去掉网关
  await b.agent.applyLan({ iface: 'enp1s0', mode: 'static', address: '10.20.1.15', prefix: 24, gateway: '10.20.1.1' });
  await b.agent.confirmLan();
  await assert.rejects(b.agent.applyLan({ iface: 'enp2s0', mode: 'static', address: '10.20.1.16', prefix: 24 }), /同一个网段/);
  await b.agent.applyLan({ iface: 'enp2s0', mode: 'static', address: '192.168.10.250', prefix: 24, gateway: '192.168.10.1', primary: true });
  plan = parseNetplanPorts(b.file());
  assert.equal(plan.primary, 'enp2s0');
  assert.equal(plan.ports[0].cfg.gateway, '', 'old primary loses its gateway');
  assert.equal(plan.ports[0].cfg.address, '10.20.1.15');
  assert.equal(plan.ports[1].cfg.gateway, '192.168.10.1');
  // 回滚把两个网口一起恢复
  await b.agent.rollbackLan();
  plan = parseNetplanPorts(b.file());
  assert.equal(plan.primary, 'enp1s0');
  assert.equal(plan.ports[0].cfg.gateway, '10.20.1.1');
  assert.ok(readFileSync(join(b.etc, 'h2z/audit.log'), 'utf8').includes('"action":"lan-rollback"'));
});

test('device info: serial from DMI or MAC, H2Z OS version, app commit, time status', async () => {
  assert.equal(deviceSerial('To be filled by O.E.M.', '00:e0:4c:68:12:01'), 'H2Z00E04C681201');
  assert.equal(deviceSerial('G6NB1234ABC', 'x'), 'G6NB1234ABC');
  assert.equal(deviceSerial('', ''), '');
  assert.deepEqual(parseNtpServers('# x\nserver 10.20.1.1 iburst\npool pool.ntp.org iburst\n', 'chrony'), ['10.20.1.1', 'pool.ntp.org']);
  assert.deepEqual(parseNtpServers('[Time]\nNTP=10.0.0.1 time.cloudflare.com\n', 'timesyncd'), ['10.0.0.1', 'time.cloudflare.com']);
  const b = x86();
  const sys = await b.agent.system();
  assert.equal(sys.hostname, 'H2Z-1201');
  assert.equal(sys.deviceName, 'H2Z-1201', 'defaults to the hostname');
  assert.equal(sys.serial, 'H2Z00E04C681201');
  assert.deepEqual(sys.os, { name: 'H2Z OS', version: '0.1.3', buildDate: '2026-11-03T01:00:00Z', commit: '9f2c1ab', kernel: '6.12.48-amd64', chrome: '' });
  assert.deepEqual(sys.app, { repo: '/opt/h2z.security', commit: '9f2c1ab', date: '2026-11-03T08:00:00+00:00', branch: 'claude/h2zos-system' });
  assert.equal(sys.model.cpu, '12th Gen Intel(R) Core(TM) i5-1240P');
  assert.equal(sys.uptimeSec, 1051201);
  assert.deepEqual(sys.time.ntp, { backend: 'chrony', enabled: true, synced: false, servers: ['10.20.1.1'], offsetMs: 0 });
  assert.equal(sys.time.timezone, 'America/Chicago');
  await b.agent.setName({ name: '  LA9 仓库录像机 ' });
  assert.equal((await b.agent.system()).deviceName, 'LA9 仓库录像机');
  await assert.rejects(b.agent.setName({ name: '' }), /1–32/);
  assert.equal((await b.agent.system()).lang, 'en', 'factory default is English');
  await assert.rejects(b.agent.setLang({ lang: 'fr' }), /en 或 zh-CN/);
  assert.deepEqual(await b.agent.setLang({ lang: 'zh-CN' }), { lang: 'zh-CN' });
  assert.equal((await b.agent.system()).lang, 'zh-CN');
  await b.agent.setLang({ lang: 'en' });
  assert.equal((await b.agent.system()).lang, 'en');
});

test('time: timezone validated and set, NTP servers written for chrony / timesyncd, manual time refused while synced', async () => {
  const b = x86();
  await assert.rejects(b.agent.setTime({ timezone: 'Mars/Base' }), /没有这个时区/);
  await assert.rejects(b.agent.setTime({ timezone: '../etc' }), /时区格式不对/);
  await assert.rejects(b.agent.setTime({ ntp: { servers: ['bad host!'] } }), /NTP 服务器格式不对/);
  await b.agent.setTime({ timezone: 'Asia/Shanghai', ntp: { enabled: true, servers: '10.20.1.1, pool.ntp.org' } });
  assert.ok(b.calls.includes('timedatectl set-timezone Asia/Shanghai'));
  const w = b.calls.find((c) => c.startsWith('sh -c mkdir'));
  assert.match(w, /\/etc\/chrony\/sources\.d\/h2z\.sources/);
  assert.match(w, /server 10\.20\.1\.1 iburst\nserver pool\.ntp\.org iburst/);
  assert.ok(b.calls.includes('systemctl enable --now chrony'));
  await b.agent.setTime({ setTime: Date.parse('2026-11-03T15:00:00Z') });
  assert.ok(b.calls.includes('date -u -s @' + Date.parse('2026-11-03T15:00:00Z') / 1000));
  const synced = x86({ synced: true });
  await assert.rejects(synced.agent.setTime({ setTime: Date.parse('2026-11-03T15:00:00Z') }), /已经自动对时/);
  const ts = x86({ ntpBackend: 'timesyncd' });
  await ts.agent.setTime({ ntp: { enabled: false, servers: ['10.0.0.1'] } });
  assert.match(ts.calls.find((c) => c.startsWith('sh -c mkdir')), /timesyncd\.conf\.d\/h2z\.conf.*NTP=10\.0\.0\.1/s);
  assert.ok(ts.calls.includes('timedatectl set-ntp false'));
});

test('power: scheduled on the host a few seconds later, audited; unknown action refused', async () => {
  const b = x86();
  await assert.rejects(b.agent.power({ action: 'format' }), /action 只能是/);
  assert.deepEqual(await b.agent.power({ action: 'reboot', by: 'local-console' }), { scheduled: 'reboot', inSeconds: 3 });
  assert.ok(b.calls.some((c) => /^systemd-run --quiet --unit=h2z-power-\d+ --on-active=3s .* \/usr\/bin\/systemctl reboot$/.test(c)));
  await b.agent.power({ action: 'restart-app' });
  assert.ok(b.calls.some((c) => c.endsWith('/bin/sh -c cd "$1" && docker compose restart sh /opt/h2z.security')));
  const log = readFileSync(join(b.etc, 'h2z/audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((x) => [x.action, x.op, x.by || '']), [['power', 'reboot', 'local-console'], ['power', 'restart-app', '']]);
});

test('POST /v1/link/factory-reset: 404 without H2Z_LINK_DIR; needs the confirm string; schedules the shared script on the host, audited', async () => {
  await assert.rejects(x86().agent.linkFactoryReset({ confirm: 'RESET-EDGE' }), (e) => e.status === 404);
  const dir = mkdtempSync(join(tmpdir(), 'link-'));
  const b = x86({ extra: { linkDir: dir } });
  await assert.rejects(b.agent.linkFactoryReset({}), /RESET-EDGE/);
  await assert.rejects(b.agent.linkFactoryReset({ confirm: 'yes' }), /RESET-EDGE/);
  assert.ok(!b.calls.some((c) => c.startsWith('systemd-run')), 'no confirm = nothing scheduled');
  assert.deepEqual(await b.agent.linkFactoryReset({ confirm: 'RESET-EDGE', by: 'admin' }), { scheduled: 'edge-factory-reset', inSeconds: 3 });
  assert.ok(b.calls.some((c) => /^systemd-run --quiet --unit=h2z-edge-reset-\d+ --on-active=3s .* \/bin\/sh -c cd "\$1" && sh scripts\/edge-factory-reset\.sh --yes sh \/opt\/h2z\.security$/.test(c)), b.calls.join('\n'));
  const log = readFileSync(join(b.etc, 'h2z/audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((x) => [x.action, x.by || '']), [['edge-factory-reset', 'admin']]);
  rmSync(dir, { recursive: true, force: true });
});

test('system routes on the unix socket API', async () => {
  const b = x86();
  const server = createServer(b.agent);
  const sock = join(b.etc, 'a.sock');
  await new Promise((r) => server.listen(sock, r));
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    assert.equal((await call('GET', '/v1/system')).body.serial, 'H2Z00E04C681201');
    assert.equal((await call('POST', '/v1/name', { name: 'NVR-1' })).body.deviceName, 'NVR-1');
    assert.equal((await call('POST', '/v1/power', { action: 'x' })).status, 400);
    assert.equal((await call('POST', '/v1/lan/note', { iface: 'enp2s0', note: '摄像头网' })).body.note, '摄像头网');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// 2026-11-03 H2Z OS 整包升级（.h2zup）：验签、校验、上传、U 盘、准备、交给 h2z-os-upgrade
// ---------------------------------------------------------------------------------------------------
import { generateKeyPairSync, sign as edSign, createHash as sha } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

function makePackage(dir, { key, version = '0.1.4', fromMin = '0.1.0', osFiles = ['usr/local/sbin/h2z-os-upgrade', 'usr/share/h2z/splash.html'], tamper = '', arch = 'amd64' } = {}) {
  const w = join(dir, 'pkg-' + Math.random().toString(36).slice(2));
  mkdirSync(join(w, 'os'), { recursive: true });
  for (const f of osFiles) { mkdirSync(join(w, 'os', f, '..'), { recursive: true }); writeFileSync(join(w, 'os', f), '#!/bin/bash\necho ' + f + '\n'); }
  execFileSync('tar', ['--format=ustar', '-cf', join(w, 'os-files.tar'), '-C', join(w, 'os'), ...osFiles]);
  writeFileSync(join(w, 'repo.bundle'), 'bundle');
  writeFileSync(join(w, 'images.tar'), 'images-' + 'x'.repeat(3000));
  const h = (f) => sha('sha256').update(readFileSync(join(w, f))).digest('hex');
  const man = { format: 1, product: 'H2Z OS', arch, version, fromMin, created: '2026-11-03T06:00:00Z', notes: '录像服务 1.6.2',
    repo: { branch: 'claude/h2zos-system', commit: 'abcdef1234567' }, images: ['ghcr.io/h2ztech/ioc:latest', 'ghcr.io/h2ztech/recorder:1.6'],
    files: { 'repo.bundle': h('repo.bundle'), 'os-files.tar': h('os-files.tar'), 'images.tar': h('images.tar') } };
  const manText = JSON.stringify(man);
  writeFileSync(join(w, 'manifest.json'), manText);
  writeFileSync(join(w, 'manifest.sig'), edSign(null, Buffer.from(manText), key).toString('base64'));
  if (tamper === 'images') writeFileSync(join(w, 'images.tar'), 'images-' + 'y'.repeat(3000));
  if (tamper === 'manifest') writeFileSync(join(w, 'manifest.json'), manText.replace('0.1.4', '0.9.9'));
  const out = join(dir, 'h2zos-update-' + version + (tamper ? '-' + tamper : '') + '.h2zup');
  execFileSync('tar', ['--format=ustar', '-cf', out, '-C', w, 'manifest.json', 'manifest.sig', 'repo.bundle', 'os-files.tar', 'images.tar']);
  return out;
}

function upgradeBox({ pub, version = '0.1.3' } = {}) {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='enp1s0'\nAP_IF=''\n");
  const up = join(etc, 'upgrade'); mkdirSync(up);
  const calls = [], loaded = [];
  const host = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'cat' && args[0] === '/usr/share/h2z/os-release') return version ? 'H2ZOS_VERSION=' + version + '\nH2ZOS_REPO_COMMIT=9f2c1ab\n' : (() => { throw new Error('no'); })();
    if (cmd === 'cat' && args[0] === '/usr/share/h2z/update-pubkey.pem') { if (!pub) throw new Error('no'); return pub; }
    if (cmd === 'uname') return 'x86_64\n';
    if (cmd === 'readlink') throw new Error('not linked');
    if (cmd === 'test') return '';
    if (cmd === 'git' && args.includes('rev-parse')) return '9f2c1ab0000000000000000000000000000000aa\n';
    if (cmd === 'git' && args.includes('symbolic-ref')) return 'main\n';
    if (cmd === 'docker' && args[0] === 'image') return 'sha256:old-' + args.at(-1).split('/').pop() + '\n';
    if (cmd === 'tar') return execFileSync('tar', args, { encoding: 'utf8' }); // host paths = the same directory in this test
    if (cmd === 'lsblk') return JSON.stringify({ blockdevices: [
      { name: 'sda', tran: 'sata', children: [{ name: 'sda1', path: '/dev/sda1', fstype: 'ext4' }] },
      { name: 'sdb', tran: 'usb', children: [{ name: 'sdb1', path: '/dev/sdb1', fstype: 'exfat', label: 'KINGSTON', mountpoint: join(etc, 'usb') }] },
      { name: 'sdc', tran: 'usb', children: [{ name: 'sdc1', path: '/dev/sdc1', fstype: 'ext4', label: 'H2ZINSTALL' }] },
    ] });
    if (cmd === 'find') { const real = args.map((a) => a.replace(/^\/run\/h2z-usb\/sdb1/, join(etc, 'usb'))); return execFileSync('find', real, { encoding: 'utf8' }).replaceAll(join(etc, 'usb'), '/run/h2z-usb/sdb1'); }
    if (cmd === 'cp') { execFileSync('cp', args.map((a) => a.replace(/^\/run\/h2z-usb\/sdb1/, join(etc, 'usb')))); return ''; }
    return '';
  };
  const spawnHost = (args) => {
    const chunks = [];
    const child = new (require_events())();
    child.stdin = new (require_stream().Writable)({ write(c, _e, cb) { chunks.push(c); cb(); }, final(cb) { loaded.push(Buffer.concat(chunks).toString()); cb(); setImmediate(() => child.emit('close', 0)); } });
    child.stderr = new (require_events())();
    calls.push('spawn ' + args.join(' '));
    return child;
  };
  const agent = createAgent({ hostEtc: etc, host, spawnHost, upgradeDir: up, upgradeHostDir: up, tailscaleSocket: join(etc, 'none.sock') });
  return { etc, up, agent, calls, loaded };
}
import { EventEmitter } from 'node:events';
import * as streamMod from 'node:stream';
const require_events = () => EventEmitter;
const require_stream = () => streamMod;
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

test('upgrade helpers: tar index, version compare, allowed OS files', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const pkg = makePackage(dir, { key: privateKey });
  const idx = await tarIndex(pkg);
  assert.deepEqual([...idx.keys()], ['manifest.json', 'manifest.sig', 'repo.bundle', 'os-files.tar', 'images.tar']);
  assert.equal(idx.get('repo.bundle').size, 6);
  assert.equal(cmpVersion('0.1.10', '0.1.9'), 1);
  assert.equal(cmpVersion('0.1.3', '0.1.3'), 0);
  assert.equal(cmpVersion('0.1.0-202611030101', '0.1.0-202611020101'), 1);
  assert.deepEqual(osFileProblems('-rw-r--r-- root/root 1 2026-11-03 01:00 usr/share/h2z/splash.html\ndrwxr-xr-x root/root 0 2026-11-03 01:00 etc/\n-rw-r--r-- root/root 1 2026-11-03 01:00 etc/shadow\n-rw-r--r-- root/root 1 2026-11-03 01:00 usr/share/h2z/../../../etc/x'), ['etc/shadow', 'usr/share/h2z/../../../etc/x']);
  assert.deepEqual(osFileProblems('drwxr-xr-x root/root 0 2026-11-03 01:00 etc/systemd/system/docker.service.d/\n-rw-r--r-- root/root 1 2026-11-03 01:00 etc/systemd/system/docker.service.d/10-h2z.conf\n-rw-r--r-- root/root 1 2026-11-03 01:00 etc/systemd/system/docker.service.d/99-evil.conf'), ['etc/systemd/system/docker.service.d/99-evil.conf'], 'docker 的 drop-in 只允许 10-h2z.conf');
});

test('upgrade: upload over the socket → verified; tampered parts, wrong key, too old, wrong arch refused', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const b = upgradeBox({ pub });
  const server = createServer(b.agent);
  const sock = join(b.etc, 'a.sock');
  await new Promise((r) => server.listen(sock, r));
  const upload = (file) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/upgrade/upload', headers: { 'content-type': 'application/octet-stream' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); createReadStream(file).pipe(req);
  });
  try {
    const st0 = await b.agent.upgradeStatus();
    assert.equal(st0.available, true);
    assert.deepEqual(st0.current, { version: '0.1.3', commit: '9f2c1ab', branch: '' });
    const ok = await upload(makePackage(dir, { key: privateKey }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.version, '0.1.4');
    assert.equal(ok.body.downgrade, false);
    assert.equal(ok.body.source, 'upload');
    assert.equal((await b.agent.upgradeStatus()).staged.version, '0.1.4');
    const bad = async (opts, re) => { const r = await upload(makePackage(dir, { key: privateKey, ...opts })); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.message, re); assert.equal((await b.agent.upgradeStatus()).staged, null, '失败后没有暂存的包'); };
    await bad({ tamper: 'images' }, /images\.tar 的校验和不对/);
    await bad({ tamper: 'manifest' }, /签名不对/);
    await bad({ key: generateKeyPairSync('ed25519').privateKey }, /签名不对/);
    await bad({ fromMin: '0.2.0' }, /太旧/);
    await bad({ arch: 'arm64' }, /arm64 的/);
    const junk = join(dir, 'junk.h2zup'); writeFileSync(junk, 'x'.repeat(2000));
    assert.equal((await upload(junk)).status, 400);
    const down = await upload(makePackage(dir, { key: privateKey, version: '0.1.2' }));
    assert.equal(down.body.downgrade, true);
  } finally {
    server.close();
  }
  // 不是 H2Z OS / 没有公钥：不能用
  assert.match((await upgradeBox({ pub: '' }).agent.upgradeStatus()).reason, /没有升级公钥/);
  assert.match((await upgradeBox({ pub, version: '' }).agent.upgradeStatus()).reason, /不是 H2Z OS/);
});

test('upgrade: start loads the images from the package, records the versions to go back to, hands over to h2z-os-upgrade', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const b = upgradeBox({ pub });
  await assert.rejects(b.agent.upgradeStart({}), /还没有验证过的升级包/);
  const pkg = makePackage(dir, { key: privateKey });
  writeFileSync(join(b.up, 'incoming.h2zup'), readFileSync(pkg));
  // U 盘：只列 U 盘根目录的 .h2zup，不碰安装盘；导入 = 拷过来再验
  mkdirSync(join(b.etc, 'usb'));
  writeFileSync(join(b.etc, 'usb', 'h2zos-update-0.1.4.h2zup'), readFileSync(pkg));
  const usb = await b.agent.usbScan();
  assert.deepEqual(usb.sticks.map((x) => [x.device, x.files.map((f) => f.name)]), [['/dev/sdb1', ['h2zos-update-0.1.4.h2zup']]]);
  await assert.rejects(b.agent.usbImport({ path: '/etc/passwd' }), /只能从 U 盘根目录/);
  // 测试里 U 盘挂在临时目录（路径规则只认 /run/h2z-usb、/media、/mnt）：这里改用上传
  const server = createServer(b.agent);
  const sock = join(b.etc, 'a.sock');
  await new Promise((r) => server.listen(sock, r));
  await new Promise((resolve, reject) => { const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/upgrade/upload' }, (res) => { res.resume(); res.on('end', resolve); }); req.on('error', reject); createReadStream(pkg).pipe(req); });
  server.close();
  assert.deepEqual(await b.agent.upgradeStart({ by: 'local-console 127.0.0.1' }), { started: true, version: '0.1.4' });
  await assert.rejects(b.agent.upgradeStart({}), /正在升级/);
  const st = await waitFor(async () => { const s2 = await b.agent.upgradeStatus(); return s2.state?.phase === "switching" && s2.state; });
  assert.equal(st.phase, 'switching', JSON.stringify(st));
  assert.deepEqual(st.from, { version: '0.1.3', commit: '9f2c1ab', branch: 'main' });
  assert.deepEqual(st.to, { version: '0.1.4', commit: 'abcdef1', branch: 'claude/h2zos-system' });
  assert.deepEqual(st.prev.images, { 'ghcr.io/h2ztech/ioc:latest': 'sha256:old-ioc:latest', 'ghcr.io/h2ztech/recorder:1.6': 'sha256:old-recorder:1.6' });
  assert.equal(st.repoPath, '/opt/h2z.security');
  assert.equal(b.loaded[0], 'images-' + 'x'.repeat(3000), 'docker load 读的正是升级包里的 images.tar');
  assert.ok(existsSync(join(b.up, 'work/repo.bundle')) && existsSync(join(b.up, 'work/usr/local/sbin/h2z-os-upgrade')));
  assert.ok(b.calls.some((c) => new RegExp('^systemd-run --quiet --collect --unit=h2z-os-upgrade-\\d+ /bin/bash ' + b.up + '/work/usr/local/sbin/h2z-os-upgrade apply ' + b.up + '$').test(c)), b.calls.filter((c) => c.startsWith('systemd-run')).join('\n'));
  assert.ok(readFileSync(join(b.etc, 'h2z/audit.log'), 'utf8').includes('"action":"upgrade-start"'));
  // 切换中不能回退；失败的也不能；升级完成后才能回退
  await assert.rejects(b.agent.upgradeRollback({}), /正在升级/);
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ ...st, phase: 'failed' }));
  await assert.rejects(b.agent.upgradeRollback({}), /升级完成后/);
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ ...st, phase: 'done' }));
  assert.equal((await b.agent.upgradeStatus()).canRollback, true);
  await b.agent.upgradeRollback({});
  assert.ok(b.calls.some((c) => c.includes('/usr/local/sbin/h2z-os-upgrade rollback ' + b.up + ' manual')));
});

test('upgrade: a package with system files outside the allowed paths fails before anything switches; images put back', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const b = upgradeBox({ pub });
  const pkg = makePackage(dir, { key: privateKey, osFiles: ['usr/local/sbin/h2z-os-upgrade', 'etc/sudoers.d/evil'] });
  const server = createServer(b.agent);
  const sock = join(b.etc, 'a.sock');
  await new Promise((r) => server.listen(sock, r));
  await new Promise((resolve, reject) => { const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/upgrade/upload' }, (res) => { res.resume(); res.on('end', resolve); }); req.on('error', reject); createReadStream(pkg).pipe(req); });
  server.close();
  await b.agent.upgradeStart({});
  const st = await waitFor(async () => { const s2 = await b.agent.upgradeStatus(); return !s2.busy && s2.state; });
  assert.equal(st.phase, 'failed');
  assert.match(st.message, /不允许的系统文件：etc\/sudoers\.d\/evil/);
  assert.match(st.message, /没有切换版本/);
  assert.equal(b.loaded.length, 0, '没导入镜像');
  assert.ok(b.calls.includes('docker tag sha256:old-ioc:latest ghcr.io/h2ztech/ioc:latest'));
  assert.ok(!b.calls.some((c) => c.startsWith('systemd-run')));
  // 失败后可以丢掉暂存的包
  assert.deepEqual(await b.agent.upgradeDiscard(), { discarded: true });
  assert.equal((await b.agent.upgradeStatus()).staged, null);
});

test('upgrade (review fixes): concurrent uploads refused, tampering after verification caught at start, downgrade needs confirmation, USB import', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const b = upgradeBox({ pub });
  // 1. 一个上传还没传完，第二个上传直接拒绝（不会共用临时文件）
  const slow = new Readable({ read() {} });
  const first = b.agent.upgradeUpload(slow);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(b.agent.upgradeUpload(Readable.from([Buffer.from('x')])), /另一个升级操作正在进行/);
  await assert.rejects(b.agent.upgradeStart({}), /另一个升级操作正在进行/);
  slow.push(readFileSync(makePackage(dir, { key: privateKey }))); slow.push(null);
  assert.equal((await first).version, '0.1.4');
  // 2. 验证之后 incoming 被换成改过的内容：开始时在副本上重新校验，发现后不执行、不导入
  const evil = makePackage(dir, { key: privateKey, osFiles: ['usr/local/sbin/h2z-os-upgrade'] });
  const buf = readFileSync(evil);
  const at = buf.indexOf('#!/bin/bash');
  buf.write('#!/bin/evil', at);
  writeFileSync(join(b.up, 'incoming.h2zup'), buf);
  await b.agent.upgradeStart({});
  let st = await waitFor(async () => { const s2 = await b.agent.upgradeStatus(); return !s2.busy && s2.state; });
  assert.equal(st.phase, 'failed');
  assert.match(st.message, /os-files\.tar 的校验和不对/);
  assert.equal(b.loaded.length, 0);
  assert.ok(!b.calls.some((c) => c.startsWith('systemd-run')));
  // 3. 降级要明确确认；USB 导入只认我们自己挂的 U 盘根目录里的普通文件
  mkdirSync(join(b.etc, 'usb'));
  writeFileSync(join(b.etc, 'usb', 'h2zos-update-0.1.2.h2zup'), readFileSync(makePackage(dir, { key: privateKey, version: '0.1.2' })));
  const scan = await b.agent.usbScan();
  assert.deepEqual(scan.sticks.map((x) => [x.mount, x.files.map((f) => f.name)]), [['/run/h2z-usb/sdb1', ['h2zos-update-0.1.2.h2zup']]]);
  await assert.rejects(b.agent.usbImport({ path: '/mnt/x/a.h2zup' }), /只能从 U 盘根目录/);
  await assert.rejects(b.agent.usbImport({ path: '/run/h2z-usb/sdb1/../x.h2zup' }), /只能从 U 盘根目录/);
  await assert.rejects(b.agent.usbImport({ path: '/run/h2z-usb/sdb1/missing.h2zup' }), /没有这个升级包/);
  const staged = await b.agent.usbImport({ path: '/run/h2z-usb/sdb1/h2zos-update-0.1.2.h2zup' });
  assert.deepEqual([staged.version, staged.downgrade, staged.source], ['0.1.2', true, 'usb']);
  assert.ok(b.calls.includes('umount /run/h2z-usb/sdb1'));
  await assert.rejects(b.agent.upgradeStart({}), /确认要降级/);
  assert.deepEqual(await b.agent.upgradeStart({ allowDowngrade: true }), { started: true, version: '0.1.2' });
  st = await waitFor(async () => { const s2 = await b.agent.upgradeStatus(); return !s2.upOp && s2.state?.phase === 'switching' && s2.state; });
  assert.equal(st.to.version, '0.1.2');
  assert.equal(existsSync(join(b.up, 'work/images.tar')), false, '导入后删掉副本，空间还给录像');
});

test('upgrade (review fixes): a preparation cut off by a host-agent restart is marked failed; a host step silent for 20 min is not busy', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const b = upgradeBox({ pub: publicKey.export({ type: 'spki', format: 'pem' }) });
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ phase: 'loading', updatedAt: new Date().toISOString(), prev: { images: { 'h2z/ioc:latest': 'sha256:old' } } }));
  writeFileSync(join(b.up, 'incoming-abc.part'), 'x');
  assert.equal(await b.agent.recoverUpgrade(), 'interrupted');
  const st = (await b.agent.upgradeStatus()).state;
  assert.equal(st.phase, 'failed');
  assert.ok(b.calls.includes('docker tag sha256:old h2z/ioc:latest'));
  assert.equal(existsSync(join(b.up, 'incoming-abc.part')), false);
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ phase: 'checking', updatedAt: new Date(Date.now() - 2 * 60_000).toISOString() }));
  assert.equal((await b.agent.upgradeStatus()).busy, true);
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ phase: 'checking', updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() }));
  assert.equal((await b.agent.upgradeStatus()).busy, false, '20 分钟没动静的宿主机步骤不算在跑（断电等）');
  assert.deepEqual(osFileProblems('-rwsr-xr-x root/root 1 2026-11-03 01:00 usr/local/sbin/h2z-x'), ['usr/local/sbin/h2z-x（带 setuid / setgid）']);
});

test('LAN (review fixes): rollback timer is monotonic; time cannot be changed while a LAN change waits for confirmation', async () => {
  const b = x86();
  await b.agent.applyLan({ iface: 'enp2s0', mode: 'static', address: '192.168.10.250', prefix: 24 });
  const st = await b.agent.status();
  assert.equal(st.lan.pending.remainingMs, 180_000);
  await assert.rejects(b.agent.setTime({ timezone: 'UTC' }), /等待确认/);
  await b.agent.confirmLan();
  await b.agent.setTime({ timezone: 'UTC' });
  // 单调钟和墙上时钟分开：墙上时钟往后跳 1 小时，不会立刻回滚
  let wall = Date.parse('2026-11-03T15:00:00Z'), m = 0;
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='eth0'\nAP_IF=''\n");
  writeFileSync(join(etc, 'netplan/20-h2z-lan.yaml'), renderNetplan('eth0', { mode: 'dhcp' }));
  const a = createAgent({ hostEtc: etc, host: async () => '', now: () => wall, mono: () => m, rollbackMs: 180_000, tailscaleSocket: join(etc, 'x') });
  await a.applyLan({ mode: 'static', address: '10.0.0.5', prefix: 24 });
  wall += 3600_000;
  assert.equal(await a.tick(), 'pending', '墙上时钟跳了也不回滚');
  m += 181_000;
  assert.equal(await a.tick(), 'rolled-back');
  // host-agent 重启后只剩墙上时钟的截止时间：时钟往回调过，最多再等一个完整窗口
  await a.applyLan({ mode: 'static', address: '10.0.0.5', prefix: 24 });
  wall -= 10 * 3600_000;
  const a2 = createAgent({ hostEtc: etc, host: async () => '', now: () => wall, mono: () => m, rollbackMs: 180_000, tailscaleSocket: join(etc, 'x') });
  assert.equal((await a2.status()).lan.pending.remainingMs, 180_000);
});

test('LAN: the confirmation window starts after netplan apply has finished', async () => {
  let m = 0;
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='eth0'\nAP_IF=''\n");
  writeFileSync(join(etc, 'netplan/20-h2z-lan.yaml'), renderNetplan('eth0', { mode: 'dhcp' }));
  const host = async (cmd) => { if (cmd === 'netplan') m += 60_000; return ''; }; // a slow netplan apply: 60 s
  const a = createAgent({ hostEtc: etc, host, now: () => Date.parse('2026-11-03T15:00:00Z') + m, mono: () => m, rollbackMs: 180_000, tailscaleSocket: join(etc, 'x') });
  await a.applyLan({ mode: 'static', address: '10.0.0.5', prefix: 24 });
  assert.equal((await a.status()).lan.pending.remainingMs, 180_000, 'full 3 minutes after the change took effect');
});

test('langFromEnv：H2Z_LANG 带引号 / 不带引号都认', async () => {
  const { langFromEnv } = await import('./host-agent.mjs');
  assert.equal(langFromEnv('H2Z_LANG="zh-CN"\n'), 'zh-CN');
  assert.equal(langFromEnv("H2Z_LANG='zh-CN'\n"), 'zh-CN');
  assert.equal(langFromEnv('A=1\nH2Z_LANG=zh-CN\n'), 'zh-CN');
  assert.equal(langFromEnv('H2Z_LANG="en"\n'), 'en');
  assert.equal(langFromEnv(''), 'en');
});

// ---- 「远程接入」是扩展包：没装（没有 tailscale 命令行）不是故障 ----
test('Tailscale 命令行不在：状态是 installed:false（不报错）；登录 / 退出回 409 并说明要重新 up', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'h2z-ts-'));
  const agent = createAgent({ hostEtc: etc, host: async () => '', tailscaleCli: join(etc, 'no-such-tailscale'), tailscaleSocket: join(etc, 'none.sock') });
  const st = await agent.status();
  assert.equal(st.tailscale.installed, false);
  assert.equal(st.tailscale.available, false, '老前端只看 available：照旧显示不可用');
  assert.match(st.tailscale.reason, /命令行/);
  for (const call of [() => agent.tailscaleLogin({}), () => agent.tailscaleLogin({ authKey: 'tskey-abc' }), () => agent.tailscaleLogout()]) {
    await assert.rejects(call(), (e) => e.code === 'E_TAILSCALE_NOT_INSTALLED' && e.status === 409 && /docker compose up/.test(e.message));
  }
});

test('Tailscale 装了但没在跑：installed:true、available:false；在跑：installed:true 加上原来的字段', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'h2z-ts-'));
  const cli = join(etc, 'tailscale');
  writeFileSync(cli, '#!/bin/sh\n');
  const sock = join(etc, 'tailscaled.sock');
  const down = createAgent({ hostEtc: etc, host: async () => '', tailscaleCli: cli, tailscaleSocket: sock });
  const st = await down.status();
  assert.equal(st.tailscale.installed, true);
  assert.equal(st.tailscale.available, false);
  assert.equal(st.tailscale.reason, 'Tailscale 服务没有运行');
  writeFileSync(sock, '');
  const json = JSON.stringify({ BackendState: 'Running', Self: { HostName: 'h2z-ab12', DNSName: 'h2z-ab12.tail1.ts.net.', TailscaleIPs: ['100.90.1.2'], Online: true } });
  const up = createAgent({ hostEtc: etc, host: async () => '', tailscaleCli: cli, tailscaleSocket: sock, local: async () => json });
  const ok = (await up.status()).tailscale;
  assert.equal(ok.installed, true);
  assert.equal(ok.available, true);
  assert.equal(ok.state, 'Running');
  assert.deepEqual(ok.ips, ['100.90.1.2']);
  const broken = createAgent({ hostEtc: etc, host: async () => '', tailscaleCli: cli, tailscaleSocket: sock, local: async () => { const e = new Error('x'); e.stderr = 'failed to connect to local tailscaled'; throw e; } });
  const b = (await broken.status()).tailscale;
  assert.equal(b.installed, true);
  assert.equal(b.available, false);
  assert.match(b.reason, /failed to connect/);
});

test('升级完成后：已装上的旧包 / 旧的在线下载不再显示，回到可检查状态；真的更新的包还在', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const b = upgradeBox({ pub: publicKey.export({ type: 'spki', format: 'pem' }), version: '0.2.9' });
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ phase: 'done', updatedAt: new Date().toISOString(), to: { version: '0.2.9' } }));
  writeFileSync(join(b.up, 'staged.json'), JSON.stringify({ version: '0.2.9', sizeBytes: 1 }));
  writeFileSync(join(b.up, 'incoming.h2zup'), 'x');
  writeFileSync(join(b.up, 'online.json'), JSON.stringify({ state: 'ready', latest: { version: '0.2.6' } }));
  const st = await b.agent.upgradeStatus();
  assert.equal(st.staged, null, '同版本的已装包不再显示');
  assert.equal(existsSync(join(b.up, 'staged.json')), false);
  assert.equal(existsSync(join(b.up, 'incoming.h2zup')), false);
  assert.equal((await b.agent.onlineStatus()).state, 'idle', '0.2.6 比当前 0.2.9 旧：作废，回到可检查');
  writeFileSync(join(b.up, 'staged.json'), JSON.stringify({ version: '0.3.0', sizeBytes: 1 }));
  writeFileSync(join(b.up, 'online.json'), JSON.stringify({ state: 'ready', latest: { version: '0.3.0' } }));
  assert.equal((await b.agent.upgradeStatus()).staged?.version, '0.3.0', '更新的包保留');
  assert.equal((await b.agent.onlineStatus()).state, 'ready');
});

test('Tailscale 启用开关：on 调 up、off 调 down；状态带 enabled 和账号；参数不对 400', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'h2z-ts-'));
  const cli = join(etc, 'tailscale');
  writeFileSync(cli, '#!/bin/sh\n');
  const sock = join(etc, 'tailscaled.sock');
  writeFileSync(sock, '');
  const calls = [];
  let state = 'Running';
  const local = async (bin, args) => {
    calls.push(args.filter((a) => !a.startsWith('--socket')).join(' '));
    if (args.includes('down')) state = 'Stopped';
    if (args.includes('up')) state = 'Running';
    return JSON.stringify({ BackendState: state, Self: { HostName: 'h2z-ab12', UserID: 7, TailscaleIPs: ['100.90.1.2'], Online: state === 'Running' }, User: { 7: { LoginName: 'a@b.com' } } });
  };
  const agent = createAgent({ hostEtc: etc, host: async () => '', tailscaleCli: cli, tailscaleSocket: sock, local });
  const off = await agent.tailscaleEnable({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.account, 'a@b.com');
  assert.ok(calls.some((c) => c === 'down'));
  const on = await agent.tailscaleEnable({ enabled: true });
  assert.equal(on.enabled, true);
  assert.ok(calls.some((c) => c.startsWith('up ')));
  await assert.rejects(agent.tailscaleEnable({ enabled: 'yes' }), (e) => e.code === 'E_PARAM');
});

test('upgrade: upload interrupted by the client — the file handle is closed and the .part removed (deleted files must not keep holding disk space)', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const b = upgradeBox({ pub: publicKey.export({ type: 'spki', format: 'pem' }) });
  const { PassThrough } = streamMod;
  const openUp = () => readdirSync('/proc/self/fd').map((f) => { try { return readlinkSync('/proc/self/fd/' + f); } catch { return ''; } }).filter((l) => l.includes(b.up));
  for (const how of ['aborted', 'error']) {
    const req = new PassThrough();
    const up = b.agent.upgradeUpload(req);
    req.write(Buffer.alloc(2 ** 20, 1));
    await waitFor(() => openUp().length === 1);
    setTimeout(() => (how === 'aborted' ? req.emit('aborted') : req.emit('error', new Error('socket hang up'))), 50);
    await assert.rejects(up);
    await waitFor(() => openUp().length === 0);
    assert.deepEqual(readdirSync(b.up).filter((f) => f.endsWith('.part')), [], how + ': .part removed');
    req.destroy();
  }
});

test('display: modes come from the connected monitor, resolution validated, saved in kiosk.env, local screen restarted', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z'));
  writeFileSync(join(etc, 'h2z/kiosk.env'), '# kiosk\nH2Z_KIOSK_RESOLUTION=1920x1080\nH2Z_KIOSK_MODE=x11\n');
  const calls = [];
  const host = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'sh') return 'card0-HDMI-A-1|connected|1920x1080 1280x720 3840x2160 1920x1080i 1280x720 \ncard0-DP-1|disconnected|\n';
    return '';
  };
  const agent = createAgent({ hostEtc: etc, host, now: () => 1, tailscaleSocket: join(etc, 'none.sock') });
  const st = await agent.displayStatus();
  assert.equal(st.setting, '1920x1080');
  assert.equal(st.connected, true);
  assert.deepEqual(st.modes, ['3840x2160', '1920x1080', '1280x720'], 'biggest first, interlaced / duplicates dropped');
  assert.deepEqual(st.outputs.map((o) => [o.name, o.connected]), [['HDMI-A-1', true], ['DP-1', false]]);
  await assert.rejects(agent.setDisplay({ resolution: '1024x768' }), /不支持/);
  await assert.rejects(agent.setDisplay({ resolution: 'big' }), /auto/);
  assert.deepEqual(await agent.setDisplay({ resolution: '1280x720' }), { resolution: '1280x720', restartInSeconds: 3 });
  assert.equal(readFileSync(join(etc, 'h2z/kiosk.env'), 'utf8'), '# kiosk\nH2Z_KIOSK_RESOLUTION=1280x720\nH2Z_KIOSK_MODE=x11\n', 'only that line changes');
  assert.ok(calls.some((c) => c.startsWith('systemd-run') && c.includes('h2z-kiosk-restart')));
  await agent.setDisplay({ resolution: 'auto' });
  assert.match(readFileSync(join(etc, 'h2z/kiosk.env'), 'utf8'), /H2Z_KIOSK_RESOLUTION=auto/);
});

// ----- 旁挂机器（不是 H2Z OS）的更新：git + scripts/update.sh，同一套检查 → 下载 → 升级界面 -----
function gitBox({ behind = 3, fetchFails = false } = {}) {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  writeFileSync(join(etc, 'h2z/host.env'), "LAN_IF='enp1s0'\nAP_IF=''\n");
  const up = join(etc, 'upgrade'); mkdirSync(up);
  const calls = [];
  const world = { behind, head: 'aaa1111', fetchFails };
  const host = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'cat') throw new Error('no such file'); // 没有 /usr/share/h2z/os-release：不是 H2Z OS
    if (cmd === 'readlink') return '/opt/h2z.security/host/systemd/h2z-maint-ap.service\n';
    if (cmd === 'sh' && args[0] === '-c' && /test -f/.test(args[1])) return 'yes\n';
    if (cmd === 'sh' && args[0] === '-c' && /getent/.test(args[1])) return '/home/jackie\n';
    if (cmd === 'stat') return 'jackie\n';
    if (cmd === 'runuser') {
      const script = args[args.indexOf('-c') + 1];
      if (/git fetch/.test(script) && world.fetchFails) { const e = new Error('x'); e.stderr = 'Permission denied (publickey).'; throw e; }
      if (/git diff --name-only/.test(script)) return ['bbb2222', '2026-11-11', String(world.behind), 'compose.yaml scripts/x.mjs ', 'fix: 修 A', 'feat: 加 B'].join('\n') + '\n';
      if (/rev-parse --short HEAD/.test(script)) return world.head + '\nmain\n2026-11-10\n';
      if (/rev-list --count/.test(script)) return String(world.behind) + '\n';
      return '';
    }
    return '';
  };
  const spawnHost = (args) => {
    const child = new (require_events())();
    child.stderr = new (require_events())();
    calls.push('spawn ' + args.join(' '));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const agent = createAgent({ hostEtc: etc, host, spawnHost, upgradeDir: up, upgradeHostDir: up, tailscaleSocket: join(etc, 'none.sock') });
  return { etc, up, agent, calls, world };
}

test('旁挂更新：不是 H2Z OS 但有 update.sh → 页面可用（mode git，没有「不是 H2Z OS」的限制），当前版本是提交', async () => {
  const b = gitBox();
  const st = await b.agent.upgradeStatus();
  assert.equal(st.available, true);
  assert.equal(st.reason, '');
  assert.equal(st.mode, 'git');
  assert.equal(st.current.commit, 'aaa1111');
  assert.equal(st.current.branch, 'main');
  assert.equal(st.canRollback, false);
  assert.equal(st.online.state, 'idle');
  assert.equal(st.busy, false);
});

test('旁挂更新：检查 = git fetch 看落后几个提交，提交标题是更新说明；已追平 = latest；fetch 失败 = error 带原因', async () => {
  const b = gitBox({ behind: 2 });
  const r = await b.agent.onlineCheck({});
  assert.equal(r.state, 'available');
  assert.deepEqual(r.latest.notes, ['fix: 修 A', 'feat: 加 B']);
  assert.match(r.latest.version, /^bbb2222/);
  assert.equal(r.latest.restartsRecorder, true, '改了 compose.yaml：录像服务多半要重建');
  assert.ok(b.calls.some((c) => /^runuser -u jackie -- env HOME=\/home\/jackie sh -c cd "\$1" && git fetch/.test(c)), '以部署目录属主的身份跑 git（用他的部署密钥）');
  b.world.behind = 0;
  const same = await b.agent.onlineCheck({});
  assert.equal(same.state, 'latest');
  assert.equal(same.latest, null);
  const bad = gitBox({ fetchFails: true });
  await assert.rejects(bad.agent.onlineCheck({}), (e) => e.code === 'E_GIT_FETCH' && /Permission denied/.test(e.message));
  const s = await bad.agent.onlineStatus();
  assert.equal(s.state, 'error');
  assert.equal(s.error.code, 'E_GIT_FETCH');
});

test('旁挂更新：下载 = 拉代码（--ff-only）+ docker compose pull，不重启容器；没检查过就不让下载', async () => {
  const b = gitBox();
  await assert.rejects(b.agent.onlineFetch({}), /先检查更新/);
  await b.agent.onlineCheck({});
  const r = await b.agent.onlineFetch({});
  assert.equal(r.started, true);
  await waitFor(async () => (await b.agent.onlineStatus()).state === 'ready');
  const spawned = b.calls.filter((c) => c.startsWith('spawn '));
  assert.equal(spawned.length, 2);
  assert.match(spawned[0], /git merge --ff-only/);
  assert.match(spawned[1], /docker compose pull/);
  assert.ok(!b.calls.some((c) => /docker compose up|systemd-run/.test(c)), '下载阶段不重启任何东西');
});

test('旁挂更新：升级 = 先写「备份数据库」状态，再 systemd-run 起宿主脚本 git-update.sh（带部署目录 / 属主 / 状态目录）；没下载好不让开始', async () => {
  const b = gitBox();
  await assert.rejects(b.agent.upgradeStart({ source: 'online' }), /还没下载好/);
  await b.agent.onlineCheck({});
  await b.agent.onlineFetch({});
  await waitFor(async () => (await b.agent.onlineStatus()).state === 'ready');
  const r = await b.agent.upgradeStart({ source: 'online' });
  assert.deepEqual(r, { started: true, source: 'git' });
  const run = b.calls.find((c) => c.startsWith('systemd-run '));
  assert.match(run, /--unit=h2z-git-update-\d+ sh \/opt\/h2z\.security\/host\/git-update\.sh \/opt\/h2z\.security jackie /);
  assert.ok(run.endsWith(' ' + b.up), '状态目录');
  const state = JSON.parse(readFileSync(join(b.up, 'state.json'), 'utf8'));
  assert.equal(state.job, 'git');
  assert.equal(state.phase, 'backing-up');
  assert.equal(state.from.commit, 'aaa1111');
  const st = await b.agent.upgradeStatus();
  assert.equal(st.busy, true, '宿主脚本在跑：忙');
  assert.equal(st.online.state, 'ready', '升级中不把「已下载」作废');
  await assert.rejects(b.agent.onlineCheck({}), /稍后再检查|正在升级/, '升级中不能再检查');
});

test('旁挂更新：下载好（fetch 已把代码合并，HEAD 追平上游）之后仍是「已下载」，能开始升级；HEAD 被改动才作废', async () => {
  const b = gitBox();
  await b.agent.onlineCheck({});
  // fetch 里的 git merge --ff-only 会让 HEAD 追平上游（模拟）
  b.world.behind = 0; b.world.head = 'bbb2222';
  await b.agent.onlineFetch({});
  await waitFor(async () => (await b.agent.onlineStatus()).state === 'ready');
  assert.equal((await b.agent.onlineStatus()).state, 'ready', '追平不等于作废');
  assert.deepEqual(await b.agent.upgradeStart({ source: 'online' }), { started: true, source: 'git' });
});

test('旁挂更新：已下载后有人手动换了 HEAD → 作废', async () => {
  const b = gitBox();
  await b.agent.onlineCheck({});
  await b.agent.onlineFetch({});
  await waitFor(async () => (await b.agent.onlineStatus()).state === 'ready');
  b.world.head = 'ccc3333';
  assert.equal((await b.agent.onlineStatus()).state, 'idle');
});

test('旁挂更新：升级完成后「已下载」作废（追平了）；页面不能回退（给出手动办法）；重启 host-agent 不把进行中的更新标成中断', async () => {
  const b = gitBox();
  await b.agent.onlineCheck({});
  await b.agent.onlineFetch({});
  await waitFor(async () => (await b.agent.onlineStatus()).state === 'ready');
  await b.agent.upgradeStart({ source: 'online' });
  // 宿主脚本写 done（模拟），并且代码已经追平
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ job: 'git', source: 'online', phase: 'done', message: '已更新到 bbb2222', from: { version: 'aaa1111', commit: 'aaa1111' }, to: { version: 'bbb2222', commit: 'bbb2222' }, updatedAt: new Date().toISOString() }));
  b.world.behind = 0; b.world.head = 'bbb2222';
  assert.equal((await b.agent.onlineStatus()).state, 'idle');
  await assert.rejects(b.agent.upgradeRollback({}), /不能在页面回退/);
  // host-agent 重启（update.sh 会重建它）：备份 / 切换中的 git 更新不能被「准备时重启 = 中断」的恢复逻辑改成 failed
  writeFileSync(join(b.up, 'state.json'), JSON.stringify({ job: 'git', source: 'online', phase: 'backing-up', updatedAt: new Date().toISOString() }));
  assert.equal(await b.agent.recoverUpgrade(), 'ok');
  assert.equal(JSON.parse(readFileSync(join(b.up, 'state.json'), 'utf8')).phase, 'backing-up');
});

test('旁挂更新：没有 update.sh / git-update.sh 的机器仍然是「不是 H2Z OS」（不开页面更新）', async () => {
  const etc = mkdtempSync(join(tmpdir(), 'ha-'));
  mkdirSync(join(etc, 'h2z')); mkdirSync(join(etc, 'netplan'));
  const host = async (cmd, args) => { if (cmd === 'cat') throw new Error('no'); if (cmd === 'readlink') return '/opt/h2z.security/host/systemd/h2z-maint-ap.service\n'; return ''; };
  const agent = createAgent({ hostEtc: etc, host, upgradeDir: join(etc, 'upgrade'), upgradeHostDir: join(etc, 'upgrade'), tailscaleSocket: join(etc, 'none.sock') });
  const st = await agent.upgradeStatus();
  assert.equal(st.available, false);
  assert.match(st.reason, /不是 H2Z OS/);
});

test('GET /v1/link: 404 without H2Z_LINK_DIR; with it: LAN addresses (not the hotspot), lan.json for edge-link, edge status', async () => {
  const b = board();
  await assert.rejects(b.agent.link(), (e) => e.status === 404 && e.code === 'E_NOT_FOUND');
  const dir = mkdtempSync(join(tmpdir(), 'link-'));
  const nets = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], enP3p49s0: [{ address: '10.0.0.236', family: 'IPv4', cidr: '10.0.0.236/24' }], wlan0: [{ address: '192.168.234.1', family: 'IPv4' }], docker0: [{ address: '172.17.0.1', family: 'IPv4' }] };
  const mk = (extra) => createAgent({ hostEtc: b.etc, host: async () => '', now: () => 1_800_000_000_000, tailscaleSocket: join(b.etc, 'none.sock'), networkInterfaces: () => nets, linkDir: dir, ...extra });
  // loopback-only binding: the web UI is not reachable from the LAN, no LAN address is advertised
  let r = await mk({}).link();
  assert.deepEqual(r.lan.addresses, []);
  assert.deepEqual(r.lan.ips, ['10.0.0.236'], 'IPv4 list is given regardless of exposure; no hotspot / docker / loopback');
  assert.equal(r.lan.exposed, false);
  assert.equal(r.edge, null);
  assert.equal(r.edgeRunning, false);
  // exposed to the LAN, IOC without login -> flagged
  r = await mk({ linkHttpBind: '0.0.0.0', linkHttpPort: 8096, linkIocAuth: 'none' }).link();
  assert.deepEqual(r.lan.addresses, [{ iface: 'enP3p49s0', ip: '10.0.0.236', port: 8096, url: 'http://10.0.0.236:8096' }]);
  assert.equal(r.lan.lanOpenWithoutLogin, true);
  const lanFile = JSON.parse(readFileSync(join(dir, 'lan.json'), 'utf8'));
  assert.equal(lanFile.addresses[0].ip, '10.0.0.236');
  assert.equal(lanFile.at, 1_800_000_000);
  // 契约 §13.1：iroh 固定 UDP 端口 + 局域网 IPv4（不管网页是否对局域网开放）
  assert.deepEqual(lanFile.iroh, { port: 11204, addrs: [{ ip: '10.0.0.236', port: 11204 }] });
  await mk({ linkIrohPort: 12000 }).link();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'lan.json'), 'utf8')).iroh, { port: 12000, addrs: [{ ip: '10.0.0.236', port: 12000 }] });
  // edge-link status.json: fresh = running, stale = not running
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ service: 'edge-link', state: 'online', clock: 'ok', writtenAt: 1_799_999_990 }));
  r = await mk({ linkHttpBind: '0.0.0.0', linkIocAuth: 'token' }).link();
  assert.equal(r.edge.state, 'online');
  assert.equal(r.edgeRunning, true);
  assert.equal(r.lan.lanOpenWithoutLogin, false);
  // 契约 §13.2：对外入口有 nginx 登录门（H2Z_LINK_LAN_AUTH=on）时不算「没登录」，即使 IOC_AUTH=none；没配 = 老部署，仍按原规则
  r = await mk({ linkHttpBind: '0.0.0.0', linkIocAuth: 'none', linkLanAuth: 'on' }).link();
  assert.deepEqual([r.lan.lanAuth, r.lan.lanOpenWithoutLogin], ['on', false]);
  r = await mk({ linkHttpBind: '0.0.0.0', linkIocAuth: 'none', linkLanAuth: 'off' }).link();
  assert.deepEqual([r.lan.lanAuth, r.lan.lanOpenWithoutLogin], ['off', true]);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ writtenAt: 1_799_999_000 }));
  assert.equal((await mk({}).link()).edgeRunning, false);
  rmSync(dir, { recursive: true, force: true });
});

test('WS-Discovery：带出设备自己声明的类型和 Profile（录像机不当摄像头加，FM-138）', () => {
  const xml = '<d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:9</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types>' +
    '<d:Scopes>onvif://www.onvif.org/type/Network_Video_Storage onvif://www.onvif.org/Profile/G onvif://www.onvif.org/hardware/G-REC-16</d:Scopes><d:XAddrs>http://10.0.0.5/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches>';
  const [w] = parseWsDiscovery(xml, '10.0.0.5');
  assert.deepEqual(w.onvifType, ['Network_Video_Storage']);
  assert.deepEqual(w.profiles, ['G']);
  const [d] = mergeDiscovered([w], []);
  assert.deepEqual([d.onvifType, d.profiles], [['Network_Video_Storage'], ['G']]);
  const [cam] = parseWsDiscovery(xml.replace('type/Network_Video_Storage', 'type/video_encoder').replace('Profile/G', 'Profile/Streaming'), '10.0.0.5');
  assert.deepEqual([cam.onvifType, cam.profiles], [['video_encoder'], ['S']]);
});
