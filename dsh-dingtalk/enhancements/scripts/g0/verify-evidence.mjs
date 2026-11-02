import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lock, pluginRoot, sha256 } from './runtime.mjs';

const root = join(pluginRoot, 'docs/evidence/g0');
const manifest = JSON.parse(await readFile(join(root, 'dws/manifest.json'), 'utf8'));
assert.equal(manifest.version, lock.dws.version);
assert.equal(manifest.sourceCommit, lock.dws.commit);
assert.equal(manifest.binarySha256, lock.dws.binaryChecksums['win32-x64']);
assert.equal(manifest.credentialWrites, false);
assert.equal(manifest.commands.length, 13);
for (const command of manifest.commands) {
  assert.match(command.file, /^[\w.-]+\.(txt|json)$/);
  const text = await readFile(join(root, 'dws', command.file), 'utf8');
  assert.equal(sha256(text), command.sha256, `Snapshot changed: ${command.file}`);
  assert.equal(command.exitCode, 0);
}
for (const operation of lock.dws.operations) {
  const schema = JSON.parse(await readFile(join(root, 'dws', operation.operationId + '.schema.json'), 'utf8'));
  assert.equal(schema.effect, 'read');
  assert.equal(schema.availability, 'available');
  assert.equal(schema.canonical_path, operation.canonicalPath);
  assert.equal(schema.cli_path, operation.cliPath.join(' '));
  assert.equal(sha256(await readFile(join(root, 'dws', operation.operationId + '.schema.json'))), operation.schemaSha256);
}
for (const [file, classification, checks] of [
  ['exchange-report.json', 'LOCAL_FIXTURE_ONLY', 6],
  ['upstream-smoke-report.json', 'LOCAL_FIXTURE_ONLY', 6],
  ['dsh-report.json', 'PUBLISHED_RUNTIME_API_ONLY', 4],
]) {
  const text = await readFile(join(root, file), 'utf8');
  const report = JSON.parse(text);
  assert.equal(report.success, true);
  assert.equal(report.classification, classification);
  assert.equal(report.checks.length, checks);
  for (const syntheticSecret of ['g0-fake-code', 'g0-fake-access', 'g0-fake-refresh', 'fixture-code', 'fixture-access', 'fixture-refresh']) {
    assert.ok(!text.includes(syntheticSecret), 'Test material leaked into committed evidence');
  }
}
assert.equal(lock.gate.realEnterpriseOAuth, 'PENDING_USER_TEST');
assert.equal(lock.gate.decision, 'HOLD');
console.log('PASS: 13 snapshot hashes, 3 read-only schemas, 3 scoped evidence reports; real G0 remains HOLD');
