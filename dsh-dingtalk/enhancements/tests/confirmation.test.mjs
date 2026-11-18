import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';
import { catalog } from '../lib/catalog/index.js';
import { parseHostConfig } from '../lib/host/confirmation.js';

test('the Chinese YAML template lists each pinned DWS command exactly once with no defaults enabled', () => {
  const yaml = execFileSync(process.execPath, ['scripts/confirmation-template.mjs'], { encoding: 'utf8' });
  const config = parse(yaml);
  const names = catalog.products.flatMap(p => p.tools.map(c => c.cli_path));
  assert.match(yaml, /DWS 1[.]0[.]66/);
  assert.deepEqual(Object.keys(config.confirmationAllowlist), names);
  assert.ok(Object.values(config.confirmationAllowlist).every(v => v === false));
  assert.equal(parseHostConfig(config).confirmationAllowlist.size, 0);
  const switchable = yaml.split(String.fromCharCode(10)).filter(line => line.includes(': false # 可免确认：'));
  assert.deepEqual(switchable.map(line => JSON.parse(line.slice(2, line.indexOf(': false #')))).sort(),
    ['aitable base create', 'doc create', 'todo tag create']);
});

test('only exact reviewed command names can be enabled by Host booleans', () => {
  const command = 'doc create';
  assert.deepEqual([...parseHostConfig({ confirmationAllowlist: { [command]: true, 'doc search': false } }).confirmationAllowlist], [command]);
  assert.equal(parseHostConfig().confirmationAllowlist.size, 0);
  for (const value of [null, [], { [command]: 'true' }, { '*': true }, { 'doc nonexistent': false }]) {
    assert.throws(() => parseHostConfig({ confirmationAllowlist: value }), /confirmationAllowlist/);
  }
  for (const name of ['aitable create', 'chat message send', 'todo task delete', 'drive permission add', 'doc search']) {
    assert.throws(() => parseHostConfig({ confirmationAllowlist: { [name]: true } }), /not eligible/);
  }
});
