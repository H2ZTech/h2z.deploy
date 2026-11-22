// H2Z host agent: the only component that changes the board's own network. It runs as a privileged
// container (host network + host PID) and executes host tools through `nsenter -t 1` (netplan, ip,
// systemctl, iw), so it uses exactly the tools installed by host/setup-host-network.sh. The IOC backend
// talks to it over a unix socket (no TCP port); the backend checks the device password first.
//
//   GET  /v1/status                       LAN, maintenance hotspot, Tailscale
//   POST /v1/lan {mode, address, prefix, gateway, dns, vlans?}   apply; rolled back unless confirmed in time.
//        vlans: [{id, address, prefix}] = 802.1Q sub-interfaces on the LAN port (trunk port: one IP per VLAN,
//        no gateway). Omit mode to change only the VLANs (current LAN settings kept); omit vlans to keep them.
//        iface? (default LAN_IF) + primary?: true + mode 'off' for multi-port boxes (x86: uplink + camera network)
//   POST /v1/lan/note {iface, note}       port label only ("摄像头网")
//   GET  /v1/system                       device name, serial, model, H2Z OS / app version, uptime, time + NTP
//   POST /v1/time {timezone?, ntp?: {enabled, servers[]}, setTime?: epoch ms}
//   POST /v1/name {name}                  device name (NVR "设备名称"); hostname unchanged
//   POST /v1/lang {lang: en|zh-CN}        UI language of the boot screen / text console (H2Z_LANG in /etc/h2z/os.env); GET /v1/system returns lang
//   GET  /v1/display / POST /v1/display {resolution: auto|WxH}  HDMI resolution (H2Z_KIOSK_RESOLUTION in /etc/h2z/kiosk.env; the local screen restarts 3 s later)
//   POST /v1/power {action: restart-app|reboot|shutdown}  runs 3 s later on the host; every change is in /etc/h2z/audit.log
//   GET  /v1/upgrade                      H2Z OS full-package upgrade: current version, staged package, progress
//   POST /v1/upgrade/upload  (raw body)   upload a .h2zup → verified (Ed25519 signature, sha256 of every part)
//   POST /v1/upgrade/usb/scan | /usb/import {path}   packages in the root of a USB stick (mounted read-only)
//   POST /v1/upgrade/start | /discard | /rollback     start (load images, then h2z-os-upgrade apply on the host) /
//                                         throw the staged package away / go back to the version before the last upgrade
//   POST /v1/lan/confirm                  keep the applied LAN settings
//   POST /v1/lan/rollback                 restore the previous LAN settings now
//   POST /v1/ap {action: open|close, minutes?}  open (or keep open) for `minutes` (default AP_WINDOW_MIN,
//                                         5–480; e.g. 10 = "shorten") / close until next boot
//   POST /v1/tailscale/login {authKey?}   auth key login, or start interactive login (returns the URL)
//   POST /v1/tailscale/logout
//   POST /v1/tailscale/enable {enabled}   switch on (tailscale up) / off (tailscale down); the login is kept
//   GET  /v1/link                         iroh edge-link (only where H2Z_LINK_DIR is set, else 404): LAN addresses + edge status summary
//   POST /v1/l2-scan {cidrs[]}            layer-2 neighbour scan of on-link networks (IP ↔ MAC, read-only)
//   POST /v1/cameras/discover {seconds?}  camera discovery on the attached networks: ONVIF WS-Discovery + Hikvision
//                                         SADP multicast (read-only, a few seconds, never the hotspot network)
//   POST /v1/cameras/activate {mac, password, method?, network?}  activate an unactivated camera (method: 'sadp', Hikvision
//                                         only so far; candidate recipe, see h2z.security/docs/HIKVISION-SADP-ACTIVATE-2026-11-21.md
//                                         — exchangecode/activate crypto is inferred from a packet capture, not yet verified).
//                                         network given → also sends `update` (network params incl. static IP) right after
//                                         activate succeeds: {dhcp:true} or {dhcp:false, ipv4Address, ipv4SubnetMask, ipv4Gateway?}.
//                                         update's auth field is tried as 4 candidate SHA-512 digest formulas against the real
//                                         device, first Result=success wins — also unverified, see the same doc's 2026-11-21 补充.
//
// Usage: node host-agent.mjs   (settings from env, see DEFAULTS)
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promises as fsp, existsSync, chmodSync, chownSync, unlinkSync, statfsSync, createReadStream, createWriteStream } from 'node:fs';
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  generateKeyPairSync,
  privateDecrypt,
  createCipheriv,
  randomBytes as randomBytesSync,
  constants as cryptoConstants,
} from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// 在线更新（C 版 docker2/compose.yaml 才把 online-update.mjs / pack-source.mjs 挂进来；板子 B 版没有这两个文件：导入失败 = 没有这个功能，GET /v1/upgrade 不带 online 对象）
const OU = await import('./online-update.mjs').catch(() => null);
const PS = await import('./pack-source.mjs').catch(() => null);
// Cloudflare 穿透（C 版 docker2/compose.yaml 才挂 cf-tunnel.mjs；板子 B 版没有这个文件：导入失败 = 没有这个功能，/v1/tunnel* 回 404）
const CF = await import('./cf-tunnel.mjs').catch(() => null);
// Meta Muse 连接器（C 版 docker2/compose.yaml 才挂 muse.mjs；B 版没有这个文件：导入失败 = 没有这个功能，/v1/muse* 回 404）
const MUSE = await import('./muse.mjs').catch(() => null);
const MUSE_ASK_MAX_BODY = 24 << 20; // /v1/muse/ask 带抓图（base64），请求体上限放宽到 24 MB；其他路由仍是 64 KB
const repoOfImg = OU?.repoOf || ((r) => r);
const { OnlineError = class extends Error {}, verifySigned, parseIndex, parseOnlineManifest, pullRef, restartsRecorder, ghcrReleaseFetch, backupsToDelete } = OU || {};

export const DEFAULTS = {
  upgradeDir: '/upgrade', // host /var/lib/h2z/upgrade (H2Z OS: → /data/h2z-upgrade)
  upgradeHostDir: '/var/lib/h2z/upgrade',
  upgradeMaxBytes: 8 * 2 ** 30,
  socket: '/run/h2z-host/agent.sock',
  hostEtc: '/host/etc', // host /etc/h2z and /etc/netplan are mounted below this
  tailscaleCli: '/opt/tailscale/tailscale',
  tailscaleSocket: '/var/run/tailscale/tailscaled.sock',
  socketGroup: 20001,
  rollbackMs: 180_000,
  // 扩展包（H2Z OS 瘦底座，compose.lean.yaml 设 H2Z_PACKS=1 并挂 packs.mjs / 目录；板子的 compose.yaml 没有这些，/v1/packs* 回 404 no route）
  packsEnabled: false,
  packsDir: '/packs', // 宿主 /var/lib/h2z/packs（H2Z OS：→ /data/h2z-packs）
  packsHostDir: '/var/lib/h2z/packs',
  packsCatalog: '/agent/packs.catalog.json',
  packsNoRestart: [], // 这条部署线上「装 / 停 / 启 / 卸不会重建 backend」的包（目录里 restartsConsole 是 B / C 共用的，C 用 H2Z_PACKS_NO_RESTART 覆盖）
  packsMaxBytes: 8 * 2 ** 30,
  // Cloudflare 穿透：对外网址缺省值（试点由 .env 的 TUNNEL_DEFAULT_HOSTNAME 给）、宿主上 cloudflared 程序路径、连接器指标端口
  tunnelDefaultHostname: '',
  tunnelBin: '',
  tunnelMetricsPort: 0,
  // Meta Muse 连接器（scripts/muse.mjs）：接口地址缺省 api.meta.ai；限流额度空 / 0 = 用 muse.mjs 里的缺省（并发 4、每分钟 60 次、每天 100 万 token；daily 写 0 = 不限）
  museBaseUrl: '',
  museDailyTokens: undefined,
  museRpm: 0,
  museMaxConcurrent: 0,
};

export class AgentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------------
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const ipToInt = (ip) => {
  const m = IPV4.exec(String(ip || '').trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);


// ---------------------------------------------------------------------------------------------------
// layer-2 neighbour scan (2026-10-25): the exploration runs in a NAT container and can neither see the
// board's VLAN at layer 2 nor learn MAC addresses. This agent runs on the host network, so it can make
// the kernel resolve every address of an on-link network (one tiny UDP datagram each triggers an ARP
// request; no raw socket or extra capability) and read the neighbour table back. Read-only, rate limited,
// never the maintenance hotspot network, only networks the board is directly attached to.
// ---------------------------------------------------------------------------------------------------
export const L2_MIN_PREFIX = 22; // at most 1024 addresses per network
export const L2_MAX_TOTAL = 2048; // addresses per request
export const L2_MAX_CIDRS = 8;

const cidrParts = (c) => {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(c || '').trim());
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const net = (ip & maskOf(prefix)) >>> 0;
  return { net, prefix, size: prefix === 32 ? 1 : 2 ** (32 - prefix) };
};
export const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const insideNet = (inner, outer) => inner.prefix >= outer.prefix && ((inner.net & maskOf(outer.prefix)) >>> 0) === outer.net;
const overlapNet = (a, b) => insideNet(a, b) || insideNet(b, a);

/** `ip -4 -o addr show` → [{iface, ip, prefix}] */
export function parseIpAddrs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\d+:\s+(\S+)\s+inet (\d+(?:\.\d+){3})\/(\d+)/.exec(line.trim());
    if (m) out.push({ iface: m[1], ip: m[2], prefix: Number(m[3]) });
  }
  return out;
}

/** /proc/net/arp → complete entries only (flags 0x2; incomplete ones show 00:00:00:00:00:00 / 0x0) */
export function parseArpTable(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [ip, , flags, mac, , iface] = f;
    if (ipToInt(ip) === null || !(parseInt(flags, 16) & 2)) continue;
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) || /^(00:){5}00$/i.test(mac)) continue;
    out.push({ ip, mac: mac.toUpperCase(), iface });
  }
  return out;
}

/**
 * Decide what is scanned. Returns {targets: [{cidr, net, size}], skipped: [{cidr, reason}]}.
 * A network is skipped (reported, never an error) when it is not directly attached (ARP cannot reach it),
 * overlaps the maintenance hotspot network, is larger than /22, or would exceed the per-request total.
 */
export function planL2Scan(cidrs, { onLink = [], apNetwork = '' } = {}) {
  const list = Array.isArray(cidrs) ? cidrs.slice(0, L2_MAX_CIDRS) : [];
  if (!list.length) throw bad('cidrs 不能为空');
  const ap = cidrParts(apNetwork);
  const attached = onLink.map((a) => cidrParts(a.ip + '/' + a.prefix)).filter(Boolean);
  const targets = [];
  const skipped = [];
  let total = 0;
  for (const raw of list) {
    const c = cidrParts(raw);
    const cidr = String(raw);
    if (!c) throw bad('网段格式不对：' + cidr);
    if (ap && overlapNet(c, ap)) {
      skipped.push({ cidr, reason: 'maintenance-hotspot' });
      continue;
    }
    if (c.prefix < L2_MIN_PREFIX) {
      skipped.push({ cidr, reason: 'too-large' });
      continue;
    }
    // every part of it must be on a directly attached network: scan the intersection with each one
    const parts = attached.filter((a) => overlapNet(a, c)).map((a) => (insideNet(c, a) ? c : a)).filter((p) => p.prefix >= L2_MIN_PREFIX);
    if (!parts.length) {
      skipped.push({ cidr, reason: 'not-on-link' });
      continue;
    }
    for (const p of parts) {
      if (total + p.size > L2_MAX_TOTAL) {
        skipped.push({ cidr: intToIp(p.net) + '/' + p.prefix, reason: 'request-too-large' });
        continue;
      }
      total += p.size;
      targets.push({ cidr: intToIp(p.net) + '/' + p.prefix, net: p.net, size: p.size });
    }
  }
  return { targets, skipped };
}

/** host addresses of a network (no network / broadcast address), minus our own */
export function hostsOf(target, ownIps = []) {
  const own = new Set(ownIps);
  const out = [];
  const first = target.size > 2 ? target.net + 1 : target.net;
  const last = target.size > 2 ? target.net + target.size - 2 : target.net + target.size - 1;
  for (let n = first; n <= last; n++) {
    const ip = intToIp(n);
    if (!own.has(ip)) out.push(ip);
  }
  return out;
}

/** KEY='value' / KEY="value" / KEY=value lines (host.env written by setup-host-network.sh). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const bad = (msg) => new AgentError('E_PARAM', msg);

/**
 * Validate a LAN request. Static: address + prefix (8–30) + gateway inside the subnet (optional) + up to
 * three DNS servers. The address must not be the network / broadcast address and must not fall into the
 * maintenance hotspot network.
 */
export function validateLan(body, { apNetwork } = {}) {
  const mode = body?.mode;
  if (mode === 'dhcp') return { mode: 'dhcp' };
  if (mode !== 'static') throw bad('mode 只能是 dhcp 或 static');
  const address = String(body.address || '').trim();
  const ip = ipToInt(address);
  if (ip === null) throw bad('IP 地址格式不对：' + (address || '（空）'));
  const prefix = Number(body.prefix);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) throw bad('子网前缀要在 8–30 之间（例如 24 = 255.255.255.0）');
  const mask = maskOf(prefix);
  const net = (ip & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  if (ip === net || ip === bcast) throw bad('IP 地址不能是网络地址或广播地址');
  if (address.startsWith('127.') || address.startsWith('169.254.') || ip >= ipToInt('224.0.0.0'))
    throw bad('IP 地址不能是回环、链路本地或组播地址');
  let gateway = String(body.gateway || '').trim();
  if (gateway) {
    const g = ipToInt(gateway);
    if (g === null) throw bad('网关格式不对：' + gateway);
    if (((g & mask) >>> 0) !== net) throw bad('网关不在 ' + address + '/' + prefix + ' 这个网段里');
    if (g === ip) throw bad('网关不能和本机地址相同');
  } else gateway = '';
  const dnsIn = Array.isArray(body.dns) ? body.dns : String(body.dns || '').split(/[,，\s]+/);
  const dns = dnsIn.map((x) => String(x).trim()).filter(Boolean);
  if (dns.length > 3) throw bad('DNS 最多 3 个');
  for (const d of dns) if (ipToInt(d) === null) throw bad('DNS 格式不对：' + d);
  if (apNetwork) {
    const [apNet, apPrefix] = String(apNetwork).split('/');
    const apInt = ipToInt(apNet);
    const common = maskOf(Math.min(prefix, Number(apPrefix)));
    if (apInt !== null && ((net & common) >>> 0) === ((apInt & common) >>> 0))
      throw bad('这个网段和维护热点 ' + apNetwork + ' 冲突，请换一个');
  }
  return { mode: 'static', address, prefix, gateway, dns };
}

export const MAX_VLANS = 8;
const overlaps = (a, b) => {
  const common = maskOf(Math.min(a.prefix, b.prefix));
  return ((a.net & common) >>> 0) === ((b.net & common) >>> 0);
};
/**
 * Validate the VLAN sub-interfaces of a trunk port: VLAN id 2–4094 (unique), one static address per VLAN
 * (prefix 8–30, no gateway / DNS: the default route stays on the LAN port), subnets must not overlap each
 * other, the LAN subnet (when static) or the maintenance hotspot network.
 */
export function validateVlans(list, { lan, apNetwork } = {}) {
  if (!Array.isArray(list)) throw bad('vlans 要是一个数组');
  if (list.length > MAX_VLANS) throw bad('VLAN 子接口最多 ' + MAX_VLANS + ' 个');
  const out = [];
  const nets = [];
  if (lan && lan.mode === 'static') {
    const ip = ipToInt(lan.address);
    if (ip !== null) nets.push({ net: (ip & maskOf(lan.prefix)) >>> 0, prefix: lan.prefix, label: '网口 ' + lan.address + '/' + lan.prefix });
  }
  if (apNetwork) {
    const [n, pf] = String(apNetwork).split('/');
    const ip = ipToInt(n);
    if (ip !== null && Number(pf) > 0) nets.push({ net: (ip & maskOf(Number(pf))) >>> 0, prefix: Number(pf), label: '维护热点 ' + apNetwork });
  }
  const seen = new Set();
  for (const v of list) {
    const id = Number(v?.id);
    if (!Number.isInteger(id) || id < 2 || id > 4094) throw bad('VLAN ID 要在 2–4094 之间：' + (v?.id ?? '（空）'));
    if (seen.has(id)) throw bad('VLAN ' + id + ' 重复了');
    seen.add(id);
    if (v.mode !== undefined && v.mode !== 'static') throw bad('VLAN ' + id + ' 目前只支持静态地址');
    const address = String(v?.address || '').trim();
    const ip = ipToInt(address);
    if (ip === null) throw bad('VLAN ' + id + ' 的 IP 地址格式不对：' + (address || '（空）'));
    const prefix = Number(v.prefix);
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) throw bad('VLAN ' + id + ' 的子网前缀要在 8–30 之间（例如 24 = 255.255.255.0）');
    const mask = maskOf(prefix);
    const net = (ip & mask) >>> 0;
    const bcast = (net | (~mask >>> 0)) >>> 0;
    if (ip === net || ip === bcast) throw bad('VLAN ' + id + ' 的 IP 地址不能是网络地址或广播地址');
    if (address.startsWith('127.') || address.startsWith('169.254.') || ip >= ipToInt('224.0.0.0')) throw bad('VLAN ' + id + ' 的 IP 地址不能是回环、链路本地或组播地址');
    const me = { net, prefix, label: 'VLAN ' + id + ' ' + address + '/' + prefix };
    for (const other of nets) if (overlaps(me, other)) throw bad(me.label + ' 的网段和 ' + other.label + ' 重叠，请换一个');
    nets.push(me);
    out.push({ id, address, prefix });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * The netplan file host-agent owns (/etc/netplan/20-h2z-lan.yaml), one or more wired ports (2026-11-03: x86 boxes
 * have two, like an NVR: uplink + camera network). Exactly one port carries the default route (`primary`): its static
 * gateway or its DHCP routes. Other ports never install a default route (static without gateway, DHCP with
 * use-routes: false) and are optional at boot; mode 'off' = port up, no address. VLAN sub-interfaces hang off `vlanIf`
 * (the first port, LAN_IF). A single port renders exactly as before (Orange Pi files stay byte-identical).
 *   ports: [{ iface, cfg: { mode: dhcp|static|off, address, prefix, gateway, dns } }]
 */
export function renderNetplanPorts(ports, { primary, vlans = [], vlanIf } = {}) {
  const prim = primary || ports[0]?.iface;
  const multi = ports.length > 1;
  const lines = ['# Managed by H2Z host-agent (IOC admin → 设备网络). Original files: /etc/h2z/netplan-orig/'];
  if (multi) lines.push('# h2z-primary: ' + prim);
  lines.push('network:', '  version: 2', '  renderer: networkd', '  ethernets:');
  for (const { iface, cfg } of ports) {
    const isPrim = iface === prim;
    lines.push(`    ${iface}:`);
    if (cfg.mode === 'dhcp') {
      lines.push('      dhcp4: true', '      dhcp6: true');
      if (!isPrim) lines.push('      optional: true', '      dhcp4-overrides:', '        use-routes: false', '      dhcp6-overrides:', '        use-routes: false');
    } else if (cfg.mode === 'off') {
      lines.push('      dhcp4: false', '      dhcp6: false', '      optional: true', '      link-local: []');
    } else {
      lines.push('      dhcp4: false', '      dhcp6: false');
      if (!isPrim && multi) lines.push('      optional: true');
      lines.push(`      addresses: [${cfg.address}/${cfg.prefix}]`);
      if (cfg.gateway && isPrim) lines.push('      routes:', `        - to: default`, `          via: ${cfg.gateway}`);
      if (cfg.dns?.length) lines.push('      nameservers:', `        addresses: [${cfg.dns.join(', ')}]`);
    }
  }
  // 802.1Q sub-interfaces: one static address each, never a gateway / DNS (the default route stays on the primary port)
  const link = vlanIf || ports[0]?.iface;
  if (vlans?.length) {
    lines.push('  vlans:');
    for (const v of vlans) lines.push(`    ${link}.${v.id}:`, `      id: ${v.id}`, `      link: ${link}`, '      dhcp4: false', '      dhcp6: false', `      addresses: [${v.address}/${v.prefix}]`);
  }
  return lines.join('\n') + '\n';
}

/** Single-port form (Orange Pi, and the shape older callers use). */
export function renderNetplan(iface, cfg, vlans = []) {
  return renderNetplanPorts([{ iface, cfg }], { vlans, vlanIf: iface });
}

function parsePortBlock(b) {
  if (/^\s*dhcp4:\s*true/m.test(b)) return { mode: 'dhcp' };
  const a = /addresses:\s*\[\s*([\d.]+)\/(\d+)\s*\]/.exec(b);
  if (!a) return /^\s*link-local:\s*\[\s*\]/m.test(b) ? { mode: 'off' } : { mode: 'unknown' };
  const gw = /via:\s*([\d.]+)/.exec(b);
  const ns = /nameservers:\s*\n\s*addresses:\s*\[([^\]]*)\]/.exec(b);
  return { mode: 'static', address: a[1], prefix: Number(a[2]), gateway: gw ? gw[1] : '', dns: ns ? ns[1].split(',').map((x) => x.trim()).filter(Boolean) : [] };
}

/** Read back what renderNetplanPorts wrote → { ports: [{ iface, cfg }], primary, vlans }. */
export function parseNetplanPorts(text) {
  const full = String(text || '');
  if (!full.trim()) return { ports: [], primary: '', vlans: [] };
  const [s, vsec = ''] = full.split(/\n {2}vlans:\n/);
  const vlans = [];
  for (const m of vsec.matchAll(/^ {4}[\w.-]+:\n((?: {6}.*(?:\n|$))*)/gm)) {
    const id = /^ {6}id:\s*(\d+)/m.exec(m[1]);
    const ad = /addresses:\s*\[\s*([\d.]+)\/(\d+)\s*\]/.exec(m[1]);
    if (id && ad) vlans.push({ id: Number(id[1]), address: ad[1], prefix: Number(ad[2]) });
  }
  const eth = s.split(/\n {2}ethernets:\n/)[1] || '';
  const ports = [];
  for (const m of eth.matchAll(/^ {4}([\w.-]+):\n((?: {6}.*(?:\n|$))*)/gm)) ports.push({ iface: m[1], cfg: parsePortBlock(m[2]) });
  const pm = /^# h2z-primary:\s*(\S+)/m.exec(s);
  const primary = pm && ports.some((p) => p.iface === pm[1]) ? pm[1] : ports[0]?.iface || '';
  return { ports, primary, vlans };
}

/** The first port's settings + VLANs (the shape the single-port API always returned). */
export function parseNetplan(text) {
  const { ports, vlans } = parseNetplanPorts(text);
  if (!ports.length) return { mode: 'unknown' };
  const cfg = ports[0].cfg;
  if (cfg.mode === 'unknown') return { mode: 'unknown' };
  return vlans.length ? { ...cfg, vlans } : cfg; // 没有 VLAN 时输出形状和以前一样
}

