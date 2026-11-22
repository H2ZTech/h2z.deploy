// node --test scripts/host-network-agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siteNetworks, writeSnapshot, excludedNetworks, overlaps } from './host-network-agent.mjs';

const v4 = (address, netmask) => ({ address, netmask, family: 'IPv4', internal: false });
const board = {
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  end0: [v4('10.0.0.236', '255.255.255.0')],
  wlan0: [v4('192.168.8.20', '255.255.255.0')],
  docker0: [v4('172.17.0.1', '255.255.0.0')],
  'br-3f2a1c': [v4('172.18.0.1', '255.255.0.0')],
  veth12ab: [v4('169.254.10.2', '255.255.0.0')],
  tailscale0: [v4('100.101.1.2', '255.255.255.255')],
};

test('only site NICs: Docker bridges, veth, Tailscale, loopback and link-local are skipped', () => {
  assert.deepEqual(siteNetworks(board).cidrs, ['10.0.0.0/24', '192.168.8.0/24']);
  assert.deepEqual(siteNetworks({ docker0: board.docker0 }).cidrs, [], 'cable unplugged: no site network');
});

test('snapshot is written atomically with a timestamp the backend checks for freshness', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hn-')), 'host-network.json');
  writeSnapshot(file, board, new Date('2026-10-11T03:00:00Z'));
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.updatedAt, '2026-10-11T03:00:00.000Z');
  assert.deepEqual(doc.cidrs, ['10.0.0.0/24', '192.168.8.0/24']);
  assert.deepEqual(doc.interfaces[0], { name: 'end0', address: '10.0.0.236', cidr: '10.0.0.0/24' });
  writeSnapshot(file, { end0: [v4('10.20.4.9', '255.255.252.0')] }, new Date('2026-10-11T03:00:10Z'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).cidrs, ['10.20.4.0/22'], 'new cable / DHCP lease is picked up');
});

test('the maintenance hotspot network is never a site network', () => {
  const withAp = { end0: [v4('10.0.0.236', '255.255.255.0')], wlan0: [v4('192.168.234.1', '255.255.255.0')] };
  assert.deepEqual(siteNetworks(withAp).cidrs, ['10.0.0.0/24'], 'default excludes 192.168.234.0/24');
  assert.deepEqual(siteNetworks(withAp, []).cidrs, ['10.0.0.0/24', '192.168.234.0/24']);
  assert.deepEqual(siteNetworks(withAp, ['192.168.0.0/16']).cidrs, ['10.0.0.0/24'], 'overlap by supernet');
  assert.deepEqual(excludedNetworks({}), ['192.168.234.0/24']);
  assert.deepEqual(excludedNetworks({ H2Z_EXCLUDED_NETWORKS: '192.168.50.7/24, junk' }), ['192.168.50.0/24']);
  assert.deepEqual(excludedNetworks({ H2Z_EXCLUDED_NETWORKS: '' }), []);
  assert.equal(overlaps('10.0.0.0/8', '10.20.0.0/16'), true);
  assert.equal(overlaps('10.0.0.0/24', '10.0.1.0/24'), false);
});

test('snapshot records the excluded networks for the backend', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hn-')), 'host-network.json');
  const doc = writeSnapshot(file, { wlan0: [v4('192.168.234.1', '255.255.255.0')] }, new Date('2026-10-16T00:00:00Z'));
  assert.deepEqual(doc.cidrs, []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).excluded, ['192.168.234.0/24']);
});
