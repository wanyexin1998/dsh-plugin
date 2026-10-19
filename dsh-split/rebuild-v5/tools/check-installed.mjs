import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {sha256} from './read-asar.mjs';
import {verifyPackageFiles} from './native-package.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const receipt=JSON.parse(fs.readFileSync(path.join(root,'installed.json'),'utf8'));
const config=path.join(receipt.profile,'package.json');
const requireProfile=createRequire(config);
if(!JSON.parse(fs.readFileSync(config,'utf8')).dsh?.profile?.bundles?.includes('dsh-split'))throw new Error('Split bundle is not enabled');
const resolved=receipt.operations.map(op=>{
  verifyPackageFiles({...op,target:op.link});
  const file=requireProfile.resolve(`${op.name}/client`);
  if(sha256(fs.readFileSync(file))!==op.clientSha256)throw new Error(`Profile resolves unexpected bytes: ${op.name}`);
  return {name:op.name,client:file,sha256:op.clientSha256};
});
const plugin=requireProfile('dsh-split');
if(typeof plugin.apply!=='function')throw new Error('Invalid server loader entry');
const result={checkedAt:new Date().toISOString(),version:receipt.version,packages:resolved.length,
  serverEntry:'apply function loaded successfully',resolved,receiptPath:receipt.receiptPath,desktopRestartPerformed:false};
fs.writeFileSync(path.join(root,'evidence/installed-check.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({version:result.version,packages:result.packages,serverEntry:result.serverEntry,matched:true,desktopRestartPerformed:false}));