/** `systemctl show -p NextElapseUSecRealtime --timestamp=unix --value` → epoch ms, or null. */
export function parseUnixTimestamp(text) {
  const m = /@(\d+)/.exec(String(text || ''));
  return m ? Number(m[1]) * 1000 : null;
}

/** Summary of `tailscale status --json` for the admin page. */
export function summarizeTailscale(st) {
  if (!st || typeof st !== 'object') return { available: false };
  const self = st.Self || {};
  const state = String(st.BackendState || 'Unknown');
  return {
    available: true,
    state, // NoState | NeedsLogin | NeedsMachineAuth | Stopped | Starting | Running
    loggedIn: state === 'Running' || state === 'Starting',
    enabled: state !== 'Stopped', // Stopped = switched off with `tailscale down` (login kept)
    account: String((st.User && self.UserID != null && st.User[self.UserID]?.LoginName) || ''),
    authUrl: st.AuthURL || '',
    hostName: self.HostName || '',
    dnsName: String(self.DNSName || '').replace(/\.$/, ''),
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [],
    online: self.Online === true,
    tailnet: st.CurrentTailnet?.Name || '',
    health: Array.isArray(st.Health) ? st.Health.slice(0, 5) : [],
  };
}

// ---------------------------------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------
// H2Z OS full-package upgrade (.h2zup, built by os/x86/container/build-update.sh): plain ustar archive
// manifest.json · manifest.sig · repo.bundle · os-files.tar · images.tar
// ---------------------------------------------------------------------------------------------------
export const UPGRADE_PARTS = ['repo.bundle', 'os-files.tar', 'images.tar'];
/** only these paths may be in os-files.tar (configuration under /etc/h2z is never touched) */
export const OS_FILE_PREFIXES = ['usr/local/sbin/h2z-', 'usr/local/bin/h2z-', 'usr/share/h2z/', 'etc/systemd/system/h2z-os-', 'etc/systemd/system/docker.service.d/10-h2z.conf', 'etc/avahi/services/h2z-'];
const OS_FILE_DIRS = ['usr/', 'usr/local/', 'usr/local/sbin/', 'usr/local/bin/', 'usr/share/', 'usr/share/h2z/', 'etc/', 'etc/systemd/', 'etc/systemd/system/', 'etc/systemd/system/docker.service.d/', 'etc/avahi/', 'etc/avahi/services/'];

/** ustar member index: name → { offset (data start), size }. Reads only the 512-byte headers. */
export async function tarIndex(file, { open = fsp.open } = {}) {
  const fh = await open(file, 'r');
  try {
    const { size: total } = await fh.stat();
    const out = new Map();
    out.duplicates = new Set(); // 同名成员：后面的盖掉前面的（Map），但记下来——扩展包不允许有重名成员（宿主脚本取第一个、这里取最后一个，会对不上）
    const hdr = Buffer.alloc(512);
    let pos = 0;
    while (pos + 512 <= total) {
      await fh.read(hdr, 0, 512, pos);
      if (hdr.every((b) => b === 0)) break;
      const str = (a, n) => hdr.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
      const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100);
      const size = parseInt(str(124, 12).trim() || '0', 8);
      const type = String.fromCharCode(hdr[156] || 48);
      if (!Number.isFinite(size) || size < 0) throw new AgentError('E_PACKAGE', '升级包格式不对（tar 头损坏）');
      if (type === '0' || type === '\0') {
        if (out.has(name)) out.duplicates.add(name);
        out.set(name, { offset: pos + 512, size });
      }
      pos += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** '0.1.4' vs '0.1.3-202611030101' → -1 / 0 / 1 (numbers first, then the suffix as text) */
export function cmpVersion(a, b) {
  const p = (v) => {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(String(v || '').trim()) || [];
    return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0), m[4] || ''];
  };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x[3] === y[3] ? 0 : x[3] < y[3] ? -1 : 1;
}

/** `tar -tvf os-files.tar` lines → problems (anything outside the allowed paths, links, devices, ..) */
export function osFileProblems(listing) {
  const bad = [];
  for (const line of String(listing || '').split('\n')) {
    if (!line.trim()) continue;
    const type = line[0];
    const perms = line.split(/\s+/)[0] || '';
    const name = line.split(/\s+/).slice(5).join(' ').replace(/^\.\//, '');
    if (!name) continue;
    if (name.startsWith('/') || name.split('/').includes('..')) bad.push(name);
    else if (/[sStT]/.test(perms.slice(1))) bad.push(name + '（带 setuid / setgid）');
    else if (type === 'd') { if (!OS_FILE_DIRS.includes(name.endsWith('/') ? name : name + '/') && !OS_FILE_PREFIXES.some((p) => name.startsWith(p))) bad.push(name); }
    else if (type !== '-') bad.push(name + '（不是普通文件）');
    else if (!OS_FILE_PREFIXES.some((p) => name.startsWith(p))) bad.push(name);
  }
  return bad;
}

/** NVR-style serial: the board's DMI serial when it is a real one, otherwise H2Z + the first port's MAC */
export function deviceSerial(dmi, mac) {
  const d = String(dmi || '').trim();
  if (d && !/^(0+|to be filled.*|default string|system serial number|none|n\/a|not specified|123456789|o\.e\.m\.?)$/i.test(d) && /^[\x21-\x7e]{4,40}$/.test(d)) return d;
  const m = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return m.length === 12 ? 'H2Z' + m : '';
}
/** our NTP drop-in file → server list */
export function parseNtpServers(text, backend) {
  const t = String(text || '');
  if (backend === 'chrony') return [...t.matchAll(/^\s*(?:server|pool)\s+(\S+)/gm)].map((m) => m[1]);
  const m = /^\s*NTP=(.*)$/m.exec(t);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

const nsenterExec = (cmd, args, { timeout = 60_000 } = {}) =>
  new Promise((resolve, reject) => {
    execFile('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', cmd, ...args], { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve(String(stdout));
    });
  });

const localExec = (cmd, args, { timeout = 30_000 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve(String(stdout));
    });
  });

