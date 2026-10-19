import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {openAsar} from '../tools/read-asar.mjs';
import {BASELINES, transformNative} from '../tools/native-patches.mjs';
import {stageNativePackage, verifyPackageFiles} from '../tools/native-package.mjs';

test('every released native host imports in the real Electron runtime with the original exports and dependency identities', () => {
  const archive = openAsar('E:/deepseek-harness/resources/app.asar');
  fs.mkdirSync(path.resolve(import.meta.dirname, '../.boot-check'), {recursive: true});
  const output = fs.mkdtempSync(path.resolve(import.meta.dirname, '../.boot-check/package-'));
  const packages = Object.keys(BASELINES).map(name => {
    const packageName = `@deepseek-ai/dsh-client-ui-${name}`;
    const target = path.join(output, packageName);
    const candidate = transformNative(name, archive.read(`dsh/node_modules/${packageName}/lib/client.js`));
    const record = {name: packageName, target, ...stageNativePackage(archive, packageName, candidate.source, target)};
    verifyPackageFiles(record);
    return record;
  });
  const code = `import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
    const packages=${JSON.stringify(packages.map(({name, target, hostUrl}) => ({name, target, hostUrl})))};
    for(const p of packages){const native=await import(p.hostUrl);const release=await import(pathToFileURL(p.target+'/lib/index.js'));
      assert.deepEqual(Object.keys(release),Object.keys(native),p.name);assert.equal(typeof release.apply,'function',p.name);
      for(const key of Object.keys(native))assert.equal(release[key],native[key],p.name+'/'+key);}
    console.log('Verified '+packages.length+' native host entries');`;
  const result = spawnSync('E:/deepseek-harness/DeepSeek Harness.exe', ['--input-type=module', '-e', code], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Verified 12 native host entries/);
  // Both metadata and host entrypoints are admission-critical, not just client.js.
  const entry = packages[0];
  fs.appendFileSync(path.join(entry.target, 'lib/index.js'), '\n// tampered');
  assert.throws(() => verifyPackageFiles(entry), /Hash mismatch.*index.js/);
});
