import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'lib');
if (dirname(output) !== root || output !== join(root, 'lib')) throw new Error('Unsafe build cleanup path');
await rm(output, { recursive: true, force: true });
await mkdir(output);
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit', shell: false });
if (result.status !== 0) process.exit(result.status ?? 1);
await build({
  entryPoints: [join(root, 'src/client/index.ts')], outfile: join(output, 'client.js'),
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-dingtalk", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
console.log('Built Host ESM/types and DSH platform Client bundle.');