export function createAgent(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const host = o.host || nsenterExec; // runs a command on the host
  const local = o.local || localExec; // runs a command in this container (tailscale CLI)
  const now = o.now || (() => Date.now());
  // monotonic clock for the LAN rollback timer: a time change (manual / NTP step) must not fire or delay it
  const mono = o.mono || (o.now ? o.now : () => performance.now());
  let monoDeadline = null; // mono() value at which an unconfirmed LAN change is rolled back
  const fs = o.fs || fsp;
  const P = {
    env: join(o.hostEtc, 'h2z/host.env'),
    netplan: join(o.hostEtc, 'netplan/20-h2z-lan.yaml'),
    previous: join(o.hostEtc, 'h2z/lan-previous.yaml'),
    pending: join(o.hostEtc, 'h2z/lan-pending.json'),
    lastRollback: join(o.hostEtc, 'h2z/lan-last-rollback.json'),
    notes: join(o.hostEtc, 'h2z/lan-notes.json'),
    deviceName: join(o.hostEtc, 'h2z/device-name'),
    osEnv: join(o.hostEtc, 'h2z/os.env'),
    kioskEnv: join(o.hostEtc, 'h2z/kiosk.env'),
    audit: join(o.hostEtc, 'h2z/audit.log'),
    packsState: join(o.hostEtc, 'h2z/packs.json'),
    packsSettings: join(o.hostEtc, 'h2z/packs-settings.json'),
  };
  let busy = Promise.resolve();
  /** serialize every change (LAN / hotspot / Tailscale) */
  const serial = (fn) => {
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  };

  const read = async (f) => {
    try {
      return await fs.readFile(f, 'utf8');
    } catch {
      return null;
    }
  };
  const writeAtomic = async (f, text, mode = 0o600) => {
    await fs.mkdir(dirname(f), { recursive: true });
    await fs.writeFile(f + '.tmp', text, { mode });
    await fs.rename(f + '.tmp', f);
  };
  const remove = async (f) => {
    try {
      await fs.unlink(f);
    } catch {
      /* gone */
    }
  };

  async function settings() {
    const text = await read(P.env);
    if (text === null) return null;
    const e = parseEnvFile(text);
    return {
      lanIf: e.LAN_IF || '',
      // every wired port (x86 boxes: 2); LAN_IF first. Older host.env has no LAN_IFS → just LAN_IF.
      lanIfs: [...new Set([e.LAN_IF, ...String(e.LAN_IFS || '').split(/[\s,]+/)].filter(Boolean))],
      apIf: e.AP_IF || '',
      ssid: e.AP_SSID || '',
      psk: e.AP_PSK || '',
      apAddress: e.AP_ADDRESS || '192.168.234.1/24',
      apNetwork: e.AP_NETWORK || '192.168.234.0/24',
      windowMin: Number(e.AP_WINDOW_MIN) || 120,
    };
  }
  async function ready() {
    const s = await settings();
    // no WiFi (most x86 boxes): AP_IF is empty and there is simply no maintenance hotspot
    if (!s || !s.lanIf)
      throw new AgentError('E_NOT_READY', '设备网络还没有初始化：在设备上执行 sudo sh host/setup-host-network.sh', 409);
    return s;
  }

  // ----- LAN -----
  /** live state of one wired port: carrier, speed, MAC, IPv4 addresses (dynamic = from DHCP), default gateway, DNS */
  async function portLive(iface) {
    const out = { iface, carrier: null, speed: null, mac: '', addresses: [], dynamic: false, gateway: '', dns: [] };
    const cat = async (f) => (await host('cat', ['/sys/class/net/' + iface + '/' + f], { timeout: 5000 })).trim();
    try {
      out.carrier = (await cat('carrier')) === '1';
    } catch {
      out.carrier = false;
    }
    try {
      const sp = Number(await cat('speed'));
      out.speed = sp > 0 ? sp : null;
    } catch {
      /* no link */
    }
    try {
      out.mac = (await cat('address')).toUpperCase();
    } catch {
      /* ignore */
    }
    try {
      const j = JSON.parse(await host('ip', ['-j', '-4', 'addr', 'show', 'dev', iface], { timeout: 5000 }));
      const info = (j[0]?.addr_info || []).filter((a) => a.label !== iface + ':fb'); // the boot fallback address is not "the" address
      out.addresses = info.map((a) => `${a.local}/${a.prefixlen}`);
      out.dynamic = info.some((a) => a.dynamic);
      out.fallback = (j[0]?.addr_info || []).filter((a) => a.label === iface + ':fb').map((a) => `${a.local}/${a.prefixlen}`);
    } catch {
      /* no address */
    }
    try {
      const r = JSON.parse(await host('ip', ['-j', '-4', 'route', 'show', 'default', 'dev', iface], { timeout: 5000 }));
      out.gateway = r[0]?.gateway || '';
    } catch {
      /* no route */
    }
    try {
      const d = await host('resolvectl', ['dns', iface], { timeout: 5000 });
      out.dns = (d.split(':').slice(1).join(':').match(/\d+\.\d+\.\d+\.\d+/g) || []).slice(0, 5);
    } catch {
      /* resolved not available */
    }
    return out;
  }
  const readNotes = async () => {
    try {
      return JSON.parse((await read(P.notes)) || '{}') || {};
    } catch {
      return {};
    }
  };
  async function lanStatus(s) {
    const plan = parseNetplanPorts(await read(P.netplan));
    const live = await portLive(s.lanIf);
    const out = { ...live, config: parseNetplan(await read(P.netplan)) };
    if (out.config.mode === 'static' && !out.dns.length) out.dns = out.config.dns;
    out.vlans = out.config.vlans || [];
    out.vlanLive = [];
    for (const v of out.vlans) {
      const l = { id: v.id, iface: s.lanIf + '.' + v.id, up: false, addresses: [] };
      try {
        const j = JSON.parse(await host('ip', ['-j', '-4', 'addr', 'show', 'dev', l.iface], { timeout: 5000 }));
        l.up = /UP/.test(String(j[0]?.operstate || '')) || (j[0]?.flags || []).includes('LOWER_UP');
        l.addresses = (j[0]?.addr_info || []).map((a) => `${a.local}/${a.prefixlen}`);
      } catch {
        /* sub-interface not there (yet) */
      }
      out.vlanLive.push(l);
    }
    const pending = await readPending();
    out.pending = pending ? { appliedAt: pending.appliedAt, deadline: pending.deadline, remainingMs: remainingMs(pending), config: pending.config, iface: pending.iface || s.lanIf } : null;
    const last = await read(P.lastRollback);
    out.lastRollback = last ? JSON.parse(last) : null;
    // every wired port, in LAN_IFS order ("网口 1", "网口 2"…); the first one is the `lan` above
    const notes = await readNotes();
    const primary = plan.primary || s.lanIf;
    out.ports = [];
    for (const [i, iface] of s.lanIfs.entries()) {
      const p = iface === s.lanIf ? live : await portLive(iface);
      const cfg = plan.ports.find((x) => x.iface === iface)?.cfg || { mode: 'unknown' };
      out.ports.push({ ...p, label: '网口 ' + (i + 1), config: cfg, primary: iface === primary, note: String(notes[iface] || '') });
    }
    return out;
  }
  async function readPending() {
    const t = await read(P.pending);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  const netplanApply = () => host('netplan', ['apply'], { timeout: 90_000 });

  /**
   * POST /v1/lan — one port at a time (iface, default LAN_IF), applied at once and rolled back unless confirmed.
   *   { iface?, mode: dhcp|static|off, address, prefix, gateway, dns, primary?: true, note? }  or  { vlans: [...] } only
   * primary: true moves the default route to this port (the old primary keeps its address, loses its gateway).
   * A gateway is only accepted on the primary port; 'off' never on the primary; port subnets must not overlap.
   */
  function applyLan(body) {
    return serial(async () => {
      const s = await ready();
      const iface = body?.iface === undefined || body?.iface === '' ? s.lanIf : String(body.iface);
      if (!s.lanIfs.includes(iface)) throw bad('没有这个网口：' + iface);
      const currentText = await read(P.netplan);
      const plan = parseNetplanPorts(currentText);
      const portsNow = s.lanIfs.map((i) => ({ iface: i, cfg: plan.ports.find((x) => x.iface === i)?.cfg || null }));
      let primary = plan.primary && s.lanIfs.includes(plan.primary) ? plan.primary : s.lanIf;
      const vlanOnly = body?.mode === undefined && body?.vlans !== undefined;
      let cfg;
      if (vlanOnly) {
        // VLAN only: keep the port settings host-agent already owns
        const first = portsNow[0].cfg;
        if (!first || first.mode === 'unknown') throw bad('还没有网口设置：先保存一次网口设置（IP / 网关），再添加 VLAN');
      } else {
        if (body?.mode === 'off') cfg = { mode: 'off' };
        else cfg = validateLan(body, { apNetwork: s.apNetwork });
        if (body?.primary === true) primary = iface;
        if (cfg.mode === 'off' && iface === primary) throw bad('默认网关网口不能停用：先把默认网关设到另一个网口');
        if (cfg.mode === 'static' && cfg.gateway && iface !== primary) throw bad('网关只能设在默认网关网口上：勾选「设为默认网关」，或者把网关留空');
      }
      const next = portsNow.map((p) => ({ iface: p.iface, cfg: p.iface === iface && cfg ? cfg : p.cfg }));
      // a port that was never written (older single-port file) stays out of the file: networkd keeps its default
      const ports = next.filter((p) => p.cfg && p.cfg.mode !== 'unknown');
      if (!ports.some((p) => p.iface === primary)) primary = ports[0]?.iface || s.lanIf;
      // the old primary gives up its gateway when the default route moves away
      for (const p of ports) if (p.iface !== primary && p.cfg.mode === 'static' && p.cfg.gateway) p.cfg = { ...p.cfg, gateway: '' };
      // port subnets must not overlap each other (two ports in one subnet = unpredictable replies)
      const nets = [];
      for (const p of ports) {
        if (p.cfg.mode !== 'static') continue;
        const ip = ipToInt(p.cfg.address);
        const me = { net: (ip & maskOf(p.cfg.prefix)) >>> 0, prefix: p.cfg.prefix, label: p.iface + ' ' + p.cfg.address + '/' + p.cfg.prefix };
        for (const o2 of nets) if (overlaps(me, o2)) throw bad(me.label + ' 和 ' + o2.label + ' 在同一个网段：两个网口要用不同网段');
        nets.push(me);
      }
      const first = ports.find((p) => p.iface === s.lanIf)?.cfg || { mode: 'dhcp' };
      const vlans = body?.vlans === undefined ? plan.vlans || [] : validateVlans(body.vlans, { lan: first, apNetwork: s.apNetwork });
      for (const v of vlans)
        for (const n of nets.filter((x) => !x.label.startsWith(s.lanIf + ' '))) {
          const ip = ipToInt(v.address);
          const me = { net: (ip & maskOf(v.prefix)) >>> 0, prefix: v.prefix };
          if (overlaps(me, n)) throw bad('VLAN ' + v.id + ' 的网段和 ' + n.label + ' 重叠，请换一个');
        }
      if (await readPending()) throw new AgentError('E_CONFLICT', '上一次的网口修改还在等待确认：先确认或撤销', 409);
      if (typeof body?.note === 'string') await saveNote(iface, body.note);
      const current = currentText ?? renderNetplan(s.lanIf, { mode: 'dhcp' });
      await writeAtomic(P.previous, current);
      await writeAtomic(P.netplan, renderNetplanPorts(ports, { primary, vlans, vlanIf: s.lanIf }));
      const shown = cfg ? (iface === s.lanIf && vlans.length ? { ...cfg, vlans } : cfg) : { ...first, vlans };
      const pending = { appliedAt: new Date(now()).toISOString(), deadline: new Date(now() + o.rollbackMs).toISOString(), iface, primary, config: shown };
      await writeAtomic(P.pending, JSON.stringify(pending), 0o644);
      monoDeadline = mono() + o.rollbackMs;
      await audit('lan', { iface, mode: cfg?.mode || 'vlans', primary, by: body?.by });
      try {
        await netplanApply();
      } catch (e) {
        await rollbackNow('apply-failed: ' + String(e.stderr || e.message).slice(0, 300));
        throw new AgentError('E_APPLY', '网口设置没有生效，已恢复原设置：' + String(e.stderr || e.message).slice(0, 200), 500);
      }
      // the confirmation window starts when the new settings are live (netplan apply can take a while)
      monoDeadline = mono() + o.rollbackMs;
      pending.deadline = new Date(now() + o.rollbackMs).toISOString();
      await writeAtomic(P.pending, JSON.stringify(pending), 0o644);
      return pending;
    });
  }
  async function saveNote(iface, note) {
    const n = String(note).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    const notes = await readNotes();
    if (n) notes[iface] = n;
    else delete notes[iface];
    await writeAtomic(P.notes, JSON.stringify(notes), 0o644);
  }
  /** POST /v1/lan/note { iface, note } — label only ("摄像头网"), no network change, no rollback */
  const setNote = (body) =>
    serial(async () => {
      const s = await ready();
      const iface = String(body?.iface || s.lanIf);
      if (!s.lanIfs.includes(iface)) throw bad('没有这个网口：' + iface);
      await saveNote(iface, body?.note || '');
      return { iface, note: (await readNotes())[iface] || '' };
    });
  async function rollbackNow(reason) {
    monoDeadline = null;
    const prev = await read(P.previous);
    if (prev !== null) await writeAtomic(P.netplan, prev);
    await remove(P.pending);
    await remove(P.previous);
    await writeAtomic(P.lastRollback, JSON.stringify({ at: new Date(now()).toISOString(), reason }), 0o644);
    await audit('lan-rollback', { reason });
    try {
      await netplanApply();
    } catch {
      /* best effort: the file is restored; networkd picks it up on the next apply / reboot */
    }
  }
  const confirmLan = () =>
    serial(async () => {
      if (!(await readPending())) throw new AgentError('E_CONFLICT', '没有待确认的网口修改', 409);
      monoDeadline = null;
      await remove(P.pending);
      await remove(P.previous);
      return { confirmed: true };
    });
  const rollbackLan = () =>
    serial(async () => {
      if (!(await readPending())) throw new AgentError('E_CONFLICT', '没有待确认的网口修改', 409);
      await rollbackNow('manual');
      return { rolledBack: true };
    });
  /** called every few seconds and at start: roll back an unconfirmed change after its deadline */
  /** time left before an unconfirmed change is rolled back. After a host-agent restart only the wall-clock deadline
   *  is known: it is capped at the full window (a clock that went back must not keep a broken setting) */
  function remainingMs(p) {
    if (monoDeadline === null) monoDeadline = mono() + Math.min(o.rollbackMs, Math.max(0, Date.parse(p.deadline) - now()));
    return Math.max(0, Math.round(monoDeadline - mono()));
  }
  const tick = () =>
    serial(async () => {
      const p = await readPending();
      if (!p) monoDeadline = null;
      if (p && remainingMs(p) <= 0) {
        await rollbackNow('timeout');
        return 'rolled-back';
      }
      return p ? 'pending' : 'idle';
    });

  // ----- hotspot -----
  const timerAt = async (unit) => {
    try {
      const active = (await host('systemctl', ['is-active', unit], { timeout: 5000 }).catch((e) => e.stdout || '')).trim();
      if (active !== 'active') return null;
      return parseUnixTimestamp(await host('systemctl', ['show', '-p', 'NextElapseUSecRealtime', '--timestamp=unix', '--value', unit], { timeout: 5000 }));
    } catch {
      return null;
    }
  };
  async function apStatus(s) {
    if (!s.apIf) return { available: false, iface: '', active: false, reason: '本机没有无线网卡，没有维护热点' };
    const state = (await host('systemctl', ['is-active', 'h2z-maint-ap.service'], { timeout: 5000 }).catch((e) => e.stdout || 'unknown')).trim();
    const active = state === 'active';
    let closesAt = null;
    if (active) {
      const t = [await timerAt('h2z-maint-ap-close.timer'), await timerAt('h2z-maint-ap-off.timer')].filter((x) => x && x > now());
      closesAt = t.length ? new Date(Math.min(...t)).toISOString() : null;
    }
    let clients = 0;
    if (active) {
      try {
        clients = ((await host('iw', ['dev', s.apIf, 'station', 'dump'], { timeout: 5000 })).match(/^Station /gm) || []).length;
      } catch {
        /* unknown */
      }
    }
    return { available: true, iface: s.apIf, active, state, ssid: s.ssid, address: s.apAddress, network: s.apNetwork, windowMin: s.windowMin, closesAt, clients };
  }
  /**
   * open: (re)start the hotspot and close it after `minutes` (default AP_WINDOW_MIN). The boot-window timer
   * is stopped for this boot so the chosen time wins (it is armed again at the next boot) — so "open for
   * 10 minutes" also shortens a running window. close: stop now; the hotspot reopens at the next boot.
   */
  function setAp(action, minutes) {
    return serial(async () => {
      const s = await ready();
      if (!s.apIf) throw new AgentError('E_UNAVAILABLE', '本机没有无线网卡，没有维护热点', 409);
      let mins = s.windowMin;
      if (action === 'open' && minutes !== undefined && minutes !== null && minutes !== '') {
        mins = Number(minutes);
        if (!Number.isInteger(mins) || mins < 5 || mins > 480) throw bad('热点开启时长要在 5–480 分钟之间');
      }
      if (action !== 'open' && action !== 'close') throw bad('action 只能是 open 或 close');
      await host('systemctl', ['stop', 'h2z-maint-ap-close.timer'], { timeout: 15_000 }).catch(() => {});
      await host('systemctl', ['reset-failed', 'h2z-maint-ap-close.timer', 'h2z-maint-ap-close.service'], { timeout: 15_000 }).catch(() => {});
      if (action === 'open') {
        await host('systemctl', ['stop', 'h2z-maint-ap-off.timer'], { timeout: 15_000 }).catch(() => {});
        await host('systemctl', ['start', 'h2z-maint-ap.service'], { timeout: 30_000 });
        await host(
          'systemd-run',
          ['--quiet', '--unit=h2z-maint-ap-close', `--on-active=${mins}min`, '--timer-property=AccuracySec=10s', '/usr/bin/systemctl', 'stop', 'h2z-maint-ap.service'],
          { timeout: 15_000 },
        );
      } else {
        await host('systemctl', ['stop', 'h2z-maint-ap.service'], { timeout: 30_000 });
      }
      return apStatus(s);
    });
  }

  /**
   * After `git pull`: when host/ differs from what was installed (/etc/h2z/setup.sha), re-run
   * host/setup-host-network.sh --auto on the host. The repository path is where the units are linked from.
   * Only after the one-time manual setup (no host.env / no linked unit → nothing to do).
   */
  function syncHostSetup() {
    return serial(async () => {
      if ((await read(P.env)) === null) return 'not-installed';
      let unit = '';
      try {
        unit = (await host('readlink', ['-f', '/etc/systemd/system/h2z-maint-ap.service'], { timeout: 5000 })).trim();
      } catch {
        return 'not-installed';
      }
      const m = /^(\/.+)\/host\/systemd\/h2z-maint-ap\.service$/.exec(unit);
      if (!m) return 'not-installed';
      const repo = m[1];
      const hash = (
        await host('sh', ['-c', 'cd "$1" && find host -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-64', 'sh', repo], { timeout: 30_000 })
      ).trim();
      const installed = String((await read(join(o.hostEtc, 'h2z/setup.sha'))) || '').trim();
      if (hash && hash === installed) return 'up-to-date';
      const out = await host('sh', [repo + '/host/setup-host-network.sh', '--auto'], { timeout: 600_000 });
      return 'updated: ' + out.trim().split('\n').pop();
    });
  }

  /**
   * After `git pull`: install the local-display scripts (HDMI gate, Chrome watchdog) from the repository via host/install-kiosk.sh.
   * The script does nothing on machines without a local display and nothing when the files are unchanged.
   */
  function syncKiosk() {
    return serial(async () => {
      const repo = await repoPath();
      if (!repo) return 'not-installed';
      const out = await host('sh', [repo + '/host/install-kiosk.sh'], { timeout: 60_000 });
      return out.trim().split('\n').pop() || 'ok';
    });
  }

  // ----- audit trail: every device-level change, one JSON line (kept under ~256 KB) -----
  async function audit(action, detail = {}) {
    try {
      const line = JSON.stringify({ ...detail, at: new Date(now()).toISOString(), action }) + '\n';
      const old = (await read(P.audit)) || '';
      const keep = old.length > 256 << 10 ? old.slice(old.indexOf('\n', old.length >> 1) + 1) : old;
      await writeAtomic(P.audit, keep + line, 0o640);
    } catch {
      /* the change itself must not fail because of the log */
    }
  }

  /** where the h2z.security checkout lives on the host: H2Z OS /opt/h2z.security, Orange Pi = where host/ units are linked from */
  async function repoPath() {
    try {
      const unit = (await host('readlink', ['-f', '/etc/systemd/system/h2z-maint-ap.service'], { timeout: 5000 })).trim();
      const m = /^(\/.+)\/host\/systemd\/h2z-maint-ap\.service$/.exec(unit);
      if (m) return m[1];
    } catch {
      /* not linked */
    }
    try {
      await host('test', ['-d', '/opt/h2z.security/.git'], { timeout: 5000 });
      return '/opt/h2z.security';
    } catch {
      return '';
    }
  }
  const hostCat = async (f) => {
    try {
      return (await host('cat', [f], { timeout: 5000 })).trim();
    } catch {
      return '';
    }
  };

  // ----- system: device info, time, power, device name (2026-11-03, IOC admin → 设备与系统 / local console) -----
  async function system() {
    const s = await settings();
    const [hostname, osRel, vendor, product, dmiSerial, uptime, cpuinfo, meminfo] = await Promise.all([
      host('hostname', [], { timeout: 5000 }).then((x) => x.trim()).catch(() => ''),
      hostCat('/usr/share/h2z/os-release'),
      hostCat('/sys/class/dmi/id/sys_vendor'),
      hostCat('/sys/class/dmi/id/product_name'),
      hostCat('/sys/class/dmi/id/product_serial'),
      hostCat('/proc/uptime'),
      hostCat('/proc/cpuinfo'),
      hostCat('/proc/meminfo'),
    ]);
    const firstIf = s?.lanIfs?.[0] || '';
    const mac = firstIf ? await hostCat('/sys/class/net/' + firstIf + '/address') : '';
    const rel = osRel ? parseEnvFile(osRel) : null;
    const repo = await repoPath();
    let app = null;
    if (repo) {
      try {
        const [commit, date, branch] = (await host('git', ['-c', 'safe.directory=*', '-C', repo, 'log', '-1', '--format=%h%n%cI%n%D'], { timeout: 10_000 })).trim().split('\n');
        app = { repo, commit, date, branch: (/HEAD -> ([^,]+)/.exec(branch || '') || [])[1] || '' };
      } catch {
        app = { repo, commit: '', date: '', branch: '' };
      }
    }
    const cpu = (/^model name\s*:\s*(.+)$/m.exec(cpuinfo) || [])[1] || '';
    const memKb = Number((/^MemTotal:\s+(\d+)/m.exec(meminfo) || [])[1]) || 0;
    const name = String((await read(P.deviceName)) || '').trim();
    const lang = langFromEnv(await read(P.osEnv));
    return {
      hostname,
      deviceName: name || hostname,
      lang,
      serial: deviceSerial(dmiSerial, mac),
      model: { vendor, product, cpu, memBytes: memKb * 1024 },
      os: rel ? { name: 'H2Z OS', version: rel.H2ZOS_VERSION || '', buildDate: rel.H2ZOS_BUILD_DATE || '', commit: rel.H2ZOS_REPO_COMMIT || '', kernel: rel.H2ZOS_KERNEL || '', chrome: rel.H2ZOS_CHROME || '' } : null,
      app,
      uptimeSec: Math.round(Number(uptime.split(' ')[0]) || 0),
      time: await timeStatus(),
      power: { restartApp: !!repo, reboot: true, shutdown: true },
    };
  }

  /** NTP: chrony (H2Z OS) or systemd-timesyncd (Armbian); our servers live in one drop-in file */
  const NTP_FILES = { chrony: '/etc/chrony/sources.d/h2z.sources', timesyncd: '/etc/systemd/timesyncd.conf.d/h2z.conf' };
  async function ntpBackend() {
    try {
      await host('sh', ['-c', 'command -v chronyc'], { timeout: 5000 });
      return 'chrony';
    } catch {
      /* no chrony */
    }
    try {
      await host('systemctl', ['cat', 'systemd-timesyncd.service'], { timeout: 5000 });
      return 'timesyncd';
    } catch {
      return 'none';
    }
  }
  async function timeStatus() {
    const kv = {};
    try {
      for (const l of (await host('timedatectl', ['show'], { timeout: 5000 })).split('\n')) {
        const i = l.indexOf('=');
        if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim();
      }
    } catch {
      /* no timedated */
    }
    const backend = await ntpBackend();
    let enabled = kv.NTP === 'yes';
    let offsetMs = null;
    let servers = [];
    if (backend === 'chrony') {
      enabled = (await host('systemctl', ['is-active', 'chrony'], { timeout: 5000 }).catch((e) => e.stdout || '')).trim() === 'active';
      servers = parseNtpServers(await hostCat(NTP_FILES.chrony), 'chrony');
      try {
        const f = (await host('chronyc', ['-c', 'tracking'], { timeout: 5000 })).trim().split(',');
        const off = Number(f[4]);
        if (Number.isFinite(off) && f[1] && f[1] !== '0.0.0.0') offsetMs = Math.round(off * 1e5) / 100;
      } catch {
        /* not tracking */
      }
    } else if (backend === 'timesyncd') servers = parseNtpServers(await hostCat(NTP_FILES.timesyncd), 'timesyncd');
    return {
      now: new Date(now()).toISOString(),
      timezone: kv.Timezone || '',
      ntp: { backend, enabled, synced: kv.NTPSynchronized === 'yes', servers, offsetMs },
    };
  }
  /**
   * POST /v1/time { timezone?, ntp?: { enabled, servers[] }, setTime?: epoch ms (manual, only while not NTP-synced) }
   * Servers are added to the distribution's defaults (an intranet without Internet just never reaches those).
   */
  function setTime(body) {
    return serial(async () => {
      if (await readPending()) throw new AgentError('E_CONFLICT', '网口修改还在等待确认：先「保留」或「恢复原设置」，再改时间', 409);
      const tz = body?.timezone === undefined ? null : String(body.timezone).trim();
      if (tz !== null) {
        if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) throw bad('时区格式不对：' + tz);
        const list = (await host('timedatectl', ['list-timezones'], { timeout: 10_000 }).catch(() => '')).split('\n').map((x) => x.trim());
        if (list.length > 1 && !list.includes(tz)) throw bad('没有这个时区：' + tz);
      }
      let ntp = null;
      if (body?.ntp !== undefined) {
        const servers = (Array.isArray(body.ntp.servers) ? body.ntp.servers : String(body.ntp.servers || '').split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean);
        if (servers.length > 4) throw bad('NTP 服务器最多 4 个');
        for (const x of servers) if (!(ipToInt(x) !== null || /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(x))) throw bad('NTP 服务器格式不对：' + x);
        ntp = { enabled: body.ntp.enabled !== false, servers };
      }
      let manual = null;
      if (body?.setTime !== undefined) {
        manual = Number(body.setTime);
        if (!Number.isFinite(manual) || manual < Date.UTC(2020, 0, 1) || manual > Date.UTC(2100, 0, 1)) throw bad('手动时间不对');
      }
      if (tz) await host('timedatectl', ['set-timezone', tz], { timeout: 15_000 });
      if (ntp) {
        const backend = await ntpBackend();
        if (backend === 'none') throw new AgentError('E_UNAVAILABLE', '本机没有时间同步服务（chrony / systemd-timesyncd）', 409);
        const file = NTP_FILES[backend];
        const text = backend === 'chrony' ? ntp.servers.map((x) => `server ${x} iburst`).join('\n') : ntp.servers.length ? `[Time]\nNTP=${ntp.servers.join(' ')}` : '';
        await host('sh', ['-c', 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" > "$1"', 'sh', file, '# Managed by H2Z host-agent (IOC admin → 设备与系统 → 时间)\n' + text], { timeout: 10_000 });
        if (backend === 'chrony') {
          if (ntp.enabled) {
            await host('systemctl', ['enable', '--now', 'chrony'], { timeout: 30_000 });
            await host('chronyc', ['reload', 'sources'], { timeout: 10_000 }).catch(() => {});
          } else await host('systemctl', ['disable', '--now', 'chrony'], { timeout: 30_000 });
        } else {
          await host('timedatectl', ['set-ntp', ntp.enabled ? 'true' : 'false'], { timeout: 15_000 });
          if (ntp.enabled) await host('systemctl', ['restart', 'systemd-timesyncd'], { timeout: 30_000 }).catch(() => {});
        }
      }
      if (manual !== null) {
        const st = await timeStatus();
        if (st.ntp.enabled && st.ntp.synced) throw new AgentError('E_CONFLICT', '已经自动对时（NTP 已同步），不用手动改；要手动改先关闭自动对时', 409);
        await host('date', ['-u', '-s', '@' + Math.round(manual / 1000)], { timeout: 10_000 });
        await host('hwclock', ['--systohc'], { timeout: 15_000 }).catch(() => {});
      }
      await audit('time', { timezone: tz || undefined, ntp: ntp || undefined, manual: manual !== null ? new Date(manual).toISOString() : undefined, by: body?.by });
      return timeStatus();
    });
  }

  /** POST /v1/name { name } — the device name people see (NVR "设备名称"); the hostname stays H2Z-xxxx */
  const setName = (body) =>
    serial(async () => {
      const name = String(body?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!name || [...name].length > 32) throw bad('设备名称要 1–32 个字');
      await writeAtomic(P.deviceName, name + '\n', 0o644);
      await audit('name', { name, by: body?.by });
      return { deviceName: name };
    });

  /** POST /v1/lang { lang } — boot screen / text console language: rewrites H2Z_LANG in os.env, everything else in the file is kept */
  const setLang = (body) =>
    serial(async () => {
      const lang = body?.lang;
      if (lang !== 'en' && lang !== 'zh-CN') throw bad('lang 只能是 en 或 zh-CN');
      const old = (await read(P.osEnv)) || '';
      const line = 'H2Z_LANG=' + lang;
      const next = /^H2Z_LANG=.*$/m.test(old) ? old.replace(/^H2Z_LANG=.*$/m, line) : old + (old && !old.endsWith('\n') ? '\n' : '') + line + '\n';
      if (next !== old) await writeAtomic(P.osEnv, next, 0o644);
      await audit('lang', { lang, by: body?.by });
      return { lang };
    });

  // ----- HDMI resolution (2026-11-08): the monitor's modes come from the kernel (/sys/class/drm/*/modes, no X needed);
  // the choice is H2Z_KIOSK_RESOLUTION in /etc/h2z/kiosk.env, which h2z-kiosk-browser applies with xrandr when the local screen starts -----
  const DEFAULT_RES = '1920x1080'; // same default as h2z-kiosk-browser
  const resArea = (r) => r.split('x').reduce((a, b) => a * Number(b), 1);
  async function displayStatus() {
    const script = 'for d in /sys/class/drm/card*-*; do [ -r "$d/status" ] || continue; printf "%s|%s|" "${d##*/}" "$(cat "$d/status")"; tr "\\n" " " < "$d/modes" 2>/dev/null; echo; done';
    let raw = '';
    try { raw = await host('sh', ['-c', script], { timeout: 5000 }); } catch { raw = ''; }
    const outputs = [];
    for (const line of String(raw).split('\n')) {
      const [name, status, modes = ''] = line.split('|');
      if (!name || !status) continue;
      const list = [...new Set(modes.trim().split(/\s+/).filter((m) => /^\d{3,5}x\d{3,5}$/.test(m)))].sort((a, b) => resArea(b) - resArea(a));
      outputs.push({ name: name.replace(/^card\d+-/, ''), connected: status.trim() === 'connected', modes: list });
    }
    const m = /^H2Z_KIOSK_RESOLUTION=(\S*)\s*$/m.exec((await read(P.kioskEnv)) || '');
    const setting = m && m[1] ? m[1].replace(/^['"]|['"]$/g, '') : DEFAULT_RES;
    const connected = outputs.filter((x) => x.connected);
    const modes = [...new Set(connected.flatMap((x) => x.modes))].sort((a, b) => resArea(b) - resArea(a));
    return { setting, connected: connected.length > 0, outputs, modes };
  }

  /** POST /v1/display { resolution: 'auto' | '1920x1080' … } — saved in kiosk.env; the local screen restarts 3 s later (recording is not touched) */
  const setDisplay = (body) =>
    serial(async () => {
      const res = String(body?.resolution ?? '').trim();
      if (res !== 'auto' && !/^\d{3,5}x\d{3,5}$/.test(res)) throw bad("resolution 要写 auto 或 1920x1080 这样的格式");
      const st = await displayStatus();
      if (res !== 'auto' && st.connected && st.modes.length && !st.modes.includes(res)) throw bad('当前显示器不支持 ' + res + '；支持：' + st.modes.slice(0, 8).join('、'));
      const old = (await read(P.kioskEnv)) || '';
      const line = 'H2Z_KIOSK_RESOLUTION=' + res;
      const next = /^H2Z_KIOSK_RESOLUTION=.*$/m.test(old) ? old.replace(/^H2Z_KIOSK_RESOLUTION=.*$/m, line) : old + (old && !old.endsWith('\n') ? '\n' : '') + line + '\n';
      if (next !== old) await writeAtomic(P.kioskEnv, next, 0o644);
      await audit('display', { resolution: res, by: body?.by });
      await host('systemd-run', ['--quiet', '--unit=h2z-kiosk-restart-' + now(), '--on-active=3s', '--timer-property=AccuracySec=1s', '/usr/local/bin/h2z-kiosk-restart'], { timeout: 15_000 });
      return { resolution: res, restartInSeconds: 3 };
    });

  /**
   * POST /v1/power { action: restart-app | reboot | shutdown } — scheduled a few seconds later on the host (systemd-run)
   * so the answer still reaches the browser; restart-app = docker compose restart in the checkout (recording pauses ~1 min).
   */
  function power(body) {
    return serial(async () => {
      const action = body?.action;
      if (!['restart-app', 'reboot', 'shutdown'].includes(action)) throw bad('action 只能是 restart-app、reboot 或 shutdown');
      const unit = 'h2z-power-' + now();
      let cmd;
      if (action === 'restart-app') {
        const repo = await repoPath();
        if (!repo) throw new AgentError('E_UNAVAILABLE', '找不到应用目录，不能重启应用服务', 409);
        cmd = ['/bin/sh', '-c', 'cd "$1" && docker compose restart', 'sh', repo];
      } else cmd = ['/usr/bin/systemctl', action === 'reboot' ? 'reboot' : 'poweroff'];
      await audit('power', { op: action, by: body?.by });
      await host('systemd-run', ['--quiet', '--unit=' + unit, '--on-active=3s', '--timer-property=AccuracySec=1s', ...cmd], { timeout: 15_000 });
      return { scheduled: action, inSeconds: 3 };
    });
  }

  /**
   * POST /v1/link/factory-reset { confirm: 'RESET-EDGE', by? } — 边缘恢复出厂：只清 edge-link 数据卷里的身份文件（密钥、认领、审计、配对码），
   * 录像 / 数据库 / 其他卷不碰。几秒后在宿主上跑 scripts/edge-factory-reset.sh（和命令行同一份实现）；之后录像机是新 ID、未认领、出新配对码。
   * 调用方（后台经 h2z.backend）必须已经验过管理员口令；这里只做二次确认串和审计。
   */
  async function linkFactoryReset(body) {
    if (!o.linkDir) throw new AgentError('E_NOT_FOUND', 'no route', 404);
    return serial(async () => {
      if (body?.confirm !== 'RESET-EDGE') throw bad('需要 confirm: "RESET-EDGE"（会换掉录像机 ID，需重新认领并在云端吊销旧机）');
      const repo = await repoPath();
      if (!repo) throw new AgentError('E_UNAVAILABLE', '找不到应用目录，不能恢复出厂', 409);
      const unit = 'h2z-edge-reset-' + now();
      await audit('edge-factory-reset', { by: body?.by });
      await host('systemd-run', ['--quiet', '--unit=' + unit, '--on-active=3s', '--timer-property=AccuracySec=1s', '/bin/sh', '-c', 'cd "$1" && sh scripts/edge-factory-reset.sh --yes', 'sh', repo], { timeout: 15_000 });
      return { scheduled: 'edge-factory-reset', inSeconds: 3 };
    });
  }

  // ----- H2Z OS full-package upgrade (2026-11-03) -----
  const U = {
    dir: o.upgradeDir,
    incoming: join(o.upgradeDir, 'incoming.h2zup'),
    staged: join(o.upgradeDir, 'staged.json'),
    state: join(o.upgradeDir, 'state.json'),
    work: join(o.upgradeDir, 'work'),
    host: (f) => join(o.upgradeHostDir, f),
  };
  const spawnHost = o.spawnHost || ((args) => spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] }));
  let upgradeJob = null; // the running preparation (verify → load images → hand over to h2z-os-upgrade)
  const readJson = async (f) => {
    try {
      return JSON.parse((await read(f)) || 'null');
    } catch {
      return null;
    }
  };
  async function currentVersion() {
    const rel = await hostCat('/usr/share/h2z/os-release');
    const e = rel ? parseEnvFile(rel) : {};
    return { version: e.H2ZOS_VERSION || '', commit: e.H2ZOS_REPO_COMMIT || '', branch: e.H2ZOS_REPO_BRANCH || '', isOs: !!rel };
  }
  async function upgradeStatus() {
    const cur = await currentVersion();
    if (!cur.isOs) {
      // 旁挂机器：用 git + scripts/update.sh 更新（见 gitRepo 一带），不要求 H2Z OS 的升级公钥 / 整包
      const repo = await gitRepo();
      if (repo) {
        const g = await gitCurrent(repo);
        const state = await readJson(U.state);
        return {
          available: true,
          reason: '',
          mode: 'git',
          current: { version: '', commit: g.commit, branch: g.branch, committedAt: g.date },
          staged: null,
          state,
          busy: !!upgradeJob || hostBusy(state) || !!upOp || !!gitOp,
          online: await gitOnlineStatus(repo),
          canRollback: false,
        };
      }
    }
    const pub = await hostCat('/usr/share/h2z/update-pubkey.pem');
    let reason = '';
    if (!cur.isOs) reason = '不是 H2Z OS 设备：用 git pull + docker compose 更新';
    else if (!pub) reason = '设备上没有升级公钥（/usr/share/h2z/update-pubkey.pem）：用新版安装盘重装一次后才能整包升级';
    else if (!existsSync(o.upgradeDir)) reason = 'host-agent 没有挂升级目录（compose.yaml 的 /var/lib/h2z/upgrade）';
    const state = await readJson(U.state);
    let staged = await readJson(U.staged);
    // 升级完成后留下的、已经装上的包（同版本或更旧）：不再显示、也不让「开始升级」重装；没人在升级时顺手清掉
    if (staged && cur.version && cmpVersion(staged.version, cur.version) <= 0 && state?.phase === 'done' && !upgradeJob && !hostBusy(state) && !upOp) {
      await remove(U.staged);
      await remove(U.incoming);
      await fsp.rm(U.work, { recursive: true, force: true }).catch(() => {});
      staged = null;
    }
    return {
      available: !reason,
      reason,
      current: { version: cur.version, commit: cur.commit, branch: cur.branch },
      staged,
      state,
      busy: !!upgradeJob || hostBusy(state) || !!upOp,
      ...(reason || !OU ? {} : { online: await onlineStatus() }),
      canRollback: state?.phase === 'done' && !upgradeJob && !upOp,
    };
  }
  const setState = async (patch) => {
    const st = { ...((await readJson(U.state)) || {}), ...patch, updatedAt: new Date(now()).toISOString() };
    await writeAtomic(U.state, JSON.stringify(st, null, 1), 0o644);
    return st;
  };
  /** sha256 of one member, read straight out of the package */
  const hashPart = (file, { offset, size }) =>
    new Promise((resolve, reject) => {
      const h = createHash('sha256');
      if (!size) return resolve(h.digest('hex'));
      createReadStream(file, { start: offset, end: offset + size - 1 }).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
  const readPart = async (file, { offset, size }) => {
    const fh = await fsp.open(file, 'r');
    try {
      const b = Buffer.alloc(size);
      await fh.read(b, 0, size, offset);
      return b;
    } finally {
      await fh.close();
    }
  };
  const copyPart = (file, { offset, size }, dest) =>
    new Promise((resolve, reject) => {
      const out = createWriteStream(dest, { mode: 0o644 });
      out.on('error', reject).on('finish', resolve);
      if (!size) return out.end();
      createReadStream(file, { start: offset, end: offset + size - 1 }).on('error', reject).pipe(out);
    });

  /** Ed25519 signature of manifest.json with the device's public key → the parsed manifest (throws E_PACKAGE) */
  async function checkSignature(manBuf, sigBuf) {
    const pem = await hostCat('/usr/share/h2z/update-pubkey.pem');
    if (!pem) throw new AgentError('E_PACKAGE', '设备上没有升级公钥：用新版安装盘重装一次后才能整包升级');
    let ok = false;
    try {
      ok = cryptoVerify(null, manBuf, createPublicKey(pem), Buffer.from(sigBuf.toString('utf8').trim(), 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw new AgentError('E_PACKAGE', '签名不对：这个升级包不是用这批设备的签名密钥做的，或者被改过');
    try {
      return JSON.parse(manBuf.toString('utf8'));
    } catch {
      throw new AgentError('E_PACKAGE', 'manifest.json 不是 JSON');
    }
  }

  /** check a package in U.incoming: signature, product / arch / version, every part's sha256 → staged.json */
  async function verifyIncoming(source) {
    const fail = async (msg) => {
      await remove(U.staged);
      throw new AgentError('E_PACKAGE', msg);
    };
    let idx;
    try {
      idx = await tarIndex(U.incoming);
    } catch (e) {
      return fail(e instanceof AgentError ? e.message : '不是升级包（读不出 tar 结构）');
    }
    const man = idx.get('manifest.json'), sig = idx.get('manifest.sig');
    if (!man || !sig || man.size > 1 << 20 || sig.size > 4096) return fail('不是 H2Z OS 升级包（缺少 manifest.json / manifest.sig）');
    const manBuf = await readPart(U.incoming, man);
    let m;
    try {
      m = await checkSignature(manBuf, await readPart(U.incoming, sig));
    } catch (e) {
      return fail(e.message);
    }
    if (m.format !== 1 || m.product !== 'H2Z OS') return fail('不是 H2Z OS 升级包（format / product 不对）');
    const arch = (await host('uname', ['-m'], { timeout: 5000 }).catch(() => 'x86_64')).trim();
    if (m.arch !== ({ x86_64: 'amd64', aarch64: 'arm64' }[arch] || arch)) return fail('升级包是 ' + m.arch + ' 的，这台设备是 ' + arch);
    const cur = await currentVersion();
    if (m.fromMin && cur.version && cmpVersion(cur.version, m.fromMin) < 0) return fail('当前版本 ' + cur.version + ' 太旧：这个升级包要求至少 ' + m.fromMin);
    if (!m.repo?.commit || !/^[0-9a-f]{7,40}$/.test(m.repo.commit) || !/^[\w./-]{1,100}$/.test(String(m.repo.branch || ''))) return fail('manifest.json 里的代码版本不对');
    for (const part of UPGRADE_PARTS) {
      const at = idx.get(part);
      if (!at) return fail('升级包缺少 ' + part);
      if ((await hashPart(U.incoming, at)) !== m.files?.[part]) return fail(part + ' 的校验和不对：文件损坏或被改过，重新拷一次');
    }
    const st = await fsp.stat(U.incoming);
    const staged = {
      version: m.version, fromMin: m.fromMin || '', created: m.created || '', notes: m.notes || '', repo: m.repo, images: m.images || [],
      sizeBytes: st.size, source, verifiedAt: new Date(now()).toISOString(), current: cur.version,
      downgrade: !!cur.version && cmpVersion(m.version, cur.version) < 0, same: !!cur.version && cmpVersion(m.version, cur.version) === 0,
    };
    await writeAtomic(U.staged, JSON.stringify(staged, null, 1), 0o644);
    await audit('upgrade-staged', { version: m.version, source });
    return staged;
  }
  // a host-side step (h2z-os-upgrade) that has not reported for 20 minutes is not running any more (crash, power cut)
  const HOST_PHASES = ['switching', 'starting', 'checking', 'rolling-back'];
  // 旁挂机器的更新（job: 'git'，host/git-update.sh 写）备份库那一段也算忙
  const hostBusy = (st) => (HOST_PHASES.includes(st?.phase) || (st?.job === 'git' && ['preparing', 'backing-up'].includes(st.phase))) && now() - Date.parse(st.updatedAt || 0) < 20 * 60_000;
  const notBusy = async () => {
    if (upgradeJob || hostBusy(await readJson(U.state))) throw new AgentError('E_CONFLICT', '正在升级 / 回退，请等它结束', 409);
    const pk = await packs(); // 扩展包的安装 / 卸载也在 docker compose up：不能和整包升级同时
    if (pk && (await pk.busy())) throw new AgentError('E_CONFLICT', '正在安装 / 卸载扩展，等它做完再升级', 409);
  };
  /** one upgrade operation at a time (upload / USB import / start / discard / rollback): a second one is refused */
  let upOp = '';
  async function exclusive(name, fn) {
    if (upOp) throw new AgentError('E_CONFLICT', '另一个升级操作正在进行（' + upOp + '），请稍后再试', 409);
    upOp = name;
    try {
      await notBusy();
      return await fn();
    } finally {
      upOp = '';
    }
  }
  const freeBytes = () => {
    try {
      const f = statfsSync(o.upgradeDir);
      return f.bavail * f.bsize;
    } catch {
      return Infinity;
    }
  };
  const tmpName = () => 'incoming-' + randomUUID() + '.part';
  async function removeParts() {
    try {
      for (const f of await fsp.readdir(o.upgradeDir)) if (/^incoming-[\w-]+\.part$/.test(f) || f === 'incoming.h2zup.part') await remove(join(o.upgradeDir, f));
    } catch {
      /* no directory */
    }
  }

  /** POST /v1/upgrade/upload: the request body is the package itself (streamed to its own temp file, size-capped) */
  const upgradeUpload = (req) =>
    exclusive('上传', async () => {
      if (!existsSync(o.upgradeDir)) throw new AgentError('E_UNAVAILABLE', 'host-agent 没有挂升级目录', 409);
      const part = join(o.upgradeDir, tmpName());
      await remove(U.staged);
      await new Promise((resolve, reject) => {
        let n = 0;
        const out = createWriteStream(part, { mode: 0o644, flags: 'wx' });
        const stop = (e) => { req.unpipe(out); out.destroy(); reject(e); }; // 出错 / 客户端断开：文件句柄要关掉，不然删掉的 .part 一直占着盘
        out.on('error', reject).on('finish', resolve);
        req.on('data', (d) => {
          n += d.length;
          if (n > o.upgradeMaxBytes) stop(new AgentError('E_PARAM', '升级包太大（超过 ' + Math.round(o.upgradeMaxBytes / 2 ** 30) + ' GB）', 413));
        });
        req.on('error', stop);
        req.on('aborted', () => stop(new AgentError('E_PARAM', '上传中断')));
        req.pipe(out);
      }).catch(async (e) => {
        await remove(part);
        throw e;
      });
      await fsp.rename(part, U.incoming);
      return verifyIncoming('upload');
    });

  /** USB sticks: mount data partitions read-only under /run/h2z-usb/<name> and list *.<ext> (default h2zup upgrade packages; h2zpack = extension packs) in their root */
  async function usbScan(ext = 'h2zup') {
    if (!/^[a-z0-9]{1,12}$/.test(ext)) throw bad('文件扩展名不对');
    let j;
    try {
      j = JSON.parse(await host('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TRAN,FSTYPE,LABEL,SIZE,MOUNTPOINT,TYPE'], { timeout: 10_000 }));
    } catch (e) {
      return { sticks: [], skipped: [{ device: '', reason: 'lsblk 执行失败：' + String(e?.stderr || e?.message || e).trim().slice(0, 200) }] };
    }
    const sticks = [];
    const skipped = []; // 看到了 U 盘却用不上的原因：界面能直接告诉人，不再只说"没找到"
    for (const disk of j.blockdevices || []) {
      if (disk.tran !== 'usb') continue;
      const parts = (disk.children || []).length ? disk.children : [disk];
      for (const p of parts) {
        if (/^H2ZINST/.test(p.label || '')) continue;
        if (!['vfat', 'exfat', 'ntfs', 'ext4'].includes(p.fstype) || !/^[\w-]+$/.test(p.name || '')) {
          if (p.type !== 'disk' || !(disk.children || []).length) skipped.push({ device: p.path || p.name || '', reason: p.fstype ? '不支持的文件系统：' + p.fstype + '（请用 FAT32 / exFAT / NTFS / ext4）' : '没有可识别的文件系统' });
          continue;
        }
        // always our own read-only mount (a desktop automount elsewhere is not trusted)
        const mnt = '/run/h2z-usb/' + p.name;
        try {
          await host('mkdir', ['-p', mnt], { timeout: 5000 });
          const mounted = (await host('findmnt', ['-rno', 'SOURCE', mnt], { timeout: 5000 }).catch(() => '')).trim();
          // NTFS：内核 6.9 起旧的 ntfs 驱动已移除，宿主又没装 ntfs-3g，必须明确用内核自带的 ntfs3
          if (!mounted) await host('mount', [...(p.fstype === 'ntfs' ? ['-t', 'ntfs3'] : []), '-o', 'ro,nosuid,nodev,noexec', p.path, mnt], { timeout: 30_000 });
        } catch (e) {
          skipped.push({ device: p.path, reason: '挂载失败（' + (p.fstype || '?') + '）：' + String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 160) });
          continue;
        }
        let files = [];
        try {
          const out = await host('find', [mnt, '-maxdepth', '1', '-type', 'f', '-iname', '*.' + ext, '-printf', '%s\t%p\n'], { timeout: 15_000 });
          files = out.trim().split('\n').filter(Boolean).map((l) => { const [size, path] = l.split('\t'); return { path, name: path.split('/').pop(), sizeBytes: Number(size) }; });
        } catch {
          /* unreadable */
        }
        sticks.push({ device: p.path, label: p.label || '', mount: mnt, sizeBytes: Number(p.size) || 0, files });
      }
    }
    return { sticks, skipped };
  }
  /** copy one package from the root of our USB mount (regular file only, no symlinks), then verify it */
  const usbImport = (body) =>
    exclusive('U 盘导入', async () => {
      const path = String(body?.path || '');
      const m = /^\/run\/h2z-usb\/([\w-]+)\/([^/]+\.h2zup)$/i.exec(path);
      if (!m || m[2].startsWith('-')) throw bad('只能从 U 盘根目录导入 .h2zup 升级包');
      // find -type f does not follow symlinks: a link (to /dev/zero, …) is not a regular file
      const size = Number((await host('find', [path, '-maxdepth', '0', '-type', 'f', '-printf', '%s'], { timeout: 10_000 }).catch(() => '')).trim());
      if (!Number.isFinite(size) || size <= 0) throw bad('U 盘上没有这个升级包（或者不是普通文件）');
      if (size > o.upgradeMaxBytes) throw bad('升级包太大（超过 ' + Math.round(o.upgradeMaxBytes / 2 ** 30) + ' GB）');
      if (freeBytes() < size * 2.2) throw new AgentError('E_SPACE', '数据盘空间不够：导入和升级要大约 ' + Math.ceil((size * 2.2) / 2 ** 30) + ' GB 空闲', 409);
      await remove(U.staged);
      const part = tmpName();
      try {
        await host('cp', ['--no-dereference', '--', path, U.host(part)], { timeout: 30 * 60_000 });
        await fsp.rename(join(o.upgradeDir, part), U.incoming);
      } catch (e) {
        await remove(join(o.upgradeDir, part));
        throw new AgentError('E_UPGRADE', '从 U 盘拷贝失败：' + String(e.stderr || e.message).slice(0, 200));
      } finally {
        await host('umount', ['/run/h2z-usb/' + m[1]], { timeout: 15_000 }).catch(() => {});
      }
      return verifyIncoming('usb');
    });

  /** copy one part of the package into work/ and hash the copy (only copies are used after this) */
  const copyHashed = (file, { offset, size }, dest) =>
    new Promise((resolve, reject) => {
      const h = createHash('sha256');
      const out = createWriteStream(dest, { mode: 0o644, flags: 'wx' });
      out.on('error', reject).on('finish', () => resolve(h.digest('hex')));
      if (!size) return out.end();
      createReadStream(file, { start: offset, end: offset + size - 1 })
        .on('error', reject)
        .on('data', (d) => h.update(d))
        .pipe(out);
    });

  /**
   * load the images, unpack code + OS files, then hand over to h2z-os-upgrade apply (runs on the host).
   * The package is checked again here (signature + every part's sha256, on the copies in work/): whatever happened to
   * incoming.h2zup after the upload, only verified bytes are executed or loaded.
   */
  async function prepare(staged, by) {
    const idx = await tarIndex(U.incoming);
    const cur = await currentVersion();
    const repo = (await repoPath()) || '/opt/h2z.security';
    let prevCommit = '', prevBranch = '';
    try {
      prevCommit = (await host('git', ['-c', 'safe.directory=*', '-C', repo, 'rev-parse', 'HEAD'], { timeout: 10_000 })).trim();
      prevBranch = (await host('git', ['-c', 'safe.directory=*', '-C', repo, 'symbolic-ref', '-q', '--short', 'HEAD'], { timeout: 10_000 }).catch(() => '')).trim();
    } catch {
      throw new AgentError('E_UPGRADE', '读不到当前应用代码版本（' + repo + '）');
    }
    const images = {};
    for (const ref of staged.images) images[ref] = (await host('docker', ['image', 'inspect', '-f', '{{.Id}}', ref], { timeout: 15_000 }).catch(() => '')).trim();
    await setState({
      phase: 'preparing', message: '复制并重新校验升级包', startedAt: new Date(now()).toISOString(), finishedAt: null, by,
      from: { version: cur.version, commit: prevCommit.slice(0, 7), branch: prevBranch },
      to: { version: staged.version, commit: staged.repo.commit.slice(0, 7), branch: staged.repo.branch },
      prev: { commit: prevCommit, branch: prevBranch, images }, repoPath: repo,
    });
    await fsp.rm(U.work, { recursive: true, force: true });
    await fsp.mkdir(U.work, { recursive: true });
    const man = idx.get('manifest.json'), sig = idx.get('manifest.sig');
    if (!man || !sig || man.size > 1 << 20 || sig.size > 4096) throw new AgentError('E_PACKAGE', '升级包变了：缺少 manifest');
    const manBuf = await readPart(U.incoming, man);
    const m = await checkSignature(manBuf, await readPart(U.incoming, sig));
    if (m.version !== staged.version || m.repo?.commit !== staged.repo.commit) throw new AgentError('E_PACKAGE', '升级包和验证时的不一样了：重新上传');
    const need = UPGRADE_PARTS.reduce((n, part) => n + (idx.get(part)?.size || 0), 0);
    if (freeBytes() < need + 512 * 2 ** 20) throw new AgentError('E_SPACE', '数据盘空间不够：升级要大约 ' + Math.ceil(need / 2 ** 30) + ' GB 空闲');
    await writeAtomic(join(U.work, 'manifest.json'), manBuf.toString('utf8'), 0o644);
    for (const part of UPGRADE_PARTS) {
      const at = idx.get(part);
      if (!at) throw new AgentError('E_PACKAGE', '升级包缺少 ' + part);
      if ((await copyHashed(U.incoming, at, join(U.work, part))) !== m.files?.[part]) throw new AgentError('E_PACKAGE', part + ' 的校验和不对：升级包在验证后被改过或损坏了');
    }
    const problems = osFileProblems(await host('tar', ['-tvf', U.host('work/os-files.tar')], { timeout: 30_000 }));
    if (problems.length) throw new AgentError('E_PACKAGE', '升级包里有不允许的系统文件：' + problems.slice(0, 3).join('、'));
    await host('tar', ['-xf', U.host('work/os-files.tar'), '-C', U.host('work'), 'usr/local/sbin/h2z-os-upgrade'], { timeout: 30_000 });
    await setState({ phase: 'loading', message: '导入应用镜像（' + staged.images.length + ' 个，几分钟）' });
    await new Promise((resolve, reject) => {
      const child = spawnHost(['docker', 'load']);
      let err = '';
      child.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new AgentError('E_UPGRADE', '导入镜像失败：' + err.trim().slice(-300)))));
      createReadStream(join(U.work, 'images.tar')).on('error', reject).pipe(child.stdin);
    });
    await remove(join(U.work, 'images.tar')); // loaded: the space goes back to the recordings
    await setState({ phase: 'switching', message: '切换到新版本' });
    await host('systemd-run', ['--quiet', '--collect', '--unit=h2z-os-upgrade-' + now(), '/bin/bash', U.host('work/usr/local/sbin/h2z-os-upgrade'), 'apply', o.upgradeHostDir], { timeout: 15_000 });
  }
  const restoreTags = async (st) => {
    for (const [ref, id] of Object.entries(st?.prev?.images || {})) if (id) await host('docker', ['tag', id, ref], { timeout: 15_000 }).catch(() => {});
  };
  // ----- 在线更新（2026-11-06，docs/PLAN-2026-11-06-REMOTE-UPGRADE.md §3）：发布镜像 → 验签 → docker pull 摘要 → 交给 h2z-os-upgrade apply -----
  const ONLINE = { file: join(o.upgradeDir, 'online.json'), release: join(o.upgradeDir, 'online/release'), backups: join(o.upgradeDir, 'backups') };
  const releaseImage = o.releaseImage || 'ghcr.io/h2ztech/h2z-release:stable';
  let onlineOp = ''; // 'check' | 'fetch'
  let onlineChild = null; // 正在跑的 docker pull（cancel 要杀）
  let onlineCancel = false;
  const onlineErr = (code, msg) => new OnlineError(code, msg);
  const onlineBlank = { state: 'idle', checkedAt: null, latest: null, progress: null, error: null };
  const loadOnline = async () => ({ ...onlineBlank, ...((await readJson(ONLINE.file)) || {}) });
  const saveOnline = async (patch) => {
    const cur = await loadOnline();
    const next = { ...cur, ...patch };
    await writeAtomic(ONLINE.file, JSON.stringify(next, null, 1), 0o644);
    return next;
  };
  const archOf = async () => ({ x86_64: 'amd64', aarch64: 'arm64' })[String(await host('uname', ['-m'], { timeout: 5000 }).catch(() => 'x86_64')).trim()] || 'amd64';
  /** 本机 compose 用的 tag 指向的镜像，内容 ID 是不是清单里的：离线装机（docker load）的镜像没有仓库摘要，只能靠它认 */
  const sameContent = async (img) => !!img.id && (await host('docker', ['image', 'inspect', '-f', '{{.Id}}', img.ref], { timeout: 15_000 }).catch(() => '')).trim() === img.id;
  const digestPresent = async (img) => !!(await host('docker', ['image', 'inspect', '-f', '{{.Id}}', pullRef(img)], { timeout: 15_000 }).catch(() => '')).trim();
  const imagePresent = async (img) => (await digestPresent(img)) || (await sameContent(img));
  const onlineBusyNow = async () => !!upgradeJob || !!upOp || !!onlineOp || hostBusy(await readJson(U.state));
  /** 读发布目录里已下载的清单并验签（check 和 start 都走这里：start 时重新验，不信任 check 之后磁盘上的东西） */
  async function readRelease() {
    const pem = await hostCat('/usr/share/h2z/update-pubkey.pem');
    if (!pem) throw onlineErr('E_ONLINE_MANIFEST', '设备上没有升级公钥');
    const rd = async (f) => { try { return await fsp.readFile(join(ONLINE.release, f), 'utf8'); } catch { return ''; } };
    const idxText = await rd('index.json');
    if (!idxText || !verifySigned(pem, idxText, await rd('index.sig'))) throw onlineErr('E_ONLINE_MANIFEST', '发布索引的签名不对');
    const idx = parseIndex(idxText);
    const manText = await rd(idx.os.path + '/manifest.json');
    if (!manText || !verifySigned(pem, manText, await rd(idx.os.path + '/manifest.sig'))) throw onlineErr('E_ONLINE_MANIFEST', '更新清单的签名不对');
    const man = parseOnlineManifest(manText, { arch: await archOf() });
    if (man.version !== idx.os.version || man.seq !== idx.os.seq) throw onlineErr('E_ONLINE_MANIFEST', '发布索引和更新清单对不上');
    return { idx, man, manText, dir: join(ONLINE.release, idx.os.path) };
  }
  /** 本机现在用的镜像是不是就是清单里这个摘要（compose 的 tag 对应的镜像 RepoDigests 里有它） */
  const imageCurrent = async (img) => {
    const out = await host('docker', ['image', 'inspect', '-f', '{{json .RepoDigests}}', img.ref], { timeout: 15_000 }).catch(() => '');
    try { if (JSON.parse(out || '[]').includes(repoOfImg(img.ref) + '@' + img.digest)) return true; } catch { /* 当没有 */ }
    return sameContent(img);
  };
  /** 清单里有镜像还不在本机（比如瘦底座装完还没有 AI 的镜像）。版本一样也要给「补齐」：否则装好的机器永远等不到 AI */
  const hasMissingImages = async (man) => { for (const img of man.images) if (!(await imagePresent(img))) return true; return false; };
  const latestOf = async (man, { fill = false } = {}) => {
    let size = 0;
    // 会换掉的镜像对应的服务 + 清单自带的 touches：含 recorder* 就提示会重启录像服务（设备可能跳过了中间版本，所以以本机实际为准）
    const changedServices = [];
    for (const img of man.images) if (!(await imageCurrent(img))) changedServices.push(...(img.services || []));
    for (const img of man.images) if (!(await imagePresent(img))) size += img.size;
    for (const f of ['repo.bundle', 'os-files.tar']) size += (await fsp.stat(join(ONLINE.release, 'os', man.version, f)).catch(() => ({ size: 0 }))).size;
    return { version: man.version, fill, sizeBytes: size, notes: man.notes, migrations: man.migrations, restartsRecorder: restartsRecorder([...man.touches, ...changedServices]), recorderDowntimeMin: 3 };
  };
  async function onlineStatus() {
    const gitRoot = await gitRepo();
    if (gitRoot) return gitOnlineStatus(gitRoot);
    const st = await loadOnline();
    const working = !!onlineOp;
    // 重启后留在 checking / downloading 的状态不可信：没有任务在跑就退回
    if (!working && (st.state === 'checking' || st.state === 'downloading')) return { ...st, state: st.latest ? 'available' : 'idle', progress: null };
    // 已下载 / 可更新的版本不比当前新（升级完成后留下的，或设备已经被 U 盘升到更新的版本）：作废，回到「可以检查」
    if (!working && (st.state === 'ready' || st.state === 'available') && st.latest?.version) {
      const cur = await currentVersion();
      // 「补齐」（版本和本机一样，只是还缺镜像）：下载好等着应用（ready）的不作废；还没下载（available）的，缺的镜像都已经到位了才作废
      const stillFilling = st.latest.fill === true && (st.state === 'ready' || await (async () => { try { return await hasMissingImages((await readRelease()).man); } catch { return false; } })());
      if (cur.version && cmpVersion(st.latest.version, cur.version) <= 0 && !stillFilling && !upgradeJob && !upOp && !hostBusy(await readJson(U.state))) {
        if (st.state === 'ready') await fsp.rm(ONLINE.release, { recursive: true, force: true }).catch(() => {});
        return await saveOnline({ state: 'idle', latest: null, progress: null, error: null });
      }
    }
    return st;
  }
  const needOU = () => { if (!OU) throw new AgentError('E_NOT_SUPPORTED', '这台设备不支持在线更新', 404); };
  async function onlineCheck(body) {
    const gitRoot = await gitRepo();
    if (gitRoot) return gitCheck(gitRoot, body);
    needOU();
    if (await onlineBusyNow()) throw new AgentError('E_ONLINE_BUSY', '正在升级 / 安装扩展 / 下载，稍后再检查', 409);
    onlineOp = 'check';
    try {
      await saveOnline({ state: 'checking', error: null });
      const cur = await currentVersion();
      try {
        await fsp.rm(ONLINE.release, { recursive: true, force: true });
        await fsp.mkdir(ONLINE.release, { recursive: true });
        try {
          await ghcrReleaseFetch({ host, image: releaseImage, destHost: U.host('online/release') });
        } catch (e) {
          throw e instanceof OnlineError ? e : onlineErr('E_ONLINE_UNREACHABLE', '连不上更新服务器：' + String(e.message || e).slice(-200));
        }
        const { man } = await readRelease();
        const prev = await loadOnline();
        if (man.seq < (prev.minSeq || 0)) throw onlineErr('E_ONLINE_MANIFEST', '更新清单比已经装过的旧，已拒绝');
        if (man.fromMin && cmpVersion(cur.version, man.fromMin) < 0) throw onlineErr('E_ONLINE_MANIFEST', '当前版本 ' + cur.version + ' 太旧，要先升级到 ' + man.fromMin + ' 以上（可以用 U 盘）');
        const newer = cmpVersion(man.version, cur.version) > 0;
        const fill = !newer && cmpVersion(man.version, cur.version) === 0 && (await hasMissingImages(man)); // 同版本但缺镜像 = 补齐（AI 等扩展包的镜像）
        await audit('online-check', { version: man.version, fill, by: body?.by });
        return await saveOnline({ state: newer || fill ? 'available' : 'latest', checkedAt: new Date(now()).toISOString(), latest: await latestOf(man, { fill }), progress: null, error: null });
      } catch (e) {
        await saveOnline({ state: 'error', checkedAt: new Date(now()).toISOString(), latest: null, error: { code: e.code || 'E_ONLINE_UNREACHABLE', message: String(e.message || e).slice(0, 300) } });
        throw e instanceof OnlineError ? new AgentError(e.code, e.message, 502) : e;
      }
    } finally {
      onlineOp = '';
    }
  }
  const pullChild = (ref) => new Promise((resolve, reject) => {
    const child = spawnHost(['docker', 'pull', '--quiet', ref]);
    onlineChild = child;
    let err = '';
    child.stderr?.on('data', (d) => (err = (err + d).slice(-1000)));
    child.on('error', reject);
    child.on('close', (code) => { onlineChild = null; code === 0 ? resolve() : reject(new Error(onlineCancel ? 'cancelled' : err.trim().slice(-200) || 'docker pull 失败 ' + code)); });
  });
  async function onlineFetch(body) {
    const gitRoot = await gitRepo();
    if (gitRoot) return gitFetchStart(gitRoot, body);
    needOU();
    const st0 = await loadOnline();
    if (st0.state !== 'available' && st0.state !== 'error') throw new AgentError('E_CONFLICT', '没有可下载的更新：先检查更新', 409);
    if (await onlineBusyNow()) throw new AgentError('E_ONLINE_BUSY', '正在升级 / 安装扩展，稍后再下载', 409);
    const { man } = await readRelease();
    onlineOp = 'fetch';
    onlineCancel = false;
    const todo = [];
    for (const img of man.images) if (!(await imagePresent(img))) todo.push(img);
    const total = todo.reduce((n, i) => n + i.size, 0);
    await saveOnline({ state: 'downloading', error: null, progress: { doneBytes: 0, totalBytes: total } });
    await audit('online-fetch', { version: man.version, images: todo.length, by: body?.by });
    // 后台下载：这个调用马上返回，界面轮询 GET /v1/upgrade
    (async () => {
      let done = 0;
      try {
        for (const img of todo) {
          if (onlineCancel) throw new Error('cancelled');
          await pullChild(pullRef(img));
          done += img.size;
          await saveOnline({ progress: { doneBytes: done, totalBytes: total } });
        }
        await saveOnline({ state: 'ready', progress: { doneBytes: total, totalBytes: total } });
      } catch (e) {
        if (onlineCancel) await saveOnline({ state: 'available', progress: null, error: null });
        else {
          const disk = /no space|space left/i.test(String(e.message));
          await saveOnline({ state: 'error', error: { code: disk ? 'E_ONLINE_DISK' : 'E_ONLINE_DOWNLOAD', message: String(e.message || e).slice(0, 300) } });
        }
      } finally {
        onlineOp = '';
        onlineChild = null;
      }
    })();
    return { started: true, version: man.version };
  }
  async function onlineCancelFetch() {
    if (gitOp === 'fetch') {
      gitCancel = true;
      try { gitChild?.kill?.(); } catch {}
      return { cancelled: true };
    }
    if (onlineOp !== 'fetch') return { cancelled: false };
    onlineCancel = true;
    try { onlineChild?.kill?.(); } catch {}
    return { cancelled: true };
  }
  async function onlineDiscard() {
    if (await gitRepo()) {
      if (gitOp) throw new AgentError('E_CONFLICT', '正在检查 / 下载，先取消', 409);
      await saveGit({ state: 'idle', latest: null, progress: null, error: null });
      return { discarded: true };
    }
    if (onlineOp) throw new AgentError('E_CONFLICT', '正在检查 / 下载，先取消', 409);
    await fsp.rm(ONLINE.release, { recursive: true, force: true });
    await saveOnline({ state: 'idle', latest: null, progress: null, error: null });
    return { discarded: true };
  }
  /** 扩展包目录：发布索引（验过签）里的 packs。10 分钟内下载过发布目录就复用，否则重新取（不动 online.json 的状态） */
  async function onlinePackList() {
    const fresh = existsSync(join(ONLINE.release, 'index.json')) && now() - (await fsp.stat(join(ONLINE.release, 'index.json'))).mtimeMs < 10 * 60_000;
    if (!fresh && !onlineOp) {
      await fsp.rm(ONLINE.release, { recursive: true, force: true });
      await fsp.mkdir(ONLINE.release, { recursive: true });
      await ghcrReleaseFetch({ host, image: releaseImage, destHost: U.host('online/release') });
    }
    return (await readRelease()).idx.packs;
  }
  /** pg_dump → 备份目录，保留最近 3 份；失败就不升级（有迁移时没备份等于没有退路） */
  async function backupDb() {
    const id = (await host('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.service=postgres'], { timeout: 15_000 })).trim().split(/\s+/)[0];
    if (!id) throw new AgentError('E_UPGRADE', '找不到数据库容器，不能备份');
    await fsp.mkdir(ONLINE.backups, { recursive: true });
    const d = new Date(now()), p = (n) => String(n).padStart(2, '0');
    const name = 'db-' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + '.sql.gz';
    const file = U.host('backups/' + name);
    await host('sh', ['-c', `docker exec ${id} sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip' > '${file}' && test -s '${file}' && gunzip -t '${file}'`], { timeout: 15 * 60_000 }).catch(async (e) => {
      await host('rm', ['-f', file], { timeout: 10_000 }).catch(() => {});
      throw new AgentError('E_UPGRADE', '数据库备份失败：' + String(e.message || e).slice(-200) + '；没有切换版本');
    });
    const names = await fsp.readdir(ONLINE.backups).catch(() => []);
    for (const old of backupsToDelete(names, 3)) await fsp.rm(join(ONLINE.backups, old), { force: true });
    return name;
  }
  async function prepareOnline(by) {
    const { man, manText, dir } = await readRelease();
    const ol = await loadOnline();
    if (ol.state !== 'ready') throw new AgentError('E_CONFLICT', '更新还没下载好', 409);
    const cur = await currentVersion();
    const repo = (await repoPath()) || '/opt/h2z.security';
    let prevCommit = '', prevBranch = '';
    try {
      prevCommit = (await host('git', ['-c', 'safe.directory=*', '-C', repo, 'rev-parse', 'HEAD'], { timeout: 10_000 })).trim();
      prevBranch = (await host('git', ['-c', 'safe.directory=*', '-C', repo, 'symbolic-ref', '-q', '--short', 'HEAD'], { timeout: 10_000 }).catch(() => '')).trim();
    } catch {
      throw new AgentError('E_UPGRADE', '读不到当前应用代码版本（' + repo + '）');
    }
    const images = {};
    for (const img of man.images) images[img.ref] = (await host('docker', ['image', 'inspect', '-f', '{{.Id}}', img.ref], { timeout: 15_000 }).catch(() => '')).trim();
    await setState({
      phase: 'preparing', source: 'online', message: '校验升级清单', startedAt: new Date(now()).toISOString(), finishedAt: null, by,
      from: { version: cur.version, commit: prevCommit.slice(0, 7), branch: prevBranch },
      to: { version: man.version, commit: man.repo.commit.slice(0, 7), branch: man.repo.branch },
      prev: { commit: prevCommit, branch: prevBranch, images }, repoPath: repo,
    });
    await fsp.rm(U.work, { recursive: true, force: true });
    await fsp.mkdir(U.work, { recursive: true });
    await writeAtomic(join(U.work, 'manifest.json'), manText, 0o644);
    for (const part of ['repo.bundle', 'os-files.tar']) {
      const src = join(dir, part);
      const size = (await fsp.stat(src).catch(() => null))?.size;
      if (size == null) throw new AgentError('E_PACKAGE', '更新缺少 ' + part + '：重新检查更新');
      if ((await copyHashed(src, { offset: 0, size }, join(U.work, part))) !== man.files[part]) throw new AgentError('E_PACKAGE', part + ' 的校验和不对：重新检查更新');
    }
    const problems = osFileProblems(await host('tar', ['-tvf', U.host('work/os-files.tar')], { timeout: 30_000 }));
    if (problems.length) throw new AgentError('E_PACKAGE', '更新里有不允许的系统文件：' + problems.slice(0, 3).join('、'));
    await host('tar', ['-xf', U.host('work/os-files.tar'), '-C', U.host('work'), 'usr/local/sbin/h2z-os-upgrade'], { timeout: 30_000 });
    for (const img of man.images) if (!(await imagePresent(img))) throw new AgentError('E_PACKAGE', '镜像 ' + img.ref + ' 不在本机：重新下载');
    await setState({ phase: 'backing-up', message: '备份数据库' });
    const backup = await backupDb();
    await setState({ phase: 'switching', message: '切换到新版本', backup });
    // 摘要对上的镜像才改成 compose 里用的 tag；h2z-os-upgrade 的自检失败会按 prev.images 把 tag 改回去
    for (const img of man.images) if (await digestPresent(img)) await host('docker', ['tag', pullRef(img), img.ref], { timeout: 15_000 }); // 只有「内容 ID 相同」的镜像没有摘要可 tag：它的 tag 本来就指向这份
    await saveOnline({ minSeq: Math.max(ol.minSeq || 0, man.seq) });
    await host('systemd-run', ['--quiet', '--collect', '--unit=h2z-os-upgrade-' + now(), '/bin/bash', U.host('work/usr/local/sbin/h2z-os-upgrade'), 'apply', o.upgradeHostDir], { timeout: 15_000 });
  }
  // ----- 旁挂机器的更新（2026-11-11）：不是 H2Z OS（Orange Pi / NAS / 普通 Linux 上的 B 形态，仓库在 /opt/h2z.security 一类的目录）-----
  // 界面和 H2Z OS 的在线更新是同一套（检查 → 下载 → 升级），底层换成 git + scripts/update.sh：
  //   检查 = git fetch，看落后几个提交（提交标题就是更新说明）；
  //   下载 = 拉代码（--ff-only）+ docker compose pull，不重启任何容器；
  //   升级 = 宿主上 systemd-run 跑 host/git-update.sh（备份库 → scripts/update.sh → 补宿主层），进度写进和整包升级同一个 state.json（job: 'git'）。
  // 宿主脚本要用 systemd-run 起：update.sh 会重建 host-agent 自己，它不能是 host-agent 的子进程。
  const GIT = { file: join(o.upgradeDir, 'git-online.json') };
  let gitOp = ''; // 'check' | 'fetch'
  let gitChild = null;
  let gitCancel = false;
  let gitCur = { at: 0, val: null };
  const loadGit = async () => ({ ...onlineBlank, ...((await readJson(GIT.file)) || {}) });
  const saveGit = async (patch) => {
    const next = { ...(await loadGit()), ...patch };
    await writeAtomic(GIT.file, JSON.stringify(next, null, 1), 0o644);
    return next;
  };
  /** 旁挂机器的部署目录；H2Z OS、没有 update.sh / git-update.sh 的返回 ''（那就走原来的 H2Z OS 整包 / 在线升级） */
  async function gitRepo() {
    if ((await currentVersion()).isOs) return '';
    const repo = await repoPath();
    if (!repo) return '';
    const yes = await host('sh', ['-c', 'test -f "$1/scripts/update.sh" && test -f "$1/host/git-update.sh" && echo yes', 'sh', repo], { timeout: 5000 }).catch(() => '');
    return String(yes).trim() === 'yes' ? repo : '';
  }
  /** 部署目录的属主（日常用户：在 docker 组里、有 GitHub 部署密钥）和他的家目录 */
  async function ownerEnv(repo) {
    const owner = String(await host('stat', ['-c', '%U', repo], { timeout: 5000 })).trim();
    const home = String(await host('sh', ['-c', 'getent passwd "$1" | cut -d: -f6', 'sh', owner], { timeout: 5000 })).trim();
    if (!owner || !home) throw new AgentError('E_UPGRADE', '查不到部署目录的属主 / 家目录，没法以他的身份跑 git', 500);
    return { owner, home };
  }
  /** 以部署目录属主的身份在宿主上跑一段 sh（$1 = 部署目录）；git 要用他的 ~/.ssh 里的部署密钥 */
  async function asOwner(repo, script, opts = {}) {
    const { owner, home } = await ownerEnv(repo);
    return String(await host('runuser', ['-u', owner, '--', 'env', 'HOME=' + home, 'sh', '-c', script, 'sh', repo], { timeout: 120_000, ...opts }));
  }
  /** 同上，但可以取消、没有输出上限（下载用） */
  async function asOwnerChild(repo, script, ms) {
    const { owner, home } = await ownerEnv(repo);
    return new Promise((resolve, reject) => {
      const child = spawnHost(['runuser', '-u', owner, '--', 'env', 'HOME=' + home, 'sh', '-c', script, 'sh', repo]);
      gitChild = child;
      let err = '';
      const timer = setTimeout(() => { try { child.kill?.(); } catch {} }, ms);
      child.stderr?.on('data', (d) => (err = (err + d).slice(-1000)));
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); gitChild = null; code === 0 ? resolve() : reject(new Error(gitCancel ? 'cancelled' : err.trim().slice(-200) || '命令失败 ' + code)); });
    });
  }
  async function gitCurrent(repo, fresh = false) {
    if (!fresh && gitCur.val && now() - gitCur.at < 30_000) return gitCur.val;
    const out = await asOwner(repo, 'cd "$1" && git rev-parse --short HEAD && git rev-parse --abbrev-ref HEAD && git log -1 --format=%cs', { timeout: 15_000 }).catch(() => '');
    const [commit = '', branch = '', date = ''] = out.trim().split('\n');
    gitCur = { at: now(), val: { commit, branch, date } };
    return gitCur.val;
  }
  const gitBusyNow = async () => !!upgradeJob || !!upOp || !!gitOp || hostBusy(await readJson(U.state));
  async function gitOnlineStatus(repo) {
    const st = await loadGit();
    if (gitOp) return st;
    // 重启后留在 checking / downloading 的状态不可信：没有任务在跑就退回
    if (st.state === 'checking' || st.state === 'downloading') return { ...st, state: st.latest ? 'available' : 'idle', progress: null };
    if ((st.state === 'ready' || st.state === 'available') && st.latest && !hostBusy(await readJson(U.state))) {
      // 已经追平（升级完成 / 有人手动 git pull 过）：作废，回到「可以检查」
      const behind = Number((await asOwner(repo, 'cd "$1" && git rev-list --count "HEAD..@{u}"', { timeout: 15_000 }).catch(() => '1')).trim());
      if (behind === 0) return await saveGit({ state: 'idle', latest: null, progress: null, error: null });
    }
    return st;
  }
  async function gitCheck(repo, body) {
    if (await gitBusyNow()) throw new AgentError('E_ONLINE_BUSY', '正在升级 / 安装扩展 / 下载，稍后再检查', 409);
    gitOp = 'check';
    try {
      await saveGit({ state: 'checking', error: null });
      try {
        try {
          await asOwner(repo, 'cd "$1" && git fetch --quiet origin', { timeout: 120_000 });
        } catch (e) {
          throw new AgentError('E_GIT_FETCH', '连不上代码仓库（git fetch 失败）：' + String(e.stderr || e.message || e).trim().slice(-200) + '。检查设备的网络和 GitHub 部署密钥。现在运行的系统没有受任何影响。', 502);
        }
        const out = await asOwner(repo, 'cd "$1" && git rev-parse --short "@{u}" && git log -1 --format=%cs "@{u}" && git rev-list --count "HEAD..@{u}" && git diff --name-only HEAD "@{u}" | head -400 | tr "\\n" " " && echo && git log --format=%s -n 20 "HEAD..@{u}"', { timeout: 30_000 });
        const [up = '', upDate = '', behindText = '0', files = '', ...subjects] = out.split('\n');
        const behind = Number(behindText) || 0;
        const changed = files.trim().split(/\s+/).filter(Boolean);
        // 改了 compose / 配置 / 录像相关文件的更新，录像服务多半要重建（保守估计）
        const restartsRecorder = changed.some((f) => /^(docker2\/)?compose[\w.-]*\.ya?ml$|^config\/|recorder|zlm/i.test(f));
        const latest = { version: up + (upDate ? '（' + upDate + '）' : ''), sizeBytes: 0, notes: subjects.map((s) => s.trim()).filter(Boolean), migrations: 'compatible', restartsRecorder, recorderDowntimeMin: 3 };
        await audit('online-check', { source: 'git', behind, by: body?.by });
        return await saveGit({ state: behind > 0 ? 'available' : 'latest', checkedAt: new Date(now()).toISOString(), latest: behind > 0 ? latest : null, progress: null, error: null });
      } catch (e) {
        await saveGit({ state: 'error', checkedAt: new Date(now()).toISOString(), latest: null, error: { code: e.code || 'E_GIT_FETCH', message: String(e.message || e).slice(0, 300) } });
        throw e;
      }
    } finally {
      gitOp = '';
    }
  }
  async function gitFetchStart(repo, body) {
    const st0 = await loadGit();
    if (st0.state !== 'available' && st0.state !== 'error') throw new AgentError('E_CONFLICT', '没有可下载的更新：先检查更新', 409);
    if (await gitBusyNow()) throw new AgentError('E_ONLINE_BUSY', '正在升级 / 安装扩展，稍后再下载', 409);
    gitOp = 'fetch';
    gitCancel = false;
    await saveGit({ state: 'downloading', error: null, progress: null });
    await audit('online-fetch', { source: 'git', by: body?.by });
    // 后台下载：这个调用马上返回，界面轮询 GET /v1/upgrade
    (async () => {
      try {
        await asOwnerChild(repo, 'cd "$1" && git merge --ff-only --quiet "@{u}"', 5 * 60_000);
        if (gitCancel) throw new Error('cancelled');
        // 低优先级拉镜像：录像在跑，不能被下载抢磁盘和 CPU
        await asOwnerChild(repo, 'cd "$1" && if command -v ionice >/dev/null 2>&1; then ionice -c3 nice -n 19 docker compose pull --ignore-pull-failures --quiet; else docker compose pull --ignore-pull-failures --quiet; fi', 60 * 60_000);
        gitCur = { at: 0, val: null };
        await saveGit({ state: 'ready', progress: null });
      } catch (e) {
        if (gitCancel) await saveGit({ state: 'available', progress: null, error: null });
        else {
          const disk = /no space|space left/i.test(String(e.message));
          await saveGit({ state: 'error', error: { code: disk ? 'E_ONLINE_DISK' : 'E_ONLINE_DOWNLOAD', message: String(e.message || e).slice(0, 300) } });
        }
      } finally {
        gitOp = '';
        gitChild = null;
      }
    })();
    return { started: true, source: 'git' };
  }
  async function gitStart(repo, body) {
    const st = await loadGit();
    if (st.state !== 'ready') throw new AgentError('E_CONFLICT', '更新还没下载好', 409);
    const { owner } = await ownerEnv(repo);
    const cur = await gitCurrent(repo, true);
    await audit('upgrade-start', { source: 'git', by: body?.by });
    // 先把状态写成「备份数据库」：界面马上有进度，宿主脚本接着往同一个文件写
    await setState({ job: 'git', source: 'online', phase: 'backing-up', message: '备份数据库', from: { version: cur.commit, commit: cur.commit }, to: { version: st.latest?.version || '', commit: '' }, startedAt: new Date(now()).toISOString(), finishedAt: null, backup: null });
    try {
      await host('systemd-run', ['--quiet', '--collect', '--unit=h2z-git-update-' + now(), 'sh', repo + '/host/git-update.sh', repo, owner, o.upgradeHostDir], { timeout: 15_000 });
    } catch (e) {
      await setState({ phase: 'failed', message: '没能启动更新：' + String(e.stderr || e.message || e).trim().slice(-200) + '；没有切换版本' });
      throw new AgentError('E_UPGRADE', '没能启动更新', 500);
    }
    return { started: true, source: 'git' };
  }
  const upgradeStart = (body) =>
    exclusive('开始升级', async () => {
      if (body?.source === 'online') {
        const gitRoot = await gitRepo();
        if (gitRoot) return gitStart(gitRoot, body);
        needOU();
        await audit('upgrade-start', { source: 'online', by: body?.by });
        const fillIn = (await loadOnline()).latest?.fill === true;
        upgradeJob = prepareOnline(body?.by)
          .then(async () => { if (fillIn) await saveOnline({ state: 'idle', latest: null, progress: null, error: null }); }) // 补齐没有「版本变新」可以用来作废，应用一开始就收起这条
          .catch(async (e) => {
            await restoreTags(await readJson(U.state));
            await setState({ phase: 'failed', message: (e instanceof AgentError ? e.message : String(e.message || e)).slice(0, 400) + '；没有切换版本' });
          })
          .finally(() => {
            upgradeJob = null;
          });
        return { started: true, source: 'online' };
      }
      const staged = await readJson(U.staged);
      if (!staged || !existsSync(U.incoming)) throw new AgentError('E_CONFLICT', '还没有验证过的升级包：先上传或从 U 盘导入', 409);
      if (staged.downgrade && body?.allowDowngrade !== true) throw new AgentError('E_CONFLICT', '这是旧版本（' + staged.version + '）：确认要降级后再开始', 409);
      await audit('upgrade-start', { version: staged.version, downgrade: !!staged.downgrade, by: body?.by });
      upgradeJob = prepare(staged, body?.by)
        .catch(async (e) => {
          // nothing switched yet: images that took over a tag are put back
          await restoreTags(await readJson(U.state));
          await setState({ phase: 'failed', message: (e instanceof AgentError ? e.message : String(e.message || e)).slice(0, 400) + '；没有切换版本' });
        })
        .finally(() => {
          upgradeJob = null;
        });
      return { started: true, version: staged.version };
    });
  const upgradeDiscard = () =>
    exclusive('丢掉升级包', async () => {
      await remove(U.staged);
      await remove(U.incoming);
      await removeParts();
      await fsp.rm(U.work, { recursive: true, force: true });
      return { discarded: true };
    });
  const upgradeRollback = (body) =>
    exclusive('回退', async () => {
      const st = await readJson(U.state);
      if (st?.job === 'git') throw new AgentError('E_CONFLICT', '旁挂机器的更新不能在页面回退：在设备上 git checkout 旧提交，再 docker compose up -d（升级前的数据库备份在 /var/lib/h2z/upgrade/backups/）', 409);
      if (st?.phase !== 'done') throw new AgentError('E_CONFLICT', '只有升级完成后才能回退到上一个版本', 409);
      await audit('upgrade-rollback', { from: st.to?.version, to: st.from?.version, by: body?.by });
      await setState({ phase: 'rolling-back', message: '回退到 ' + (st.from?.version || '上一个版本') });
      await host('systemd-run', ['--quiet', '--collect', '--unit=h2z-os-rollback-' + now(), '/bin/bash', '/usr/local/sbin/h2z-os-upgrade', 'rollback', o.upgradeHostDir, 'manual'], { timeout: 15_000 });
      return { started: true };
    });
  /** at start: a preparation that was running in a previous host-agent (restart / OOM) is over — say so, put tags back */
  async function recoverUpgrade() {
    await removeParts();
    const st = await readJson(U.state);
    if (st && ['preparing', 'loading', 'backing-up'].includes(st.phase) && !upgradeJob && st.job !== 'git') {
      await restoreTags(st);
      await setState({ phase: 'failed', message: '升级准备时设备管理服务重启了，升级已中断；没有切换版本，可以重新开始' });
      return 'interrupted';
    }
    return 'ok';
  }

  // ----- 扩展包（接口约定 docs/PACKS-API.md；实现在 packs.mjs，只有 H2Z OS 的 compose.lean.yaml 挂它）-----
  // U 盘文件只存在于宿主的挂载命名空间里（容器里看不到）：用宿主上的 dd / stat 读一小段（tar 头、manifest.json、base64 签名，都是 ASCII，utf8 来回不失真）。
  // 整个 images.tar 不在这里读——宿主脚本 h2z-os-pack 自己拷、边拷边算 sha256。
  const usbHostOnly = (f) => String(f).startsWith('/run/h2z-usb/');
  const hostRange = async (file, pos, len) =>
    len > 0 ? Buffer.from(await host('dd', ['if=' + file, 'iflag=skip_bytes,count_bytes', 'skip=' + pos, 'count=' + len, 'bs=65536', 'status=none'], { timeout: 30_000 }), 'utf8') : Buffer.alloc(0);
  const hostOpen = (file) => async () => ({
    stat: async () => ({ size: Number((await host('stat', ['-c', '%s', file], { timeout: 10_000 })).trim()) }),
    read: async (buf, off, len, pos) => {
      const b = await hostRange(file, pos, len);
      b.copy(buf, off);
      return { bytesRead: b.length, buffer: buf };
    },
    close: async () => {},
  });
  let packsLoad; // 第一次调用时开始加载，并发的调用等同一个结果；null = 这台设备没有扩展包功能
  const packs = () => (packsLoad ||= loadPacks());
  async function loadPacks() {
    let packsApi = null;
    if (!o.packsEnabled) return null;
    try {
      if (!existsSync(o.packsCatalog)) throw new Error('没有 ' + o.packsCatalog);
      const mod = await (o.packsImport ? o.packsImport() : import('./packs.mjs'));
      const signalExit = (e) => e && (e.code === 3 || e.code === 4);
      packsApi = mod.createPacks({
        AgentError, now,
        paths: { state: P.packsState, settings: P.packsSettings, dir: o.packsDir, hostDir: o.packsHostDir, catalog: o.packsCatalog },
        noRestart: o.packsNoRestart,
        readJson, writeAtomic, remove,
        rename: (a, b) => fsp.rename(a, b),
        mkdirp: (dir) => fsp.mkdir(dir, { recursive: true }),
        readdir: (dir) => fsp.readdir(dir),
        stat: (f) => fsp.stat(f),
        tarIndex: (f) => (usbHostOnly(f) ? tarIndex(f, { open: hostOpen(f) }) : tarIndex(f)),
        readPart: (f, m) => (usbHostOnly(f) ? hostRange(f, m.offset, m.size) : readPart(f, m)),
        hashPart: (f, m) => {
          if (usbHostOnly(f)) throw new AgentError('E_PARAM', 'U 盘上的包由宿主脚本校验，这里不读整个镜像文件', 400);
          return hashPart(f, m);
        },
        hostCat,
        usbScan: (ext) => usbScan(ext),
        osVersion: async () => (await currentVersion()).version,
        hostArch: async () => (await host('uname', ['-m'], { timeout: 5000 }).catch(() => 'x86_64')).trim(),
        freeBytes: (dir) => {
          try {
            const f = statfsSync(dir);
            return f.bavail * f.bsize;
          } catch {
            return Infinity;
          }
        },
        maxBytes: o.packsMaxBytes,
        source: o.packsSource || (o.packsOnline && PS?.ghcrSource ? PS.ghcrSource({ host, getPacks: () => onlinePackList(), toHost: (f) => String(f).replace(/^\/packs(?=\/)/, o.packsHostDir) }) : undefined), // 下载源（scripts/pack-source.mjs）；没有 = 不能联网安装
        upgradeBusy: async () => !!upgradeJob || hostBusy(await readJson(U.state)) || !!upOp, // 整包升级在进行就不装 / 卸扩展
        audit,
        // 宿主上用 systemd-run 起 h2z-os-pack（低优先级：不拖累录像）；重建 backend / host-agent 都不会把它打断
        launch: (unit, args) => host('systemd-run', ['--quiet', '--collect', '--unit=' + unit, '-p', 'Nice=10', '-p', 'IOSchedulingClass=idle', '/bin/bash', '/usr/local/sbin/h2z-os-pack', ...args], { timeout: 15_000 }),
        // 取消：只给主进程发 SIGUSR1（不要连 tar / docker compose 子进程一起收），脚本在第 1、2 步里清理退出，第 3 步起自己忽略
        signal: async (unit) => {
          try {
            await host('systemctl', ['kill', '--kill-whom=main', '--signal=SIGUSR1', unit + '.service'], { timeout: 10_000 });
            return true;
          } catch {
            return false;
          }
        },
        unitActive: async (unit) => {
          try {
            await host('systemctl', ['is-active', '--quiet', unit + '.service'], { timeout: 5000 });
            return true;
          } catch (e) {
            return signalExit(e) ? false : null; // 3 = inactive，4 = 没有这个单元；别的（没有 systemd 等）= 不知道
          }
        },
      });
      await packsApi.cleanIncoming();
    } catch (e) {
      console.error('host-agent: 扩展包功能不可用：', String(e.message || e).slice(0, 200));
      packsApi = null;
    }
    return packsApi;
  }

  // ----- Tailscale -----
  // 「远程接入」（Tailscale）是底座自带的（2026-11-08 起，不再是扩展包）：tailscale-cli 一次性容器把命令行复制进共享卷，
  // 命令行在 = 已安装；tailscaled 没登录就不连任何网络（默认关），在后台填授权密钥登录、点开关才启用。
  // 命令行不在（tailscale-cli 没跑过，或者老板子的 compose 没带）才回 installed:false，登录 / 退出回 409。
  const ts = (args, timeout = 20_000) => local(o.tailscaleCli, ['--socket=' + o.tailscaleSocket, ...args], { timeout });
  const tsInstalled = async () => existsSync(o.tailscaleCli);
  const tsNotInstalled = () => new AgentError('E_TAILSCALE_NOT_INSTALLED', '这台设备没有 Tailscale 命令行（tailscale-cli 没有运行），重新 docker compose up -d 一次', 409);
  async function tailscaleStatus() {
    if (!(await tsInstalled())) return { installed: false, available: false, reason: '这台设备没有 Tailscale 命令行（tailscale-cli 没有运行）' };
    if (!existsSync(o.tailscaleSocket)) return { installed: true, available: false, reason: 'Tailscale 服务没有运行' };
    try {
      return { installed: true, ...summarizeTailscale(JSON.parse(await ts(['status', '--json'], 10_000))) };
    } catch (e) {
      return { installed: true, available: false, reason: String(e.stderr || e.message).slice(0, 200) };
    }
  }
  function tailscaleLogin(body) {
    return serial(async () => {
      if (!(await tsInstalled())) throw tsNotInstalled();
      const key = String(body?.authKey || '').trim();
      if (key) {
        if (!/^tskey-[A-Za-z0-9_-]+$/.test(key)) throw bad('授权密钥格式不对（应以 tskey- 开头）');
        try {
          await ts(['login', '--auth-key=' + key, '--timeout=60s'], 75_000);
        } catch (e) {
          throw new AgentError('E_TAILSCALE', 'Tailscale 登录失败：' + String(e.stderr || e.message).slice(0, 300), 502);
        }
        return tailscaleStatus();
      }
      // interactive: start `tailscale login` in the background and hand back the login URL
      const child = (o.spawn || spawn)(o.tailscaleCli, ['--socket=' + o.tailscaleSocket, 'login', '--timeout=10m'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const url = await new Promise((resolve) => {
        let buf = '';
        const done = (u) => {
          clearTimeout(t);
          resolve(u);
        };
        const onData = (d) => {
          buf += d;
          const m = /https:\/\/\S+/.exec(buf);
          if (m) done(m[0]);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on?.('exit', () => done(''));
        const t = setTimeout(() => done(''), 15_000);
      });
      child.unref?.();
      const st = await tailscaleStatus();
      return { ...st, authUrl: url || st.authUrl || '' };
    });
  }
  /** on/off switch: `tailscale up` / `tailscale down`; the login (node key) stays, so switching back on needs no new key */
  const tailscaleEnable = (body) =>
    serial(async () => {
      if (!(await tsInstalled())) throw tsNotInstalled();
      if (typeof body?.enabled !== 'boolean') throw bad('enabled 要是 true 或 false');
      try {
        if (body.enabled) await ts(['up', '--timeout=30s'], 45_000);
        else await ts(['down'], 30_000);
      } catch (e) {
        throw new AgentError('E_TAILSCALE', 'Tailscale ' + (body.enabled ? '启用' : '停用') + '失败：' + String(e.stderr || e.message).slice(0, 300), 502);
      }
      return tailscaleStatus();
    });
  const tailscaleLogout = () =>
    serial(async () => {
      if (!(await tsInstalled())) throw tsNotInstalled();
      await ts(['logout'], 30_000).catch((e) => {
        throw new AgentError('E_TAILSCALE', 'Tailscale 退出失败：' + String(e.stderr || e.message).slice(0, 300), 502);
      });
      return tailscaleStatus();
    });

  // ----- layer-2 neighbour scan -----
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readArp = o.readArp || (() => fs.readFile('/proc/net/arp', 'utf8'));
  /** one UDP datagram to the discard port: the kernel resolves the address first (ARP); errors are expected */
  const probeOnce = o.probe || (() => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => {});
    return {
      send: (ip) => new Promise((resolve) => sock.send(Buffer.from('h2z'), 9, ip, () => resolve())),
      close: () => { try { sock.close(); } catch { /* closed */ } },
    };
  });
  let scanning = false;
  async function l2Scan(body) {
    if (scanning) throw new AgentError('E_CONFLICT', '二层扫描正在进行，请稍后再试', 409);
    scanning = true;
    const started = now();
    try {
      const s = await settings();
      const addrs = parseIpAddrs(await host('ip', ['-4', '-o', 'addr', 'show'], { timeout: 5000 }).catch(() => ''));
      const plan = planL2Scan(body?.cidrs, { onLink: addrs.filter((a) => !/^(lo|docker|br-|veth|tailscale)/.test(a.iface)), apNetwork: s?.apNetwork || '192.168.234.0/24' });
      const own = addrs.map((a) => a.ip);
      const perSec = Math.max(5, Math.min(100, Number(o.l2RatePerSec) || 20));
      const gapMs = Math.round(1000 / perSec);
      const found = new Map();
      let probed = 0;
      const probe = probeOnce();
      try {
        for (const t of plan.targets) {
          const ips = hostsOf(t, own);
          for (let i = 0; i < ips.length; i += 128) {
            const chunk = ips.slice(i, i + 128);
            for (const ip of chunk) {
              await probe.send(ip);
              probed++;
              await sleep(gapMs);
            }
            await sleep(o.l2SettleMs ?? 1500); // let the last ARP replies arrive
            const wanted = new Set(chunk);
            for (const n of parseArpTable(await readArp())) if (wanted.has(n.ip)) found.set(n.ip, n);
          }
        }
      } finally {
        probe.close?.();
      }
      const neighbors = [...found.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)).map(({ ip, mac, iface }) => ({ ip, mac, iface }));
      return {
        scannedAt: new Date(now()).toISOString(),
        durationMs: now() - started,
        scanned: plan.targets.map((t) => t.cidr),
        skipped: plan.skipped,
        probed,
        neighbors,
      };
    } finally {
      scanning = false;
    }
  }

  // ----- camera discovery (WS-Discovery + SADP) -----
  let discovering = false;
  /** 真正收发组播的部分（测试里替换成假的）：在每个网口上发查询，收 seconds 秒内的回复 → [{proto, from, data}] */
  const multicast = o.multicast || (async ({ ifaces, wsdProbes, sadpProbe: sp, seconds }) => {
    const replies = [];
    const sockets = [];
    let dropped = 0;
    const keep = (r) => {
      if (replies.length >= DISCOVERY_MAX_REPLIES) return void dropped++;
      replies.push(r);
    };
    const open = (port, reuseAddr, onMsg) =>
      new Promise((resolve) => {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr });
        sockets.push(sock); // 不管绑没绑上，最后都关
        sock.on('error', (e) => {
          console.error(`host-agent: discovery socket ${port}:`, e.message);
          resolve(null);
        });
        sock.on('message', (msg, rinfo) => {
          if (msg.length > DISCOVERY_MAX_REPLY) return void dropped++; // 太大不解析
          onMsg(msg.toString('utf8'), rinfo.address);
        });
        sock.bind(port, () => resolve(sock));
      });
    try {
      // WS-Discovery：每个网口一个随机端口的套接字，回复单播回来；指定不了网口的不用（否则会从默认口发出去）
      const wsdSocks = [];
      for (const f of ifaces) {
        const sock = await open(0, false, (data, from) => keep({ proto: 'wsd', from, data, iface: f.iface }));
        if (!sock) continue;
        try {
          sock.setMulticastInterface(f.ip);
          sock.setMulticastTTL(1);
          wsdSocks.push(sock);
        } catch (e) {
          console.error(`host-agent: discovery: ${f.iface} 不能发组播：${e.message}`);
        }
      }
      // SADP：独占 37020（不和别的程序共用端口，免得回复被抢走）并在每个网口加入组播组（设备多数把回复发到组播组），也收单播
      const sadpSock = await open(SADP_PORT, false, (data, from) => keep({ proto: 'sadp', from, data }));
      const sadpIfaces = [];
      if (sadpSock) {
        try { sadpSock.setMulticastTTL(1); } catch { /* ignore */ }
        for (const f of ifaces) {
          try {
            sadpSock.addMembership(DISCOVERY_GROUP, f.ip);
            sadpIfaces.push(f);
          } catch { /* 网口没了 */ }
        }
      }
      const sendAll = () => {
        wsdSocks.forEach((sock) => wsdProbes.forEach((p) => sock.send(Buffer.from(p), WSD_PORT, DISCOVERY_GROUP, () => {})));
        for (const f of sadpIfaces) {
          try {
            sadpSock.setMulticastInterface(f.ip);
            sadpSock.send(Buffer.from(sp), SADP_PORT, DISCOVERY_GROUP, () => {});
          } catch { /* ignore */ }
        }
      };
      sendAll();
      await sleep(Math.min(1000, seconds * 400));
      sendAll(); // UDP 可能丢，发两遍
      await sleep(Math.max(0, seconds * 1000 - Math.min(1000, seconds * 400)));
      if (dropped) console.error(`host-agent: discovery: 丢弃 ${dropped} 个过大或超量的回复`);
      return replies;
    } finally {
      for (const sock of sockets) { try { sock.close(); } catch { /* closed */ } }
    }
  });
  const netIfs = o.networkInterfaces || (() => os.networkInterfaces());
  const newUuid = o.uuid || (() => randomUUID());
  async function discoverCameras(body) {
    if (discovering) throw new AgentError('E_CONFLICT', '摄像头搜索正在进行，请稍后再试', 409);
    const seconds = body?.seconds === undefined || body?.seconds === null || body?.seconds === '' ? 3 : Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) throw bad('搜索时长要在 1–10 秒之间');
    discovering = true;
    const started = now();
    try {
      const s = await settings().catch(() => null);
      // 维护热点 + 调用方给的排除网段（IOC 的 host-scope 排除清单）
      const extra = (Array.isArray(body?.exclude) ? body.exclude : []).slice(0, 32).map(String).filter((c) => cidrParts(c));
      const excluded = [s?.apNetwork || '192.168.234.0/24', ...extra];
      const ifaces = discoveryInterfaces(netIfs(), { excluded });
      if (!ifaces.length) return { discoveredAt: new Date(now()).toISOString(), durationMs: 0, interfaces: [], devices: [], note: '没有可用的网口（只有回环 / 虚拟口 / 维护热点）' };
      const replies = await multicast({
        ifaces,
        wsdProbes: [wsDiscoveryProbe(newUuid()), wsDiscoveryProbe(newUuid(), 'tds:Device')],
        sadpProbe: sadpProbe(newUuid()),
        seconds,
      });
      const ownIps = new Set(ifaces.map((f) => f.ip));
      // 发送方地址本身在排除网段里的也丢掉（SADP 回复里的 IP 是设备自己写的，不能只看它）
      const usable = replies.filter((r) => !ownIps.has(r.from) && !inAnyCidr(r.from, excluded));
      const wsd = usable.filter((r) => r.proto === 'wsd').flatMap((r) => parseWsDiscovery(r.data, r.from));
      const sadp = usable.filter((r) => r.proto === 'sadp').map((r) => parseSadp(r.data)).filter(Boolean);
      const devices = mergeDiscovered(wsd, sadp, { excluded });
      // WS-Discovery 的回复大多不带 MAC：刚通过信，内核 ARP 表里有它们，按 IP 补上（只补完整的表项，标明来源）
      if (devices.some((d) => !d.mac)) {
        try {
          const arp = new Map(parseArpTable(await readArp()).map((n) => [n.ip, n.mac]));
          for (const d of devices) if (!d.mac && arp.has(d.ip)) Object.assign(d, { mac: arp.get(d.ip), macFrom: 'arp' });
        } catch { /* 读不到 ARP 表：不补 */ }
      }
      return {
        discoveredAt: new Date(now()).toISOString(),
        durationMs: now() - started,
        interfaces: ifaces,
        devices,
      };
    } finally {
      discovering = false;
    }
  }


  // ----- 摄像头激活（2026-11-21，负责人：不引导用户去用海康 SADP / iVMS-4200 一类官方工具，平台自己激活）-----
  // 协议细节（inquiry / exchangecode / activate 三步）来自真机抓包，见 h2z.security/docs/HIKVISION-SADP-ACTIVATE-2026-11-21.md；
  // exchangecode 响应的会话密钥怎么衍生、activate 的 Password 字段具体用什么对称算法，目前都只是推断（见文档「未解决的问题」），
  // 所以 camera-library 里这条 hikvision.sadp-udp 配方标的是 candidate：IOC 那边要求人确认一次才会调用这个接口，
  // 真机测试通过后再把配方升到 verified。这里只做「按推断实现一遍，让负责人能实测」，不假装协议已经验证过。
  const activatingMacs = new Set();
  /** 真正收发 SADP 单台事务的部分（测试里可以换成假的，和 multicast 一样的套路） */
  const sendSadp = o.sadpRequest || sadpRequest;
  /**
   * 发一个 SADP 请求（exchangecode / activate），等它对应 Uuid 的单播回复。UDP 可能丢，1 秒一次重发，
   * timeoutMs 内没等到就超时（海康官方工具实测单次应答一般几十到几百毫秒，给够余量）。
   */
  function sadpRequest(probeXml, { uuid, mac, ifaces, timeoutMs = 5000, parse = parseSadpResult } = {}) {
    const wantUuid = uuid ? String(uuid).toUpperCase() : null;
    const wantMac = mac ? normalizeMac(mac) : null;
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let done = false;
      let resend = null;
      let timer = null;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        if (resend) clearInterval(resend);
        if (timer) clearTimeout(timer);
        try { sock.close(); } catch { /* closed */ }
        err ? reject(err) : resolve(val);
      };
      sock.on('error', (e) => finish(new AgentError('E_SOCKET', 'SADP 套接字出错：' + e.message, 502)));
      sock.on('message', (msg) => {
        const r = parse(msg.toString('utf8'));
        if (!r) return;
        // inquiry 用的 parseSadp 没有 Uuid 字段，这时候只靠 MAC 过滤；exchangecode/activate/update 用 parseSadpResult，按 Uuid 过滤，
        // 再加一层 MAC 过滤防止广播里混进别的设备的回复（同一个 Uuid 理论上不会撞，但多台设备同时在激活时留个保险）
        if (wantUuid && r.uuid && r.uuid.toUpperCase() !== wantUuid) return;
        if (wantMac) {
          const rMac = r.mac ? normalizeMac(r.mac) : null;
          if (!rMac || rMac !== wantMac) return;
        }
        finish(null, r);
      });
      sock.bind(SADP_PORT, () => {
        try { sock.setMulticastTTL(1); } catch { /* ignore */ }
        const okIfaces = [];
        for (const f of ifaces) {
          try {
            sock.addMembership(DISCOVERY_GROUP, f.ip);
            okIfaces.push(f);
          } catch { /* 网口没了 */ }
        }
        if (!okIfaces.length) return void finish(new AgentError('E_NO_IFACE', '没有可用的网口', 422));
        const send = () => {
          for (const f of okIfaces) {
            try {
              sock.setMulticastInterface(f.ip);
              sock.send(Buffer.from(probeXml), SADP_PORT, DISCOVERY_GROUP, () => {});
            } catch { /* ignore */ }
          }
        };
        send();
        resend = setInterval(send, 1000);
        timer = setTimeout(() => finish(new AgentError('E_TIMEOUT', '设备没有在超时时间内响应（可能已经离线，或不是海康 / 不支持 SADP 激活）', 504)), timeoutMs);
      });
    });
  }
  /**
   * 海康 SADP 激活一台设备（候选实现，见文件开头注释）：
   *  1) exchangecode：生成一个一次性 RSA-1024 密钥对，把公钥（PKCS#1 DER，base64）发给设备，设备回一段用这个公钥加密过的会话密钥；
   *  2) 推断：会话密钥的前 16 字节当 AES-128-CBC 密钥，随机 IV，对新密码做 PKCS7 填充加密，IV + 密文（base64）作为 activate 的 Password；
   *  3) activate：带这个 Password 发给设备，设备回 Result=success 表示密码生效。
   * 第 2 步的具体算法没有真机验证过——这正是这条配方留在 candidate 的原因；真机测试失败时，大概率要回来改这一步。
   */
  async function activateHikvisionSadp({ mac, password, ifaces }) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 16) {
      throw bad('密码长度要在 8–16 位之间（海康激活要求）');
    }
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 0x10001 });
    const pubB64 = publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
    const uuid1 = newUuid();
    const r1 = await sendSadp(sadpExchangeCodeProbe(uuid1, mac, pubB64), { uuid: uuid1, ifaces });
    if (r1.types !== 'exchangecode' || r1.result !== 'success' || !r1.code) {
      throw new AgentError('E_ACTIVATE', 'exchangecode 没有成功（' + (r1.result || '设备没有返回会话密钥') + '）', 502);
    }
    let sessionSecret;
    try {
      sessionSecret = privateDecrypt({ key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(r1.code, 'base64'));
    } catch (e) {
      throw new AgentError('E_ACTIVATE', '会话密钥解密失败（RSA 解密出错，可能是这步的加密方案推断错了）：' + e.message, 502);
    }
    if (sessionSecret.length < 16) throw new AgentError('E_ACTIVATE', '会话密钥长度不够（解密出 ' + sessionSecret.length + ' 字节，不到 16）', 502);
    const aesKey = sessionSecret.subarray(0, 16);
    const iv = randomBytesSync(16);
    let passwordB64;
    try {
      const cipher = createCipheriv('aes-128-cbc', aesKey, iv);
      const enc = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
      passwordB64 = Buffer.concat([iv, enc]).toString('base64');
    } catch (e) {
      throw new AgentError('E_ACTIVATE', '密码加密失败：' + e.message, 502);
    }
    const uuid2 = newUuid();
    const r2 = await sendSadp(sadpActivateProbe(uuid2, mac, passwordB64), { uuid: uuid2, ifaces });
    if (r2.types !== 'activate' || r2.result !== 'success') {
      throw new AgentError('E_ACTIVATE', '激活没有成功（' + (r2.result || 'unknown') + '），海康密码规则：8–16 位，至少两类字符', 502);
    }
    return { activated: true, method: 'sadp' };
  }

  /** 按 MAC 查一次 inquiry（单台，取当前的 Salt / 端口 / IPv6 等字段），超时 3 秒 */
  function sadpInquiryOne(mac, ifaces, timeoutMs = 3000) {
    return sendSadp(sadpProbe(newUuid()), { mac, ifaces, timeoutMs, parse: parseSadp });
  }

  /**
   * update（改网络参数，含 IP）的鉴权字段候选公式（候选实现，4 选 1，见文件开头注释 2026-11-21 补充）：
   * 64 字节 = SHA-512 摘要长度，猜测是"证明知道密码"的摘要而不是加密payload（因为 IP 等参数本身是明文发的）。
   * salt 是 inquiry 里 <Salt> 字段（hex），具体和 password/username 的拼接顺序没有真机验证过，所以挨个试：
   * 第一个让设备回 Result=success 的就是对的，顺便把命中的是第几个记下来，供真机测试后固化成 verified。
   */
  function updatePasswordCandidates(saltHex, password) {
    const saltBuf = Buffer.from(String(saltHex || '').replace(/[^0-9a-f]/gi, ''), 'hex');
    const pwBuf = Buffer.from(password, 'utf8');
    const userBuf = Buffer.from('admin', 'utf8');
    const sha512 = (...parts) => createHash('sha512').update(Buffer.concat(parts)).digest();
    return [
      { formula: 'sha512(salt+password)', digest: sha512(saltBuf, pwBuf) },
      { formula: 'sha512(password+salt)', digest: sha512(pwBuf, saltBuf) },
      { formula: 'sha512(username+salt+password)', digest: sha512(userBuf, saltBuf, pwBuf) },
      { formula: 'sha512(salt+username+password)', digest: sha512(saltBuf, userBuf, pwBuf) },
    ];
  }

  /**
   * 海康 SADP update：改网络参数（含静态 IP），候选实现，还没真机验证过（见文件开头 2026-11-21 补充）：
   *  1) 按 MAC inquiry 一次，拿当前的 Salt / CommandPort / HttpPort / IPv6* 等字段（没传的字段原样回填，update 是整段发不是增量 patch）；
   *  2) 没有 Salt 就没法算鉴权字段，直接报错（说明这台设备可能不支持这个 update 鉴权方式，需要回去看抓包）；
   *  3) 依次试 4 个候选摘要公式，每次都是一次新的 update 事务（新 Uuid），哪个先 Result=success 就用哪个；
   *  4) 全部失败就把 4 次尝试的 result 都带出去，方便真机测试时判断是哪一步错了。
   */
  async function updateHikvisionSadpNetwork({ mac, password, network, ifaces }) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 16) {
      throw bad('密码长度要在 8–16 位之间（海康激活要求）');
    }
    const inq = await sadpInquiryOne(mac, ifaces).catch(() => null);
    if (!inq) throw new AgentError('E_UPDATE', '改 IP 前查询设备当前状态失败（设备没有响应按 MAC 的 inquiry）', 502);
    if (!inq.salt) throw new AgentError('E_UPDATE', '设备没有返回 Salt 字段，没法计算鉴权摘要（这台设备可能用的是另一套 update 鉴权方式）', 502);
    const net = {
      ipv4Address: network?.ipv4Address,
      ipv4SubnetMask: network?.ipv4SubnetMask,
      ipv4Gateway: network?.ipv4Gateway ?? '',
      ipv6Address: network?.ipv6Address ?? '',
      ipv6Gateway: network?.ipv6Gateway ?? '',
      ipv6MaskLen: network?.ipv6MaskLen ?? 0,
      dhcp: !!network?.dhcp,
      commandPort: inq.commandPort ?? 8000,
      httpPort: inq.httpPort ?? 80,
    };
    if (!net.dhcp && (!net.ipv4Address || !net.ipv4SubnetMask)) {
      throw bad('静态 IP 模式下 ipv4Address / ipv4SubnetMask 不能为空');
    }
    const candidates = updatePasswordCandidates(inq.salt, password);
    const attempts = [];
    for (const c of candidates) {
      const uuid = newUuid();
      const probe = sadpUpdateProbe(uuid, mac, c.digest.toString('base64'), net);
      let r;
      try {
        r = await sendSadp(probe, { uuid, mac, ifaces, timeoutMs: 5000 });
      } catch (e) {
        attempts.push({ formula: c.formula, error: String(e?.message || e) });
        continue;
      }
      attempts.push({ formula: c.formula, result: r.result });
      if (r.types === 'update' && r.result === 'success') {
        return { updated: true, viaFormula: c.formula, network: net };
      }
    }
    throw new AgentError('E_UPDATE', '改 IP 没有成功，4 个候选鉴权公式都试过了：' + JSON.stringify(attempts), 502);
  }

  /** POST /v1/cameras/activate {mac, password, method?, network?} —— 目前只有 method:'sadp'（海康，候选实现）
   *  network 给了就在 activate 成功后接着做一次 update（设密码 + 改网络参数合并成一次调用）：
   *  {dhcp:true} 或 {dhcp:false, ipv4Address, ipv4SubnetMask, ipv4Gateway?}
   */
  async function activateCamera(body) {
    const mac = normalizeMac(body?.mac);
    if (!mac) throw bad('mac 不合法');
    const method = body?.method || 'sadp';
    if (method !== 'sadp') throw new AgentError('E_NOT_SUPPORTED', '不支持的激活方式：' + method, 422);
    if (activatingMacs.has(mac)) throw new AgentError('E_CONFLICT', '这台设备正在激活中，请稍后再试', 409);
    activatingMacs.add(mac);
    try {
      const s = await settings().catch(() => null);
      const ifaces = discoveryInterfaces(netIfs(), { excluded: [s?.apNetwork || '192.168.234.0/24'] });
      if (!ifaces.length) throw new AgentError('E_NO_IFACE', '没有可用的网口', 422);
      const activated = await activateHikvisionSadp({ mac, password: body?.password, ifaces });
      if (!body?.network) return activated;
      try {
        const updated = await updateHikvisionSadpNetwork({ mac, password: body.password, network: body.network, ifaces });
        return { ...activated, network: updated };
      } catch (e) {
        // 密码已经设成功了，改 IP 失败不回滚密码——设备已经是"激活了但网络参数没改"的状态，把错误带回去让前端能提示重试改 IP
        return { ...activated, network: { updated: false, error: String(e?.message || e) } };
      }
    } finally {
      activatingMacs.delete(mac);
    }
  }

  async function status() {
    const s = await settings();
    let hostname = '';
    try {
      hostname = (await host('hostname', [], { timeout: 5000 })).trim();
    } catch {
      /* ignore */
    }
    const tailscale = await tailscaleStatus();
    if (!s || !s.lanIf) return { ready: false, hint: 'sudo sh host/setup-host-network.sh', hostname, tailscale };
    const [lan, ap] = await Promise.all([lanStatus(s), apStatus(s)]);
    return { ready: true, hostname, lan, ap, tailscale };
  }

  /** 顶栏资源：2 秒内重复请求复用上一次结果（多个页面同时开不放大读盘次数） */
  let lastSample = null, lastMetrics = null;
  async function metrics() {
    const at = Date.now();
    if (lastMetrics && at - lastMetrics.at < 2000) return lastMetrics;
    const read = async (f) => { try { return await fsp.readFile(f, 'utf8'); } catch { return ''; } };
    const [stat, mem, net, load] = await Promise.all([read('/proc/stat'), read('/proc/meminfo'), read('/proc/net/dev'), read('/proc/loadavg')]);
    let disk = null;
    try {
      const f = statfsSync(o.hostEtc);
      disk = { total: f.blocks * f.bsize, used: (f.blocks - f.bfree) * f.bsize };
    } catch { /* 读不到就不显示 */ }
    const cur = { at, cpu: parseCpuStat(stat), mem: parseMeminfo(mem), disk, net: parseNetDev(net), load: Number(load.split(' ')[0]) || null };
    lastMetrics = metricsFrom(lastSample, cur);
    lastSample = cur;
    return lastMetrics;
  }

  // ----- Cloudflare 穿透（cf-tunnel.mjs）：没有这个文件的部署（B）里 tunnel = null -----
  const tunnel = CF
    ? CF.createTunnel({
        host, fs, hostEtc: o.hostEtc, serial, audit, now, fetch: o.fetch, sleep: o.sleep,
        ...(o.tunnelDefaultHostname ? { defaultHostname: o.tunnelDefaultHostname } : {}),
        ...(o.tunnelBin ? { bin: o.tunnelBin } : {}),
        ...(o.tunnelMetricsPort ? { metricsPort: o.tunnelMetricsPort } : {}),
        ...(o.tunnelTiming || {}),
      })
    : null;

  // ----- Meta Muse 连接器（muse.mjs）：没有这个文件的部署（B）里 muse = null -----
  const muse = MUSE
    ? MUSE.createMuse({
        fs, hostEtc: o.hostEtc, serial, audit, now, fetch: o.fetch, sleep: o.sleep,
        ...(o.museBaseUrl ? { baseUrl: o.museBaseUrl } : {}),
        ...(o.museDailyTokens !== undefined ? { dailyTokens: o.museDailyTokens } : {}),
        ...(o.museRpm ? { rpm: o.museRpm } : {}),
        ...(o.museMaxConcurrent ? { maxConcurrent: o.museMaxConcurrent } : {}),
        ...(o.museTiming || {}),
      })
    : null;

  // ----- iroh 边缘（edge-link）：GET /v1/link —— 局域网地址上报 + 边缘状态摘要（给后台，方案 A）-----
  // 没配 H2Z_LINK_DIR 的部署（板子 B、没有 edge-link 的机器）：回 404 no route，和扩展包 / 穿透一样。
  // 做三件事：1) 算出本机真正的局域网地址（edge-link 在容器里只看到 docker 网桥）写到 <linkDir>/lan.json，
  // edge-link 只对持有效令牌的手机经 /_h2z/info 返回；2) 读 edge-link 每 10 秒写的 <linkDir>/status.json（完整状态）；
  // 3) 汇总成一个对象：局域网地址 + 是否对局域网开放 + IOC 本地登录模式 + 边缘状态（含时钟、开放模式警告）。
  async function link() {
    if (!o.linkDir) throw new AgentError('E_NOT_FOUND', 'no route', 404);
    const s = await settings().catch(() => null);
    const bind = String(o.linkHttpBind || '127.0.0.1');
    const port = Number(o.linkHttpPort) || 8096;
    const lanAuth = String(o.linkLanAuth || '').toLowerCase() === 'on';
    const exposed = !['127.0.0.1', 'localhost', '::1'].includes(bind);
    const excluded = [s?.apNetwork || '192.168.234.0/24'];
    const addresses = exposed
      ? discoveryInterfaces(netIfs(), { excluded }).map((f) => ({ iface: f.iface, ip: f.ip, port, url: `http://${f.ip}:${port}` }))
      : [];
    const at = Math.floor(now() / 1000);
    // ips: 本机局域网 IPv4（不含回环 / docker 网桥 / 维护热点），不管网页绑不绑局域网都给 edge-link 的 /_h2z/info 的 lan 数组；addresses 带端口，只在网页对局域网开放时有
    const ips = discoveryInterfaces(netIfs(), { excluded }).map((f) => f.ip);
    // iroh: 固定 UDP 端口（契约 §13.1，edge-link 的 --bind-port / H2Z_IROH_PORT，compose 发布同一端口）+ 局域网 IPv4；
    // 和网页是否对局域网开放无关（iroh 有自己的令牌鉴权）。edge-link 对外返回时会用自己实际绑定的端口覆盖这里的 port。
    const irohPort = Number(o.linkIrohPort) || 11204;
    const iroh = { port: irohPort, addrs: ips.map((ip) => ({ ip, port: irohPort })) };
    const lan = { v: 1, at, ips, addresses, httpBind: bind, httpPort: port, exposed, iroh };
    try {
      const tmp = join(o.linkDir, 'lan.json.tmp');
      await fs.writeFile(tmp, JSON.stringify(lan), { mode: 0o644 });
      await fs.rename(tmp, join(o.linkDir, 'lan.json'));
    } catch { /* 目录不可写：只影响 edge-link 的局域网提示，不影响状态汇总 */ }
    let edge = null, edgeAgeSec = null;
    try {
      edge = JSON.parse(await fs.readFile(join(o.linkDir, 'status.json'), 'utf8'));
      edgeAgeSec = Math.max(0, at - Number(edge.writtenAt || 0));
    } catch { /* edge-link 还没写过 / 没起来 */ }
    return {
      ready: true,
      // lanAuth = 对外网页入口的 nginx 登录门（契约 §13.2，H2Z_LINK_LAN_AUTH=on）：开着时局域网浏览器读写和视频都要登录，不算「没登录」。
      // 没配（板子 / 老部署，nginx 没有登录门）= off；这时只有 IOC_AUTH≠none 才挡写，读和视频照样开放，所以仍按原规则标记。
      lan: { ...lan, iocAuth: o.linkIocAuth || 'unknown', lanAuth: lanAuth ? 'on' : 'off', lanOpenWithoutLogin: exposed && !lanAuth && (o.linkIocAuth || 'none') === 'none' },
      edge,
      edgeAgeSec,
      edgeRunning: edgeAgeSec !== null && edgeAgeSec <= 45,
      hostTime: at,
    };
  }

  return { tunnel, muse, link, linkFactoryReset, metrics, status, system, setTime, setName, setLang, displayStatus, setDisplay, power, setNote, upgradeStatus, upgradeUpload, usbScan, usbImport, upgradeStart, upgradeDiscard, upgradeRollback, onlineStatus, onlineCheck, onlineFetch, onlineCancel: onlineCancelFetch, onlineDiscard, recoverUpgrade, upgradeJob: () => upgradeJob, applyLan, confirmLan, rollbackLan, tick, setAp, syncHostSetup, syncKiosk, tailscaleStatus, tailscaleLogin, tailscaleLogout, tailscaleEnable, l2Scan, discoverCameras, activateCamera, packs, paths: P };
}

