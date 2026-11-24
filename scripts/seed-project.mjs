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
if(/^IOC_AUTO_PROJECT=1\s*$/m.test(readFileSync('.env','utf8'))) {
  // The backend creates the device project (named after the device, with its space and the device language) in the background.
  for(let i=0;i<60;i++) {
    const s=await api('GET','/settings');
    if(s.currentProject) { console.log('Device project '+s.currentProject+' was created automatically.'); process.exit(0); }
    await new Promise(r=>setTimeout(r,5000));
  }
  console.log('The device project is not created yet; the backend keeps retrying in the background.');
  process.exit(0);
}
const list=await api('GET','/projects');
const projects=Array.isArray(list)?list:list.projects;
// Only when there is no project at all: one default project named after this machine, and its id is the same as its name
// (letters, digits, "_" and "-"; anything else becomes "-"), the same rule the backend uses for the automatic device project.
const { hostname } = await import('node:os');
const name=hostname()||'H2Z';
const id=name.trim().replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'local';
if(!projects.length) await api('POST','/projects',{projectId:id,name,mode:'warehouse'});
const settings=await api('GET','/settings');
const first=projects.length?projects[0].projectId:id;
if(!settings.currentProject) await api('PUT','/settings/current',{projectId:first});
console.log('Default project: '+first+'. An existing current project is preserved; no camera, model or inference events seeded.');
