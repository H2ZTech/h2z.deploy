// Camera discovery for the H2Z host agent (exhaustive local discovery, 2026-11-23).
//
// THIS FILE EXISTS IN TWO REPOSITORIES AND MUST BE BYTE-IDENTICAL IN BOTH:
//   h2z.security/scripts/camera-discovery.mjs   and   h2z.deploy/scripts/camera-discovery.mjs
// Each repository has a test (scripts/camera-discovery.test.mjs) that pins the SHA-256 of this file.
// Change both copies together and update the pinned digest in both tests.
//
// host-agent.mjs imports this file from its own directory (optional import, like cf-tunnel.mjs / muse.mjs):
// when the file is not mounted the agent falls back to its built-in ONVIF + SADP search.
//
// What it does: finds IP cameras on the networks the box is attached to, through four of the six
// channels of docs/PLAN-2026-11-23-CAMERA-ONBOARDING.md section 2 (the other two are backend / human):
//   A  devices that ANSWER a multicast / broadcast discovery query (standard and vendor protocols)
//   B  devices with OPEN PORTS, asked one address at a time (ARP sweep, TCP ports, unauthenticated banners)
//   C  devices that TALK BY THEMSELVES while we listen (announcements, cloud beacons, DHCP requests)
//   D  devices reachable on LAYER 2 ONLY (factory address in a foreign subnet, IPv4/IPv6 link-local)
//
// Rules for everything in here (this runs in a privileged host-network process):
//   - read-only: nothing is ever written to a device; no credentials are ever sent;
//   - bounded: reply size, reply count, target count, follow-up count and total run time are capped;
//   - rate limited: sweeps and connects are paced;
//   - hostile input never throws out of discover(): every parser is wrapped, malformed replies are counted;
//   - the maintenance-hotspot network and virtual / wireless / uplink interfaces are never probed and
//     nothing from them is reported (same rule as discoveryInterfaces in host-agent.mjs);
//   - no npm dependencies; raw-socket work (ARP, ICMPv6) goes through host tools (`arping`, `ping`, `ip`).
//
// Evidence honesty: a vendor probe is implemented only when its wire format is described by vendor
// documentation or by a public open-source implementation (see `evidence.source` of each registry entry).
// The formats were re-implemented from those descriptions; no third-party source code is copied here.
// Nothing new in this file has been verified against a real device yet (evidence level 'documented');
// only ONVIF WS-Discovery and Hikvision SADP are 'verified' (field use since 2026-11-02).
//
// Adding a protocol = adding one entry to PROBES (target + request builder + reply parser).

import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------------------------------
export const DISCOVERY_GROUP = '239.255.255.250';
export const WSD_PORT = 3702;
export const SADP_PORT = 37020;
/** largest reply that is parsed, replies kept per run (same values as the built-in search of host-agent.mjs) */
export const DISCOVERY_MAX_REPLY = 8 << 10;
export const DISCOVERY_MAX_REPLIES = 500;
export const LIMITS = Object.freeze({
  maxReply: DISCOVERY_MAX_REPLY,
  maxReplies: DISCOVERY_MAX_REPLIES,
  maxRepliesPerProbe: 200, // per probe, unless the entry sets its own maxReplies
  maxRepliesTotal: 4000,
  maxDevices: 1024,
  rawPerDevice: 8, // raw replies kept per device
  rawBytes: 2048, // bytes kept per raw reply
  minPrefix: 22, // a swept network has at most 1024 addresses (same as the L2 scan)
  maxSweepAddresses: 2048,
  maxCidrs: 8,
  maxFactoryIps: 64,
  maxPorts: 32,
  maxPortHosts: 256, // hosts whose ports are probed in one run
  maxUnicastHosts: 64, // routed hosts that get the unicast-capable registry probes
  maxFollowUps: 48, // follow-up queries of one probe (mDNS)
  maxHttpFetches: 16, // SSDP LOCATION fetches
  httpBytes: 64 << 10,
  bannerBytes: 16 << 10,
  extraBudgetMs: 8000, // the whole run ends at most this long after the `seconds` listening window
  heavyIntervalMs: 10 * 60_000, // channels B and D run at most this often unless the request names `channels` itself
  arpGapMs: 10, // 100 ARP triggers per second
  connectGapMs: 5, // 200 TCP connects per second
  connectConcurrency: 64,
  bannerConcurrency: 16,
  connectTimeoutMs: 400,
  bannerTimeoutMs: 1500,
});

/** ports probed on every alive host (PLAN section 2.2) */
export const DEFAULT_PORTS = Object.freeze([554, 8554, 10554, 80, 443, 8080, 8000, 37777, 34567, 9000, 2020, 8899, 5000, 7447, 1935, 51826]);
const RTSP_PORTS = new Set([554, 8554, 10554]);
const HTTP_PORTS = new Set([80, 8080]);
const HTTPS_PORTS = new Set([443]);
const ONVIF_PORTS = new Set([80, 8080, 8000, 2020, 8899, 5000]);
const ALIVE_PORTS = [80, 554, 443, 8000]; // routed networks: a connect or a refusal on any of these = alive

/**
 * Factory-default static addresses probed by ARP when the caller passes no `factoryIps` (the backend is
 * expected to pass the camera library's list). Conservative on purpose.
 *   192.168.1.64, 192.0.0.64  Hikvision   camera-library/library.json vendors.hikvision.factory
 *   192.168.1.13              Uniview     camera-library/library.json vendors.uniview.factory
 *   192.168.1.108             Dahua       vendor quick-start guides (PLAN-2026-11-23 section 2.4)
 *   192.168.1.100             Hanwha      vendor quick-start guides (PLAN-2026-11-23 section 2.4)
 *   192.168.0.90              Axis        vendor documentation (PLAN-2026-11-23 section 2.4)
 */
export const DEFAULT_FACTORY_IPS = Object.freeze(['192.168.1.64', '192.0.0.64', '192.168.1.13', '192.168.1.108', '192.168.1.100', '192.168.0.90']);

export class DiscoveryError extends Error {
  constructor(message, code = 'E_PARAM') {
    super(message);
    this.code = code;
  }
}
const bad = (msg) => new DiscoveryError(msg);

// ---------------------------------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------------------------------
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const ipToInt = (ip) => {
  const m = IPV4.exec(String(ip || '').trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
export const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
export const cidrParts = (c) => {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(c || '').trim());
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const net = (ip & maskOf(prefix)) >>> 0;
  return { net, prefix, size: prefix === 32 ? 1 : 2 ** (32 - prefix) };
};
const insideNet = (inner, outer) => inner.prefix >= outer.prefix && ((inner.net & maskOf(outer.prefix)) >>> 0) === outer.net;
const overlapNet = (a, b) => insideNet(a, b) || insideNet(b, a);
export const inAnyCidr = (ip, cidrs) => {
  const n = ipToInt(ip);
  if (n === null) return false;
  return cidrs.some((c) => {
    const p = cidrParts(c);
    return p && ((n & maskOf(p.prefix)) >>> 0) === p.net;
  });
};
const hostsOf = (t, own) => {
  const out = [];
  const first = t.size > 2 ? t.net + 1 : t.net;
  const last = t.size > 2 ? t.net + t.size - 2 : t.net + t.size - 1;
  for (let n = first; n <= last; n++) {
    const ip = intToIp(n);
    if (!own.has(ip)) out.push(ip);
  }
  return out;
};
/** 'AA-BB-CC-DD-EE-FF' / 'aabbccddeeff' -> 'AA:BB:CC:DD:EE:FF'; '' when invalid */
export function normalizeMac(v) {
  const hex = String(v || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/i.test(hex)) return '';
  return hex.toUpperCase().match(/../g).join(':');
}
const macOfBytes = (buf, off) => (buf.length >= off + 6 ? normalizeMac(buf.subarray(off, off + 6).toString('hex')) : '');
const ipOfBytes = (buf, off) => (buf.length >= off + 4 ? `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}` : '');
/** a usable unicast IPv4 address (not 0.0.0.0, loopback, multicast or broadcast), else '' */
const usableIp = (ip) => {
  const n = ipToInt(ip);
  if (n === null || n === 0 || n >>> 24 === 127 || n >>> 24 >= 224) return '';
  return intToIp(n);
};
/** fixed-size, NUL-terminated ASCII field; only printable characters are kept */
const cstr = (buf, off, len) => {
  if (buf.length <= off) return '';
  const part = buf.subarray(off, Math.min(buf.length, off + len));
  const end = part.indexOf(0);
  return (end === -1 ? part : part.subarray(0, end)).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim();
};
const clip = (v, n = 128) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const xmlEscape = (v) => String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
/** text of an XML element (namespace prefix and case ignored), '' when absent */
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
const hostOfUrl = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};
const jsonObject = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const str = (v, n = 128) => (typeof v === 'string' || typeof v === 'number' ? clip(v, n) : '');
const uniq = (list) => [...new Set(list)];

/** /proc/net/arp -> complete entries only */
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

/** interfaces used for discovery: wired IPv4 ports (no loopback / virtual / wireless / uplink ports, no excluded network) */
export function discoveryInterfaces(netIfs = {}, { excluded = [] } = {}) {
  const out = [];
  for (const [iface, addrs] of Object.entries(netIfs)) {
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
// minimal DNS message codec (mDNS / DNS-SD): encoder for queries, decoder with name compression.
// Bounds: labels <= 63 bytes, names <= 255 bytes, compression pointers must point strictly backwards
// (so a loop is impossible) and at most 16 are followed per name, at most `maxRecords` records.
// ---------------------------------------------------------------------------------------------------
export const DNS_TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 });

export function dnsEncodeName(name) {
  const labels = String(name || '').split('.').filter(Boolean);
  const parts = [];
  let total = 1;
  for (const l of labels) {
    const b = Buffer.from(l, 'utf8');
    if (!b.length || b.length > 63) throw new Error('bad DNS label');
    total += b.length + 1;
    if (total > 255) throw new Error('DNS name too long');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** questions: [{name, type, unicast?}] -> one query message */
export function dnsEncodeQuery(questions, { id = 0 } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id & 0xffff, 0);
  head.writeUInt16BE(questions.length, 4);
  const parts = [head];
  for (const q of questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(q.unicast ? 0x8001 : 0x0001, 2); // class IN; top bit = unicast response wanted (RFC 6762 5.4)
    parts.push(dnsEncodeName(q.name), tail);
  }
  return Buffer.concat(parts);
}

function dnsReadName(buf, start) {
  const labels = [];
  let off = start;
  let next = -1; // offset after the name in the original position
  let jumps = 0;
  let total = 0;
  let floor = start; // a pointer must point before the position it is read at
  for (;;) {
    if (off >= buf.length) return null;
    const len = buf[off];
    if (len === 0) {
      off += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) return null;
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (ptr >= floor || ++jumps > 16) return null; // forward or self pointer / too many jumps: refuse
      if (next < 0) next = off + 2;
      floor = ptr;
      off = ptr;
      continue;
    }
    if (len > 63 || off + 1 + len > buf.length) return null;
    total += len + 1;
    if (total > 255) return null;
    labels.push(buf.subarray(off + 1, off + 1 + len).toString('utf8'));
    off += 1 + len;
  }
  return { labels, name: labels.join('.'), next: next < 0 ? off : next };
}

/** -> {id, response, questions: [{name,type}], records: [{name, labels, type, ttl, data}]} or null when malformed */
export function dnsDecode(buf, { maxRecords = 64 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  if (qd > 32) return null;
  let off = 12;
  const questions = [];
  for (let i = 0; i < qd; i++) {
    const n = dnsReadName(buf, off);
    if (!n || n.next + 4 > buf.length) return null;
    questions.push({ name: n.name, type: buf.readUInt16BE(n.next) });
    off = n.next + 4;
  }
  const records = [];
  for (let i = 0; i < rr && records.length < maxRecords; i++) {
    const n = dnsReadName(buf, off);
    if (!n || n.next + 10 > buf.length) return null;
    const type = buf.readUInt16BE(n.next);
    const ttl = buf.readUInt32BE(n.next + 4);
    const rdlen = buf.readUInt16BE(n.next + 8);
    const rd = n.next + 10;
    if (rd + rdlen > buf.length) return null;
    let data = null;
    if (type === DNS_TYPE.A && rdlen === 4) data = ipOfBytes(buf, rd);
    else if (type === DNS_TYPE.AAAA && rdlen === 16) data = buf.subarray(rd, rd + 16).toString('hex').match(/.{4}/g).join(':');
    else if (type === DNS_TYPE.PTR) {
      const t = dnsReadName(buf, rd);
      if (t && t.next <= rd + rdlen) data = { name: t.name, labels: t.labels };
    } else if (type === DNS_TYPE.SRV && rdlen >= 7) {
      const t = dnsReadName(buf, rd + 6);
      if (t && t.next <= rd + rdlen) data = { port: buf.readUInt16BE(rd + 4), target: t.name };
    } else if (type === DNS_TYPE.TXT) {
      data = [];
      let p = rd;
      while (p < rd + rdlen && data.length < 32) {
        const l = buf[p];
        if (p + 1 + l > rd + rdlen) break;
        if (l) data.push(buf.subarray(p + 1, p + 1 + l).toString('utf8'));
        p += 1 + l;
      }
    }
    if (data !== null) records.push({ name: n.name, labels: n.labels, type, ttl, data });
    off = rd + rdlen;
  }
  return { id, response: Boolean(flags & 0x8000), questions, records };
}

// ---------------------------------------------------------------------------------------------------
// ONVIF WS-Discovery and Hikvision SADP (moved here unchanged from host-agent.mjs)
// ---------------------------------------------------------------------------------------------------
/** WS-Discovery Probe. type: 'dn:NetworkVideoTransmitter', 'tds:Device', or '' for a probe without Types (matches every WSD device) */
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
    (type ? `<s:Body><d:Probe><d:Types>${xmlEscape(type)}</d:Types></d:Probe></s:Body></s:Envelope>` : '<s:Body><d:Probe/></s:Body></s:Envelope>')
  );
}

export const sadpProbe = (uuid) => `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${xmlEscape(String(uuid).toUpperCase())}</Uuid><Types>inquiry</Types></Probe>`;

