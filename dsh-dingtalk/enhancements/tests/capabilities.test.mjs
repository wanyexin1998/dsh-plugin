import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { catalog, discover, describe, integration } from '../lib/catalog/index.js';
import { prepareCommand } from '../lib/adapters/local/command.js';
import { CommandJobs } from '../lib/adapters/local/jobs.js';
import { createLocalBackend } from '../lib/adapters/local/index.js';
import { createConnectionService } from '../lib/shared/service.js';
import { parseInvokeInput, publicInvokeResult } from '../lib/shared/validation.js';
import { DEFAULT_LIMITS } from '../lib/shared/config.js';
import { dingtalkTool } from '../lib/host/tool.js';
import { fixture as officialFixture, officialFixtureSkip } from '../scripts/p0-fixture.mjs';

const commands = catalog.products.flatMap(p => p.tools);
const read = { operationId: 'dws.execute', args: { command: 'doc search', parameters: { query: '中文文档' } } };
const write = { operationId: 'dws.execute', args: { command: 'todo task create', parameters: { title: '合成测试', executors: 'synthetic-user' } } };
async function fixture(control = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capabilities-'));
  const trace = join(root, 'trace.jsonl'), config = join(root, 'control.json');
  await writeFile(trace, ''); await writeFile(config, JSON.stringify({ ...control, trace }));
  const backend = createLocalBackend({ binaryPath: process.execPath, profile: 'test-corp:test-user', configDirectory: join(root, 'private') }, { ...DEFAULT_LIMITS, timeoutMs: 15000 }, {
    verify: async () => process.execPath,
    environment: { ...process.env, MOCK_DWS_CONTROL: config },
    spawn(binary, args, options) { assert.equal(options.shell, false); return spawn(binary, [resolve('tests/fixtures/mock-dws.mjs'), ...args], { ...options, stdio: 'pipe' }); },
  });
  const owner = createConnectionService(backend);
  return { root, service: owner.service, trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse), async dispose() { await owner.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('all official commands remain discoverable and public schemas survive the real service projection', () => {
  assert.equal(catalog.version, '1.0.66'); assert.equal(catalog.products.length, 33); assert.equal(commands.length, 1540);
  assert.equal(new Set(commands.map(t => t.cli_path)).size, 1540);
  assert.equal(commands.filter(t => integration(t) === 'upstream_unavailable').length, 31);
  assert.match(describe('doc search').agent_summary, /搜索文档/);
  for (const command of commands) {
    publicInvokeResult({ status: 'ok', data: describe(command.cli_path) });
    for (const p of Object.values(command.parameters)) if (p.type === 'array') assert.ok(['csv', 'repeat'].includes(p.cli_encoding));
  }
  publicInvokeResult({ status: 'ok', data: discover({}) });
  for (const product of catalog.products) {
    let offset = 0, found = [];
    do { const page = discover({ product: product.id, offset, limit: 30 }); found.push(...page.commands); offset = page.nextOffset; } while (offset !== null);
    assert.equal(found.length, product.tools.length);
  }
});

test('unknown commands, credentials, injected flags and invalid types cannot reach execution', async () => {
  for (const args of [
    { command: 'auth logout', parameters: {} },
    { command: 'doc search; whoami', parameters: {} },
    { command: 'doc search', parameters: { profile: 'other:user' } },
    { command: 'doc search', parameters: { limit: '2' } },
    { command: 'doc search', parameters: { query: 2 } },
    { command: 'doc search', parameters: { extensions: [4] } },
    { command: 'doc search', parameters: { query: '@../private.json' } },
    { command: 'todo task create', parameters: { title: 'missing executor' } },
  ]) await assert.rejects(prepareCommand(args, 'test-corp:test-user', {}));
  for (const command of commands.filter(t => integration(t) !== 'available')) await assert.rejects(prepareCommand({ command: command.cli_path, parameters: {} }, 'test-corp:test-user', {}));
  assert.throws(() => parseInvokeInput({ ...write, args: { ...write.args, confirmed: true } }));
  const ready = await prepareCommand({ command: 'doc search', parameters: { query: '--profile=other; echo bad', extensions: ['pdf', 'a,b'] } }, 'test-corp:test-user', {});
  assert.ok(ready.argv.includes('--query=--profile=other; echo bad'));
  assert.ok(ready.argv.includes('--extensions=pdf,"a,b"'));
  assert.ok(ready.argv.includes('--profile=test-corp:test-user'));
  const camel = await prepareCommand({ command: 'attendance schedule import', parameters: { groupId: 'synthetic-group', scheduleVOS: '[]' } }, 'test-corp:test-user', {});
  assert.ok(camel.argv.includes('--groupId=synthetic-group'));
  const field = await prepareCommand({ command: 'aitable +field-create', parameters: { 'base-id': 'base-test', 'table-id': 'table-test', fields: JSON.stringify([{ fieldName: '示例', type: 'text' }]) } }, 'test-corp:test-user', {});
  assert.ok(field.argv.some(arg => arg.startsWith('--fields=[')));
  const exported = await prepareCommand({ command: 'aitable +export-data', parameters: { 'base-id': 'base-test', format: 'excel' } }, 'test-corp:test-user', { workingDirectory: process.cwd() });
  assert.ok(exported.argv.includes('--format=excel')); assert.ok(!exported.argv.includes('--format=json'));
});

test('workspace files use safe relative paths and reject escape, protected files and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'));
  try {
    await mkdir(join(root, 'private')); await writeFile(join(root, 'sample.json'), '[]');
    const prepare = file => prepareCommand({ command: 'aicard lint', parameters: { file } }, 'test-corp:test-user', { workingDirectory: root }, join(root, 'private'));
    const ready = await prepare(join(root, 'sample.json'));
    assert.ok(ready.argv.includes('--file=sample.json')); assert.equal(ready.needsApproval, true);
    for (const file of ['../outside.json', '.env', '.git/config', 'private/token.json', '-', 'sample.json:stream']) await assert.rejects(prepare(file), { reasonCode: 'file_access_denied' });
    await symlink(join(root, 'private'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepare('linked/secret.json'), { reasonCode: 'file_access_denied' });
    const calendar = await prepareCommand({ command: 'calendar attachment add', parameters: { event: 'synthetic', files: 'file-id:report.pdf' } }, 'test-corp:test-user', {});
    assert.ok(calendar.argv.includes('--files=file-id:report.pdf'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native approval is mandatory for writes; rejected or absent approval spawns nothing', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.invoke(write)).reasonCode, 'confirmation_required');
    assert.equal((await f.service.invoke(write, { approve: async () => false })).reasonCode, 'confirmation_rejected');
    assert.equal((await f.trace()).length, 0);
    const signal = new AbortController().signal, agent = { id: 'agent-1', session: { id: 'session-1' } };
    let approved = 0;
    const tool = dingtalkTool(f.service, () => ({ workingDirectory: { get: () => f.root }, approval: { request: async request => { assert.equal(request.agent, agent); assert.equal(request.signal, signal); assert.equal(request.callId, 'call-1'); assert.match(request.reason, /todo task create/); approved++; return 'allowed-once'; } } }));
    const result = await tool.execute(write, { agent, signal, callId: 'call-1' });
    assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(approved, 1);
    const trace = await f.trace(); assert.ok(trace.some(x => x.stage === 'contact user get-self'));
    const sent = trace.find(x => x.stage === 'todo task create'); assert.ok(sent.args.includes('--yes'));
    assert.ok(!JSON.stringify(result).includes('test-private'));
  } finally { await f.dispose(); }
});

test('generic reads use bound identity; mismatch prevents writes even after approval', async () => {
  const f = await fixture();
  try { assert.equal((await f.service.invoke(read)).status, 'ok'); assert.equal((await f.service.status()).state, 'connected'); }
  finally { await f.dispose(); }
  const wrong = await fixture({ wrongIdentity: true });
  try { assert.equal((await wrong.service.invoke(write, { approve: async () => true })).reasonCode, 'identity_mismatch'); assert.ok(!(await wrong.trace()).some(t => t.stage === 'todo task create')); }
  finally { await wrong.dispose(); }
});

test('cancelled approval cannot execute, and file paths are checked again after the decision', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const cancelled = await f.service.invoke(write, { signal: controller.signal, approve: async () => { controller.abort(); return true; } });
    assert.equal(cancelled.reasonCode, 'execution_cancelled'); assert.equal((await f.trace()).length, 0);
    await mkdir(join(f.root, 'input')); await mkdir(join(f.root, 'private'));
    const result = await f.service.invoke({ operationId: 'dws.execute', args: { command: 'aicard lint', parameters: { file: 'input/file.json' } } }, { workingDirectory: f.root, approve: async () => {
      await rm(join(f.root, 'input'), { recursive: true });
      await symlink(join(f.root, 'private'), join(f.root, 'input'), process.platform === 'win32' ? 'junction' : 'dir'); return true;
    } });
    assert.equal(result.reasonCode, 'file_access_denied'); assert.equal((await f.trace()).length, 0);
  } finally { await f.dispose(); }
});

