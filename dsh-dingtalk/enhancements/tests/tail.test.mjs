import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizationTail } from '../lib/client/tail.js';
const result = (id, status = 'auth_required', reasonCode = 'not_connected') => ({ kind: 'tool-result', name: 'dingtalk_call', callId: id, content: [{ type: 'text', text: JSON.stringify({ status, reasonCode }) }] });
const node = (turn, root, seq = turn) => ({ kind: 'tool-call', anchorSeq: seq, visibility: 'hidden', location: { kind: 'step', turn: { turn } }, data: { root } });
const select = nodes => authorizationTail({ nodes: { values: () => nodes } });
test('folded and nested tool results produce a footer without mounting any ToolView', () => {
  assert.deepEqual(JSON.parse(select([node(2, { kind: 'tool-result', name: 'run_code', subCalls: [result('nested')] })])), { turn: 2, callId: 'nested', reason: 'not_connected' });
});
test('one latest authorization turn; retries retain card identity; ordinary errors do not request authorization', () => {
  const original = node(1, result('first'), 1);
  assert.equal(JSON.parse(select([original, node(1, result('retry'), 2)])).callId, 'first');
  assert.equal(JSON.parse(select([original, node(2, result('later'), 3)])).callId, 'later');
  assert.equal(select([node(1, result('bad', 'failed', 'invalid_cli_output')), node(2, result('ok', 'ok'))]), '');
  assert.equal(select([{ ...original, kind: 'assistant-step' }]), '', 'assistant text must never create an authorization action');
  assert.equal(select([]), '', 'switching to an unrelated session has no prompt');
});
