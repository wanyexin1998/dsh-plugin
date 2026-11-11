import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createLocalBackend } from '../lib/adapters/local/index.js';
import { verifyExecutable } from '../lib/adapters/local/executable.js';
import { parseLocalSettings } from '../lib/adapters/local/settings.js';
import { processEnvironment } from '../lib/adapters/local/process.js';
import { DEFAULT_LIMITS, parseConfig } from '../lib/shared/config.js';
import { sandbox } from '../scripts/g0/runtime.mjs';

const input = { operationId: 'docs.search', args: { query: '测试', limit: 2 } };
// Windows process startup can exceed short fixture deadlines under a full CI run.
// Keep production limits unchanged; allow readiness before asserting timeout/kill.
const fixtureTimeout = process.platform === 'win32' ? 15000 : 5000;
async function fixture(control = {}, limits = {}) {
  const isolated = await sandbox();
  const trace = join(isolated.root, 'trace.jsonl');
  const childPid = join(isolated.root, 'child.pid');
  const file = join(isolated.root, 'control.json');
  await writeFile(trace, '');
  await writeFile(file, JSON.stringify({ ...control, trace, childPid }));
  let running = 0, maximum = 0;
  const backend = createLocalBackend({ binaryPath: process.execPath, profile: 'test-corp:test-user' }, { ...DEFAULT_LIMITS, timeoutMs: fixtureTimeout, ...limits }, {
    verify: async () => process.execPath,
    environment: { ...isolated.env, MOCK_DWS_CONTROL: file },
    spawn(binary, args, options) {
      assert.equal(binary, process.execPath); assert.equal(options.shell, false);
      running++; maximum = Math.max(maximum, running);
      const child = spawn(binary, [resolve('tests/fixtures/mock-dws.mjs'), ...args], { ...options, stdio: 'pipe' });
      child.on('close', () => { running--; });
      return child;
    },
  });
  return { backend, isolated, childPid, maximum: () => maximum,
    trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async dispose() { await backend.dispose(); await isolated.dispose(); } };
}
async function waitFor(predicate) {
  const end = Date.now() + (process.platform === 'win32' ? 15000 : 4000);
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Fixture did not reach expected state');
}
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('reviewed PAT protocol distinguishes org policy, missing scope and generic data permission without exposing upstream links', async () => {
  for (const [pat, status, reasonCode] of [['PAT_ORG_POLICY_DENIED', 'denied', 'org_policy_denied'], ['PAT_SCOPE_AUTH_REQUIRED', 'auth_required', 'scope_authorization_required'], ['PAT_NO_PERMISSION', 'denied', 'permission_denied']]) {
    const f = await fixture({ pat });
    try { const value = await f.backend.invoke(input); assert.equal(value.status, status); assert.equal(value.reasonCode, reasonCode); assert.ok(!JSON.stringify(value).includes('untrusted.invalid')); }
    finally { await f.dispose(); }
  }
});

test('production discovery rejects absent/tampered binaries; no PATH fallback or private environment inheritance', async () => {
  const isolated = await sandbox();
  try {
    await assert.rejects(verifyExecutable(), { reasonCode: 'cli_missing' });
    const file = join(isolated.root, 'dws.exe'); await writeFile(file, 'not-the-reviewed-binary');
    await assert.rejects(verifyExecutable(file), { reasonCode: 'cli_integrity_failed' });
    for (const settings of [{ binaryPath: 'dws' }, { binaryPath: '\\\\untrusted\\share\\dws.exe' }, { profile: 'corp' }, { profile: 'a:b,c:d' }, { profile: '--bad:a' }, { argv: [] }]) assert.throws(() => parseLocalSettings(settings));
    assert.throws(() => parseConfig({ execution: { timeoutMs: 0 } }));
    const old = process.env.DWS_CLIENT_SECRET; process.env.DWS_CLIENT_SECRET = 'never-inherit';
    try { assert.equal(processEnvironment({}).DWS_CLIENT_SECRET, undefined); }
    finally { if (old === undefined) delete process.env.DWS_CLIENT_SECRET; else process.env.DWS_CLIENT_SECRET = old; }
    assert.equal(processEnvironment({}).DWS_AUDIT, '0');
    assert.equal(processEnvironment({}).DWS_KEYCHAIN_TEST_NAMESPACE, undefined);
  } finally { await isolated.dispose(); }
});

