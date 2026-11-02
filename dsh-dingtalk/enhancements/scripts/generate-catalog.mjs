// Generate discovery and policy metadata from the exact, checksum-pinned official binary.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'dws.lock.json'), 'utf8'));
const binary = resolve(process.argv[2] || resolve(root, '../.cache/dingtalk-g0/bin-amd64/dws.exe'));
if (createHash('sha256').update(await readFile(binary)).digest('hex') !== lock.dws.binaryChecksums[`${process.platform}-${process.arch}`]) throw Error('Catalog binary checksum mismatch');
const child = spawnSync(binary, ['schema', '--all', '--format=json'], { windowsHide: true, shell: false, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, DWS_NO_UPDATE_CHECK: '1', DWS_DISABLE_KEYCHAIN: '1', DWS_AUDIT: '0', DWS_CONFIG_DIR: resolve(root, '../.cache/catalog-generation') } });
if (child.status !== 0) throw Error('Official schema export failed');
const schema = JSON.parse(child.stdout.toString('utf8'));
const pick = (v, keys) => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
const products = schema.products.map(p => ({ id: p.id, summary: p.agent_summary, tools: p.tools.map(t => ({
  ...pick(t, ['cli_path', 'canonical_path', 'agent_summary', 'description', 'effect', 'risk', 'confirmation', 'availability', 'interface_mode', 'interface_reason', 'constraints', 'examples', 'use_when', 'avoid_when', 'idempotency']),
  parameters: Object.fromEntries(Object.entries(t.parameters || {}).map(([k,v]) => [k, pick(v, ['type', 'required', 'cli_required', 'required_when', 'description', 'enum', 'default', 'format', 'anyOf'])])),
})) }));
const out = { version: lock.dws.version, commit: lock.dws.commit, surfaceHash: schema.surface_hash, toolCount: schema.tool_count, products };
// Cobra distinguishes CSV StringSlice flags from repeatable StringArray flags.
// The JSON schema calls both "array"; preserve their real argv encoding.
for (const product of products) for (const tool of product.tools) {
  const arrays = Object.entries(tool.parameters).filter(([, p]) => p.type === 'array');
  if (!arrays.length) continue;
  const help = spawnSync(binary, [...tool.cli_path.split(' '), '--help'], { windowsHide: true, shell: false, env: { ...process.env, DWS_CONFIG_DIR: resolve(root, '../.cache/catalog-generation'), DWS_NO_UPDATE_CHECK: '1' }, maxBuffer: 4 * 1024 * 1024 });
  if (help.status !== 0) throw Error(`Cannot inspect flags for ${tool.cli_path}`);
  for (const [key, parameter] of arrays) {
    const kind = help.stdout.toString('utf8').match(new RegExp(`^\\s+(?:-[a-zA-Z], )?--${key}\\s+(\\w+)`, 'm'))?.[1];
    if (!['strings', 'stringArray', 'ints', 'int64s', 'uints', 'float64s', 'bools'].includes(kind)) throw Error(`Unknown array encoding: ${tool.cli_path} --${key}: ${kind}`);
    parameter.cli_encoding = kind === 'stringArray' ? 'repeat' : 'csv';
    parameter.item_type = kind === 'strings' || kind === 'stringArray' ? 'string' : kind === 'bools' ? 'boolean' : 'number';
  }
}
await mkdir(resolve(root, 'src/catalog'), { recursive: true });
await writeFile(resolve(root, 'src/catalog/catalog.json'), JSON.stringify(out) + '\n');
console.log(JSON.stringify({version:out.version,products:products.length,tools:products.reduce((n,p)=>n+p.tools.length,0)}));
