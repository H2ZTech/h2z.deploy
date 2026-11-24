// Checks that every image the stack will run has a manifest for the given architecture (default arm64).
//   node scripts/check-images.mjs [arm64|amd64]
// Image list = every *_IMAGE line in .env, plus the compose.yaml defaults (${X_IMAGE:-ref}) of variables that .env does not set:
// a machine whose .env predates a new service (activator, bridge, edge-link ...) runs that service from the compose default,
// so the default has to be checked (and reported) too.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** [[name, image, source]]: .env values first (last assignment wins, as in docker compose), then compose defaults for names .env leaves unset or empty. */
export function imageRefs(envText, composeTexts = []) {
  const out = new Map();
  for (const line of String(envText || '').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+_IMAGE)=(.*)$/.exec(line);
    if (m) out.set(m[1], [m[2].trim(), '.env']);
  }
  for (const text of composeTexts) {
    for (const m of String(text || '').matchAll(/\$\{([A-Z0-9_]+_IMAGE):-([^}\s]+)\}/g)) {
      if (!out.has(m[1]) || !out.get(m[1])[0]) out.set(m[1], [m[2], 'compose default']);
    }
  }
  return [...out].filter(([, [image]]) => image).map(([name, [image, source]]) => [name, image, source]);
}

function main() {
  process.chdir(fileURLToPath(new URL('..',import.meta.url)));
  const arch=process.argv[2]||'arm64';
  const env=readFileSync('.env','utf8');
  const compose=existsSync('compose.yaml')?[readFileSync('compose.yaml','utf8')]:[];
  let fail=false;
  for(const [name,image,source] of imageRefs(env,compose)) {
    const note=source==='.env'?'':' ('+source+', not set in .env)';
    try {
      const data=JSON.parse(execFileSync('docker',['manifest','inspect','--verbose',image],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}));
      const entries=Array.isArray(data)?data:[data];
      const platforms=entries.map(x=>x.Descriptor?.platform||x.SchemaV2Manifest?.platform||{});
      if(!platforms.some(p=>p.architecture===arch&&p.os==='linux')) throw Error('platform unavailable');
      console.log('PASS',name,image,arch+note);
    } catch { console.log('FAIL',name,image,'registry or linux/'+arch+' unavailable'+note); fail=true; }
  }
  process.exitCode=fail?1:0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