// ---------------------------------------------------------------------------------------------------
// 本机资源（顶栏显示）：CPU / 内存 / 磁盘 / 网络。host-agent 在宿主 pid 与 net 命名空间里，/proc 读到的就是宿主的。
// ---------------------------------------------------------------------------------------------------
/** /proc/stat 第一行 → { idle, total }（idle 含 iowait） */
export function parseCpuStat(text) {
  const f = String(text).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.some((x) => !Number.isFinite(x))) return null;
  return { idle: f[3] + (f[4] || 0), total: f.slice(0, 8).reduce((a, b) => a + b, 0) };
}
/** /proc/meminfo → { total, used }（字节；used = total − MemAvailable） */
export function parseMeminfo(text) {
  const kb = (k) => Number((new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(text) || [])[1]);
  const total = kb('MemTotal') * 1024, avail = kb('MemAvailable') * 1024;
  return Number.isFinite(total) && Number.isFinite(avail) ? { total, used: Math.max(0, total - avail) } : null;
}
/** /proc/net/dev → { rx, tx }（累计字节，不含 lo / docker / veth / br- 等虚拟口） */
export function parseNetDev(text) {
  let rx = 0, tx = 0;
  for (const line of String(text).split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || /^(lo|docker|veth|br-|tailscale|virbr)/.test(m[1])) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) { rx += f[0]; tx += f[8]; }
  }
  return { rx, tx };
}
/** 两次采样 → 指标；first 为空（第一次）时 CPU / 网速给 null */
export function metricsFrom(prev, cur) {
  const dt = prev ? (cur.at - prev.at) / 1000 : 0;
  const dTotal = prev && cur.cpu && prev.cpu ? cur.cpu.total - prev.cpu.total : 0;
  const cpu = dTotal > 0 ? Math.min(100, Math.max(0, Math.round((1 - (cur.cpu.idle - prev.cpu.idle) / dTotal) * 1000) / 10)) : null;
  const rate = (a, b) => (dt > 0.2 && Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / dt) : null);
  return {
    cpu,
    mem: cur.mem,
    disk: cur.disk,
    net: { rxBps: prev ? rate(prev.net.rx, cur.net.rx) : null, txBps: prev ? rate(prev.net.tx, cur.net.tx) : null },
    load: cur.load,
    at: cur.at,
  };
}