test('three operations use exact Profile, verify identity, redact results, and keep flag-shaped values as data', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.backend.status()).reasonCode, 'business_verification_required');
    for (const request of [{ operationId: 'identity.getSelf', args: {} }, { operationId: 'calendar.listEvents', args: { start: '2026-11-02T00:00:00+08:00', end: '2026-11-03T00:00:00+08:00', limit: 2 } },
      { operationId: 'docs.search', args: { query: '--profile=other; echo injected', cursor: '--base-url=http://invalid' } }]) {
      const result = await f.backend.invoke(request);
      assert.equal(result.status, 'ok', `${request.operationId}: ${result.reasonCode || result.status}`);
      assert.ok(!JSON.stringify(result).includes('test-private'));
    }
    assert.equal((await f.backend.status()).state, 'connected');
    const trace = await f.trace();
    assert.ok(trace.filter(entry => entry.stage !== 'version').every(entry => entry.args.includes('--profile=test-corp:test-user')));
    assert.ok(trace.some(entry => entry.args.includes('--query=--profile=other; echo injected')));
    assert.ok(trace.some(entry => entry.args.includes('--cursor=--base-url=http://invalid')));
    assert.ok(!trace.some(entry => entry.args.includes('--profile=other')));
  } finally { await f.dispose(); }
});

test('unregistered model fields/writes are rejected without spawning a process', async () => {
  const f = await fixture();
  try {
    for (const request of [{ operationId: 'message.send', args: {} }, { operationId: 'identity.getSelf', args: { profile: 'other' } }, { ...input, userId: 'other' }, { operationId: 'docs.search', args: { shell: 'rm' } }]) {
      assert.equal((await f.backend.invoke(request)).reasonCode, 'invalid_request');
    }
    assert.equal((await f.trace()).length, 0);
  } finally { await f.dispose(); }
});