/** WS-Discovery ProbeMatches (or Hello with element = 'Hello') -> [{uuid, xaddrs[], ip, name, hardware, manufacturer, mac, location, types, onvifType, profiles}] */
export function parseWsDiscovery(xml, fromIp = '', element = 'ProbeMatch') {
  const text = String(xml || '');
  if (!new RegExp(element, 'i').test(text)) return [];
  const out = [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${element}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${element}>`, 'gi');
  let m;
  while ((m = re.exec(text)) && out.length < 16) {
    const body = m[1];
    const uuid = tag(tag(body, 'EndpointReference'), 'Address').replace(/^(urn:)?uuid:/i, '').toLowerCase();
    const xaddrs = tag(body, 'XAddrs').split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
    const scopes = tag(body, 'Scopes').split(/\s+/).filter(Boolean);
    const scope = (key) => {
      const hit = scopes.find((s) => s.toLowerCase().startsWith(`onvif://www.onvif.org/${key.toLowerCase()}/`));
      return hit ? decodeScope(hit.slice(`onvif://www.onvif.org/${key}/`.length)) : '';
    };
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
      onvifType: scopes.filter((x) => /^onvif:\/\/www\.onvif\.org\/type\//i.test(x)).map((x) => decodeScope(x.replace(/^onvif:\/\/www\.onvif\.org\/type\//i, ''))).slice(0, 8),
      profiles: scopes.filter((x) => /^onvif:\/\/www\.onvif\.org\/Profile\//i.test(x)).map((x) => decodeScope(x.replace(/^onvif:\/\/www\.onvif\.org\/Profile\//i, '')).toUpperCase().replace(/^STREAMING$/, 'S')).slice(0, 8),
    });
  }
  return out;
}

/** SADP reply -> {ip, mac, model, serial, httpPort, commandPort, activated, dhcp, softwareVersion, salt} or null (not a device reply) */
export function parseSadp(xml) {
  const text = String(xml || '');
  const type = tag(text, 'Types').toLowerCase();
  if (!/<ProbeMatch|<Probe/i.test(text) || (type && type !== 'inquiry' && type !== 'hello' && type !== 'update')) return null;
  const ip = tag(text, 'IPv4Address');
  if (ipToInt(ip) === null) return null; // our own query (multicast loopback) has no IPv4Address
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

/** WS-Discovery + SADP results -> device list, merged by MAC, then ONVIF UUID, then IP; sorted by IP (unchanged) */
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

/** does this WS-Discovery match describe an ONVIF device (and not a printer / PC that answered the untyped probe)? */
const looksOnvif = (w, xml) =>
  w.types.some((t) => {
    if (/NetworkVideo/i.test(t)) return true;
    // a type counts as ONVIF when its prefix is bound to an onvif.org namespace (tds:Device yes, wsdp:Device no)
    const prefix = /^([\w.-]+):/.exec(t)?.[1];
    const ns = prefix ? new RegExp(`xmlns:${prefix.replace(/[.]/g, '\\.')}="([^"]*)"`).exec(xml) : null;
    return Boolean(ns && /onvif\.org/i.test(ns[1]));
  }) || w.xaddrs.some((u) => /\/onvif\//i.test(u)) || Boolean(w.name || w.hardware || w.onvifType.length || w.profiles.length);

// ---------------------------------------------------------------------------------------------------
// vendor wire formats (builders and parsers are exported for the tests)
// A parser returns an array of observations: {ip?, mac?, uuid?, vendor?, model?, serial?, name?, fields?, cloudType?}.
// `ip` empty = use the sender address. Parsers never trust lengths found in the packet without checking them.
// ---------------------------------------------------------------------------------------------------

// --- Dahua DHDiscover (DHIP): 32-byte header + JSON. Header: u32le 0x20, 'DHIP', 8 zero bytes, u32le body length,
// u32le 0, u32le body length, u32le 0. "uni":1 asks for a unicast reply.
export function dahuaRequest() {
  const body = Buffer.from('{"method":"DHDiscover.search","params":{"mac":"","uni":1}}\n', 'latin1');
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0x20, 0);
  head.write('DHIP', 4, 'latin1');
  head.writeUInt32LE(body.length, 16);
  head.writeUInt32LE(body.length, 24);
  return Buffer.concat([head, body]);
}
export function parseDahua(buf) {
  if (buf.length < 34 || buf.readUInt32LE(0) !== 0x20 || buf.toString('latin1', 4, 8) !== 'DHIP') return [];
  const len = buf.readUInt32LE(16);
  if (len < 2 || len > buf.length - 32) return [];
  const j = jsonObject(buf.toString('utf8', 32, 32 + len).replace(/[\u0000\s]+$/, ''));
  if (!j || j.method !== 'client.notifyDevInfo') return [];
  const info = j.params && typeof j.params === 'object' && j.params.deviceInfo && typeof j.params.deviceInfo === 'object' ? j.params.deviceInfo : {};
  const v4 = info.IPv4Address && typeof info.IPv4Address === 'object' ? info.IPv4Address : {};
  return [{
    ip: usableIp(v4.IPAddress),
    mac: normalizeMac(typeof j.mac === 'string' ? j.mac : str(info.mac)),
    vendor: str(info.Vendor, 64) || 'Dahua',
    model: str(info.DeviceType),
    serial: str(info.SerialNo),
    name: str(info.MachineName),
    fields: { deviceClass: str(info.DeviceClass, 32), version: str(info.Version, 64), httpPort: Number(info.HttpPort) || null, port: Number(info.Port) || null, init: Number.isFinite(Number(info.Init)) ? Number(info.Init) : null, subnetMask: str(v4.SubnetMask, 16), gateway: str(v4.DefaultGateway, 16), dhcp: typeof v4.DhcpEnable === 'boolean' ? v4.DhcpEnable : null },
  }];
}

// --- Hanwha / Wisenet / Samsung: 262-byte fixed structure. Request: byte 0 = 0x01, the rest zero, to UDP 7701;
// the reply (byte 0 = 0x0b) goes to UDP 7711. ASCII fields: MAC @0x13 (18), IP @0x25 (16), mask @0x35 (16),
// gateway @0x45 (16), device type @0x6d (10), URL @0x85 (39).
export function hanwhaRequest() {
  const b = Buffer.alloc(262);
  b[0] = 0x01;
  return b;
}
export function parseHanwha(buf) {
  if (buf.length < 0x77 || buf[0] !== 0x0b) return [];
  const mac = normalizeMac(cstr(buf, 0x13, 18));
  const ip = usableIp(cstr(buf, 0x25, 16));
  if (!mac && !ip) return [];
  return [{ ip, mac, vendor: 'Hanwha', model: cstr(buf, 0x6d, 10), fields: { subnetMask: cstr(buf, 0x35, 16), gateway: cstr(buf, 0x45, 16), url: cstr(buf, 0x85, 39) } }];
}

// --- Bosch: 12-byte request to UDP 1757 (99 39 a4 27, 4-byte transaction id, ff 00 06 de); replies go to UDP 1758:
// either a 32-byte binary one (magic 99 39 a4 27, MAC @8, IPv4 @0x10, mask @0x14, gateway @0x18) or an XML document.
const BOSCH_MAGIC = Buffer.from('9939a427', 'hex');
export function boschRequest(txId = 0) {
  const b = Buffer.alloc(12);
  BOSCH_MAGIC.copy(b, 0);
  b.writeUInt32BE(txId >>> 0, 4);
  b.writeUInt32BE(0xff0006de, 8);
  return b;
}
export function parseBosch(buf) {
  if (buf.length === 32 && buf.subarray(0, 4).equals(BOSCH_MAGIC)) {
    const mac = macOfBytes(buf, 8);
    const ip = usableIp(ipOfBytes(buf, 0x10));
    return mac || ip ? [{ ip, mac, vendor: 'Bosch', fields: { subnetMask: ipOfBytes(buf, 0x14), gateway: ipOfBytes(buf, 0x18) } }] : [];
  }
  const text = buf.toString('utf8');
  if (!/<unitIPAddress>|<physAddress>/i.test(text)) return [];
  return [{ ip: usableIp(tag(text, 'unitIPAddress')), mac: normalizeMac(tag(text, 'physAddress')), vendor: 'Bosch', model: clip(tag(text, 'friendlyName')), serial: clip(tag(text, 'serialNumber')), fields: {} }];
}

// --- Vivotek: 5-byte header (session byte, magic 4a 5d 8f 1c) to UDP 10000; the reply repeats the header and adds
// type / length / value items: 0x01 long name, 0x02 MAC (6), 0x03 IPv4 (4), 0x09 short name; type 0x04 has no value.
const VIVOTEK_MAGIC = Buffer.from('4a5d8f1c', 'hex');
export function vivotekRequest(session = 1) {
  return Buffer.concat([Buffer.from([session & 0xff]), VIVOTEK_MAGIC]);
}
export function parseVivotek(buf) {
  if (buf.length < 9 || !buf.subarray(1, 5).equals(VIVOTEK_MAGIC)) return [];
  const o = { vendor: 'Vivotek', fields: {} };
  let p = 5;
  let items = 0;
  while (p + 2 <= buf.length && items++ < 64) {
    const type = buf[p];
    const size = buf[p + 1];
    p += 2;
    if (type === 0) break;
    if (type === 0x04) continue; // single-byte item: the "size" byte is the value
    if (p + size > buf.length) break;
    const v = buf.subarray(p, p + size);
    p += size;
    if (type === 0x01) o.name = clip(v.toString('utf8'));
    else if (type === 0x02 && size === 6) o.mac = macOfBytes(v, 0);
    else if (type === 0x03 && size === 4) o.ip = usableIp(ipOfBytes(v, 0));
    else if (type === 0x09) o.model = clip(v.toString('utf8'));
  }
  return o.ip || o.mac ? [o] : [];
}

// --- Sony: 0x02, lines terminated by 0xff, 0x03. Request line "ENQ:allinfo" to UDP 2380; the reply has "key:value"
// lines (Model, Serial, Mac, Ipadr ...) and may be sent to the broadcast address.
export function sonyRequest() {
  return Buffer.concat([Buffer.from([0x02]), Buffer.from('ENQ:allinfo', 'latin1'), Buffer.from([0xff, 0x03])]);
}
export function parseSony(buf) {
  if (buf.length < 4 || buf[0] !== 0x02 || buf[buf.length - 1] !== 0x03) return [];
  const kv = {};
  let start = 1;
  let lines = 0;
  for (let i = 1; i < buf.length - 1 && lines < 64; i++) {
    if (buf[i] !== 0xff) continue;
    const line = buf.toString('latin1', start, i);
    start = i + 1;
    lines++;
    const c = line.indexOf(':');
    if (c > 0) kv[line.slice(0, c).trim().toLowerCase()] = clip(line.slice(c + 1));
  }
  if (!kv.model && !kv.ipadr && !kv.mac) return [];
  return [{ ip: usableIp(kv.ipadr), mac: normalizeMac(kv.mac), vendor: 'Sony', model: kv.model || '', serial: kv.serial || '', fields: {} }];
}

// --- Arecont Vision: "Arecont_Vision-AV2000" (21 bytes) + 0x01 to UDP 69. Reply: the same 21 bytes, command byte,
// MAC @22 (6), IPv4 @28 (4), firmware version @32 (2), base model @34 (2), IP lock @36 (1), camera name @37 (32).
const ARECONT_ID = Buffer.from('Arecont_Vision-AV2000', 'latin1');
export function arecontRequest() {
  return Buffer.concat([ARECONT_ID, Buffer.from([0x01])]);
}
export function parseArecont(buf) {
  if (buf.length < 37 || !buf.subarray(0, 21).equals(ARECONT_ID)) return [];
  const mac = macOfBytes(buf, 22);
  const ip = usableIp(ipOfBytes(buf, 28));
  if (!mac && !ip) return [];
  // the byte order of the two 16-bit fields is not stated in the manual: they are reported as hex, not interpreted
  return [{ ip, mac, vendor: 'Arecont Vision', name: cstr(buf, 37, 32), fields: { firmwareHex: buf.toString('hex', 32, 34), baseModelHex: buf.toString('hex', 34, 36), ipLock: buf[36] } }];
}

// --- Ubiquiti: request 01 00 00 00 (version 1, command 0, length 0) to UDP 10001. Reply: version, command,
// u16be length, then items: type (1), u16be length, value. 0x01 MAC, 0x02 MAC + IPv4, 0x03 firmware, 0x0b host name,
// 0x0c product, 0x14 / 0x15 model, 0x16 version.
export function ubiquitiRequest() {
  return Buffer.from([0x01, 0x00, 0x00, 0x00]);
}
export function parseUbiquiti(buf) {
  if (buf.length < 8 || (buf[0] !== 0x01 && buf[0] !== 0x02) || buf.readUInt16BE(2) !== buf.length - 4) return [];
  const o = { vendor: 'Ubiquiti', fields: {} };
  let p = 4;
  let items = 0;
  while (p + 3 <= buf.length && items++ < 64) {
    const type = buf[p];
    const len = buf.readUInt16BE(p + 1);
    p += 3;
    if (p + len > buf.length) break;
    const v = buf.subarray(p, p + len);
    p += len;
    if (type === 0x01 && len >= 6) o.mac = o.mac || macOfBytes(v, 0);
    else if (type === 0x02 && len >= 10) {
      o.mac = o.mac || macOfBytes(v, 0);
      o.ip = o.ip || usableIp(ipOfBytes(v, 6));
    } else if (type === 0x03) o.fields.firmware = clip(v.toString('utf8'));
    else if (type === 0x0b) o.name = clip(v.toString('utf8'));
    else if (type === 0x0c) o.fields.product = clip(v.toString('utf8'), 64);
    else if (type === 0x14 || type === 0x15) o.model = o.model || clip(v.toString('utf8'));
    else if (type === 0x16) o.fields.version = clip(v.toString('utf8'), 64);
  }
  return o.mac || o.ip ? [o] : [];
}

// --- XiongMai DVRIP (NETIP): 20-byte request to UDP 34569 (sent from port 34569); reply = 20-byte header + JSON with
// "NetWork.NetCommon" {HostIP: "0x..." (address bytes in reverse order), HostName, MAC, SN, TCPPort, HttpPort ...}.
export function dvripRequest() {
  return Buffer.from('ff00000000000000000000000000fa0500000000', 'hex');
}
export function parseDvrip(buf) {
  if (buf.length < 22) return [];
  const j = jsonObject(buf.toString('utf8', 20).replace(/[\u0000\s]+$/, ''));
  const c = j && j['NetWork.NetCommon'];
  if (!c || typeof c !== 'object') return [];
  let ip = '';
  const m = /^0x([0-9a-f]{8})$/i.exec(typeof c.HostIP === 'string' ? c.HostIP : '');
  if (m) {
    const b = Buffer.from(m[1], 'hex');
    ip = usableIp(`${b[3]}.${b[2]}.${b[1]}.${b[0]}`);
  }
  return [{ ip, mac: normalizeMac(str(c.MAC)), vendor: 'XiongMai', name: str(c.HostName), serial: str(c.SN), fields: { tcpPort: Number(c.TCPPort) || null, httpPort: Number(c.HttpPort) || null, version: str(c.Version, 64), deviceType: Number.isFinite(Number(c.DeviceType)) ? Number(c.DeviceType) : null, channels: Number(c.ChannelNum) || null } }];
}

// --- TP-Link Kasa (legacy, UDP 9999): JSON obfuscated with an XOR autokey cipher (first key 171), no length prefix on UDP.
export function kasaEncrypt(text) {
  const plain = Buffer.from(String(text), 'utf8');
  const out = Buffer.alloc(plain.length);
  let key = 171;
  for (let i = 0; i < plain.length; i++) {
    key ^= plain[i];
    out[i] = key;
  }
  return out;
}
export function kasaDecrypt(buf) {
  const out = Buffer.alloc(buf.length);
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    out[i] = key ^ buf[i];
    key = buf[i];
  }
  return out.toString('utf8');
}
export const kasaRequest = () => kasaEncrypt('{"system":{"get_sysinfo":{}}}');
export function parseKasa(buf) {
  if (buf.length < 16) return [];
  const j = jsonObject(kasaDecrypt(buf));
  const s = j && j.system && typeof j.system === 'object' ? j.system.get_sysinfo : null;
  if (!s || typeof s !== 'object') return [];
  // newer camera firmware nests the data one level deeper
  const info = s.system && typeof s.system === 'object' ? s.system : s;
  if (!Object.keys(info).length) return []; // our own looped-back query
  return [{ mac: normalizeMac(str(info.mac) || str(info.mic_mac) || str(info.ethernet_mac)), vendor: 'TP-Link', model: str(info.model), name: str(info.alias) || str(info.dev_name), serial: str(info.deviceId, 64), fields: { type: str(info.type || info.mic_type, 64), hwVersion: str(info.hw_ver, 32), swVersion: str(info.sw_ver, 64) } }];
}

