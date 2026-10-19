import fs from 'node:fs';
import path from 'node:path';
import {checkBoot} from './real-boot-check.mjs';
import {sha256} from './read-asar.mjs';
import {assertBootAdmission} from './boot-admission.mjs';

const releaseFile=path.resolve(process.argv[2]);
// Explicitly reuse completed checks for these exact immutable bytes. Failed
// checks never qualify; restart still depends on the accepted enabled profile.
const releaseSha256=sha256(fs.readFileSync(releaseFile));
const reuse=process.argv.slice(3).map(file=>JSON.parse(fs.readFileSync(path.resolve(file),'utf8')));
for(const check of reuse)if(check.passed!==true||check.releaseSha256!==releaseSha256||check.errors?.length!==0)throw new Error('Cannot reuse failed or mismatched native verification');
const checks=[];
for(const mode of ['baseline','enabled','restart','disabled','without-patches']){
  console.log(`Checking ${mode} in an isolated native Desktop Host and Chromium...`);
  const checked=reuse.find(check=>check.mode===mode)??await checkBoot(releaseFile,mode,mode==='restart'?checks.find(c=>c.mode==='enabled').home:undefined);
  checks.push(checked);
  if(!checked.passed)throw new Error(`Release rejected: ${mode}; see ${checked.home}`);
}
const report={verifiedAt:new Date().toISOString(),releaseSha256:sha256(fs.readFileSync(releaseFile)),passed:true,
  checks:checks.map(({mode,passed,home,hostEntries,interactions,sessionUi,errors})=>({mode,passed,home,entries:hostEntries.length,interactions,sessionUi,errorCount:errors.length})),
  scope:'Shipped Electron Desktop Host and Chromium using isolated DSH profiles. Three empty native sessions; their catalog rows are made visible for menu testing. No model requests or user session data.'};
const destination=path.join(path.dirname(releaseFile),'boot-validation.json');
fs.writeFileSync(destination,JSON.stringify(report,null,2));
assertBootAdmission(releaseFile);
console.log(JSON.stringify({passed:true,scenarios:checks.length,evidence:destination}));
