import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from './read-asar.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.join(root,'evidence');fs.mkdirSync(evidence,{recursive:true});
const steps=[];
/**
 * Execute one verification step.
 * @param name - step name, also the evidence log basename.
 * @param args - argv for node, or for `executable` when one is given.
 * @param options.executable - absolute program to spawn instead of this node binary.
 */
function run(name,args,{executable=process.execPath}={}){
  const result=spawnSync(executable,args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});
  fs.writeFileSync(path.join(evidence,`${name}.log`),`${result.stdout??''}${result.stderr??''}`);
  steps.push({name,exitCode:result.status,log:`evidence/${name}.log`});
  console.log(`${name}: ${result.status===0?'PASS':'FAIL'}`);
  if(result.status!==0){console.error((result.stdout??'').split('\n').filter(line=>line.startsWith('not ok')).join('\n') || (result.stderr??'').slice(-3000));console.error(`See evidence/${name}.log`);process.exit(1);}
  return result.stdout;
}
/**
 * TypeScript 7 ships tsc as a native Go binary, which some hosts refuse to start
 * from this working tree (Windows reports `winapi error #5` while loading
 * bcrypt.dll). DSH_SPLIT_TSC points at a tsc outside that tree; a JavaScript
 * entry is still launched through this node binary.
 */
function typecheckArgs(){
  const override=process.env.DSH_SPLIT_TSC;
  const args=['--noEmit','-p','tsconfig.fixture.json'];
  if(!override)return{args:['../node_modules/typescript/bin/tsc',...args],executable:process.execPath};
  if(!fs.existsSync(override))throw new Error(`DSH_SPLIT_TSC does not exist: ${override}`);
  return /\.(?:js|mjs|cjs)$/i.test(override)
    ?{args:[override,...args],executable:process.execPath}
    :{args,executable:override};
}
const typecheck=typecheckArgs();
run('typecheck',typecheck.args,{executable:typecheck.executable});
run('build',['tools/build.mjs']);
const tests=fs.readdirSync(path.join(root,'tests')).filter(file=>file.endsWith('.test.mjs')).sort().map(file=>`tests/${file}`);
const output=run('tests',['--test','--test-reporter=tap',...tests]);
const count=Number(output.match(/^# tests (\d+)/m)?.[1]);
const passed=Number(output.match(/^# pass (\d+)/m)?.[1]);
if(!count||count!==passed)throw new Error('Test report lacks complete passing evidence');
const report={verifiedAt:new Date().toISOString(),testCount:count,passed,steps,
  clientSha256:sha256(fs.readFileSync(path.join(root,'lib/client.js'))),
  nativeManifestSha256:sha256(fs.readFileSync(path.join(root,'host-patches/manifest.json'))),
  browser:'Real native host and Chromium startup validation is separately required by tools/validate-release.mjs before installation.',
  desktopRestartPerformed:false};
fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
