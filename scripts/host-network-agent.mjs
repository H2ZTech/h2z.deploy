// Host network agent: runs with `network_mode: host`, so os.networkInterfaces() returns the
// board's real NICs (not the 172.x Docker bridge the backend sees). Every few seconds it writes
// the site CIDRs the board is currently attached to (whatever DHCP / the plugged-in cable gave)
// as {updatedAt, cidrs, interfaces} to a shared volume. The IOC backend reads it per task via
// IOC_HOST_NETWORK_FILE and uses it as the default exploration scope (still human-approved).
//
// Networks listed in H2Z_EXCLUDED_NETWORKS (comma separated CIDRs; default: the maintenance WiFi
// hotspot 192.168.234.0/24 from host/setup-host-network.sh) are never published as site networks,
// so exploration never targets the hotspot. They are also written as `excluded` for the backend.
//
// Usage: node host-network-agent.mjs <output.json> [intervalSeconds]
import os from 'node:os';
import { writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Same virtual-interface filter as h2z.backend apps/ioc/src/network/host-scope.ts.
export const VIRTUAL = /(docker|veth|^br-|vethernet|wsl|hyper-v|vmware|virtualbox|vbox|tailscale|zerotier|wireguard|^wg\d|^utun|^tun|^tap|loopback|npcap|vpn|cni|flannel|calico|podman)/i;

const toInt = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const prefixOf = (mask) => { let b = 0; for (let i = 31; i >= 0 && (mask >>> i) & 1; i--) b++; return b; };

/** Parse "a.b.c.d/n" into [network, mask] (null when invalid). */
export function parseCidr(text) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const ip = toInt(m[1]); const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { net: (ip & mask) >>> 0, mask, prefix, cidr: `${toIp((ip & mask) >>> 0)}/${prefix}` };
}

/** True when the two CIDRs share any address. */
export function overlaps(a, b) {
  const x = parseCidr(a); const y = parseCidr(b);
  if (!x || !y) return false;
  const mask = x.prefix < y.prefix ? x.mask : y.mask;
  return ((x.net & mask) >>> 0) === ((y.net & mask) >>> 0);
}

export const DEFAULT_EXCLUDED = ['192.168.234.0/24'];

export function excludedNetworks(env = process.env) {
  const raw = env.H2Z_EXCLUDED_NETWORKS;
  const list = raw === undefined ? DEFAULT_EXCLUDED : String(raw).split(/[,\s]+/).filter(Boolean);
  return [...new Set(list.map((c) => parseCidr(c)?.cidr).filter(Boolean))];
}

/** Site-facing IPv4 networks of the given interface table. */
export function siteNetworks(ifaces = os.networkInterfaces(), excluded = DEFAULT_EXCLUDED) {
  const interfaces = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if (a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
      const ip = toInt(a.address); const mask = toInt(a.netmask);
      if (ip === null || mask === null) continue;
      if (a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
      const prefix = prefixOf(mask);
      if (prefix < 8 || prefix > 32) continue;
      const cidr = `${toIp((ip & mask) >>> 0)}/${prefix}`;
      if (excluded.some((x) => overlaps(x, cidr))) continue;
      interfaces.push({ name, address: a.address, cidr });
    }
  }
  return { cidrs: [...new Set(interfaces.map((i) => i.cidr))].slice(0, 32), interfaces };
}

export function writeSnapshot(file, ifaces, now = new Date(), excluded = DEFAULT_EXCLUDED) {
  const doc = { updatedAt: now.toISOString(), ...siteNetworks(ifaces, excluded), excluded };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc) + '\n', { mode: 0o644 });
  renameSync(tmp, file);
  return doc;
}

function main() {
  const [file, intervalArg] = process.argv.slice(2);
  if (!file) { console.error('usage: host-network-agent.mjs <output.json> [intervalSeconds]'); process.exit(2); }
  const intervalMs = Math.max(2, Number(intervalArg || 10)) * 1000;
  const excluded = excludedNetworks();
  let last = '';
  const tick = () => {
    try {
      const doc = writeSnapshot(file, undefined, new Date(), excluded);
      const now = doc.cidrs.join(',');
      if (now !== last) { console.log(`host-network: ${now || 'no site network'} (${doc.interfaces.map((i) => `${i.name}=${i.address}`).join(' ') || '-'})`); last = now; }
    } catch (e) { console.error(`host-network: ${e.message}`); }
  };
  tick();
  setInterval(tick, intervalMs);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