// ---------------------------------------------------------------------------------------------------
// 摄像头发现（2026-11-02）：像传统 NVR 的"搜索设备"，不走 AI 探索。两种组播，几秒出结果，只读：
//   ONVIF WS-Discovery  239.255.255.250:3702，回复单播到发送端口：开了 ONVIF 的摄像头（服务地址、UUID、型号）
//   海康 SADP            239.255.255.250:37020，回复多为组播：海康 / OEM 设备（IP、MAC、序列号、是否已激活），
//                       ONVIF 没开的海康也能搜到
// 组播只在本网段有效（跨 VLAN 的摄像头要手动添加或按网段探测）。维护热点网段既不发包也不收结果。
// ---------------------------------------------------------------------------------------------------
export const DISCOVERY_GROUP = '239.255.255.250';
export const WSD_PORT = 3702;
export const SADP_PORT = 37020;
/** 单个回复最大字节数（摄像头的回复一般 1–3 KB）、一次搜索最多收多少个回复：防止局域网里有人灌包拖住这个特权进程 */
export const DISCOVERY_MAX_REPLY = 8 << 10;
export const DISCOVERY_MAX_REPLIES = 500;

const xmlEscape = (v) => String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** WS-Discovery Probe。type: 'dn:NetworkVideoTransmitter'（摄像头）或 'tds:Device'（部分设备只回这个） */
export function wsDiscoveryProbe(messageId, type = 'dn:NetworkVideoTransmitter') {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"' +
    ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
    '<s:Header><a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>' +
    `<a:MessageID>uuid:${xmlEscape(messageId)}</a:MessageID>` +
    '<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>' +
    '<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header>' +
    `<s:Body><d:Probe><d:Types>${xmlEscape(type)}</d:Types></d:Probe></s:Body></s:Envelope>`
  );
}