test('ambiguous writes report unknown outcome with no automatic retry', async () => {
  const f = await fixture({ badJson: true });
  try { const result = await f.service.invoke(write, { approve: async () => true }); assert.equal(result.reasonCode, 'outcome_unknown'); assert.equal(result.retryable, false); assert.equal((await f.trace()).filter(t => t.stage === 'todo task create').length, 1); }
  finally { await f.dispose(); }
});

test('jobs isolate sessions, bound retained events, cancel and dispose their processes', async () => {
  const jobs = new CommandJobs(); let stopped = 0;
  const execute = (signal, emit) => new Promise((resolve, reject) => { for (let i = 0; i < 115; i++) emit({ i, access_token: 'private-test' }); signal.addEventListener('abort', () => { stopped++; reject(Error('stopped')); }, { once: true }); });
  try {
    const first = jobs.start('session-a', 'event consume', execute); await Promise.resolve();
    assert.deepEqual(await jobs.access('session-b', { action: 'list' }), { jobs: [] });
    await assert.rejects(jobs.access('session-b', { action: 'stop', jobId: first.jobId }), { reasonCode: 'job_not_found' });
    const read = await jobs.access('session-a', { action: 'read', jobId: first.jobId }); assert.equal(read.records.length, 10); assert.equal(read.truncated, true); assert.equal(read.nextCursor, 25); assert.ok(!JSON.stringify(read).includes('private-test'));
    const stoppedJob = await jobs.access('session-a', { action: 'stop', jobId: first.jobId }); assert.equal(stoppedJob.state, 'stopped');
    for (let i = 0; i < 4; i++) jobs.start('session-a', 'event consume', execute);
    assert.throws(() => jobs.start('session-a', 'event consume', execute), { reasonCode: 'job_limit' });
    await Promise.resolve();
  } finally { await jobs.dispose(); }
  assert.equal(stopped, 5);
});

