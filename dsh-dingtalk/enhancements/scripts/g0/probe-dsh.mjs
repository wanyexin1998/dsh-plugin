import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { option, pluginRoot, run, sandbox, sha256 } from './runtime.mjs';

// A published DSH installation, not the Cellgent workspace or user's active Profile.
const runtime = resolve(option('--runtime', resolve(pluginRoot, '../.cache/dingtalk-g0/dsh-runtime')));
const output = resolve(option('--out', resolve(pluginRoot, '../.cache/dingtalk-g0/dsh-report.json')));
const requireRuntime = createRequire(join(runtime, 'package.json'));
const slotRuntime = resolve(option('--slot-runtime', resolve(pluginRoot, '../.cache/dingtalk-g0/slot-runtime')));
const requireSlots = createRequire(join(slotRuntime, 'package.json'));
const resolver = name => name.startsWith('@deepseek-ai/dsh-client-ui-slots') ? requireSlots : requireRuntime;
const load = name => import(pathToFileURL(resolver(name).resolve(name)).href);
const packages = ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-client-ui-settings'];
const manifests = [];
for (const name of packages) {
  const path = resolver(name).resolve(name + '/package.json');
  const text = await readFile(path, 'utf8');
  const pkg = JSON.parse(text);
  manifests.push({ name, version: pkg.version, manifestSha256: sha256(text) });
}
assert.equal(manifests[0].version, '0.2.1-rc.5', 'DSH target version drifted');
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: ToolRuntime, defineTool } = await load('@deepseek-ai/dsh-tools');
const { SlotCore } = await load('@deepseek-ai/dsh-client-ui-slots');
const checks = [];
const ctx = new Context();
const test = await sandbox();
try {
  // CLI version is executed from an empty temporary cwd and DSH_HOME.
  test.env.DSH_HOME = join(test.root, 'dsh-home');
  const cli = join(dirname(requireRuntime.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
  const version = await run(process.execPath, [cli, '--version'], { env: test.env, cwd: test.root });
  assert.equal(version.code, 0);
  assert.ok(version.stdout.includes('0.2.1-rc.5'));
  checks.push('published DSH CLI boots --version with isolated DSH_HOME');
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const tool = defineTool({
    name: 'dingtalk_g0_probe', description: 'G0 test-only auth-required projection',
    parameters: { operationId: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => JSON.stringify({ status: 'auth_required', reasonCode: 'test_only' }),
  });
  const owner = await ctx.plugin({ name: 'dingtalk-g0-probe-owner', inject: ['tools'], apply(scope) { scope.tools.register(tool); } });
  assert.ok(ctx.tools.schemas().some(schema => schema.name === tool.name));
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: 'g0-probe', name: tool.name, arguments: { operationId: 'identity.getSelf' } });
  assert.equal(JSON.parse(result.content[0].text).status, 'auth_required');
  checks.push('real ToolRuntime registers and executes a synthetic auth_required tool');
  await owner.dispose();
  assert.ok(!ctx.tools.schemas().some(schema => schema.name === tool.name));
  checks.push('disposing the Cordis owner unregisters the tool');

  // Exercise the real SlotCore API. Owners are declared here for an isolated
  // registry test; this does not claim the assembled UI has rendered these seats.
  const slots = new SlotCore();
  const releaseOwner = slots.register({ name: 'root', children: {
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'settings.section': { kind: 'list', scope: 'root' },
  } }, () => null);
  const card = slots.register({ name: 'tool.call.toolview', key: tool.name }, () => null);
  const settings = slots.register({ name: 'settings.section', id: 'dingtalk-g0', label: '钉钉连接' }, () => null);
  assert.equal(slots.entriesOfSlot('tool.call.toolview').length, 1);
  assert.equal(slots.entriesOfSlot('settings.section').length, 1);
  card(); settings();
  assert.equal(slots.entriesOfSlot('tool.call.toolview').length, 0);
  assert.equal(slots.entriesOfSlot('settings.section').length, 0);
  releaseOwner();
  checks.push('real SlotCore supports keyed tool cards and list settings; disposers clear both');

  const contractChecks = [];
  for (const [name, key] of [['@deepseek-ai/dsh-client-ui-tool', 'tool.call.toolview'], ['@deepseek-ai/dsh-client-ui-settings', 'settings.section']]) {
    const base = dirname(requireRuntime.resolve(name + '/package.json'));
    const types = join(base, 'lib/types/client/contract/slots.d.ts');
    const text = await readFile(types, 'utf8');
    assert.ok(text.includes(`'${key}'`));
    contractChecks.push({ package: name, key, path: 'lib/types/client/contract/slots.d.ts', sha256: sha256(text) });
  }
  const report = { success: true, classification: 'PUBLISHED_RUNTIME_API_ONLY', packages: manifests, checks, contractChecks,
    limitations: ['No desktop application launched', 'No assembled browser UI or OAuth callback tested', 'No model/provider requested', 'No user Profile modified', 'Not a G0/G1 acceptance PASS'] };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: true, checks: checks.length, classification: report.classification, output }, null, 2));
} finally { try { await ctx.fiber.dispose(); } finally { await test.dispose(); } }
