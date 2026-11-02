import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { run, sandbox } from './g0/runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = resolve(process.env.DSH_TEST_RUNTIME ?? join(root, '../.cache/dingtalk-g0/dsh-runtime'));
const requireDsh = createRequire(join(runtime, 'package.json'));
const dshManifest = requireDsh.resolve('@deepseek-ai/dsh/package.json');
const cli = join(dirname(dshManifest), 'lib/bin.js');
const appBoot = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href);
const isolated = await sandbox();
const checks = [];
const privateConfig = process.env.DSH_DINGTALK_CONFIG_FILE;
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(isolated.root, 'parent-home');
delete process.env.DSH_DINGTALK_CONFIG_FILE;
const artifacts = join(root, 'artifacts');
try {
  assert.ok(process.env.npm_execpath, 'Run using npm run verify:bundle');
  await mkdir(artifacts, { recursive: true });
  const packed = await run(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: root, env: isolated.env, timeoutMs: 180000 });
  assert.equal(packed.code, 0, packed.stderr);
  const [pack] = JSON.parse(packed.stdout);
  assert.equal(pack.name, '@wanyexin1998/dsh-dingtalk');
  const paths = pack.files.map(file => file.path);
  for (const required of ['lib/index.js', 'lib/a2ui.js', 'enhancements/lib/host/index.js', 'enhancements/lib/client.js', 'cordis.patch.yml', 'enhancements/dws.lock.json']) assert.ok(paths.includes(required), required);
  assert.ok(paths.every(path => !/(^|\/)(node_modules|tests|src|\.cache)(\/|$)|\.(exe|zip|log|py)$|\.env/.test(path)));
  checks.push('npm archive contains Host/Client/types/patch/lock/manuals; excludes credentials, tests and CLI binaries');
  const archive = join(artifacts, pack.filename);
  const home = join(isolated.root, 'dsh-home');
  const profileName = 'dingtalk-issue-5';
  const profile = join(home, 'profiles', profileName);
  await mkdir(profile, { recursive: true });
  const original = { name: 'dingtalk-issue-5-test', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  await writeFile(join(profile, 'package.json'), JSON.stringify(original));
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
  isolated.env.DSH_HOME = home;
  async function pluginCommand(args) {
    const result = await run(process.execPath, [cli, 'plugin', '--profile', profileName, ...args], { cwd: isolated.root, env: isolated.env, timeoutMs: 180000 });
    assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-6000));
  }
  await pluginCommand(['add', archive, '--ignore-scripts']);
  const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(installed.dsh.profile.bundles.includes('@wanyexin1998/dsh-dingtalk'));
  const loaded = appBoot.loadProfileDirectory('dsh', profile, dshManifest);
  assert.equal(loaded.skippedBundles.length, 0);
  const entries = appBoot.composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, '@wanyexin1998/dsh-dingtalk'); assert.equal(entries[1].name, '@wanyexin1998/dsh-dingtalk/web');

  checks.push('official dsh plugin add activates the archive Bundle in an isolated clean Profile');
  const installedRoot = await realpath(join(profile, 'node_modules/@wanyexin1998/dsh-dingtalk'));
  const host = await import(pathToFileURL(join(installedRoot, 'enhancements/lib/host/index.js')).href);
  const ctx = new Context();
  try {
    const fiber = await ctx.plugin(host, entries[1].config ?? {});
    const service = ctx.get('dingtalkConnection');
    assert.deepEqual(await service.status(), { state: 'unlinked', reasonCode: 'not_connected' });
    await fiber.dispose();
    assert.equal(ctx.get('dingtalkConnection'), undefined);
    await assert.rejects(service.status(), { reasonCode: 'service_disposed' });
  } finally { await ctx.fiber.dispose(); }
  checks.push('installed archive Host loads and unloads on real Cordis without DSH source changes');
  await pluginCommand(['remove', '@wanyexin1998/dsh-dingtalk']);
  const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(!removed.dsh.profile.bundles.includes('@wanyexin1998/dsh-dingtalk'));
  assert.ok(!removed.dependencies?.['@wanyexin1998/dsh-dingtalk']);
  const after = appBoot.loadProfileDirectory('dsh', profile, dshManifest);
  assert.equal(appBoot.composeEntries([...after.layers.map(layer => layer.patches), after.patches]).length, 0);
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n');
  checks.push('official remove eliminates the dependency and composed entry, preserving the user patch');
  const report = { success: true, classification: 'ISOLATED_PROFILE_AND_RUNTIME', dshVersion: JSON.parse(await readFile(dshManifest, 'utf8')).version,
    pluginVersion: pack.version, archive: pack.filename, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    packageFiles: paths, checks, limitations: ['No real OAuth', 'No assembled Desktop/Web UI or Agent tool', 'No Host-private CLI/profile configured in this archive smoke; G0 remains HOLD'] };
  await writeFile(join(artifacts, 'p0-bundle-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: true, checks: checks.length, archive: pack.filename, classification: report.classification }, null, 2));
} finally { await isolated.dispose(); if (privateConfig !== undefined) process.env.DSH_DINGTALK_CONFIG_FILE = privateConfig; if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; }
