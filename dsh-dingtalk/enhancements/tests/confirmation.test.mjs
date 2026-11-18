import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';
import { catalog } from '../lib/catalog/index.js';
import { parseHostConfig } from '../lib/host/confirmation.js';

test('the Chinese YAML template enables every pinned command without commenting entries out', () => {
  const yaml = execFileSync(process.execPath, ['scripts/confirmation-template.mjs'], { encoding: 'utf8' });
  const config = parse(yaml);
  const names = catalog.products.flatMap(p => p.tools.map(c => c.cli_path));
  assert.match(yaml, /DWS 1[.]0[.]66/);
  assert.doesNotMatch(yaml, /沿用现有规则|: false(?: |$)/m);
  const rows = [...yaml.matchAll(/^  ("(?:[^"\\]|\\.)*"): true # (.+)$/gm)];
  assert.deepEqual(rows.map(row => JSON.parse(row[1])), names);
  assert.ok(rows.every(row => /\p{Script=Han}/u.test(row[2])));
  assert.deepEqual(Object.keys(config.confirmationAllowlist), names);
  assert.ok(Object.values(config.confirmationAllowlist).every(value => value === true));
  assert.deepEqual([...parseHostConfig(config).confirmationAllowlist], names);
});

test('configuration requires exact known command names and literal boolean values', () => {
  const commands = { 'chat message send': true, 'todo task delete': true, 'drive permission add': true, 'doc create': false };
  assert.deepEqual([...parseHostConfig({ confirmationAllowlist: commands }).confirmationAllowlist],
    ['chat message send', 'todo task delete', 'drive permission add']);
  assert.equal(parseHostConfig().confirmationAllowlist.size, 0);
  for (const value of [null, [], { 'doc create': 'true' }, { '*': true }, { 'doc nonexistent': false }]) {
    assert.throws(() => parseHostConfig({ confirmationAllowlist: value }), /confirmationAllowlist/);
  }
});
