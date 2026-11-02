import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { lock, option, pluginRoot, run, sandbox, sha256, verifiedBinary } from './runtime.mjs';

const binary = await verifiedBinary(option('--binary', resolve(pluginRoot, '../.cache/dingtalk-g0/bin-amd64/dws.exe')));
const output = resolve(option('--out', resolve(pluginRoot, '../.cache/dingtalk-g0/snapshots')));
const workspace = await sandbox();
try {
  await mkdir(output, { recursive: true });
  const commands = [
    ['version', ['--version'], 'txt'],
    ['auth-exchange-help', ['auth', 'exchange', '--help'], 'txt'],
    ['auth-login-help', ['auth', 'login', '--help'], 'txt'],
    ['auth-status-help', ['auth', 'status', '--help'], 'txt'],
    ['auth-logout-help', ['auth', 'logout', '--help'], 'txt'],
    ['auth-exchange-dry-run', ['auth', 'exchange', '--code-stdin', '--client-id', 'default', '--dry-run', '--format', 'json'], 'json'],
    ['auth-status-empty', ['auth', 'status', '--readonly', '--format', 'json'], 'json'],
    ...lock.dws.operations.flatMap(operation => [
      [operation.operationId + '.help', [...operation.cliPath, '--help'], 'txt'],
      [operation.operationId + '.schema', ['schema', operation.schemaPath, '--compact'], 'json'],
    ]),
  ];
  const results = [];
  for (const [name, args, extension] of commands) {
    const result = await run(binary, args, { env: workspace.env, cwd: workspace.root });
    assert.equal(result.code, 0, `${name}: unexpected exit ${result.code}`);
    if (name === 'version') assert.ok(result.stdout.startsWith(`dws version v${lock.dws.version} (${lock.dws.commit},`));
    if (extension === 'json') {
      const json = JSON.parse(result.stdout);
      if (name.endsWith('.schema')) {
        assert.equal(json.effect, 'read');
        assert.equal(json.availability, 'available');
      }
    }
    const filename = `${name}.${extension}`;
    await writeFile(join(output, filename), result.stdout);
    if (result.stderr) await writeFile(join(output, `${name}.stderr.txt`), result.stderr);
    results.push({ name, args, exitCode: result.code, file: filename, sha256: sha256(result.stdout), stderr: result.stderr || null });
  }
  const files = await readdir(workspace.config, { recursive: true });
  assert.ok(files.every(file => file === 'logs' || /^logs[\\/]/.test(file)),
    `Declaration-only commands wrote non-log state: ${files.join(', ')}`);
  const executable = await readFile(binary);
  const machine = process.platform === 'win32' ? executable.readUInt16LE(executable.readUInt32LE(0x3c) + 4) : null;
  if (process.platform === 'win32' && process.arch === 'x64') assert.equal(machine, 0x8664, 'Expected AMD64 PE executable');
  const report = { schemaVersion: 1, version: lock.dws.version, sourceCommit: lock.dws.commit,
    binarySha256: sha256(executable), peMachine: machine,
    platform: process.platform, arch: process.arch, environment: 'isolated; no real credentials; update check disabled',
    classification: 'LOCAL_DECLARATION_ONLY', filesystemEntries: files.map(file => file.replaceAll('\\', '/')), credentialWrites: false, commands: results };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: true, commands: results.length, filesystemEntries: files, credentialWrites: false, output }, null, 2));
} finally { await workspace.dispose(); }