test('official root-level document output supports Chinese and empty searches without invalidating a working binding', async () => {
  const f = await fixture({ flatDocuments: true });
  try {
    for (const args of [{ query: '合成中文' }, {}]) {
      const result = await f.backend.invoke({ operationId: 'docs.search', args });
      assert.equal(result.status, 'ok'); assert.equal(result.data.documents[0].name, '合成中文文档');
      assert.equal(result.data.hasMore, false); assert.equal((await f.backend.status()).state, 'connected');
    }
    const path = join(f.isolated.root, 'control.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...saved, emptyDocuments: true }));
    const empty = await f.backend.invoke(input); assert.equal(empty.status, 'ok'); assert.deepEqual(empty.data.documents, []);
    await writeFile(path, JSON.stringify({ ...saved, badDocuments: true }));
    const malformed = await f.backend.invoke(input); assert.equal(malformed.reasonCode, 'invalid_cli_output'); assert.equal(malformed.retryable, false);
    assert.equal((await f.backend.status()).state, 'connected', 'a query decoding failure must not revoke a verified identity');
  } finally { await f.dispose(); }
});

test('inconclusive snapshot does not become logout or attempt business calls; expiry may refresh in DWS', async () => {
  const f = await fixture({ inconclusive: true });
  try {
    assert.deepEqual(await f.backend.status(), { state: 'unknown', reasonCode: 'connection_unknown' });
    assert.equal((await f.backend.invoke(input)).reasonCode, 'connection_unknown');
    assert.ok(!(await f.trace()).some(entry => entry.stage === 'contact user get-self'));
  } finally { await f.dispose(); }
  const expired = await fixture({ expired: true });
  try {
    assert.equal((await expired.backend.status()).reasonCode, 'token_refresh_pending');
    assert.equal((await expired.backend.invoke(input)).status, 'ok');
  } finally { await expired.dispose(); }
});

test('identity selects the target enterprise and rejects duplicate or conflicting directory IDs', async () => {
  const target = { orgEmployeeModel: { corpId: 'test-corp', userid: 'test-user' } };
  const other = { orgEmployeeModel: { corpId: 'other-corp', userid: 'other-user' } };
  const conflict = { orgEmployeeModel: { ...target.orgEmployeeModel, userId: 'another-user' } };
  for (const [employees, expected] of [[[other, target], 'ok'], [[target, target], 'denied'], [[conflict], 'denied']]) {
    const f = await fixture({ employees });
    try {
      const result = await f.backend.invoke({ operationId: 'identity.getSelf', args: {} });
      assert.equal(result.status, expected);
      assert.ok(!JSON.stringify(result).includes('other-corp'));
      if (expected === 'denied') assert.equal(result.reasonCode, 'identity_mismatch');
    } finally { await f.dispose(); }
  }
});

test('online identity mismatch blocks the requested business operation', async () => {
  const f = await fixture({ wrongIdentity: true });
  try {
    assert.deepEqual(await f.backend.invoke(input), { status: 'denied', reasonCode: 'identity_mismatch', retryable: false });
    assert.ok(!(await f.trace()).some(entry => entry.stage === 'doc search'));
  } finally { await f.dispose(); }
});

test('old CLI, malformed output, and private stderr are normalized without leaking materials or guessing IT denial', async () => {
  for (const [control, code] of [[{ oldVersion: true }, 'cli_version_unsupported'], [{ badJson: true }, 'invalid_cli_output'], [{ error: true }, 'connection_unknown']]) {
    const f = await fixture(control);
    try {
      const result = await f.backend.invoke(input);
      assert.equal(result.reasonCode, code);
      assert.ok(!JSON.stringify(result).includes('test-private'));
      assert.ok(!JSON.stringify(result).includes('/private/path'));
    } finally { await f.dispose(); }
  }
});

test('operations are serialized across status/identity/business subprocesses', async () => {
  const f = await fixture({ delay: 60 }, { queueTimeoutMs: 2 * fixtureTimeout });
  try {
    const result = await Promise.all([f.backend.invoke(input), f.backend.invoke(input), f.backend.invoke(input)]);
    assert.deepEqual(result.map(item => item.status === 'ok' ? 'ok' : item.reasonCode), ['ok', 'ok', 'ok']);
    assert.equal(f.maximum(), 1);
  } finally { await f.dispose(); }
});

test('bounded queue rejects overflow and cancels queued work without spawning it', async () => {
  const f = await fixture({ hang: true }, { queueLimit: 1 });
  const first = new AbortController(), second = new AbortController();
  try {
    const active = f.backend.invoke(input, { signal: first.signal });
    await waitFor(async () => (await f.trace()).some(entry => entry.stage === 'doc search'));
    const queued = f.backend.invoke(input, { signal: second.signal });
    assert.equal((await f.backend.invoke(input)).reasonCode, 'queue_full');
    second.abort(); assert.equal((await queued).reasonCode, 'execution_cancelled');
    first.abort(); assert.equal((await active).reasonCode, 'execution_cancelled');
    assert.equal((await f.trace()).filter(entry => entry.stage === 'doc search').length, 1);
  } finally { await f.dispose(); }
});

test('zero-wait queue releases capacity before a completed call returns', async () => {
  const f = await fixture({}, { queueLimit: 0 });
  try {
    assert.equal((await f.backend.invoke(input)).status, 'ok');
    assert.equal((await f.backend.invoke(input)).status, 'ok');
  } finally { await f.dispose(); }
});

test('queued calls expire without starting and are drained on dispose', async () => {
  const f = await fixture({ hang: true }, { queueTimeoutMs: 60 });
  try {
    const active = f.backend.invoke(input);
    await waitFor(async () => (await f.trace()).some(entry => entry.stage === 'doc search'));
    assert.equal((await f.backend.invoke(input)).reasonCode, 'queue_timeout');
    await f.backend.dispose(); assert.equal((await active).reasonCode, 'execution_cancelled');
    assert.equal((await f.trace()).filter(entry => entry.stage === 'doc search').length, 1);
  } finally { await f.dispose(); }
});

test('timeout and Abort kill the subprocess tree, including a spawned child', async () => {
  for (const abort of [false, true]) {
    const f = await fixture({ spawnChild: true }, { timeoutMs: abort ? fixtureTimeout : process.platform === 'win32' ? 5000 : 1400 });
    const controller = new AbortController();
    try {
      const active = f.backend.invoke(input, { signal: controller.signal });
      let pid;
      await waitFor(async () => { try { pid = Number(await readFile(f.childPid, 'utf8')); return !!pid; } catch { return false; } });
      if (abort) controller.abort();
      assert.equal((await active).reasonCode, abort ? 'execution_cancelled' : 'execution_timeout');
      await waitFor(() => gone(pid));
      for (const entry of await f.trace()) assert.ok(gone(entry.pid));
    } finally { await f.dispose(); }
  }
});

test('combined stdout/stderr byte cap terminates noisy subprocesses', async () => {
  for (const large of ['stdout', 'stderr']) {
    const f = await fixture({ large }, { maxOutputBytes: 1024 });
    try { assert.equal((await f.backend.invoke(input)).reasonCode, 'output_limit_exceeded'); }
    finally { await f.dispose(); }
  }
});
