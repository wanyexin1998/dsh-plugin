import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

/** Use the desktop's pinned package manager so later plugin operations retain these links. */
export function syncProfileDependencies(profile, logPath) {
  const pnpm = 'E:/deepseek-harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
  const result = spawnSync(process.execPath, [pnpm, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: profile, encoding: 'utf8', windowsHide: true,
    env: {...process.env, CI: 'true'}, maxBuffer: 8 * 1024 * 1024,
  });
  if (logPath) fs.writeFileSync(logPath, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.status !== 0) throw new Error(`Profile dependency synchronization failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
}

/** Check both manifests and the package manager's persisted resolution before reporting success. */
export function assertProfileDependencies(profile, operations) {
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  const locks = ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'];
  for (const operation of operations) {
    const expected = `link:${operation.target.replaceAll('\\', '/')}`;
    if (config.dependencies?.[operation.name] !== expected) throw new Error(`Profile manifest differs: ${operation.name}`);
    for (const file of locks) {
      const text = fs.readFileSync(path.join(profile, file), 'utf8');
      const key = operation.name.startsWith('@') ? `'${operation.name}'` : operation.name;
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const block = text.match(new RegExp(`^      ${escaped}:\\r?\\n        specifier: ([^\\r\\n]+)\\r?\\n        version: ([^\\r\\n]+)`, 'm'));
      const version = block?.[2];
      if (block?.[1] !== expected || !version?.startsWith('link:') || path.resolve(profile, version.slice(5)).toLowerCase() !== path.resolve(operation.target).toLowerCase()) throw new Error(`Profile lock differs: ${file}/${operation.name}`);
    }
  }
}