// --- TP-Link Tapo / newer Kasa (UDP 20002): fixed 16-byte query; reply = 16-byte header + JSON {"result": {...}}.
export function tapoRequest() {
  return Buffer.from('020000010000000000000000463cb5d3', 'hex');
}
export function parseTapo(buf) {
  if (buf.length < 18) return [];
  const j = jsonObject(buf.toString('utf8', 16).replace(/[\u0000\s]+$/, ''));
  const r = j && j.result;
  if (!r || typeof r !== 'object') return [];
  const type = str(r.device_type, 64);
  return [{ ip: usableIp(str(r.ip)), mac: normalizeMac(str(r.mac)), vendor: 'TP-Link', model: str(r.device_model), name: str(r.device_name), serial: str(r.device_id, 64), fields: { deviceType: type, owner: Boolean(r.owner), factoryDefault: typeof r.factory_default === 'boolean' ? r.factory_default : null, encrypt: r.mgt_encrypt_schm && typeof r.mgt_encrypt_schm === 'object' ? str(r.mgt_encrypt_schm.encrypt_type, 16) : '' } }];
}

// --- Reolink: aa aa 00 00 to UDP 2000; cameras answer with binary data to UDP 3000. The reply layout is not
// documented: only the sender address is used, the printable strings are reported as hints and the raw reply is kept.
export function reolinkRequest() {
  return Buffer.from('aaaa0000', 'hex');
}
export function parseReolink(buf, rinfo = {}) {
  if (rinfo.localPort !== 3000 || buf.length < 8) return [];
  const strings = (buf.toString('latin1').match(/[\x20-\x7e]{4,64}/g) || []).slice(0, 8);
  return [{ fields: { vendorHint: 'Reolink', strings } }];
}

// --- PPPP / CS2 / iLnk P2P cameras: MSG_LAN_SEARCH f1 30 00 00 to UDP 32108; the answer is MSG_PUNCH_PKT:
// f1 41, u16be length (20), device id = prefix (8, NUL padded) + serial (u32be) + check code (8, NUL padded).
export function ppppRequest() {
  return Buffer.from('f1300000', 'hex');
}
export function parsePppp(buf) {
  if (buf.length < 24 || buf[0] !== 0xf1 || buf[1] !== 0x41) return [];
  const len = buf.readUInt16BE(2);
  if (len < 20 || len > buf.length - 4) return [];
  const prefix = cstr(buf, 4, 8);
  const check = cstr(buf, 16, 8);
  if (!/^[A-Za-z0-9]{1,8}$/.test(prefix)) return [];
  const uid = `${prefix}-${String(buf.readUInt32BE(12)).padStart(6, '0')}-${check}`;
  return [{ serial: uid, cloudType: 'p2p-pppp', fields: { uid } }];
}

// --- VStarcam: 44 48 01 01 to UDP 8600; reply >= 256 bytes with magic 44 48 01 08, ASCII IP @4 (16), mask @0x14,
// gateway @0x24, MAC @0x54 (6 bytes), serial @0x5c (32), name @0x7c (32), firmware @0xcc (32).
export function vstarcamRequest() {
  return Buffer.from('44480101', 'hex');
}
export function parseVstarcam(buf) {
  if (buf.length < 0x100 || buf.readUInt32BE(0) !== 0x44480108) return [];
  return [{ ip: usableIp(cstr(buf, 4, 16)), mac: macOfBytes(buf, 0x54), vendor: 'VStarcam', serial: cstr(buf, 0x5c, 32), name: cstr(buf, 0x7c, 32), fields: { subnetMask: cstr(buf, 0x14, 16), gateway: cstr(buf, 0x24, 16), firmware: cstr(buf, 0xcc, 32) }, cloudType: 'p2p-vstarcam' }];
}

// --- GigE Vision GVCP DISCOVERY_CMD: 42 11 00 02 00 00 <request id> to UDP 3956. DISCOVERY_ACK: status (0), 00 03,
// length 00 f8, request id, then 248 bytes: MAC @0x12 (6), current IP @0x2c, manufacturer @0x50 (32), model @0x70 (32),
// device version @0x90 (32), serial @0xe0 (16), user-defined name @0xf0 (16).
export function gvcpRequest(requestId = 1) {
  const b = Buffer.from('4211000200000000', 'hex');
  b.writeUInt16BE((requestId & 0xffff) || 1, 6);
  return b;
}
export function parseGvcp(buf) {
  if (buf.length < 0x100 || buf.readUInt16BE(0) !== 0 || buf.readUInt16BE(2) !== 0x0003 || buf.readUInt16BE(4) !== buf.length - 8) return [];
  return [{ ip: usableIp(ipOfBytes(buf, 0x2c)), mac: macOfBytes(buf, 0x12), vendor: cstr(buf, 0x50, 32), model: cstr(buf, 0x70, 32), serial: cstr(buf, 0xe0, 16), name: cstr(buf, 0xf0, 16), fields: { deviceVersion: cstr(buf, 0x90, 32), gigeVision: true } }];
}

