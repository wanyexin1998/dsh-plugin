import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';
import { catalog } from '../lib/catalog/index.js';
import { parseHostConfig } from '../lib/host/confirmation.js';

test('the Chinese YAML template lists every pinned command and only activates reviewed entries', () => {
  const yaml = execFileSync(process.execPath, ['scripts/confirmation-template.mjs'], { encoding: 'utf8' });
  const config = parse(yaml);
  const names = catalog.products.flatMap(p => p.tools.map(c => c.cli_path));
  const expected = ['aitable base create', 'doc create', 'todo tag create'];
  assert.match(yaml, /DWS 1[.]0[.]66/);
  assert.doesNotMatch(yaml, /沿用现有规则|: false(?: |$)/m);
  const rows = [...yaml.matchAll(/^  (?:# )?("(?:[^"\\]|\\.)*"): true # (.+)$/gm)];
  assert.deepEqual(rows.map(row => JSON.parse(row[1])), names);
  assert.ok(rows.every(row => /\p{Script=Han}/u.test(row[2])));
  assert.deepEqual(Object.keys(config.confirmationAllowlist).sort(), expected);
  assert.ok(Object.values(config.confirmationAllowlist).every(value => value === true));
  assert.deepEqual([...parseHostConfig(config).confirmationAllowlist].sort(), expected);
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
