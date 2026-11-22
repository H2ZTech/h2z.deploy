import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const arch=process.argv[2]||'arm64';
const env=readFileSync('.env','utf8');
let fail=false;
for(const [name,image] of env.split(/\r?\n/).filter(l=>/^[A-Z_]+_IMAGE=/.test(l)).map(l=>l.split('='))) {
  try {
    const data=JSON.parse(execFileSync('docker',['manifest','inspect','--verbose',image],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}));
    const entries=Array.isArray(data)?data:[data];
    const platforms=entries.map(x=>x.Descriptor?.platform||x.SchemaV2Manifest?.platform||{});
    if(!platforms.some(p=>p.architecture===arch&&p.os==='linux')) throw Error('platform unavailable');
    console.log('PASS',name,image,arch);
  } catch { console.log('FAIL',name,image,'registry or linux/'+arch+' unavailable'); fail=true; }
}
process.exitCode=fail?1:0;
