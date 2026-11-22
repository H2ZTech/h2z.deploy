import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const port=readFileSync('.env','utf8').match(/^HTTP_PORT=(.+)$/m)?.[1]||'8096';
const token=readFileSync('secrets/ioc/admin-token','utf8').trim();
const base='http://127.0.0.1:'+port+'/api/ioc';
async function api(method,path,body) {
  const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!r.ok) throw Error(path+' returned '+r.status);
  return r.json();
}
const list=await api('GET','/projects');
const projects=Array.isArray(list)?list:list.projects;
if(!projects.some(p=>p.projectId==='security')) await api('POST','/projects',{projectId:'security',name:'H2Z 安防',mode:'warehouse'});
const settings=await api('GET','/settings');
if(!settings.currentProject) await api('PUT','/settings/current',{projectId:'security'});
console.log('Empty security warehouse project exists. Existing current project preserved; no camera, model or inference events seeded.');
