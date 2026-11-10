import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './read-asar.mjs';
import {verifyPackageFiles} from './native-package.mjs';
import {assertBootAdmission} from './boot-admission.mjs';
import {syncProfileDependencies,assertProfileDependencies} from './profile-dependencies.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=path.resolve('C:/Users/wanyexin/.dsh/profiles/desktop');
const modules=path.join(profile,'node_modules');
const config=path.join(profile,'package.json');
const configFiles=['package.json','cordis.yml','cordis.patch.yml','pnpm-lock.yaml','node_modules/.pnpm/lock.yaml','node_modules/.modules.yaml','node_modules/.pnpm-workspace-state-v1.json'];
function restoreConfig(backup){
  for(const name of configFiles.filter(name=>name!=='cordis.yml'&&name!=='cordis.patch.yml')){const source=path.join(backup,name);if(fs.existsSync(source)){fs.mkdirSync(path.dirname(path.join(profile,name)),{recursive:true});fs.copyFileSync(source,path.join(profile,name));}}
}
function inside(file,directory){return path.resolve(file).toLowerCase().startsWith(path.resolve(directory).toLowerCase()+path.sep);}
function checkedLink(file){
  if(!inside(file,modules))throw new Error('Destination leaves the named desktop profile');
  try {const stat=fs.lstatSync(file);if(!stat.isSymbolicLink())throw new Error(`Destination is not a junction: ${file}`);return fs.readlinkSync(file);}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function unlinkJunction(file){if(checkedLink(file)!==null)fs.unlinkSync(file);}
function relink(file,target){
  unlinkJunction(file);
  if(target){fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync(target,file,'junction');}
}
if(process.argv[2]==='--rollback'){
  const receiptPath=path.resolve(process.argv[3]??'');
  if(!inside(receiptPath,path.join(root,'backups')))throw new Error('Rollback receipt outside rebuild backups');
  const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  for(const op of receipt.operations){
    const current=checkedLink(op.link);
    if(current&&path.resolve(current).toLowerCase()!==path.resolve(op.target).toLowerCase())throw new Error(`A later install changed ${op.name}; refusing stale rollback`);
  }
  for(const op of receipt.operations)relink(op.link,op.previous);
  restoreConfig(path.dirname(receiptPath));
  console.log(JSON.stringify({rolledBack:true,profile,restartPerformed:false}));
}else{
  const releaseFile=path.resolve(process.argv[2]??'');
  if(!inside(releaseFile,path.join(root,'releases')))throw new Error('Release outside rebuild-v5/releases');
  const manifest=JSON.parse(fs.readFileSync(releaseFile,'utf8'));
  if(sha256(fs.readFileSync('E:/deepseek-harness/resources/app.asar'))!==manifest.baselineAsar)throw new Error('Native baseline changed');
  const bootValidation=assertBootAdmission(releaseFile);
  const operations=manifest.replacements.map(item=>{
    const link=path.resolve(modules,item.name),target=path.resolve(item.target);
    if(!inside(target,path.dirname(releaseFile)))throw new Error('Release target escapes release');
    if(sha256(fs.readFileSync(path.join(target,'lib/client.js')))!==item.clientSha256)throw new Error(`Hash mismatch: ${item.name}`);
    return {name:item.name,link,target,previous:checkedLink(link),clientSha256:item.clientSha256,files:item.files};
  });
  const backup=path.join(root,'backups',`install-${new Date().toISOString().replace(/[:.]/g,'-')}`);
  fs.mkdirSync(backup,{recursive:true});
  for(const name of configFiles){
    const input=path.join(profile,name);if(fs.existsSync(input)){const destination=path.join(backup,name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(input,destination);}
  }
  const receipt={version:manifest.version,release:manifest.release,profile,backup,operations,bootValidation:bootValidation.verifiedAt,restartPerformed:false};
  const receiptPath=path.join(backup,'receipt.json');fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
  const changed=[];
  try {
    for(const op of operations){changed.push(op);relink(op.link,op.target);}
    const packageConfig=JSON.parse(fs.readFileSync(config,'utf8'));
    packageConfig.dependencies??={};
    for(const op of operations)packageConfig.dependencies[op.name]=`link:${op.target.replaceAll('\\','/')}`;
    packageConfig.dsh??={};packageConfig.dsh.profile??={};
    packageConfig.dsh.profile.bundles=[...new Set([...(packageConfig.dsh.profile.bundles??[]),'dsh-split'])];
    const temporary=path.join(profile,`.package-v5-${process.pid}.json`);
    fs.writeFileSync(temporary,JSON.stringify(packageConfig,null,2)+'\n');fs.renameSync(temporary,config);
    syncProfileDependencies(profile,path.join(backup,'pnpm-install.log'));
    assertProfileDependencies(profile,operations);
    for(const op of operations)verifyPackageFiles({...op,target:op.link});
  }catch(error){
    for(const op of changed.reverse())relink(op.link,op.previous);
    restoreConfig(backup);throw error;
  }
  fs.writeFileSync(path.join(root,'installed.json'),JSON.stringify({...receipt,receiptPath,installedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({version:manifest.version,installedPackages:operations.length,release:manifest.release,receiptPath,restartPerformed:false}));
}
