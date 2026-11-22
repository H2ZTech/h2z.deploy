/**
 * 给 AI 探索当依据的摘要：把三个库里「怎么认设备、用什么只读办法问它、结论能下到什么程度」压成一份 Markdown。
 * 不含任何账号、口令、团体名（摄像头库里的出厂账号不进摘要）。同样的库永远生成同样的字节。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIB_DIR, loadData } from './lib.mjs';

const lv = (s) => ({ verified: 'verified on real devices', documented: 'vendor documentation / standard', candidate: 'candidate, unverified' })[s] || s;

export function buildAiDigest(dir = LIB_DIR) {
  const cam = JSON.parse(readFileSync(resolve(dir, 'library.json'), 'utf8'));
  const rec = loadData('recorders', dir);
  const net = loadData('netdevs', dir);
  const L = [];
  L.push('# Device library digest (basis for discovery)', '');
  L.push('This is a digest of the product device library, to help you identify devices and choose read-only query methods. It is a lead, not a conclusion:', '');
  L.push('- Every entry carries an evidence level. Interfaces marked "candidate, unverified" may differ from real devices; treat what they return as unconfirmed, and do not keep retrying what cannot be read.');
  L.push('- Devices not in the library are classified from evidence as usual; write unknown if you cannot identify them.');
  L.push('- This digest contains no account passwords. Use only the read-only handles given by the operator; if there are none, register ACTION_REQUIRED and do not guess default values.');
  L.push('- Query only. The commands and interfaces listed below are read-only; do not run a command that is not listed here just because it "looks like a query".', '');

  L.push('## 1. Network devices: how to identify them', '');
  L.push('Read `sysObjectID` (1.3.6.1.2.1.1.2.0) first: the enterprise number in `1.3.6.1.4.1.<enterprise number>...` maps to the vendor; then confirm with the wording in `sysDescr` and the SSH banner.', '');
  L.push('| Platform | Enterprise number | sysDescr wording | SSH banner | Roles |', '|---|---|---|---|---|');
  for (const f of net.families) L.push(`| ${f.name} (\`${f.id}\`) | ${(f.identify.enterprise || []).join(', ')} | ${(f.identify.sysDescr || []).join(' / ') || '—'} | ${f.identify.ssh || '—'} | ${f.roles.join(', ')} |`);
  const gen = net.families.find((f) => f.identify.enterpriseNames);
  if (gen) L.push('', 'Other enterprise numbers: ' + Object.entries(gen.identify.enterpriseNames).map(([k, v]) => `${k} = ${v}`).join('; ') + '.');
  L.push('', '## 2. Network devices: standard SNMP tables (query these first on any platform)', '', '| Table | OID | What it gives |', '|---|---|---|');
  for (const t of net.snmp.tables) L.push(`| ${t.id} | \`${t.oid}\` | ${t.gives} |`);
  L.push('', '## 3. How to conclude a link', '');
  for (const r of net.linkRules) L.push(`- ${r}`);
  L.push('', '## 4. Network devices: read-only commands per platform', '');
  for (const f of net.families) {
    if (!f.cli && !f.controller) continue;
    L.push(`### ${f.name} (\`${f.id}\`)`, '');
    if (f.cli) {
      L.push(`- Login: ${f.cli.transport.join(' / ')}${f.cli.prompt ? `; prompt \`${f.cli.prompt}\`` : ''}; disable paging: \`${f.cli.paging || '—'}\`${f.cli.readOnlyRole ? `; read-only role: ${f.cli.readOnlyRole}` : ''}`);
      L.push(`- Evidence: ${lv(f.cli.evidence)}${f.cli.evidenceNote ? ` (${f.cli.evidenceNote})` : ''}`);
      L.push('- Commands: ' + Object.entries(f.cli.commands).map(([k, c]) => `${k} -> \`${c}\``).join('; '));
    }
    if (f.controller) L.push(`- Controller interface (${lv(f.controller.evidence)}): \`${f.controller.path}\`${f.controller.gives ? `, gives ${f.controller.gives}` : ''}`);
    if (f.snmp?.enableHint) L.push(`- If SNMP is not enabled on the device, ask the operator to enable read-only access like this: ${f.snmp.enableHint}`);
    for (const x of f.limits || []) L.push(`- Note: ${x}`);
    L.push('');
  }

  L.push('## 5. Recorders: by protocol family', '', '| Protocol family | Brands | How to identify | Product support |', '|---|---|---|---|');
  for (const f of rec.families) {
    const h = f.identify.http;
    L.push(`| ${f.name} (\`${f.id}\`) | ${f.vendors.join(', ') || 'any'} | port ${(f.identify.tcpPorts || []).join('/')}${h ? `; ${h.method} \`${h.path}\` should return ${h.expect}` : ''} (${lv(f.identify.evidence)}) | ${f.productSupport === 'supported' ? 'supported' : 'not supported'} |`);
  }
  L.push('');
  for (const f of rec.families) {
    L.push(`### ${f.name} (\`${f.id}\`)`, '');
    L.push(`- Authentication: HTTP ${f.auth.http || '—'}; RTSP ${f.auth.rtsp || '—'}${f.auth.lockout ? `; **${f.auth.lockout}**` : ''}`);
    L.push(`- Time: ${f.time.zone === 'utc' ? 'UTC' : 'recorder local time'}${f.time.note ? ` (${f.time.note})` : ''}; channel numbers start at ${f.channelBase}`);
    for (const [k, it] of Object.entries(f.interfaces)) L.push(`- ${k}（${lv(it.evidence)}）：${it.method} \`${it.path}\``);
    if (f.rtsp.live) L.push(`- Live (${lv(f.rtsp.live.evidence)}): main \`${f.rtsp.live.main}\`, sub \`${f.rtsp.live.sub}\``);
    if (f.rtsp.playback) L.push(`- Playback (${lv(f.rtsp.playback.evidence)}): \`${f.rtsp.playback.template}\`${f.rtsp.playback.timeFormat ? `, time written as ${f.rtsp.playback.timeFormat}` : ''}`);
    for (const x of f.limits || []) L.push(`- Note: ${x}`);
    L.push('');
  }

  L.push('## 6. Cameras: brands and stream path conventions', '');
  L.push(`The library has ${cam.vendors.length} brands. Common ONVIF ports: ${cam.onvifPorts.join(', ')}. Identify the brand from the ONVIF manufacturer name, the HTTP auth realm and the model wording. Below is the preferred main / sub stream path pair for each brand (\`{ch}\` is the channel number):`, '');
  L.push('| Brand | Aliases | RTSP port | Main stream | Sub stream | Evidence |', '|---|---|---|---|---|---|');
  for (const v of cam.vendors) {
    const pr = v.pairs.find((x) => x.id === v.pin) || v.pairs[0];
    if (!pr) continue;
    L.push(`| ${v.name} | ${v.aliases.slice(0, 3).join(', ')} | ${v.rtspPort ?? 554} | \`${pr.main}\` | \`${pr.sub}\` | ${lv(pr.status)} |`);
  }
  L.push('', 'When probing streams, first send a path that does not exist: the path is only proven correct if the device returns 404 for it and 401 for the real path; a device that returns 401 for everything cannot be told apart.', '');
  return L.join('\n');
}