// --- SSDP / UPnP
export function ssdpRequest() {
  return Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${DISCOVERY_GROUP}:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n`, 'latin1');
}
/** M-SEARCH response or NOTIFY ssdp:alive -> one observation with SERVER / ST / USN / LOCATION */
export function parseSsdp(buf) {
  const text = buf.toString('latin1');
  const lines = text.split(/\r?\n/, 40);
  const first = lines[0] || '';
  const notify = /^NOTIFY \* HTTP\/1\.[01]/i.test(first);
  if (!notify && !/^HTTP\/1\.[01] 200/i.test(first)) return [];
  const h = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c > 0) h[line.slice(0, c).trim().toLowerCase()] = clip(line.slice(c + 1), 256);
  }
  if (notify && !/ssdp:alive/i.test(h.nts || '')) return [];
  const st = h.st || h.nt || '';
  if (!st && !h.usn) return [];
  return [{ fields: { server: h.server || '', st, usn: h.usn || '', location: /^https?:\/\//i.test(h.location || '') ? h.location : '', notify } }];
}
/** UPnP device description XML -> the few fields that identify a device */
export function parseUpnpDescription(xml) {
  const text = String(xml || '');
  const dev = tag(text, 'device') || text;
  const o = {};
  for (const [k, t] of [['friendlyName', 'friendlyName'], ['manufacturer', 'manufacturer'], ['modelName', 'modelName'], ['modelNumber', 'modelNumber'], ['serialNumber', 'serialNumber'], ['udn', 'UDN']]) {
    const v = clip(tag(dev, t).replace(/<[^>]*>/g, ''));
    if (v) o[k] = v;
  }
  return o;
}

// --- mDNS / DNS-SD
const MDNS_META = '_services._dns-sd._udp.local';
/** service types that are always asked for (the meta query finds the rest) */
export const MDNS_TYPES = Object.freeze(['_axis-video._tcp.local', '_hap._tcp.local', '_rtsp._tcp.local', '_http._tcp.local', '_psia._tcp.local', '_onvif._tcp.local', '_ndi._tcp.local', '_arec._tcp.local']);
export function mdnsRequest() {
  return dnsEncodeQuery([MDNS_META, ...MDNS_TYPES].map((name) => ({ name, type: DNS_TYPE.PTR, unicast: true })));
}
/**
 * One mDNS response -> one observation for the sender, plus follow-up queries (new service types from the meta
 * answer, SRV / TXT of instances that came without them). `ctx.asked` remembers what was already asked.
 */
export function parseMdns(buf, rinfo = {}, ctx = {}) {
  const msg = dnsDecode(buf);
  if (!msg || !msg.response || !msg.records.length) return [];
  const asked = (ctx.asked ||= new Set([MDNS_META, ...MDNS_TYPES]));
  const followUp = [];
  const ask = (name, type) => {
    const key = type + ' ' + name.toLowerCase();
    if (asked.has(key) || asked.has(name.toLowerCase()) || asked.size >= 96) return;
    asked.add(key);
    try {
      followUp.push(dnsEncodeQuery([{ name, type, unicast: true }]));
    } catch { /* a name we cannot encode: skip */ }
  };
  const services = new Set();
  const instances = new Map(); // instance name -> {type, name, port?, host?}
  const txt = {};
  const addresses = [];
  for (const r of msg.records) {
    const lname = r.name.toLowerCase();
    if (r.type === DNS_TYPE.PTR) {
      if (lname === MDNS_META) {
        const type = r.data.name.toLowerCase();
        if (/^_[a-z0-9-]+\._(tcp|udp)\.local$/.test(type)) {
          services.add(type);
          if (!asked.has(type) && asked.size < 96) {
            asked.add(type);
            followUp.push(dnsEncodeQuery([{ name: type, type: DNS_TYPE.PTR, unicast: true }]));
          }
        }
      } else if (/^_[a-z0-9-]+\._(tcp|udp)\.local$/.test(lname) && r.data.labels.length >= 4) {
        services.add(lname);
        if (instances.size < 16 && !instances.has(r.data.name)) instances.set(r.data.name, { type: lname, name: clip(r.data.labels[0]) });
      }
    } else if (r.type === DNS_TYPE.SRV) {
      const inst = instances.get(r.name) || { type: r.labels.slice(1).join('.').toLowerCase(), name: clip(r.labels[0] || '') };
      Object.assign(inst, { port: r.data.port, host: clip(r.data.target) });
      if (instances.size < 16) instances.set(r.name, inst);
      if (inst.type) services.add(inst.type);
    } else if (r.type === DNS_TYPE.TXT) {
      for (const kv of r.data) {
        const c = kv.indexOf('=');
        if (c > 0 && Object.keys(txt).length < 24) txt[clip(kv.slice(0, c), 32)] = clip(kv.slice(c + 1));
      }
    } else if (r.type === DNS_TYPE.A && addresses.length < 8) addresses.push(r.data);
  }
  for (const [full, inst] of instances) if (inst.port === undefined) ask(full, DNS_TYPE.SRV), ask(full, DNS_TYPE.TXT);
  if (!services.size && !instances.size && !addresses.length) return followUp.length ? [{ skip: true, followUp }] : [];
  const o = { fields: { services: [...services].slice(0, 24), instances: [...instances.values()], txt, addresses }, followUp };
  const first = [...instances.values()][0];
  if (first) o.name = first.name;
  // Axis: instance "AXIS <model> - <serial = MAC without separators>", TXT macaddress=<MAC>
  const axis = [...instances.values()].find((i) => i.type === '_axis-video._tcp.local');
  if (axis) {
    const m = /^(?:AXIS\s+)?(.*?)\s+-\s+([0-9A-Fa-f]{12})$/.exec(axis.name);
    Object.assign(o, { vendor: 'Axis', model: m ? clip(m[1]) : '', mac: normalizeMac(txt.macaddress || (m ? m[2] : '')) });
  }
  // HomeKit: TXT md = model, ci = accessory category (17 = IP camera, 18 = video doorbell)
  if (services.has('_hap._tcp.local') && txt.md) Object.assign(o, { model: o.model || txt.md }, { fields: { ...o.fields, hapCategory: Number(txt.ci) || null } });
  if (services.has('_arec._tcp.local')) o.vendor = o.vendor || 'Arecont Vision';
  return [o];
}

// --- passive: Tuya LAN beacons (UDP 6666 plain, 6667 encrypted). The frame prefix is checked, the payload is NOT
// decrypted: the point is to tell the user "this is a cloud camera", not to connect to it.
export function parseTuya(buf, rinfo = {}) {
  if (buf.length < 20) return [];
  const prefix = buf.readUInt32BE(0);
  if (prefix !== 0x000055aa && prefix !== 0x00006699) return [];
  return [{ cloudType: 'tuya', fields: { port: rinfo.localPort || null, frame: prefix === 0x000055aa ? '55aa' : '6699' } }];
}

// --- passive: DHCP requests of other hosts (clients broadcast DISCOVER / REQUEST to 255.255.255.255:67).
export function parseDhcp(buf) {
  if (buf.length < 240 || buf[0] !== 1 || buf[1] !== 1 || buf[2] !== 6 || buf.readUInt32BE(236) !== 0x63825363) return [];
  const mac = macOfBytes(buf, 28);
  if (!mac) return [];
  const o = { mac, ip: usableIp(ipOfBytes(buf, 12)), fields: {} };
  let p = 240;
  let items = 0;
  while (p < buf.length && items++ < 64) {
    const code = buf[p];
    if (code === 255) break;
    if (code === 0) {
      p += 1;
      continue;
    }
    if (p + 2 > buf.length) break;
    const len = buf[p + 1];
    if (p + 2 + len > buf.length) break;
    const v = buf.subarray(p + 2, p + 2 + len);
    p += 2 + len;
    if (code === 12) o.fields.hostname = clip(v.toString('latin1').replace(/[^\x20-\x7e]/g, ''), 64);
    else if (code === 60) o.fields.vendorClass = clip(v.toString('latin1').replace(/[^\x20-\x7e]/g, ''), 64);
    else if (code === 55) o.fields.params = [...v.subarray(0, 32)];
    else if (code === 53 && len === 1) o.fields.messageType = v[0];
    else if (code === 50 && len === 4) o.ip = o.ip || usableIp(ipOfBytes(v, 0));
  }
  if (o.fields.hostname) o.name = o.fields.hostname;
  return [o];
}

// --- layer 2 helpers (channel D)
/** `arping` output (iputils "Unicast reply from IP [MAC]" or "NN bytes from MAC (IP)") -> MAC or '' */
export function parseArping(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/\bfrom\b/i.test(line)) continue;
    const m = /\b((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\b/i.exec(line);
    if (m && normalizeMac(m[1])) return normalizeMac(m[1]);
  }
  return '';
}
/** fe80::xxyy:zzff:fezz:zzzz (EUI-64) -> MAC, '' when the address does not have the ff:fe form */
export function macFromEui64(ip6) {
  const groups = expandIp6(ip6);
  if (!groups || groups[0] !== 'fe80') return '';
  const [a, b, c, d] = groups.slice(4);
  if (b.slice(2) !== 'ff' || c.slice(0, 2) !== 'fe') return '';
  const first = (parseInt(a.slice(0, 2), 16) ^ 0x02).toString(16).padStart(2, '0');
  return normalizeMac(first + a.slice(2) + b.slice(0, 2) + c.slice(2) + d);
}
function expandIp6(ip6) {
  const s = String(ip6 || '').toLowerCase().split('%')[0];
  if (!/^[0-9a-f:]{2,39}$/.test(s) || (s.match(/::/g) || []).length > 1) return null;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0'));
}
/** `ip -6 neigh show dev X` + the output of `ping -6 ff02::1%X` -> [{ipv6, mac}] (link-local addresses only) */
export function parseIp6Neighbours(neighText, pingText = '') {
  const found = new Map();
  for (const line of String(neighText || '').split(/\r?\n/).slice(0, 2048)) {
    const m = /^(fe80:[0-9a-f:]+)\s.*?lladdr\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s.*?(\S+)\s*$/i.exec(line.trim());
    if (m && !/FAILED|INCOMPLETE/i.test(m[3]) && normalizeMac(m[2])) found.set(m[1].toLowerCase(), normalizeMac(m[2]));
  }
  for (const m of String(pingText || '').matchAll(/from\s+(fe80:[0-9a-f:]+)/gi)) {
    const ip = m[1].toLowerCase();
    if (!found.has(ip) && found.size < 2048) found.set(ip, macFromEui64(ip));
  }
  return [...found].filter(([ip]) => expandIp6(ip)).map(([ipv6, mac]) => ({ ipv6, mac }));
}

// ---------------------------------------------------------------------------------------------------
// probe registry
// entry: { id, channel, kind, targets, bindPort?, exclusive?, joinGroup?, listen?, text?, vendorHint, unicastCapable,
//          implemented, evidence: {level, source}, note?, buildRequest(ctx), parseReply(buf, rinfo, ctx), enrich?(...) }
//   kind 'multicast': the request goes to a multicast group on every interface
//   kind 'broadcast': the request goes to 255.255.255.255 and to the directed broadcast address of every interface
//   kind 'passive'  : nothing is sent; `listen` sockets collect what devices send by themselves
//   kind 'unicast'  : per-host probing (channel B) or host tooling (channel D); run by the sweep, listed for the summary
//   bindPort        : source port the protocol requires (0 / absent = any); listen: extra [{port, group?, address?}]
//                     Listeners on ports that host services may use (mDNS 5353, SSDP 1900, WS-Discovery 3702, DHCP 67) are bound to
//                     the group / broadcast address itself, so they only ever receive multicast / broadcast datagrams and can
//                     never take a unicast datagram away from avahi, systemd-resolved, a DHCP client or a DHCP server.
//   text            : replies are text (raw replies are stored as utf8 instead of base64)
// ---------------------------------------------------------------------------------------------------
const BCAST = '255.255.255.255';
const US = 'https://github.com/julienblitte/UniversalScanner';
const placeholder = (id, vendorHint, note, source = US + ' (doc/protocols.html: port only)') => ({
  id, channel: 'A', kind: 'broadcast', targets: [], vendorHint, unicastCapable: false, implemented: false,
  evidence: { level: 'candidate', source }, note,
  buildRequest: () => [], parseReply: () => [],
});

export const PROBES = Object.freeze([
  // ----- A: standard protocols -----
  {
    id: 'onvif', channel: 'A', kind: 'multicast', targets: [{ address: DISCOVERY_GROUP, port: WSD_PORT }], text: true, maxReplies: 3 * DISCOVERY_MAX_REPLIES,
    vendorHint: 'any ONVIF device', unicastCapable: true, implemented: true,
    evidence: { level: 'verified', source: 'ONVIF Core Specification (device discovery, WS-Discovery); in field use since 2026-11-02' },
    // three probes: NetworkVideoTransmitter, tds:Device and one without Types; a reply to the untyped probe that does
    // not look like ONVIF (printers, PCs) is reported as 'wsd-generic' and never as 'onvif'
    buildRequest: (ctx) => {
      ctx.untyped = String(ctx.uuid());
      return [wsDiscoveryProbe(ctx.uuid()), wsDiscoveryProbe(ctx.uuid(), 'tds:Device'), wsDiscoveryProbe(ctx.untyped, '')].map((x) => Buffer.from(x));
    },
    parseReply: (buf, rinfo, ctx) => {
      const xml = buf.toString('utf8');
      const generic = Boolean(ctx.untyped) && tag(xml, 'RelatesTo').toLowerCase().includes(ctx.untyped.toLowerCase());
      return parseWsDiscovery(xml, rinfo.address).map((w) =>
        generic && !looksOnvif(w, xml)
          ? { probe: 'wsd-generic', ip: w.ip, uuid: w.uuid, fields: { types: w.types.slice(0, 8), xaddrs: w.xaddrs.slice(0, 4) } }
          : { ip: w.ip, legacy: { proto: 'wsd', parsed: w } });
    },
  },
  {
    id: 'mdns', channel: 'A', kind: 'multicast', targets: [{ address: '224.0.0.251', port: 5353 }], ttl: 255, maxFollowUps: LIMITS.maxFollowUps,
    vendorHint: 'Axis (_axis-video), HomeKit cameras (_hap), NDI (_ndi), Arecont (_arec), devices announcing _rtsp / _http / _psia / _onvif', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'RFC 6762 / RFC 6763; Axis and Arecont service types: ' + US + ' (Axis.cs, Arecont.cs)' },
    buildRequest: () => mdnsRequest(),
    parseReply: parseMdns,
  },
  {
    id: 'ssdp', channel: 'A', kind: 'multicast', targets: [{ address: DISCOVERY_GROUP, port: 1900 }], text: true,
    vendorHint: 'Axis, Flir, Siqura, Vivotek, Sony, Panasonic, Foscam, D-Link and other UPnP devices', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'UPnP Device Architecture 1.1 (SSDP M-SEARCH, device description)' },
    buildRequest: () => ssdpRequest(),
    parseReply: parseSsdp,
    // the device description is fetched only from the host that answered, plain http, small and with a short timeout
    enrich: async (observations, { io, deadline, now }) => {
      let fetched = 0;
      const seen = new Set();
      for (const o of observations) {
        const loc = o.fields?.location;
        if (!loc || fetched >= LIMITS.maxHttpFetches || now() >= deadline) continue;
        let u;
        try {
          u = new URL(loc);
        } catch {
          continue;
        }
        if (u.protocol !== 'http:' || u.hostname !== o.from || seen.has(u.host)) continue;
        seen.add(u.host);
        fetched++;
        const r = await io.httpGet(loc, { timeoutMs: LIMITS.bannerTimeoutMs, maxBytes: LIMITS.httpBytes }).catch(() => null);
        if (!r || r.status !== 200) continue;
        const d = parseUpnpDescription(r.body);
        for (const x of observations) if (x.from === o.from) x.fields.description = d;
        Object.assign(o, { vendor: d.manufacturer || '', model: d.modelName || d.modelNumber || '', serial: d.serialNumber || '', name: d.friendlyName || '' });
      }
    },
  },
  {
    id: 'gige-vision', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 3956 }],
    vendorHint: 'GigE Vision industrial cameras, some Flir', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'GigE Vision GVCP DISCOVERY_CMD / DISCOVERY_ACK; ' + US + ' (GigEVision.cs); port: https://www.theimagingsource.com/en-us/support/knowledge-base/gigevision-ports/' },
    buildRequest: (ctx) => gvcpRequest(ctx.seq),
    parseReply: parseGvcp,
  },
  // ----- A: vendor protocols -----
  {
    id: 'sadp', channel: 'A', kind: 'multicast', targets: [{ address: DISCOVERY_GROUP, port: SADP_PORT }], bindPort: SADP_PORT, exclusive: true, joinGroup: true, text: true, maxReplies: DISCOVERY_MAX_REPLIES,
    vendorHint: 'Hikvision, HiLook, LTS, Annke, EZVIZ (also not activated / foreign subnet)', unicastCapable: false, implemented: true,
    evidence: { level: 'verified', source: 'captures of real devices, h2z.security/docs/HIKVISION-SADP-ACTIVATE-2026-11-21.md; in field use since 2026-11-02' },
    buildRequest: (ctx) => Buffer.from(sadpProbe(ctx.uuid())),
    parseReply: (buf) => {
      const s = parseSadp(buf.toString('utf8'));
      return s ? [{ ip: s.ip, legacy: { proto: 'sadp', parsed: s } }] : [];
    },
  },
  {
    id: 'dahua-dhdiscover', channel: 'A', kind: 'multicast', targets: [{ address: '239.255.255.251', port: 37810 }],
    vendorHint: 'Dahua, Amcrest, Lorex, Imou (also not initialised)', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/mcw0/DahuaConsole (net.py, DHIP discover); ' + US + ' (Dahua2.cs)' },
    buildRequest: () => dahuaRequest(),
    parseReply: parseDahua,
  },
  {
    id: 'hanwha', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 7701 }], listen: [{ port: 7711 }],
    vendorHint: 'Hanwha, Wisenet, Samsung Techwin', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: US + ' (Hanwha.cs); ports: https://support.hanwhavision.com/hc/en-001/articles/47782302118675' },
    buildRequest: () => hanwhaRequest(),
    parseReply: parseHanwha,
  },
  {
    id: 'bosch', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 1757 }], listen: [{ port: 1758 }],
    vendorHint: 'Bosch', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: US + ' (Bosch.cs); ports: https://jmacfiles.s3.amazonaws.com/MBVXDVR8A-DataSheet.pdf' },
    buildRequest: (ctx) => boschRequest(ctx.seq),
    parseReply: parseBosch,
  },
  {
    id: 'vivotek', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 10000 }],
    vendorHint: 'Vivotek', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: US + ' (Vivotek.cs)' },
    buildRequest: (ctx) => vivotekRequest(ctx.seq),
    parseReply: parseVivotek,
  },
  {
    id: 'sony', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 2380 }], text: false,
    vendorHint: 'Sony', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: US + ' (Sony.cs)' },
    buildRequest: () => sonyRequest(),
    parseReply: parseSony,
  },
  {
    id: 'arecont', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 69 }],
    vendorHint: 'Arecont Vision (no DHCP, no factory address: this is the only way)', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://sales.arecontvision.com/marketing/contents/Arecont%20Vision%20API%20and%20Camera%20Web%20Page%20Manual_2017-06-30_1.pdf (chapter I, Camera Discovery)' },
    buildRequest: () => arecontRequest(),
    parseReply: parseArecont,
  },
  {
    id: 'ubiquiti', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 10001 }], listen: [{ port: 10001, group: '233.89.188.1' }],
    vendorHint: 'Ubiquiti UniFi cameras', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/nmap/nmap/blob/master/scripts/ubiquiti-discovery.nse; port: https://help.ui.com/hc/en-us/articles/218506997-Required-Ports-Reference' },
    buildRequest: () => ubiquitiRequest(),
    parseReply: parseUbiquiti,
  },
  {
    id: 'xiongmai-dvrip', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 34569 }], bindPort: 34569, text: false,
    vendorHint: 'XiongMai-based white-label cameras and recorders', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/AlexxIT/go2rtc/blob/master/internal/dvrip/dvrip.go' },
    buildRequest: () => dvripRequest(),
    parseReply: parseDvrip,
  },
  {
    id: 'tplink-kasa', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 9999 }],
    vendorHint: 'TP-Link Kasa (legacy protocol)', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/python-kasa/python-kasa (kasa/discover.py, kasa/transports/xortransport.py); https://python-kasa.readthedocs.io/en/stable/discover.html' },
    buildRequest: () => kasaRequest(),
    parseReply: parseKasa,
  },
  {
    id: 'tplink-tapo', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 20002 }],
    vendorHint: 'TP-Link Tapo, VIGI, newer Kasa (also with RTSP switched off)', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/python-kasa/python-kasa (kasa/discover.py DISCOVERY_QUERY_2, reply JSON after a 16-byte header); port: https://www.tapo.com/en/faqs/network-ports-used-by-services' },
    buildRequest: () => tapoRequest(),
    parseReply: parseTapo,
  },
  {
    id: 'reolink', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 2000 }], listen: [{ port: 3000 }],
    vendorHint: 'Reolink', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/thirtythreeforty/neolink/blob/master/dissector/udp.md (request aaaa0000 on 2000, binary reply on 3000; reply layout not documented)' },
    note: 'The reply layout is undocumented: the sender address identifies the camera, printable strings are reported as hints.',
    buildRequest: () => reolinkRequest(),
    parseReply: parseReolink,
  },
  {
    id: 'pppp', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 32108 }],
    vendorHint: 'cheap P2P cameras (CS2 / iLnk / PPPP: Yi, A9, X5 ...); cloud type, reported so the user knows why it cannot be added', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/DavidVentura/cam-reverse (LanSearch f130 / PunchPkt f141); https://palant.info/2025/11/05/an-overview-of-the-pppp-protocol-for-iot-cameras' },
    note: 'Only the unencrypted variant; devices that obfuscate the whole message (CS2 P2P_Proprietary_Encrypt) do not match.',
    buildRequest: () => ppppRequest(),
    parseReply: parsePppp,
  },
  {
    id: 'vstarcam', channel: 'A', kind: 'broadcast', targets: [{ address: BCAST, port: 8600 }], listen: [{ port: 8600 }],
    vendorHint: 'VStarcam and white-label cameras of the same platform', unicastCapable: true, implemented: true,
    evidence: { level: 'documented', source: US + ' (Vstarcam.cs)' },
    buildRequest: () => vstarcamRequest(),
    parseReply: parseVstarcam,
  },
  // ----- A: placeholders (wire format not confirmed here; never sent) -----
  placeholder('tplink-tapo-20015', 'TP-Link Tapo cameras / hubs (UDP 20015, 21112)', 'Ports are listed by the vendor, the wire format is not public. Covered meanwhile by tplink-tapo (20002), onvif, B.', 'https://www.tapo.com/en/faqs/network-ports-used-by-services'),
  placeholder('dahua-v1', 'Dahua legacy (UDP 5050)', 'Old fixed binary protocol; DHDiscover (37810) covers current firmware. Covered meanwhile by dahua-dhdiscover, onvif, B (37777).', 'https://github.com/mcw0/DahuaConsole (net.py); ' + US + ' (Dahua1.cs)'),
  placeholder('axis-proprietary', 'Axis', 'No separate proprietary UDP protocol confirmed: the reference implementation finds Axis through mDNS. Covered by mdns (_axis-video._tcp), ssdp, onvif.'),
  placeholder('panasonic', 'Panasonic, i-PRO (UDP 10669 -> 10670)', 'Type-length-value format not re-verified against a second source. Covered meanwhile by ssdp, onvif, B.'),
  placeholder('foscam', 'Foscam (UDP 10000)', 'Fixed binary format with optional XOR obfuscation, not re-verified. Covered meanwhile by ssdp, onvif, B.'),
  placeholder('360vision', '360 Vision (UDP 3600)', 'Text format not re-verified. Covered meanwhile by onvif, B.'),
  placeholder('nicevision', 'NiceVision (UDP 2007)', 'Fixed binary format not re-verified. Covered meanwhile by onvif, B.'),
  placeholder('uniview-proprietary', 'Uniview (possibly UDP 3705 / 3707)', 'No public description of the proprietary search. Covered meanwhile by onvif, D (factory address 192.168.1.13), B.', 'https://support.visiotechsecurity.com/hc/en-us/articles/360016233540'),
  placeholder('tvt', 'TVT', 'No public description found. Covered meanwhile by onvif, B.', 'none'),
  placeholder('tiandy', 'Tiandy', 'No public description found. Covered meanwhile by onvif, B.', 'none'),
  placeholder('jovision', 'Jovision', 'No public description found. Covered meanwhile by onvif, B.', 'none'),
  placeholder('milesight', 'Milesight', 'No public description found. Covered meanwhile by onvif, B.', 'none'),
  placeholder('geovision', 'GeoVision', 'No public description found. Covered meanwhile by onvif, ssdp, B.', 'none'),
  placeholder('acti', 'ACTi', 'No public description found. Covered meanwhile by onvif, ssdp, B.', 'none'),
  // ----- B: one address at a time (run by the sweep) -----
  { id: 'arp-sweep', channel: 'B', kind: 'unicast', targets: [], vendorHint: 'every on-link IPv4 host', unicastCapable: true, implemented: true, evidence: { level: 'verified', source: 'same technique as POST /v1/l2-scan (kernel ARP + /proc/net/arp)' }, buildRequest: () => [], parseReply: () => [] },
  { id: 'tcp-ports', channel: 'B', kind: 'unicast', targets: [], vendorHint: 'any device with an open camera-related port', unicastCapable: true, implemented: true, evidence: { level: 'documented', source: 'PLAN-2026-11-23-CAMERA-ONBOARDING.md section 2.2 (port list)' }, buildRequest: () => [], parseReply: () => [] },
  { id: 'http-banner', channel: 'B', kind: 'unicast', targets: [], vendorHint: 'any device with a web interface', unicastCapable: true, implemented: true, evidence: { level: 'documented', source: 'RFC 9110 (GET /, no credentials)' }, buildRequest: () => [], parseReply: () => [] },
  { id: 'rtsp-options', channel: 'B', kind: 'unicast', targets: [], vendorHint: 'any RTSP server', unicastCapable: true, implemented: true, evidence: { level: 'documented', source: 'RFC 2326 (OPTIONS, no credentials)' }, buildRequest: () => [], parseReply: () => [] },
  { id: 'onvif-unicast', channel: 'B', kind: 'unicast', targets: [], vendorHint: 'ONVIF devices behind a router', unicastCapable: true, implemented: true, evidence: { level: 'documented', source: 'ONVIF Core Specification: GetSystemDateAndTime needs no authentication' }, buildRequest: () => [], parseReply: () => [] },
  { id: 'snmp-sysdescr', channel: 'B', kind: 'unicast', targets: [], vendorHint: 'devices with SNMP enabled', unicastCapable: true, implemented: false, evidence: { level: 'candidate', source: 'RFC 1157' }, note: 'Not implemented: needs an ASN.1 BER codec; most cameras ship with SNMP off. Covered by http-banner / rtsp-options.', buildRequest: () => [], parseReply: () => [] },
  // ----- C: passive -----
  {
    id: 'wsd-hello', channel: 'C', kind: 'passive', listen: [{ port: WSD_PORT, group: DISCOVERY_GROUP, address: DISCOVERY_GROUP }], targets: [], text: true,
    vendorHint: 'ONVIF / WSD devices that have just come online', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: 'WS-Discovery 1.0 (Hello)' },
    buildRequest: () => [],
    parseReply: (buf, rinfo) => parseWsDiscovery(buf.toString('utf8'), rinfo.address, 'Hello').map((w) => ({ ip: w.ip, uuid: w.uuid, mac: w.mac, name: w.name, model: w.hardware, vendor: w.manufacturer, fields: { types: w.types.slice(0, 8), xaddrs: w.xaddrs.slice(0, 4) } })),
  },
  {
    id: 'mdns-announce', channel: 'C', kind: 'passive', listen: [{ port: 5353, group: '224.0.0.251', address: '224.0.0.251' }], targets: [],
    vendorHint: 'devices announcing DNS-SD services', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: 'RFC 6762 (unsolicited responses)' },
    buildRequest: () => [],
    parseReply: (buf, rinfo) => parseMdns(buf, rinfo, { asked: new Set() }).filter((o) => !o.skip).map((o) => ({ ...o, followUp: [] })),
  },
  {
    id: 'ssdp-notify', channel: 'C', kind: 'passive', listen: [{ port: 1900, group: DISCOVERY_GROUP, address: DISCOVERY_GROUP }], targets: [], text: true,
    vendorHint: 'UPnP devices announcing themselves', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: 'UPnP Device Architecture 1.1 (NOTIFY ssdp:alive)' },
    buildRequest: () => [],
    parseReply: (buf) => parseSsdp(buf).filter((o) => o.fields.notify),
  },
  {
    id: 'tuya-beacon', channel: 'C', kind: 'passive', listen: [{ port: 6666 }, { port: 6667 }], targets: [],
    vendorHint: 'Tuya / Smart Life cloud cameras (flagged as cloud type, never decrypted)', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: 'https://github.com/jasonacox/tinytuya (core/const.py UDPPORT 6666 / UDPPORTS 6667, core/header.py frame prefix); https://www.netify.ai/documentation/agent/protocols/catalog/tuya-lan' },
    buildRequest: () => [],
    parseReply: parseTuya,
  },
  {
    id: 'dhcp-fingerprint', channel: 'C', kind: 'passive', listen: [{ port: 67, address: BCAST }], targets: [],
    vendorHint: 'any device asking for an address (option 12 host name, 60 vendor class, 55 parameter list)', unicastCapable: false, implemented: true,
    evidence: { level: 'documented', source: 'RFC 2131 / RFC 2132' },
    note: 'The socket is bound to 255.255.255.255:67 so only broadcasts are delivered to it (unicast DHCP traffic of the host is never taken); nothing is ever sent. Skipped while an excluded network (maintenance hotspot) is active on the host, because its clients cannot be told apart.',
    buildRequest: () => [],
    parseReply: parseDhcp,
  },
  { id: 'arp-listen', channel: 'C', kind: 'passive', targets: [], vendorHint: 'every host', unicastCapable: false, implemented: false, evidence: { level: 'candidate', source: 'RFC 826' }, note: 'Not implemented: capturing ARP frames needs a raw (AF_PACKET) socket, which plain Node does not have. The kernel neighbour table is read instead (arp-sweep, link-local-v4).', buildRequest: () => [], parseReply: () => [] },
  { id: 'lldp-listen', channel: 'C', kind: 'passive', targets: [], vendorHint: 'PoE cameras that send LLDP', unicastCapable: false, implemented: false, evidence: { level: 'candidate', source: 'IEEE 802.1AB' }, note: 'Not implemented: LLDP frames need a raw (AF_PACKET) socket or lldpd on the host. Switch-side LLDP is read by the backend (channel E).', buildRequest: () => [], parseReply: () => [] },
  // ----- D: layer 2 only -----
  { id: 'factory-arp', channel: 'D', kind: 'unicast', targets: [], vendorHint: 'devices still at their factory address in a foreign subnet', unicastCapable: true, implemented: true, evidence: { level: 'documented', source: 'RFC 826 / RFC 5227 through `arping` on the host (iputils-arping, part of H2Z OS); kernel ARP when the host has an address in that subnet (H2Z_FALLBACK_ADDRESS)' }, note: 'Without `arping` on the host only factory subnets the host has an address in are probed.', buildRequest: () => [], parseReply: () => [] },
  { id: 'link-local-v4', channel: 'D', kind: 'unicast', targets: [], vendorHint: 'devices that fell back to 169.254/16', unicastCapable: false, implemented: true, evidence: { level: 'documented', source: 'RFC 3927; kernel neighbour table' }, note: 'Only neighbours the kernel already knows are listed; 169.254/16 is not swept (65k addresses).', buildRequest: () => [], parseReply: () => [] },
  { id: 'ipv6-all-nodes', channel: 'D', kind: 'unicast', targets: [], vendorHint: 'every IPv6-enabled device on the link, whatever its IPv4 configuration', unicastCapable: false, implemented: true, evidence: { level: 'documented', source: 'RFC 4291 (ff02::1), RFC 4443 echo through `ping -6` on the host; MAC from the neighbour table or the EUI-64 address' }, buildRequest: () => [], parseReply: () => [] },
]);

export const CHANNELS = Object.freeze(['A', 'B', 'C', 'D']);

// ---------------------------------------------------------------------------------------------------
// request options
// ---------------------------------------------------------------------------------------------------
/** validate the body of POST /v1/cameras/discover; throws DiscoveryError('E_PARAM') */
export function validateOptions(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const seconds = b.seconds === undefined || b.seconds === null || b.seconds === '' ? 3 : Number(b.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) throw bad('The search duration must be between 1 and 10 seconds');
  const list = (v, name, max) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw bad(`${name} must be an array`);
    if (v.length > max) throw bad(`${name} accepts at most ${max} entries`);
    return v;
  };
  const exclude = (Array.isArray(b.exclude) ? b.exclude : []).slice(0, 32).map(String).filter((c) => cidrParts(c));
  const extraCidrs = list(b.extraCidrs, 'extraCidrs', LIMITS.maxCidrs).map((c) => {
    if (!cidrParts(c)) throw bad(`Wrong subnet format: ${clip(c, 40)}`);
    return String(c).trim();
  });
  const factoryIps = b.factoryIps === undefined || b.factoryIps === null ? null : uniq(list(b.factoryIps, 'factoryIps', LIMITS.maxFactoryIps).map((ip) => {
    const ok = usableIp(ip);
    if (!ok) throw bad(`Wrong factory address: ${clip(ip, 40)}`);
    return ok;
  }));
  const channels = b.channels === undefined || b.channels === null ? [...CHANNELS] : uniq(list(b.channels, 'channels', 8).map((c) => {
    const ch = String(c).toUpperCase();
    if (!CHANNELS.includes(ch)) throw bad(`Unknown discovery channel: ${clip(c, 16)} (use A, B, C, D)`);
    return ch;
  }));
  const ports = b.ports === undefined || b.ports === null ? null : uniq(list(b.ports, 'ports', LIMITS.maxPorts).map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(`Wrong port: ${clip(p, 16)}`);
    return n;
  }));
  return { seconds, exclude, extraCidrs, factoryIps, channels, ports };
}

/**
 * Networks the sweep may touch. Same limits as planL2Scan of host-agent.mjs: at most /22 per network and
 * LIMITS.maxSweepAddresses in total. Excluded networks (maintenance hotspot, caller excludes) are skipped.
 * -> {onLink: [{cidr, net, size, iface}], routed: [{cidr, net, size}], skipped: [{cidr, reason}]}
 */
export function planSweep({ ifaces = [], extraCidrs = [], excluded = [] } = {}) {
  const ex = excluded.map(cidrParts).filter(Boolean);
  const onLink = [];
  const routed = [];
  const skipped = [];
  let total = 0;
  const take = (list, entry, cidr) => {
    if (total + entry.size > LIMITS.maxSweepAddresses) return void skipped.push({ cidr, reason: 'request-too-large' });
    total += entry.size;
    list.push(entry);
  };
  for (const f of ifaces) {
    const c = cidrParts(f.cidr);
    if (!c) continue;
    const cidr = intToIp(c.net) + '/' + c.prefix;
    if (onLink.some((t) => t.cidr === cidr)) continue;
    if (ex.some((e) => overlapNet(c, e))) skipped.push({ cidr, reason: 'excluded' });
    else if (c.prefix < LIMITS.minPrefix) skipped.push({ cidr, reason: 'too-large' });
    else take(onLink, { cidr, net: c.net, size: c.size, iface: f.iface }, cidr);
  }
  const attached = ifaces.map((f) => cidrParts(f.cidr)).filter(Boolean);
  for (const raw of extraCidrs.slice(0, LIMITS.maxCidrs)) {
    const c = cidrParts(raw);
    const cidr = String(raw);
    if (!c) continue;
    if (ex.some((e) => overlapNet(c, e))) skipped.push({ cidr, reason: 'excluded' });
    else if (c.prefix < LIMITS.minPrefix) skipped.push({ cidr, reason: 'too-large' });
    else if (attached.some((a) => overlapNet(a, c))) skipped.push({ cidr, reason: 'on-link' }); // already covered by the ARP sweep
    else take(routed, { cidr: intToIp(c.net) + '/' + c.prefix, net: c.net, size: c.size }, cidr);
  }
  return { onLink, routed, skipped };
}

// ---------------------------------------------------------------------------------------------------
// banner parsers (channel B)
// ---------------------------------------------------------------------------------------------------
/** HTTP response -> the unauthenticated facts that identify a device */
export function httpSignal(port, r) {
  const h = r.headers || {};
  const one = (v) => clip(Array.isArray(v) ? v[0] : v, 160);
  const auth = one(h['www-authenticate']);
  const realm = /realm="([^"]{0,120})"/i.exec(auth);
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(String(r.body || ''));
  const o = { port, status: Number(r.status) || 0 };
  if (h.server) o.server = one(h.server);
  if (auth) o.auth = clip(auth.split(/\s+/)[0], 16);
  if (realm) o.realm = clip(realm[1]);
  if (title) o.title = clip(title[1].replace(/\s+/g, ' '));
  if (h['axis-setup'] !== undefined) o.axisSetup = one(h['axis-setup']) || true;
  if (h.location) o.location = one(h.location);
  if (r.cert && (r.cert.cn || r.cert.o)) o.tls = { cn: clip(r.cert.cn, 96), o: clip(r.cert.o, 96) };
  return o;
}
/** RTSP response to OPTIONS -> {port, status, server?, public?} or null */
export function rtspSignal(port, text) {
  const m = /^RTSP\/1\.0 (\d{3})/.exec(String(text || ''));
  if (!m) return null;
  const o = { port, status: Number(m[1]) };
  const server = /^Server:\s*(.+)$/im.exec(text);
  const pub = /^Public:\s*(.+)$/im.exec(text);
  if (server) o.server = clip(server[1], 160);
  if (pub) o.public = clip(pub[1], 160);
  return o;
}
export const onvifDateRequest = () =>
  '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>';

// ---------------------------------------------------------------------------------------------------
// default I/O (replaced by fakes in the tests)
// ---------------------------------------------------------------------------------------------------
function defaultIo() {
  return {
    createSocket: (opts) => dgram.createSocket(opts),
    /** -> 'open' | 'refused' | 'timeout' */
    tcpProbe: (ip, port, timeoutMs) =>
      new Promise((resolve) => {
        const sock = net.connect({ host: ip, port, timeout: timeoutMs });
        const done = (v) => {
          sock.destroy();
          resolve(v);
        };
        sock.once('connect', () => done('open'));
        sock.once('timeout', () => done('timeout'));
        sock.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'));
      }),
    /** RTSP OPTIONS -> response text ('' on failure) */
    rtspOptions: (ip, port, timeoutMs) =>
      new Promise((resolve) => {
        const sock = net.connect({ host: ip, port, timeout: timeoutMs });
        let data = '';
        const done = () => {
          sock.destroy();
          resolve(data);
        };
        const timer = setTimeout(done, timeoutMs);
        sock.once('connect', () => sock.write(`OPTIONS rtsp://${ip}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: h2z-discovery\r\n\r\n`));
        sock.on('data', (c) => {
          data += c.toString('latin1');
          if (data.length > 2048 || data.includes('\r\n\r\n')) {
            clearTimeout(timer);
            done();
          }
        });
        sock.once('timeout', () => { clearTimeout(timer); done(); });
        sock.once('error', () => { clearTimeout(timer); done(); });
        sock.once('close', () => { clearTimeout(timer); resolve(data); });
      }),
    /** one HTTP(S) request without credentials -> {status, headers, body, cert?}; rejects on failure. Redirects are not followed. */
    httpGet: (url, { method = 'GET', body = null, headers = {}, timeoutMs = 1500, maxBytes = 16 << 10 } = {}) =>
      new Promise((resolve, reject) => {
        const u = new URL(url);
        const tls = u.protocol === 'https:';
        if (ipToInt(u.hostname) === null) return void reject(new Error('address literals only'));
        const req = (tls ? https : http).request(
          // certificate verification is off on purpose: cameras use self-signed certificates and nothing secret is sent
          { host: u.hostname, port: Number(u.port) || (tls ? 443 : 80), path: u.pathname + u.search, method, agent: false, timeout: timeoutMs, rejectUnauthorized: false, headers: { 'User-Agent': 'h2z-discovery', Connection: 'close', ...headers } },
          (res) => {
            let cert = null;
            try {
              const c = tls ? res.socket.getPeerCertificate() : null;
              if (c && c.subject) cert = { cn: String(c.subject.CN || ''), o: String(c.subject.O || '') };
            } catch { /* no certificate details */ }
            const chunks = [];
            let size = 0;
            const finish = () => {
              clearTimeout(timer);
              resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), cert });
              req.destroy();
            };
            res.on('data', (c) => {
              size += c.length;
              if (size <= maxBytes) chunks.push(c);
              else finish();
            });
            res.on('end', finish);
            res.on('error', finish);
          },
        );
        const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs + 200);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        req.end(body || undefined);
      }),
  };
}

