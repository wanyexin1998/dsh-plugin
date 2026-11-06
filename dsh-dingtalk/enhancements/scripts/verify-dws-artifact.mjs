#!/usr/bin/env node
// Verify and install a pinned official DWS artifact without running it.
// Usage: node scripts/verify-dws-artifact.mjs --archive <file> [--platform linux-x64] [--install-dir <dir>] [--json]
// Requires a prior `pnpm run build` because it reuses the compiled extractor.
import { readFile, writeFile, mkdir, stat, chmod, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(root, 'dws.lock.json'), 'utf8'));
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
const platformKey = option('platform') ?? (process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`);
const archivePath = option('archive');
if (!archivePath) { console.error('usage: verify-dws-artifact.mjs --archive <file> [--platform win32-x64|linux-x64] [--install-dir <dir>] [--json]'); process.exit(2); }
const fail = (message, extra = {}) => { console.error(JSON.stringify({ ok: false, platform: platformKey, error: message, ...extra })); process.exit(1); };
const assetByKey = { 'win32-x64': 'windows-amd64', 'linux-x64': 'linux-amd64' };
const assetPlatform = assetByKey[platformKey];
if (!assetPlatform) fail('platform_not_pinned');
const asset = lock.dws.assets.find(item => item.platform === assetPlatform);
if (!asset) fail('asset_not_in_lock');
const archive = await readFile(archivePath);
const archiveSha = createHash('sha256').update(archive).digest('hex');
if (archive.length !== asset.size) fail('archive_size_mismatch', { expected: asset.size, actual: archive.length });
if (archiveSha !== asset.sha256) fail('archive_sha256_mismatch', { expected: asset.sha256, actual: archiveSha });
const { extractWindowsBinary, extractLinuxBinary } = await import(pathToFileURL(join(root, 'lib/host/bootstrap.js')).href);
let binary;
try { binary = platformKey === 'win32-x64' ? extractWindowsBinary(archive) : extractLinuxBinary(archive); }
catch (error) { fail('binary_extract_failed', { reasonCode: error?.reasonCode }); }
const binarySha = createHash('sha256').update(binary).digest('hex');
const expectedBinary = lock.dws.binaryChecksums[platformKey];
if (!expectedBinary) fail('binary_not_pinned');
if (binarySha !== expectedBinary) fail('binary_sha256_mismatch', { expected: expectedBinary, actual: binarySha });
const installDirectory = option('install-dir');
let installed;
if (installDirectory) {
  const directory = resolve(installDirectory);
  if (!isAbsolute(directory)) fail('install_dir_not_absolute');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  installed = join(directory, platformKey.startsWith('win32') ? 'dws.exe' : 'dws');
  await writeFile(installed, binary, { flag: 'w', mode: platformKey.startsWith('win32') ? 0o700 : 0o755 });
  if (process.platform !== 'win32') await chmod(installed, platformKey.startsWith('win32') ? 0o700 : 0o755);
  const info = await stat(await realpath(installed));
  const expectedMode = process.platform === 'win32' ? undefined : (platformKey.startsWith('win32') ? 0o700 : 0o755);
  if (expectedMode !== undefined && (info.mode & 0o777) !== expectedMode) fail('installed_mode_mismatch', { expectedMode: expectedMode.toString(8), actualMode: (info.mode & 0o777).toString(8) });
  if (expectedMode !== undefined && (info.mode & 0o6000) !== 0) fail('installed_setuid_rejected');
}
const report = {
  ok: true, platform: platformKey, version: lock.dws.version, commit: lock.dws.commit,
  archive: { file: archivePath, size: archive.length, sha256: archiveSha },
  binary: { sha256: binarySha, size: binary.length, ...(installed ? { path: installed } : {}) },
  verified: ['archive_size', 'archive_sha256', 'single_binary_extract', 'binary_sha256', ...(installed ? ['executable_mode', 'no_setuid'] : [])],
};
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(`verified ${platformKey} DWS ${lock.dws.version} archive_sha256=${archiveSha} binary_sha256=${binarySha}${installed ? ` installed=${installed}` : ''}`);