/** 海康 SADP 查询 */
export const sadpProbe = (uuid) => `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${xmlEscape(String(uuid).toUpperCase())}</Uuid><Types>inquiry</Types></Probe>`;

/** 海康 SADP exchangecode 请求：带目标设备 MAC + host 自己的 RSA 公钥（PKCS#1 DER，base64）。字段顺序和真机抓包一致 */
export const sadpExchangeCodeProbe = (uuid, mac, pubKeyB64) =>
  `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${xmlEscape(String(uuid).toUpperCase())}</Uuid><MAC>${xmlEscape(mac)}</MAC><Types>exchangecode</Types><Code>${xmlEscape(pubKeyB64)}</Code></Probe>`;

/** 海康 SADP activate 请求：带目标设备 MAC + 加密过的新密码（base64）。字段顺序和真机抓包一致 */
export const sadpActivateProbe = (uuid, mac, passwordB64) =>
  `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${xmlEscape(String(uuid).toUpperCase())}</Uuid><MAC>${xmlEscape(mac)}</MAC><Types>activate</Types><Password>${xmlEscape(passwordB64)}</Password></Probe>`;

/**
 * 海康 SADP update 请求：改网络参数（IP/端口/网关/DHCP 等），字段顺序和真机抓包一致。
 * network 里缺的字段用 inquiry 查到的当前值原样回填（海康要求整段一起发，不是增量 patch）。
 * passwordB64：bSalt="true" 的鉴权字段（64 字节，猜测是摘要，不是加密payload——这条还没真机验证过）。
 */