test('real subprocess NDJSON supports split UTF-8, job ownership and cancellation', async () => {
  const f = await fixture({ stream: true, hang: true });
  try {
    const result = await f.service.invoke({ ...read, args: { ...read.args, background: true } }, { sessionId: 'a', approve: async () => true });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const input = { operationId: 'dws.jobs', args: { action: 'read', jobId: result.data.jobId } };
    assert.equal((await f.service.invoke(input, { sessionId: 'b' })).reasonCode, 'job_not_found');
    let data;
    for (let i = 0; i < 100; i++) { data = await f.service.invoke(input, { sessionId: 'a' }); if (data.data?.records.length) break; await new Promise(r => setTimeout(r, 30)); }
    assert.equal(data.data.records[0].data.text, '合成中文事件'); assert.ok(!JSON.stringify(data).includes('test-private'));
    const stopped = await f.service.invoke({ ...input, args: { ...input.args, action: 'stop' } }, { sessionId: 'a' });
    assert.equal(stopped.data.state, 'stopped');
  } finally { await f.dispose(); }
});

test('pinned official CLI performs generic read/write through synthetic OAuth and MCP endpoints', { skip: officialFixtureSkip }, async () => {
  const f = await officialFixture();
  try {
    assert.equal((await f.service.invoke({ operationId: 'dws.catalog', args: {} })).status, 'ok');
    await f.authorize();
    const result = await f.service.invoke({ ...read, args: { ...read.args, parameters: { query: '合成目录', extensions: ['pdf', 'docx'] } } });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const search = f.events.find(e => e.name === 'search_documents');
    assert.ok(JSON.stringify(search.arguments).includes('pdf')); assert.ok(!JSON.stringify(search.arguments).includes('[\\"pdf'));
    const created = await f.service.invoke(write, { approve: async () => true });
    assert.equal(created.status, 'ok', JSON.stringify(created));
    assert.ok(f.events.some(e => e.type === 'write' && e.name === 'create_personal_todo'));
    assert.deepEqual(f.failures, []);
  } finally { await f.dispose(); }
});