/** run `fn` over `items` with a concurrency limit, a minimum gap between starts and a deadline; returns how many were started */
async function pool(items, limit, fn, { gapMs = 0, deadline = Infinity, now = Date.now, sleep }) {
  let next = 0;
  let started = 0;
  let gate = Promise.resolve();
  const worker = async () => {
    for (;;) {
      // serialise the "take the next item" step so the gap applies across workers
      const turn = gate.then(async () => {
        if (next >= items.length || now() >= deadline) return null;
        const item = items[next++];
        started++;
        if (gapMs) await sleep(gapMs);
        return { item };
      });
      gate = turn.catch(() => null);
      const t = await turn;
      if (!t) return;
      await fn(t.item).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return started;
}

// ---------------------------------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------------------------------
const rawOf = (buf, text) => {
  const part = buf.subarray(0, LIMITS.rawBytes);
  const s = text ? part.toString('utf8') : '';
  return text && !s.includes('�') ? { encoding: 'utf8', data: s, truncated: buf.length > part.length } : { encoding: 'base64', data: part.toString('base64'), truncated: buf.length > part.length };
};

/**
 * Observations of every channel -> {devices, candidates, unaddressed}.
 * The WS-Discovery / SADP part goes through mergeDiscovered unchanged; the other observations are folded in by
 * MAC, then ONVIF UUID, then IP. `devices` keeps today's meaning (seen by ONVIF or SADP), everything else is a
 * candidate; observations without an IPv4 address that match no device by MAC are `unaddressed`.
 */
export function mergeObservations(observations, { excluded = [], arp = [] } = {}) {
  const legacy = observations.filter((o) => o.legacy);
  const devices = mergeDiscovered(legacy.filter((o) => o.legacy.proto === 'wsd').map((o) => o.legacy.parsed), legacy.filter((o) => o.legacy.proto === 'sadp').map((o) => o.legacy.parsed), { excluded });
  const unaddressed = [];
  const find = (d) => devices.find((x) => (d.mac && x.mac === d.mac) || (d.uuid && x.onvif?.uuid === d.uuid) || (d.ip && x.ip === d.ip));
  const touch = (d, o) => {
    d.channels = uniq([...(d.channels || []), o.channel]).sort();
    d.signals ||= {};
    if (o.raw && (d.raw ||= []).length < LIMITS.rawPerDevice && !d.raw.some((r) => r.probe === o.probe && r.data === o.raw.data)) d.raw.push({ probe: o.probe, ...o.raw });
    if (o.cloudType && !d.cloudType) d.cloudType = o.cloudType;
  };
  // legacy observations: channels / raw only (their fields are already in the device)
  for (const o of legacy) {
    const key = o.legacy.proto === 'sadp' ? { mac: o.legacy.parsed.mac, ip: o.legacy.parsed.ip } : { mac: o.legacy.parsed.mac, uuid: o.legacy.parsed.uuid, ip: o.legacy.parsed.ip };
    const d = find(key);
    if (d) touch(d, o);
  }
  const rest = observations.filter((o) => !o.legacy);
  // observations with an address first, so MAC-only ones (DHCP, IPv6) can attach to them
  for (const o of [...rest.filter((x) => x.ip), ...rest.filter((x) => !x.ip)]) {
    if (o.ip && inAnyCidr(o.ip, excluded)) continue;
    let d = find(o);
    if (!d && !o.ip) {
      if (!o.mac || unaddressed.length >= LIMITS.maxDevices) continue;
      let u = unaddressed.find((x) => x.mac === o.mac);
      if (!u) unaddressed.push((u = { mac: o.mac, sources: [], channels: [], signals: { oui: o.mac.replace(/:/g, '').slice(0, 6) } }));
      d = u;
    } else if (!d) {
      if (devices.length >= LIMITS.maxDevices) continue;
      devices.push((d = { ip: o.ip, mac: o.mac || '', vendor: '', model: '', serial: '', name: '', sources: [], onvif: null, sadp: null }));
    }
    touch(d, o);
    if (!d.sources.includes(o.probe)) d.sources.push(o.probe);
    if ('ip' in d) {
      d.mac = d.mac || o.mac || '';
      for (const k of ['vendor', 'model', 'serial', 'name']) if (!d[k] && o[k]) d[k] = clip(o[k]);
    }
    const s = d.signals;
    if (o.signal) {
      for (const [k, v] of Object.entries(o.signal)) {
        if (Array.isArray(v)) s[k] = [...(s[k] || []), ...v].slice(0, 32);
        else s[k] = v;
      }
    } else if (o.fields && o.probe.startsWith('mdns')) {
      const m = (s.mdns ||= { services: [], instances: [], txt: {}, addresses: [] });
      m.services = uniq([...m.services, ...(o.fields.services || [])]).slice(0, 32);
      for (const i of o.fields.instances || []) if (m.instances.length < 16 && !m.instances.some((x) => x.type === i.type && x.name === i.name && x.port === i.port)) m.instances.push(i);
      m.txt = { ...m.txt, ...(o.fields.txt || {}) };
      m.addresses = uniq([...m.addresses, ...(o.fields.addresses || [])]).slice(0, 8);
      if (o.fields.hapCategory) m.hapCategory = o.fields.hapCategory;
    } else if (o.fields && o.probe.startsWith('ssdp')) {
      const m = (s.ssdp ||= { server: '', location: '', st: [], usn: [] });
      m.server = m.server || o.fields.server || '';
      m.location = m.location || o.fields.location || '';
      if (o.fields.st) m.st = uniq([...m.st, o.fields.st]).slice(0, 16);
      if (o.fields.usn) m.usn = uniq([...m.usn, o.fields.usn]).slice(0, 16);
      if (o.fields.description) m.description = o.fields.description;
    } else if (o.fields) (s.probes ||= {})[o.probe] = { ...(s.probes?.[o.probe] || {}), ...o.fields };
  }
  // MAC from the kernel neighbour table for devices that did not report one (as before)
  const arpMap = new Map(arp.map((n) => [n.ip, n.mac]));
  for (const d of devices) if (!d.mac && arpMap.has(d.ip)) Object.assign(d, { mac: arpMap.get(d.ip), macFrom: 'arp' });
  // an unaddressed sighting whose MAC became known through ARP belongs to that device
  for (let i = unaddressed.length - 1; i >= 0; i--) {
    const u = unaddressed[i];
    const d = devices.find((x) => x.mac && x.mac === u.mac);
    if (!d) continue;
    d.sources.push(...u.sources.filter((x) => !d.sources.includes(x)));
    d.channels = uniq([...(d.channels || []), ...u.channels]).sort();
    d.signals = { ...u.signals, ...(d.signals || {}), probes: { ...(u.signals.probes || {}), ...(d.signals?.probes || {}) } };
    if (u.raw) d.raw = [...(d.raw || []), ...u.raw].slice(0, LIMITS.rawPerDevice);
    unaddressed.splice(i, 1);
  }
  for (const d of devices) if (d.mac && d.signals) d.signals.oui = d.mac.replace(/:/g, '').slice(0, 6);
  devices.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  const isLegacy = (d) => d.sources.includes('onvif') || d.sources.includes('sadp');
  return { devices: devices.filter(isLegacy), candidates: devices.filter((d) => !isLegacy(d)), unaddressed };
}

// ---------------------------------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------------------------------
/**
 * createCameraDiscovery({ netIfs, host, readArp, sleep, now, uuid, io, legacyMulticast, apNetwork, log })
 *   netIfs()           os.networkInterfaces()-shaped object
 *   host(cmd, args, {timeout})  runs a tool on the host (arping, ping, ip); rejects with err.stdout on a non-zero exit
 *   readArp()          text of /proc/net/arp
 *   legacyMulticast    the old `multicast` hook of host-agent.mjs ({ifaces, wsdProbes, sadpProbe, seconds} -> [{proto, from, data}]):
 *                      when given, ONLY the ONVIF + SADP exchange runs, through that hook (used by existing tests)
 * returns { discover(body, {excluded?, ifaces?}) }.
 */
export function createCameraDiscovery(o = {}) {
  const netIfs = o.netIfs || (() => ({}));
  const host = o.host || (async () => { throw new Error('no host tooling'); });
  const readArp = o.readArp || (async () => '');
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || (() => Date.now());
  const newUuid = o.uuid || (() => randomUUID());
  const io = { ...defaultIo(), ...(o.io || {}) };
  const log = o.log || ((msg) => console.error('host-agent: discovery: ' + msg));
  const registry = o.probes || PROBES;
  const heavyIntervalMs = o.heavyIntervalMs ?? LIMITS.heavyIntervalMs;
  let heavy = null; // last result of channels B / D: {key, at, observations, sweep, layer2}
  let seq = 0;

  const summaryOf = () => new Map(registry.map((p) => [p.id, { id: p.id, channel: p.channel, kind: p.kind, implemented: p.implemented, evidence: p.evidence.level, sent: 0, replies: 0 }]));

  /** channels A and C: every active probe on every interface plus the passive listeners, for `seconds` */
  async function runUdp({ entries, ifaces, seconds, accept, summary, deadline, observations }) {
    const sockets = [];
    const senders = []; // () => void, one per (probe, socket, target)
    const state = { total: 0, dropped: 0, parseErrors: 0 };
    const ctxOf = new Map();
    const fail = (entry, e) => {
      const s = summary.get(entry.id);
      if (!s.error) s.error = clip(e?.message || e, 160);
    };
    const onMessage = (entry, sock, msg, rinfo, localPort) => {
      const s = summary.get(entry.id);
      if (msg.length > LIMITS.maxReply || state.total >= LIMITS.maxRepliesTotal || s.replies >= (entry.maxReplies || LIMITS.maxRepliesPerProbe)) return void state.dropped++;
      if (!accept(rinfo.address)) return;
      let found;
      try {
        found = entry.parseReply(msg, { address: rinfo.address, port: rinfo.port, localPort }, ctxOf.get(entry.id)) || [];
      } catch {
        state.parseErrors++; // a parser must never take the agent down
        return;
      }
      if (!found.length) return;
      state.total++;
      s.replies++;
      const raw = rawOf(msg, entry.text);
      for (const f of found.slice(0, 16)) {
        const ctx = ctxOf.get(entry.id);
        for (const q of f.followUp || []) {
          if (ctx.followUps >= (entry.maxFollowUps || 0) || !entry.targets[0]) break;
          ctx.followUps++;
          try {
            sock.send(q, entry.targets[0].port, entry.targets[0].address, () => {});
            s.sent++;
          } catch { /* socket closed */ }
        }
        if (f.skip) continue;
        observations.push({ ...f, followUp: undefined, probe: f.probe || entry.id, channel: entry.channel, ip: f.ip || usableIp(rinfo.address), from: rinfo.address, raw });
      }
    };
    const open = (entry, port, { address, reuseAddr = true } = {}) =>
      new Promise((resolve) => {
        let sock;
        let settled = false;
        const settle = (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        try {
          sock = io.createSocket({ type: 'udp4', reuseAddr });
        } catch (e) {
          fail(entry, e);
          return void resolve(null);
        }
        sockets.push(sock);
        sock.on('error', (e) => {
          fail(entry, e);
          settle(null);
        });
        sock.on('message', (msg, rinfo) => onMessage(entry, sock, msg, rinfo, port));
        try {
          if (address) sock.bind(port, address, () => settle(sock));
          else sock.bind(port, () => settle(sock));
        } catch (e) {
          fail(entry, e);
          settle(null);
        }
      });
    const tryDo = (fn) => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    const directed = (f) => {
      const c = cidrParts(f.cidr);
      return c && c.prefix <= 30 ? intToIp((c.net + c.size - 1) >>> 0) : '';
    };
    try {
      for (const entry of entries) {
        const s = summary.get(entry.id);
        const ctx = { uuid: newUuid, seq: (++seq & 0xff) || 1, followUps: 0 };
        ctxOf.set(entry.id, ctx);
        let requests = [];
        if (entry.kind !== 'passive') {
          try {
            const built = entry.buildRequest(ctx);
            requests = (Array.isArray(built) ? built : [built]).filter((b) => Buffer.isBuffer(b) && b.length);
          } catch (e) {
            fail(entry, e);
            continue;
          }
        }
        const sendOn = (sock, address, port) => senders.push(() => requests.forEach((r) => tryDo(() => sock.send(r, port, address, () => {})) && s.sent++));
        if (entry.kind === 'multicast' && entry.bindPort) {
          // one socket on the protocol's own port, member of the group on every interface (SADP)
          const sock = await open(entry, entry.bindPort, { reuseAddr: !entry.exclusive });
          if (sock) {
            tryDo(() => sock.setMulticastTTL(entry.ttl || 1));
            const joined = entry.joinGroup ? ifaces.filter((f) => tryDo(() => sock.addMembership(entry.targets[0].address, f.ip))) : ifaces;
            for (const t of entry.targets) for (const f of joined) senders.push(() => tryDo(() => sock.setMulticastInterface(f.ip)) && requests.forEach((r) => tryDo(() => sock.send(r, t.port, t.address, () => {})) && s.sent++));
          }
        } else if (entry.kind === 'multicast') {
          // one socket per interface on a random port; replies come back unicast
          for (const f of ifaces) {
            const sock = await open(entry, 0, { reuseAddr: false });
            if (!sock) continue;
            if (!tryDo(() => { sock.setMulticastInterface(f.ip); sock.setMulticastTTL(entry.ttl || 1); })) {
              log(`${f.iface} cannot send multicast`);
              continue;
            }
            for (const t of entry.targets) sendOn(sock, t.address, t.port);
          }
        } else if (entry.kind === 'broadcast') {
          // limited broadcast from a socket bound to each interface address (reaches devices in a foreign subnet) ...
          for (const f of ifaces) {
            const sock = await open(entry, 0, { address: f.ip, reuseAddr: false });
            if (!sock || !tryDo(() => sock.setBroadcast(true))) continue;
            for (const t of entry.targets) sendOn(sock, t.address, t.port);
          }
          // ... and directed broadcasts from one wildcard socket, which also receives replies sent to the broadcast address
          const shared = await open(entry, entry.bindPort || 0, { reuseAddr: true });
          if (shared && tryDo(() => shared.setBroadcast(true))) for (const t of entry.targets) for (const f of ifaces) if (directed(f)) sendOn(shared, directed(f), t.port);
        }
        for (const l of entry.listen || []) {
          const sock = await open(entry, l.port, { address: l.address, reuseAddr: true });
          if (sock && l.group) for (const f of ifaces) tryDo(() => sock.addMembership(l.group, f.ip));
        }
      }
      const sendAll = () => senders.forEach((fn) => fn());
      const first = Math.min(1000, seconds * 400);
      sendAll();
      await sleep(first);
      sendAll(); // UDP may be lost: everything is sent twice
      await sleep(Math.max(0, seconds * 1000 - first));
      for (const entry of entries) {
        if (!entry.enrich) continue;
        await entry.enrich(observations.filter((x) => x.probe === entry.id), { io, deadline, now }).catch(() => null);
      }
      if (state.dropped) log(`dropped ${state.dropped} oversized or excess replies`);
    } finally {
      for (const sock of sockets) tryDo(() => sock.close());
    }
    return state;
  }

  /** kernel ARP for a list of on-link addresses: one tiny datagram to the discard port each, then read the table */
  async function arpTouch(ips, { stopAt, settleMs }) {
    let sock;
    let sent = 0;
    try {
      sock = io.createSocket({ type: 'udp4' });
      sock.on('error', () => {});
      for (const ip of ips) {
        if (now() >= stopAt) break;
        await new Promise((resolve) => {
          try {
            sock.send(Buffer.from('h2z'), 9, ip, () => resolve());
          } catch {
            resolve();
          }
        });
        sent++;
        await sleep(LIMITS.arpGapMs);
      }
      if (sent) await sleep(settleMs);
    } catch { /* no socket: nothing probed */ } finally {
      try { sock?.close(); } catch { /* closed */ }
    }
    return sent;
  }
  const arpEntries = async (ifaces) => {
    const names = new Set(ifaces.map((f) => f.iface));
    try {
      return parseArpTable(await readArp()).filter((n) => names.has(n.iface));
    } catch {
      return [];
    }
  };

  /** channel B */
  async function runSweep({ ifaces, excluded, opts, ownIps, summary, deadline, observations, udpEntries, accept }) {
    const plan = planSweep({ ifaces, extraCidrs: opts.extraCidrs, excluded });
    const out = { scanned: [...plan.onLink, ...plan.routed].map((t) => t.cidr), skipped: plan.skipped, arpProbed: 0, alive: 0, portHosts: 0, truncated: false };
    const ports = opts.ports || DEFAULT_PORTS;
    // 1. alive hosts: ARP on directly attached networks (gives the MAC) ...
    const onLinkIps = plan.onLink.flatMap((t) => hostsOf(t, ownIps));
    const sweepEnd = Math.min(deadline - 3000, now() + opts.seconds * 1000 + 2000);
    out.arpProbed = await arpTouch(onLinkIps, { stopAt: sweepEnd, settleMs: 800 });
    summary.get('arp-sweep').sent = out.arpProbed;
    if (out.arpProbed < onLinkIps.length) out.truncated = true;
    const neighbours = (await arpEntries(ifaces)).filter((n) => accept(n.ip));
    summary.get('arp-sweep').replies = neighbours.length;
    const alive = new Map(); // ip -> {mac, routed}
    for (const n of neighbours) {
      alive.set(n.ip, { mac: n.mac, routed: false });
      observations.push({ probe: 'arp-sweep', channel: 'B', ip: n.ip, mac: n.mac, signal: { iface: n.iface } });
    }
    // ... TCP on routed networks the caller added (no MAC there)
    const routedIps = plan.routed.flatMap((t) => hostsOf(t, ownIps)).filter((ip) => accept(ip));
    if (routedIps.length) {
      const jobs = routedIps.flatMap((ip) => ALIVE_PORTS.map((port) => ({ ip, port })));
      const started = await pool(jobs, LIMITS.connectConcurrency, async ({ ip, port }) => {
        if (alive.has(ip)) return;
        const r = await io.tcpProbe(ip, port, LIMITS.connectTimeoutMs);
        if (r === 'open' || r === 'refused') alive.set(ip, { mac: '', routed: true });
      }, { gapMs: LIMITS.connectGapMs, deadline: deadline - 2500, now, sleep });
      summary.get('tcp-ports').sent += started;
      if (started < jobs.length) out.truncated = true;
    }
    out.alive = alive.size;
    // 2. ports of the alive hosts
    const hosts = [...alive.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
    if (hosts.length > LIMITS.maxPortHosts) out.truncated = true;
    const portHosts = hosts.slice(0, LIMITS.maxPortHosts);
    out.portHosts = portHosts.length;
    const open = new Map(portHosts.map((ip) => [ip, []]));
    const portJobs = ports.flatMap((port) => portHosts.map((ip) => ({ ip, port })));
    const startedPorts = await pool(portJobs, LIMITS.connectConcurrency, async ({ ip, port }) => {
      if ((await io.tcpProbe(ip, port, LIMITS.connectTimeoutMs)) === 'open') open.get(ip).push(port);
    }, { gapMs: LIMITS.connectGapMs, deadline: deadline - 2000, now, sleep });
    summary.get('tcp-ports').sent += startedPorts;
    if (startedPorts < portJobs.length) out.truncated = true;
    // 3. unauthenticated banners of the open ports
    const bannerJobs = [];
    for (const [ip, list] of open) {
      // a routed host is listed even with no port of the list open (it answered or refused a connect); an on-link one already is (arp-sweep)
      if (!list.length && !alive.get(ip).routed) continue;
      list.sort((a, b) => a - b);
      summary.get('tcp-ports').replies++;
      observations.push({ probe: 'tcp-ports', channel: 'B', ip, mac: alive.get(ip).mac, signal: { ports: list } });
      for (const port of list) {
        if (HTTP_PORTS.has(port) || HTTPS_PORTS.has(port)) bannerJobs.push({ kind: 'http', ip, port });
        if (RTSP_PORTS.has(port)) bannerJobs.push({ kind: 'rtsp', ip, port });
        if (ONVIF_PORTS.has(port)) bannerJobs.push({ kind: 'onvif', ip, port });
      }
    }
    const banner = async ({ kind, ip, port }) => {
      const id = kind === 'http' ? 'http-banner' : kind === 'rtsp' ? 'rtsp-options' : 'onvif-unicast';
      summary.get(id).sent++;
      const base = { probe: id, channel: 'B', ip, mac: alive.get(ip).mac };
      if (kind === 'http') {
        const r = await io.httpGet(`${HTTPS_PORTS.has(port) ? 'https' : 'http'}://${ip}:${port}/`, { timeoutMs: LIMITS.bannerTimeoutMs, maxBytes: LIMITS.bannerBytes });
        summary.get(id).replies++;
        const head = `HTTP ${r.status}\n` + Object.entries(r.headers || {}).slice(0, 24).map(([k, v]) => `${k}: ${v}`).join('\n');
        observations.push({ ...base, signal: { http: [httpSignal(port, r)] }, raw: rawOf(Buffer.from(head), true) });
      } else if (kind === 'rtsp') {
        const text = await io.rtspOptions(ip, port, LIMITS.bannerTimeoutMs);
        const sig = rtspSignal(port, text);
        if (!sig) return;
        summary.get(id).replies++;
        observations.push({ ...base, signal: { rtsp: [sig] }, raw: rawOf(Buffer.from(text, 'latin1'), true) });
      } else {
        const r = await io.httpGet(`http://${ip}:${port}/onvif/device_service`, { method: 'POST', body: onvifDateRequest(), headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' }, timeoutMs: LIMITS.bannerTimeoutMs, maxBytes: LIMITS.bannerBytes });
        if (!/GetSystemDateAndTimeResponse/i.test(String(r.body || ''))) return;
        summary.get(id).replies++;
        observations.push({ ...base, signal: { onvifUnicast: [{ port, xaddr: `http://${ip}:${port}/onvif/device_service` }] }, raw: rawOf(Buffer.from(String(r.body)), true) });
      }
    };
    const startedBanners = await pool(bannerJobs, LIMITS.bannerConcurrency, banner, { gapMs: LIMITS.connectGapMs, deadline: deadline - 1600, now, sleep });
    if (startedBanners < bannerJobs.length) out.truncated = true;
    // 4. the unicast-capable registry probes, re-sent to alive hosts behind a router (broadcast does not get there)
    const targets = [...alive].filter(([, v]) => v.routed).map(([ip]) => ip).slice(0, LIMITS.maxUnicastHosts);
    if (targets.length && udpEntries.length && now() < deadline - 1500) await runUnicast({ entries: udpEntries.filter((e) => e.unicastCapable && e.kind !== 'passive' && e.targets.length && !e.exclusive), targets, summary, observations, accept, deadline });
    return out;
  }

  /** registry probes sent straight to a list of hosts (routed networks) */
  async function runUnicast({ entries, targets, summary, observations, accept, deadline }) {
    const sockets = [];
    try {
      for (const entry of entries) {
        const s = summary.get(entry.id);
        const ctx = { uuid: newUuid, seq: (++seq & 0xff) || 1, followUps: 0 };
        let requests;
        try {
          const built = entry.buildRequest(ctx);
          requests = (Array.isArray(built) ? built : [built]).filter((b) => Buffer.isBuffer(b) && b.length);
        } catch {
          continue;
        }
        const sock = await new Promise((resolve) => {
          let x;
          try {
            x = io.createSocket({ type: 'udp4', reuseAddr: true });
            sockets.push(x);
            x.on('error', () => resolve(null));
            x.bind(entry.bindPort || 0, () => resolve(x));
          } catch {
            resolve(null);
          }
        });
        if (!sock) continue;
        let replies = 0;
        sock.on('message', (msg, rinfo) => {
          if (msg.length > LIMITS.maxReply || replies >= LIMITS.maxRepliesPerProbe || !accept(rinfo.address)) return;
          let found = [];
          try {
            found = entry.parseReply(msg, { address: rinfo.address, port: rinfo.port, localPort: entry.bindPort || 0 }, ctx) || [];
          } catch { /* malformed */ }
          if (!found.length) return;
          replies++;
          s.replies++;
          const raw = rawOf(msg, entry.text);
          for (const f of found.slice(0, 16)) if (!f.skip) observations.push({ ...f, followUp: undefined, probe: f.probe || entry.id, channel: 'B', ip: f.ip || usableIp(rinfo.address), from: rinfo.address, raw });
        });
        for (const ip of targets) {
          for (const r of requests) {
            try {
              sock.send(r, entry.targets[0].port, ip, () => {});
              s.sent++;
            } catch { /* closed */ }
          }
          await sleep(2);
        }
      }
      await sleep(Math.max(0, Math.min(1200, deadline - now() - 300)));
    } finally {
      for (const sock of sockets) try { sock.close(); } catch { /* closed */ }
    }
  }

  /** channel D */
  async function runLayer2({ ifaces, excluded, opts, ownIps, summary, deadline, observations, accept }) {
    const out = { factoryProbed: 0, arping: null, ipv6: null };
    const nets = ifaces.map((f) => ({ f, c: cidrParts(f.cidr) })).filter((x) => x.c);
    const factory = (opts.factoryIps || DEFAULT_FACTORY_IPS).filter((ip) => !ownIps.has(ip) && !inAnyCidr(ip, excluded));
    const local = factory.filter((ip) => nets.some((x) => inAnyCidr(ip, [x.f.cidr])));
    const foreign = factory.filter((ip) => !local.includes(ip));
    const s = summary.get('factory-arp');
    // factory addresses inside a subnet the host has an address in (for example the fallback address): kernel ARP
    if (local.length) {
      s.sent += await arpTouch(local, { stopAt: deadline - 2000, settleMs: 600 });
      for (const n of await arpEntries(ifaces)) {
        if (!local.includes(n.ip) || !accept(n.ip)) continue;
        s.replies++;
        observations.push({ probe: 'factory-arp', channel: 'D', ip: n.ip, mac: n.mac, fields: { iface: n.iface, via: 'kernel' } });
      }
    }
    // factory addresses in a foreign subnet: `arping` on the host, on every discovery interface
    const names = uniq(ifaces.map((f) => f.iface));
    const jobs = foreign.flatMap((ip) => names.map((iface) => ({ ip, iface })));
    let missing = false;
    await pool(jobs, 8, async ({ ip, iface }) => {
      if (missing) return;
      s.sent++;
      out.factoryProbed++;
      let text = '';
      try {
        text = await host('arping', ['-c', '1', '-w', '1', '-I', iface, ip], { timeout: 4000 });
      } catch (e) {
        if (e?.code === 'ENOENT' || /not found|No such file/i.test(String(e?.stderr || e?.message || ''))) return void (missing = true);
        text = String(e?.stdout || '');
      }
      const mac = parseArping(text);
      if (!mac) return;
      s.replies++;
      observations.push({ probe: 'factory-arp', channel: 'D', ip, mac, fields: { iface, via: 'arping', foreignSubnet: true } });
    }, { deadline: deadline - 1500, now, sleep });
    out.arping = jobs.length ? (missing ? 'not-installed' : 'ok') : 'not-needed';
    if (missing) s.error = 'arping is not installed on the host: factory addresses in foreign subnets were not probed';
    // IPv4 link-local neighbours the kernel already knows
    const ll = summary.get('link-local-v4');
    for (const n of await arpEntries(ifaces)) {
      if (!/^169\.254\./.test(n.ip)) continue;
      ll.replies++;
      observations.push({ probe: 'link-local-v4', channel: 'D', ip: n.ip, mac: n.mac, fields: { iface: n.iface } });
    }
    // IPv6 all-nodes echo per interface, then the neighbour table
    const v6 = summary.get('ipv6-all-nodes');
    out.ipv6 = 'ok';
    for (const iface of names) {
      if (now() >= deadline - 2500) break;
      let ping = '';
      v6.sent++;
      try {
        ping = await host('ping', ['-6', '-c', '2', '-w', '2', '-I', iface, 'ff02::1'], { timeout: 5000 });
      } catch (e) {
        if (e?.code === 'ENOENT') {
          out.ipv6 = 'ping-not-installed';
          v6.error = 'ping is not installed on the host';
          break;
        }
        ping = String(e?.stdout || '');
      }
      const neigh = await host('ip', ['-6', 'neigh', 'show', 'dev', iface], { timeout: 4000 }).catch(() => '');
      for (const n of parseIp6Neighbours(neigh, ping).slice(0, 512)) {
        if (!n.mac) continue;
        v6.replies++;
        observations.push({ probe: 'ipv6-all-nodes', channel: 'D', mac: n.mac, signal: { ipv6: [n.ipv6] }, fields: { iface } });
      }
    }
    return out;
  }

  async function discover(body = {}, pre = {}) {
    const opts = validateOptions(body);
    const started = now();
    const excluded = pre.excluded || [o.apNetwork || '192.168.234.0/24', ...opts.exclude];
    const ifaces = pre.ifaces || discoveryInterfaces(netIfs(), { excluded });
    const stamp = () => new Date(now()).toISOString();
    const summary = summaryOf();
    if (!ifaces.length) return { discoveredAt: stamp(), durationMs: 0, interfaces: [], devices: [], candidates: [], unaddressed: [], probes: [...summary.values()], channels: opts.channels };
    const observations = [];
    const deadline = started + opts.seconds * 1000 + LIMITS.extraBudgetMs;
    const stats = { sweep: null, layer2: null, dropped: 0, parseErrors: 0 };
    const ifaceIps = new Set(ifaces.map((f) => f.ip));
    let ownIps = ifaceIps;

    if (o.legacyMulticast) {
      // compatibility transport: only the ONVIF + SADP exchange, exactly as host-agent.mjs did it
      const replies = await o.legacyMulticast({ ifaces, wsdProbes: [wsDiscoveryProbe(newUuid()), wsDiscoveryProbe(newUuid(), 'tds:Device')], sadpProbe: sadpProbe(newUuid()), seconds: opts.seconds });
      for (const r of Array.isArray(replies) ? replies : []) {
        if (!r || ifaceIps.has(r.from) || inAnyCidr(r.from, excluded)) continue;
        const id = r.proto === 'wsd' ? 'onvif' : r.proto === 'sadp' ? 'sadp' : '';
        if (!id) continue;
        const data = String(r.data ?? '');
        const parsed = r.proto === 'wsd' ? parseWsDiscovery(data, r.from) : [parseSadp(data)].filter(Boolean);
        if (!parsed.length) continue;
        summary.get(id).replies++;
        const raw = rawOf(Buffer.from(data), true);
        for (const p of parsed) observations.push({ probe: id, channel: 'A', ip: p.ip, from: r.from, legacy: { proto: r.proto, parsed: p }, raw });
      }
      for (const s of summary.values()) if (s.id !== 'onvif' && s.id !== 'sadp' && s.implemented) s.skipped = 'legacy-transport';
    } else {
      ownIps = new Set(Object.values(netIfs() || {}).flatMap((list) => (list || []).map((a) => a.address)).concat([...ifaceIps]));
      const accept = (ip) => !ownIps.has(ip) && !inAnyCidr(ip, excluded);
      const hotspotUp = Object.values(netIfs() || {}).some((list) => (list || []).some((a) => inAnyCidr(a.address, excluded)));
      const udpEntries = registry.filter((p) => p.implemented && ((p.channel === 'A' && opts.channels.includes('A') && p.kind !== 'unicast') || (p.channel === 'C' && opts.channels.includes('C') && p.kind === 'passive')));
      const active = udpEntries.filter((p) => {
        if (p.id === 'dhcp-fingerprint' && hotspotUp) {
          summary.get(p.id).skipped = 'excluded network active on this host';
          return false;
        }
        return true;
      });
      for (const s of summary.values()) if (s.implemented && !opts.channels.includes(s.channel)) s.skipped = 'channel not requested';
      const guard = (name, p) => p.catch((e) => {
        log(`${name}: ${e?.message || e}`);
        return null;
      });
      // Rate limit for the sweeping channels (B: ARP + TCP + banners, D: arping + ICMPv6). The backend searches every minute
      // for plug-and-play; a request that does not name `channels` reuses the last B / D result for heavyIntervalMs.
      const wantsB = opts.channels.includes('B');
      const wantsD = opts.channels.includes('D');
      const heavyKey = JSON.stringify([wantsB, wantsD, opts.extraCidrs, opts.factoryIps, opts.ports, excluded, ifaces.map((f) => f.iface + ' ' + f.cidr)]);
      const cached = !Array.isArray(body?.channels) && heavy && heavy.key === heavyKey && now() - heavy.at < heavyIntervalMs ? heavy : null;
      const heavyObs = [];
      const [udp, sweep, layer2] = await Promise.all([
        active.length ? guard('udp', runUdp({ entries: active, ifaces, seconds: opts.seconds, accept, summary, deadline, observations })) : null,
        wantsB && !cached ? guard('sweep', runSweep({ ifaces, excluded, opts, ownIps, summary, deadline, observations: heavyObs, udpEntries: registry.filter((p) => p.implemented && p.channel === 'A'), accept })) : null,
        wantsD && !cached ? guard('layer2', runLayer2({ ifaces, excluded, opts, ownIps, summary, deadline, observations: heavyObs, accept })) : null,
      ]);
      if (cached) {
        const ageMs = now() - cached.at;
        for (const s of summary.values()) if (s.implemented && (s.channel === 'B' || s.channel === 'D')) s.skipped = 'rate limited: previous result reused';
        observations.push(...cached.observations);
        Object.assign(stats, { sweep: cached.sweep && { ...cached.sweep, cached: true, ageMs }, layer2: cached.layer2 && { ...cached.layer2, cached: true, ageMs } });
      } else {
        if (wantsB || wantsD) heavy = { key: heavyKey, at: now(), observations: heavyObs, sweep, layer2 };
        observations.push(...heavyObs);
        Object.assign(stats, { sweep, layer2 });
      }
      Object.assign(stats, { dropped: udp?.dropped || 0, parseErrors: udp?.parseErrors || 0 });
    }

    const usable = observations.filter((x) => !x.from || (!ownIps.has(x.from) && !inAnyCidr(x.from, excluded)));
    let arp = [];
    try {
      arp = parseArpTable(await readArp());
    } catch { /* no ARP table: MACs are not filled in */ }
    const merged = mergeObservations(usable, { excluded, arp });
    return {
      discoveredAt: stamp(),
      durationMs: now() - started,
      interfaces: ifaces,
      devices: merged.devices,
      candidates: merged.candidates,
      unaddressed: merged.unaddressed,
      probes: [...summary.values()],
      channels: opts.channels,
      ...(stats.sweep ? { sweep: stats.sweep } : {}),
      ...(stats.layer2 ? { layer2: stats.layer2 } : {}),
      ...(stats.dropped || stats.parseErrors ? { dropped: stats.dropped, parseErrors: stats.parseErrors } : {}),
    };
  }

  return { discover, registry };
}
