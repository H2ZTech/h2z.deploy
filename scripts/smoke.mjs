import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLogLimits, composeConfig } from './log-limits.mjs';
import { checkCameraLibrary } from './camera-library/library.mjs';
import { checkDeviceLibraries } from './device-library/lib.mjs';
import { buildAiDigest } from './device-library/ai-digest.mjs';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const e = Object.fromEntries(readFileSync('.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
const base = 'http://127.0.0.1:'+(e.HTTP_PORT||8096);
const checks = [];
async function check(name, fn, required=true) {
  try { const result=await fn(); const status=result==='skip'?'skip':'pass'; checks.push({name,status,required}); console.log(status.toUpperCase(),name); }
  catch (err) { checks.push({name,status:'fail',required,reason:err.message}); console.log('FAIL',name,err.message); }
}
const assert = (ok,message) => {if(!ok) throw Error(message);};
const token = readFileSync('secrets/ioc/admin-token','utf8').trim();
async function http(path, auth=false) {
  const r = await fetch(base+path,{headers:auth?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(15000)});
  return {status:r.status,body:await r.text()};
}
// /api/security/* is gated by the LAN login in nginx and the IOC admin token is not a login, so an outside request gets 401 even when the platform is fine.
// Probe those paths from inside the backend container (the same way the engine-token check below does); everything else goes through nginx as before.
async function api(path, auth=false) {
  if (!path.startsWith('/api/security/')) return http(path, auth);
  const out = inside('backend', `fetch('http://127.0.0.1:3001${path.slice(4)}').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(()=>process.exit(1))`);
  return JSON.parse(out);
}
function inside(service, code) {
  // Arguments go directly to docker; never through a shell. Child errors are sanitized.
  try { return execFileSync('docker',['compose','exec','-T',service,'node','-e',code],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim(); }
  catch { throw Error('container probe failed: '+service); }
}
// In the lean base (compose.lean.yaml) extension packs that are not installed have no emqx / h2z-api / Node-RED services: their checks are skipped when they are not in the compose config;
// services that are in the config (boards, dev machines, H2Z OS with the pack installed) are checked as before and count as failures if they are not up. If the config cannot be read, everything is checked.
let configured = null;
try { configured = new Set(execFileSync('docker',['compose','config','--services'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).split(/\r?\n/).map(x=>x.trim()).filter(Boolean)); } catch { configured = null; }
const needs = (service, fn) => async () => {
  if (configured && !configured.has(service)) { console.log('SKIP not installed: '+service); return 'skip'; }
  return fn();
};
await check('frontend SPA',async()=>{const r=await http('/ioc/');assert(r.status===200&&r.body.includes('<div id="app"'),'SPA missing');});
await check('IOC API health through nginx',async()=>assert((await http('/api/ioc/health')).status===200,'IOC health failed'));
await check('IOC project catalog readable (upstream read policy)',async()=>assert((await http('/api/ioc/projects')).status===200,'project catalog failed'));
await check('IOC project list with administrator token',async()=>assert((await http('/api/ioc/projects',true)).status===200,'IOC request failed'));
await check('IOC write rejects anonymous',async()=>{
  const mode=inside('backend',"console.log(process.env.IOC_AUTH||'none')");
  if(mode==='none') {
    console.log('SKIP anonymous write rejection: IOC_AUTH=none');
    return 'skip';
  }
  const r=await fetch(base+'/api/ioc/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:'auth-probe-never-create',name:'Auth probe',mode:'dashboard'})});
  assert([401,403].includes(r.status),'anonymous create not denied: '+r.status);
});
await check('platform security health',async()=>assert((await api('/api/security/health')).status===200,'security health failed'));
await check('IOC → h2z API with service token',needs('h2z-api',()=>assert(inside('backend',`const fs=require('fs');fetch('http://h2z-api:3083/v1/capabilities',{headers:{Authorization:'Bearer '+fs.readFileSync(process.env.IOC_H2Z_TOKEN_FILE,'utf8').trim()}}).then(async r=>{if(!r.ok)process.exit(1);console.log('ok')}).catch(()=>process.exit(1))`)==='ok','AI token failed')));
await check('AI API denies missing token',needs('h2z-api',()=>assert(inside('backend',`fetch('http://h2z-api:3083/v1/capabilities').then(r=>{if(r.status!==401)process.exit(1);console.log('ok')})`)==='ok','AI auth failed')));
await check('Node-RED bridge health',needs(configured&&!configured.has('nodered-bridge')?'h2z-api':'nodered-bridge',()=>assert(inside('backend',`fetch('http://nodered-bridge:3090/healthz').then(r=>{if(!r.ok)process.exit(1);console.log('ok')})`)==='ok','bridge failed')));
await check('Node-RED admin protected',needs('nodered',()=>assert(inside('backend',`fetch('http://nodered:1880/flows').then(r=>{if(r.status!==401)process.exit(1);console.log('ok')})`)==='ok','Node-RED auth failed')));
await check('PostgreSQL connection and camera schema',()=>assert(inside('backend',`const {Client}=require('pg');const c=new Client({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});c.connect().then(()=>c.query('SELECT count(*) FROM camera')).then(()=>{console.log('ok');return c.end()}).catch(()=>process.exit(1))`)==='ok','PG camera table failed'));
await check('EMQX authenticated MQTT round trip',needs('emqx',()=>assert(inside('backend',`const mqtt=require('mqtt');const topic='security/verify/'+Date.now();const c=mqtt.connect(process.env.MQTT_BROKER_URL);const timer=setTimeout(()=>process.exit(1),12000);c.on('connect',()=>c.subscribe(topic,{qos:1},err=>{if(err)process.exit(1);c.publish(topic,'verification',{qos:1})}));c.on('message',(t,b)=>{if(t===topic&&b.toString()==='verification'){clearTimeout(timer);console.log('ok');c.end()}});c.on('error',()=>process.exit(1));`)==='ok','MQTT failed')));
await check('ZLM API secret and configured recording hook',()=>assert(inside('backend',`fetch('http://zlm/index/api/getServerConfig?secret='+process.env.ZLM_SECRET).then(r=>r.json()).then(v=>{if(v.code!==0||!v.data[0]['hook.on_record_mp4'].includes('backend:3001/security/zlm/hook'))process.exit(1);console.log('ok')}).catch(()=>process.exit(1))`)==='ok','ZLM configuration failed'));
await check('nginx hides ZLM administrative API',async()=>assert((await http('/media/index/api/getServerConfig')).status===403,'ZLM API exposed'));
// Every service's logs must have a cap (added after a 39 GB td-log filled a system disk)
await check('every service has log limits (compose)',()=>{const p=checkLogLimits(composeConfig());assert(!p.length,p.join('；'));});
// Camera library (camera-library/): data passes the gate, library.json is valid and consistent with the data, and compose mounts it read-only into the backend.
// If the backend cannot read the library it falls back to a built-in minimal set without an error, so it is checked explicitly here; otherwise nobody would notice the library silently not taking effect.
await check('camera library is valid, in sync and mounted read-only into backend',()=>{
  const p=checkCameraLibrary();assert(!p.length,p.join('；'));
  const b=composeConfig().services.backend;
  const env=Array.isArray(b.environment)?Object.fromEntries(b.environment.map(x=>x.split(/=(.*)/s).slice(0,2))):b.environment;
  assert(env.IOC_CAMERA_LIBRARY_FILE==='/camera-library/library.json','backend does not set IOC_CAMERA_LIBRARY_FILE');
  const m=(b.volumes||[]).find(v=>v.target==='/camera-library');
  assert(m&&m.read_only===true,'backend does not mount ./camera-library read-only');
});
// The recorder library / network device library / AI digest live in the same directory as the camera library (same read-only mount): data passes the gate, generated output matches the data, the digest is current.
await check('recorder and network-device libraries are valid and in sync',()=>{const p=checkDeviceLibraries(undefined,buildAiDigest);assert(!p.length,p.join('；'));});
await check('TDengine log directory under 2 GB',()=>{
  let out;
  try { out=execFileSync('docker',['compose','exec','-T','tdengine','du','-sm','/var/log/taos'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}); }
  catch { return 'skip'; } // tdengine is not running (recorder / telemetry not enabled)
  const mb=Number(out.trim().split(/\s+/)[0]);
  assert(Number.isFinite(mb)&&mb<2048,'td-log '+mb+' MB');
});
const full = process.argv.includes('--full');
let PID='security';
try { const st=JSON.parse((await http('/api/ioc/settings',true)).body); if(st.currentProject) PID=st.currentProject; } catch { /* keep default */ }
for(const [name,path,field] of [
  ['IOC project alarms','/api/ioc/projects/'+PID+'/alarms?status=active&limit=50','alarms'],
  ['IOC project dock summary','/api/ioc/projects/'+PID+'/ai/docks',null],
  ['IOC project camera list','/api/ioc/projects/'+PID+'/network/cameras','cameras'],
  ['IOC project space list','/api/ioc/projects/'+PID+'/network/spaces',null],
  ['IOC warehouse initialization state','/api/ioc/projects/'+PID+'/warehouse',null],
  ['security alarms','/api/security/ioc/alarms?status=active&limit=50',null],
  ['security dock summary','/api/security/ioc/docks',null],
]) {
  await check(name,async()=>{
    const r=await api(path,true);
    assert(r.status===200,'HTTP '+r.status+' at '+path);
    let value; try { value=JSON.parse(r.body); } catch { throw Error('response is not JSON'); }
    assert(value!==null&&typeof value==='object','response is not an object');
    if(field) assert(Array.isArray(value[field]),'missing array: '+field);
  },full);
}
await check('current platform YOLO algorithm API',async()=>assert((await api('/api/security/ioc/ai/algorithms')).status===200,'image does not provide algorithm API'),full);
await check('current IOC AI scenarios relay',async()=>assert((await http('/api/ioc/ai/scenarios',true)).status===200,'image does not provide AI scenarios relay'),full);
await check('current platform engine-token guard',()=>assert(inside('backend',`fetch('http://127.0.0.1:3001/security/ioc/ai/engine/yolo8-vehicle/configs').then(r=>{if(r.status!==401)process.exit(1);console.log('ok')})`)==='ok','current engine guard unavailable'),full);
mkdirSync('runtime',{recursive:true});
writeFileSync('runtime/smoke-results.json',JSON.stringify({checkedAt:new Date().toISOString(),full,checks},null,2));
const failed=checks.filter(c=>c.required&&c.status==='fail');
console.log(`${checks.filter(c=>c.status==='pass').length}/${checks.length} passed; required failures: ${failed.length}`);
process.exitCode=failed.length?1:0;