export const sadpUpdateProbe = (uuid, mac, passwordB64, network) =>
  `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${xmlEscape(String(uuid).toUpperCase())}</Uuid><Types>update</Types><PWErrorParse>true</PWErrorParse><MAC>${xmlEscape(mac)}</MAC><Password bSalt="true">${xmlEscape(passwordB64)}</Password><IPv4Address>${xmlEscape(network.ipv4Address || '')}</IPv4Address><CommandPort>${xmlEscape(String(network.commandPort ?? ''))}</CommandPort><IPv4SubnetMask>${xmlEscape(network.ipv4SubnetMask || '')}</IPv4SubnetMask><IPv4Gateway>${xmlEscape(network.ipv4Gateway || '')}</IPv4Gateway><IPv6Address>${xmlEscape(network.ipv6Address || '')}</IPv6Address><IPv6Gateway>${xmlEscape(network.ipv6Gateway || '')}</IPv6Gateway><IPv6MaskLen>${xmlEscape(String(network.ipv6MaskLen ?? ''))}</IPv6MaskLen><DHCP>${xmlEscape(String(!!network.dhcp))}</DHCP><HttpPort>${xmlEscape(String(network.httpPort ?? ''))}</HttpPort></Probe>`;

/** exchangecode / activate / update 的回复（没有 IPv4Address 这种 inquiry 专属字段，parseSadp 认不出）→ {uuid, mac, types, result, code} 或 null */
export function parseSadpResult(xml) {
  const text = String(xml || '');
  if (!/<ProbeMatch|<Probe/i.test(text)) return null;
  const types = tag(text, 'Types').toLowerCase();
  if (!types) return null;
  return {
    uuid: tag(text, 'Uuid'),
    mac: tag(text, 'MAC') || null,
    types,
    result: tag(text, 'Result').toLowerCase() || null,
    code: tag(text, 'Code') || null,
  };
}

