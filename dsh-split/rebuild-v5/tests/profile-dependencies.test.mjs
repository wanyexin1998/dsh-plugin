import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {syncProfileDependencies,assertProfileDependencies} from '../tools/profile-dependencies.mjs';

test('a subsequent package-manager operation keeps upgraded local links and matching lockfiles', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-split-install-'));
  try {
    const profile=path.join(root,'profile');fs.mkdirSync(profile);
    const operations=['old','new'].map(version=>{
      const target=path.join(root,version);fs.mkdirSync(target);
      fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'dsh-split',version:version==='old'?'1.0.0':'2.0.0'}));
      return {name:'dsh-split',target};
    });
    const write=operation=>fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'isolated-profile',private:true,dependencies:{'dsh-split':`link:${operation.target.replaceAll('\\','/')}`},dsh:{profile:{bundles:['dsh-split','other-plugin']}}}));
    fs.writeFileSync(path.join(profile,'pnpm-workspace.yaml'),'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    write(operations[0]);syncProfileDependencies(profile);
    write(operations[1]);
    assert.throws(()=>assertProfileDependencies(profile,[operations[1]]),/lock differs/);
    syncProfileDependencies(profile);
    assertProfileDependencies(profile,[operations[1]]);
    // This is the operation that previously reverted the desktop junctions.
    syncProfileDependencies(profile);
    assertProfileDependencies(profile,[operations[1]]);
    assert.equal(path.resolve(fs.realpathSync(path.join(profile,'node_modules/dsh-split'))),operations[1].target);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile,'package.json'))).dsh.profile.bundles,['dsh-split','other-plugin']);
  } finally {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-split-install-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