/** 取 XML 元素文本（忽略命名空间前缀、大小写），没有返回 '' */
const tag = (xml, name) => {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
};
const decodeScope = (v) => {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v;
  }
};
/** 'AA-BB-CC-DD-EE-FF' / 'aabbccddeeff' → 'AA:BB:CC:DD:EE:FF'，不合法返回 '' */
export function normalizeMac(v) {
  const hex = String(v || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/i.test(hex)) return '';
  return hex.toUpperCase().match(/../g).join(':');
}
const hostOfUrl = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/** WS-Discovery ProbeMatches → [{uuid, xaddrs[], ip, name, hardware, manufacturer, mac, location, types}]（一个回复里可能有多条） */
export function parseWsDiscovery(xml, fromIp = '') {
  const text = String(xml || '');
  if (!/ProbeMatch/i.test(text)) return [];
  const out = [];
  const re = /<(?:[\w.-]+:)?ProbeMatch(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?ProbeMatch>/gi;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const uuid = tag(tag(body, 'EndpointReference'), 'Address').replace(/^(urn:)?uuid:/i, '').toLowerCase();
    const xaddrs = tag(body, 'XAddrs').split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
    const scopes = tag(body, 'Scopes').split(/\s+/).filter(Boolean);
    const scope = (key) => {
      const hit = scopes.find((s) => s.toLowerCase().startsWith(`onvif://www.onvif.org/${key.toLowerCase()}/`));
      return hit ? decodeScope(hit.slice(`onvif://www.onvif.org/${key}/`.length)) : '';
    };
    // 摄像头回复的 XAddrs 里通常就有它自己的 IP；有多个时优先和来源地址相同、且是 IPv4 的那个
    const ips = xaddrs.map(hostOfUrl).filter((h) => ipToInt(h) !== null);
    const ip = ips.includes(fromIp) ? fromIp : ips[0] || fromIp;
    out.push({
      uuid,
      xaddrs,
      ip,
      name: scope('name'),
      hardware: scope('hardware'),
      manufacturer: scope('manufacturer') || scope('mfr'),
      mac: normalizeMac(scope('MAC') || scope('mac')),
      location: scope('location'),
      types: tag(body, 'Types').split(/\s+/).filter(Boolean),
      // 设备自己声明的类型和 Profile（scope type/… 可以有多条）：录像机声明 Network_Video_Storage / 只有 Profile G，
      // 上层据此不把它当摄像头添加（型号里没有 NVR 字样的录像机只能靠这个认）
      onvifType: scopes.filter((x) => /^onvif:\/\/www\.onvif\.org\/type\//i.test(x)).map((x) => decodeScope(x.replace(/^onvif:\/\/www\.onvif\.org\/type\//i, ''))).slice(0, 8),
      profiles: scopes.filter((x) => /^onvif:\/\/www\.onvif\.org\/Profile\//i.test(x)).map((x) => decodeScope(x.replace(/^onvif:\/\/www\.onvif\.org\/Profile\//i, '')).toUpperCase().replace(/^STREAMING$/, 'S')).slice(0, 8),
    });
  }
  return out;
}

/** SADP 回复 → {ip, mac, model, serial, httpPort, commandPort, activated, dhcp, softwareVersion} 或 null（不是设备回复） */
export function parseSadp(xml) {
  const text = String(xml || '');
  const type = tag(text, 'Types').toLowerCase();
  if (!/<ProbeMatch|<Probe/i.test(text) || (type && type !== 'inquiry' && type !== 'hello' && type !== 'update')) return null;
  const ip = tag(text, 'IPv4Address');
  if (ipToInt(ip) === null) return null; // 我们自己发出的查询（组播回环）也会收到，没有 IPv4Address
  const yes = (v) => (v === '' ? null : /^true$/i.test(v));
  return {
    ip,
    mac: normalizeMac(tag(text, 'MAC')),
    model: tag(text, 'DeviceDescription') || tag(text, 'DeviceType'),
    serial: tag(text, 'DeviceSN'),
    httpPort: Number(tag(text, 'HttpPort')) || null,
    commandPort: Number(tag(text, 'CommandPort')) || null,
    activated: yes(tag(text, 'Activated')),
    dhcp: yes(tag(text, 'DHCP')),
    softwareVersion: tag(text, 'SoftwareVersion'),
    salt: tag(text, 'Salt') || null,
  };
}

/** 这个地址是否在任一网段里 */
const inAnyCidr = (ip, cidrs) => {
  const n = ipToInt(ip);
  if (n === null) return false;
  return cidrs.some((c) => {
    const p = cidrParts(c);
    return p && ((n & maskOf(p.prefix)) >>> 0) === p.net;
  });
};

/**
 * 两种协议的结果合并成设备列表：同一台设备按 MAC，其次 ONVIF UUID，再其次 IP 归并。
 * excluded 网段（维护热点）里的设备丢掉。输出按 IP 排序。
 */
export function mergeDiscovered(wsd = [], sadp = [], { excluded = [] } = {}) {
  const devices = [];
  const find = (d) =>
    devices.find((x) => (d.mac && x.mac === d.mac) || (d.uuid && x.onvif?.uuid === d.uuid) || (d.ip && x.ip === d.ip));
  for (const s of sadp) {
    if (inAnyCidr(s.ip, excluded)) continue;
    const hit = find(s);
    const sadpInfo = { activated: s.activated, httpPort: s.httpPort, commandPort: s.commandPort, dhcp: s.dhcp, softwareVersion: s.softwareVersion };
    if (hit) Object.assign(hit, { mac: hit.mac || s.mac, model: hit.model || s.model, serial: hit.serial || s.serial, sadp: sadpInfo });
    else devices.push({ ip: s.ip, mac: s.mac, vendor: 'Hikvision', model: s.model, serial: s.serial, name: '', sources: [], onvif: null, sadp: sadpInfo });
    const d = hit || devices[devices.length - 1];
    if (!d.sources.includes('sadp')) d.sources.push('sadp');
  }
  for (const w of wsd) {
    if (!w.ip || inAnyCidr(w.ip, excluded)) continue;
    const hit = find(w);
    const onvif = { uuid: w.uuid, xaddrs: w.xaddrs };
    if (hit) {
      hit.onvif = hit.onvif ? { uuid: hit.onvif.uuid || w.uuid, xaddrs: [...new Set([...hit.onvif.xaddrs, ...w.xaddrs])] } : onvif;
      hit.mac = hit.mac || w.mac;
      hit.model = hit.model || w.hardware;
      hit.name = hit.name || w.name;
      if (!hit.vendor && w.manufacturer) hit.vendor = w.manufacturer;
    } else {
      devices.push({ ip: w.ip, mac: w.mac, vendor: w.manufacturer || '', model: w.hardware, serial: '', name: w.name, sources: [], onvif, sadp: null });
    }
    const d = hit || devices[devices.length - 1];
    if (!d.sources.includes('onvif')) d.sources.push('onvif');
    if (w.onvifType?.length) d.onvifType = [...new Set([...(d.onvifType || []), ...w.onvifType])];
    if (w.profiles?.length) d.profiles = [...new Set([...(d.profiles || []), ...w.profiles])];
  }
  return devices.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

/** 发现用哪些网口：本机 IPv4 的物理口（排除回环 / Docker / Tailscale 等虚拟口和维护热点网段） */
export function discoveryInterfaces(netIfs = {}, { excluded = [] } = {}) {
  const out = [];
  for (const [iface, addrs] of Object.entries(netIfs)) {
    // 虚拟口；无线口（板子上是维护热点，x86 上一般是客户端上网）；PPP / 4G 等上行口：都不发组播
    if (/^(lo|docker|br-|veth|tailscale|virbr|wg|tun|tap|zt|wl|ww|ppp|usb)/.test(iface)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address) || inAnyCidr(a.address, excluded)) continue;
      out.push({ iface, ip: a.address, cidr: a.cidr || '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// HTTP over a unix socket
// ---------------------------------------------------------------------------------------------------
/** H2Z_LANG in os.env → 'en' | 'zh-CN' (default en: the factory language) */
export const langFromEnv = (text) => (/^H2Z_LANG=\s*["']?\s*zh/im.test(text || '') ? 'zh-CN' : 'en');

export function createServer(agent) {
  /** 没有 cf-tunnel.mjs 的部署（B）：和扩展包一样回 404 no route，IOC 翻成「不支持」 */
  const needTunnel = () => {
    if (!agent.tunnel) throw new AgentError('E_NOT_FOUND', 'no route', 404);
    return agent.tunnel;
  };
  /** 没有 muse.mjs 的部署（B）：同样回 404 no route */
  const needMuse = () => {
    if (!agent.muse) throw new AgentError('E_NOT_FOUND', 'no route', 404);
    return agent.muse;
  };
  const routes = {
    'GET /v1/status': () => agent.status(),
    'POST /v1/lan': (b) => agent.applyLan(b),
    'POST /v1/lan/confirm': () => agent.confirmLan(),
    'POST /v1/lan/note': (b) => agent.setNote(b),
    'GET /v1/system': () => agent.system(),
    'POST /v1/time': (b) => agent.setTime(b),
    'POST /v1/name': (b) => agent.setName(b),
    'POST /v1/lang': (b) => agent.setLang(b),
    'GET /v1/display': () => agent.displayStatus(),
    'POST /v1/display': (b) => agent.setDisplay(b),
    'POST /v1/power': (b) => agent.power(b),
    'GET /v1/upgrade': () => agent.upgradeStatus(),
    'POST /v1/upgrade/usb/scan': () => agent.usbScan(),
    'POST /v1/upgrade/usb/import': (b) => agent.usbImport(b),
    'POST /v1/upgrade/start': (b) => agent.upgradeStart(b),
    'POST /v1/upgrade/online/check': (b) => agent.onlineCheck(b),
    'POST /v1/upgrade/online/fetch': (b) => agent.onlineFetch(b),
    'POST /v1/upgrade/online/cancel': () => agent.onlineCancel(),
    'POST /v1/upgrade/online/discard': () => agent.onlineDiscard(),
    'POST /v1/upgrade/discard': () => agent.upgradeDiscard(),
    'POST /v1/upgrade/rollback': (b) => agent.upgradeRollback(b),
    'POST /v1/lan/rollback': () => agent.rollbackLan(),
    'POST /v1/ap': (b) => agent.setAp(b?.action, b?.minutes),
    'POST /v1/tailscale/login': (b) => agent.tailscaleLogin(b),
    'POST /v1/tailscale/logout': () => agent.tailscaleLogout(),
    'POST /v1/tailscale/enable': (b) => agent.tailscaleEnable(b),
    'POST /v1/l2-scan': (b) => agent.l2Scan(b),
    'POST /v1/cameras/discover': (b) => agent.discoverCameras(b),
    'POST /v1/cameras/activate': (b) => agent.activateCamera(b),
    'GET /v1/tunnel': () => needTunnel().status(),
    'POST /v1/tunnel/bind': (b) => needTunnel().bind(b),
    'POST /v1/tunnel/enable': (b) => needTunnel().setEnabled(b),
    'POST /v1/tunnel/restart': () => needTunnel().restart(),
    'POST /v1/tunnel/unbind': (b) => needTunnel().unbind(b),
    'GET /v1/muse': () => needMuse().status(),
    'POST /v1/muse/bind': (b) => needMuse().bind(b),
    'POST /v1/muse/enable': (b) => needMuse().setEnabled(b),
    'POST /v1/muse/unbind': (b) => needMuse().unbind(b),
    'POST /v1/muse/ask': (b) => needMuse().ask(b),
    'GET /v1/link': () => agent.link(),
    'POST /v1/link/factory-reset': (b) => agent.linkFactoryReset(b),
    'GET /v1/metrics': () => agent.metrics(),
    'GET /healthz': () => ({ ok: true }),
  };
  /** 扩展包的带参数路由（名字卡死成 PACK_NAME 的样子再交给 packs.mjs）；形状见 docs/PACKS-API.md */
  const N = '([a-z][a-z0-9-]{0,31})';
  const packRoutes = [
    ['GET', /^\/v1\/packs$/, (p) => p.list()],
    ['GET', /^\/v1\/packs\/settings$/, (p) => p.settings()],
    ['PUT', /^\/v1\/packs\/settings$/, (p, b) => p.setSettings(b)],
    ['POST', /^\/v1\/packs\/usb\/scan$/, (p) => p.usbScan()],
    ['GET', new RegExp(`^/v1/packs/${N}/progress$`), (p, b, m) => p.progress(m[1])],
    ['POST', new RegExp(`^/v1/packs/${N}/install$`), (p, b, m) => p.install(m[1], b)],
    ['POST', new RegExp(`^/v1/packs/${N}/cancel$`), (p, b, m) => p.cancel(m[1], b)],
    ['POST', new RegExp(`^/v1/packs/${N}/disable$`), (p, b, m) => p.disable(m[1], b)],
    ['POST', new RegExp(`^/v1/packs/${N}/enable$`), (p, b, m) => p.enable(m[1], b)],
    ['DELETE', new RegExp(`^/v1/packs/${N}$`), (p, b, m) => p.remove(m[1], b)],
  ];
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const fail = (e, what) => {
      // cf-tunnel.mjs 的 TunnelError 不能 import AgentError（循环引用）：同样带 E_ 开头的 code 和数字 status 的也按结构化错误回
      if (e instanceof AgentError || (e && /^E_/.test(String(e.code)) && Number.isInteger(e.status))) return send(e.status, { error: e.code, message: e.message });
      console.error(`host-agent: ${what}:`, e);
      send(500, { error: 'E_INTERNAL', message: String(e.message || e).slice(0, 300) });
    };
    const path = String(req.url).split('?')[0];
    const route = `${req.method} ${path}`;
    // the upgrade package itself is the body: streamed to disk, not parsed as JSON
    if (route === 'POST /v1/upgrade/upload') {
      agent.upgradeUpload(req).then((r) => send(200, r), (e) => fail(e, 'upload'));
      return;
    }
    /** 读 JSON 请求体（缺省 ≤ 64 KB；muse/ask 带抓图放宽）再交给 handler */
    const withBody = (handler, limit = 64 << 10) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (d) => {
        raw += d;
        if (raw.length > limit) req.destroy();
      });
      req.on('end', async () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(400, { error: 'E_PARAM', message: '请求体不是 JSON' });
        }
        try {
          send(200, await handler(body));
        } catch (e) {
          fail(e, 'route');
        }
      });
    };
    if (path === '/v1/packs' || path.startsWith('/v1/packs/')) {
      // 没开扩展包功能（板子 / 老配置）：和不认识的路径一样回 404 no route，IOC 据此知道「不支持」
      const loading = typeof agent.packs === 'function' ? agent.packs() : Promise.resolve(null);
      loading.then((packs) => {
        if (!packs) return send(404, { error: 'E_NOT_FOUND', message: 'no route' });
        if (route === 'POST /v1/packs/upload') {
          // 扩展包文件本身就是请求体：流式落盘，不进内存
          return packs.upload(req).then((r) => send(200, r), (e) => fail(e, 'pack upload'));
        }
        for (const [method, re, handler] of packRoutes) {
          const m = req.method === method && re.exec(path);
          if (m) return withBody((b) => handler(packs, b, m));
        }
        send(404, { error: 'E_NOT_FOUND', message: 'no route' });
      }).catch((e) => fail(e, 'packs'));
      return;
    }
    const handler = routes[route];
    if (!handler) return send(404, { error: 'E_NOT_FOUND', message: 'no route' });
    withBody(handler, route === 'POST /v1/muse/ask' ? MUSE_ASK_MAX_BODY : undefined);
  });
}

function main() {
  const o = {
    ...DEFAULTS,
    socket: process.env.H2Z_AGENT_SOCKET || DEFAULTS.socket,
    hostEtc: process.env.H2Z_HOST_ETC || DEFAULTS.hostEtc,
    tailscaleCli: process.env.H2Z_TAILSCALE_CLI || DEFAULTS.tailscaleCli,
    tailscaleSocket: process.env.H2Z_TAILSCALE_SOCKET || DEFAULTS.tailscaleSocket,
    rollbackMs: (Number(process.env.H2Z_LAN_ROLLBACK_SECONDS) || DEFAULTS.rollbackMs / 1000) * 1000,
    upgradeDir: process.env.H2Z_UPGRADE_DIR || DEFAULTS.upgradeDir,
    packsEnabled: process.env.H2Z_PACKS === '1',
    packsDir: process.env.H2Z_PACKS_DIR || DEFAULTS.packsDir,
    packsHostDir: process.env.H2Z_PACKS_HOST_DIR || DEFAULTS.packsHostDir,
    packsOnline: process.env.H2Z_PACKS_ONLINE === '1',
    packsCatalog: process.env.H2Z_PACKS_CATALOG || DEFAULTS.packsCatalog,
    packsNoRestart: String(process.env.H2Z_PACKS_NO_RESTART || '').split(',').map((x) => x.trim()).filter(Boolean),
    linkDir: process.env.H2Z_LINK_DIR || '',
    linkHttpBind: process.env.H2Z_LINK_HTTP_BIND || '127.0.0.1',
    linkHttpPort: Number(process.env.H2Z_LINK_HTTP_PORT) || 8096,
    linkIocAuth: process.env.H2Z_LINK_IOC_AUTH || '',
    linkIrohPort: Number(process.env.H2Z_LINK_IROH_PORT) || 11204,
    linkLanAuth: process.env.H2Z_LINK_LAN_AUTH || '',
    tunnelDefaultHostname: process.env.H2Z_TUNNEL_DEFAULT_HOSTNAME || DEFAULTS.tunnelDefaultHostname,
    tunnelBin: process.env.H2Z_CLOUDFLARED_BIN || DEFAULTS.tunnelBin,
    tunnelMetricsPort: Number(process.env.H2Z_CLOUDFLARED_METRICS_PORT) || DEFAULTS.tunnelMetricsPort,
    museBaseUrl: process.env.H2Z_MUSE_BASE_URL || DEFAULTS.museBaseUrl,
    museDailyTokens: /^\d+$/.test(process.env.H2Z_MUSE_DAILY_TOKENS || '') ? Number(process.env.H2Z_MUSE_DAILY_TOKENS) : DEFAULTS.museDailyTokens,
    museRpm: Number(process.env.H2Z_MUSE_RPM) || DEFAULTS.museRpm,
    museMaxConcurrent: Number(process.env.H2Z_MUSE_MAX_CONCURRENT) || DEFAULTS.museMaxConcurrent,
  };
  const agent = createAgent(o);
  const server = createServer(agent);
  // an upgrade package (~2 GB) over Wi-Fi / Tailscale takes longer than Node's default 5-minute request timeout
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  agent.recoverUpgrade().then((r) => r !== 'ok' && console.log('host-agent: upgrade ' + r)).catch(() => {});
  try {
    if (existsSync(o.socket)) unlinkSync(o.socket);
  } catch {
    /* ignore */
  }
  server.listen(o.socket, () => {
    try {
      chownSync(o.socket, 0, o.socketGroup);
      chmodSync(o.socket, 0o660);
    } catch (e) {
      console.error('host-agent: socket permissions:', e.message);
    }
    console.log('host-agent: listening on ' + o.socket);
  });
  const loop = () =>
    agent
      .tick()
      .then((r) => r === 'rolled-back' && console.log('host-agent: unconfirmed LAN change rolled back'))
      .catch((e) => console.error('host-agent: tick:', e.message));
  loop();
  setInterval(loop, 5000);
  // iroh 边缘：不能等后台页面来调 GET /v1/link 才写 lan.json（edge-link 的 /_h2z/info 的 lan / lanHints 全靠它，没人调就一直是空的，
  // App 就发现不了局域网地址）。启动时写一次，之后每 30 秒刷新，换网 / 换 IP 跟得上。没配 H2Z_LINK_DIR 的部署不做。
  if (o.linkDir) {
    const writeLan = () => agent.link().catch((e) => console.error('host-agent: link lan.json:', e.message));
    writeLan();
    setInterval(writeLan, 30_000);
  }
  // host/ arrives with `git pull` without restarting this container: check at start and every 10 minutes
  let lastSync = '';
  const sync = () =>
    agent
      .syncHostSetup()
      .then((r) => {
        if (r !== lastSync || r.startsWith('updated')) console.log('host-agent: host setup ' + r);
        lastSync = r;
      })
      .catch((e) => console.error('host-agent: host setup sync failed:', String(e.stderr || e.message).slice(0, 500)));
  sync();
  setInterval(sync, 10 * 60_000);
  let lastKiosk = '';
  const syncKioskScripts = () =>
    agent
      .syncKiosk()
      .then((r) => {
        if (r !== lastKiosk) console.log('host-agent: ' + r);
        lastKiosk = r;
      })
      .catch((e) => console.error('host-agent: kiosk sync failed:', String(e.stderr || e.message).slice(0, 500)));
  syncKioskScripts();
  setInterval(syncKioskScripts, 10 * 60_000);
  // 穿透：应该开着但容器没了（docker 重装 / 被删）就补回来；启动时一次，之后每 10 分钟
  if (agent.tunnel) {
    let lastTunnel = '';
    const syncTunnel = () =>
      agent.tunnel
        .reconcile()
        .then((r) => {
          if (r !== lastTunnel && r !== 'idle' && r !== 'ok') console.log('host-agent: cloudflare tunnel ' + r);
          lastTunnel = r;
        })
        .catch((e) => console.error('host-agent: cloudflare tunnel reconcile failed:', String(e.message).slice(0, 300)));
    syncTunnel();
    setInterval(syncTunnel, 10 * 60_000);
  }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
