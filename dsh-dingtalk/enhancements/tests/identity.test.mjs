import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, officialFixtureSkip } from '../scripts/p0-fixture.mjs';

test('Host identity entry shares the Web authorization and never uses another enterprise or user', { skip: officialFixtureSkip }, async () => {
  const f = await fixture();
  const principal = { corpId: 'test-corp', userId: 'test-user' };
  const input = { operationId: 'calendar.listEvents', args: {} };
  try {
    assert.equal((await f.managed.invokeFor(principal, input)).status, 'auth_required');
    assert.equal((await f.authorize()).state, 'connected');
    const before = f.events.length;
    for (const actor of [{ ...principal, userId: 'other-user' }, { ...principal, corpId: 'other-corp' }, {}, null]) {
      assert.equal((await f.managed.invokeFor(actor, input)).reasonCode, 'identity_mismatch');
    }
    assert.equal(f.events.length, before, 'mismatches must not reach DWS');
    assert.equal((await f.managed.invokeFor(principal, input)).status, 'ok');
    assert.equal((await f.managed.invokeFor(principal, { operationId: 'dws.catalog', args: {} })).status, 'ok');
    assert.equal((await f.service.invoke(input)).status, 'ok');
    assert.ok(f.events.filter(e => e.name === 'list_calendar_events').every(e => e.user === 'test-user'));
    await f.restart();
    assert.equal((await f.managed.invokeFor(principal, input)).status, 'ok');
    await f.managed.ui('test-browser', f.context, () => f.service.disconnect());
    assert.equal((await f.managed.invokeFor(principal, input)).status, 'auth_required');
  } finally { await f.dispose(); }
});

test('IM approval is native, and a pending approval cannot survive disconnect or reauthorization', { skip: officialFixtureSkip }, async () => {
  const f = await fixture({ automatic: true, install: false });
  const principal = { corpId: 'test-corp', userId: 'test-user' };
  const input = { operationId: 'dws.execute', args: { command: 'todo task create', parameters: { title: '合成测试', executors: 'test-user' } } };
  try {
    await f.authorize();
    assert.equal((await f.managed.invokeFor(principal, input)).reasonCode, 'confirmation_required');
    assert.equal((await f.managed.invokeFor(principal, input, { approve: async () => false })).reasonCode, 'confirmation_rejected');
    let confirm, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const pending = f.managed.invokeFor(principal, input, { approve: () => { entered(); return new Promise(resolve => { confirm = resolve; }); } });
    await waiting;
    await f.managed.ui('test-browser', f.context, () => f.service.disconnect());
    f.state.user = 'other-user';
    await f.authorize();
    confirm(true);
    assert.equal((await pending).reasonCode, 'confirmation_rejected');
    assert.equal((await f.managed.invokeFor(principal, input)).reasonCode, 'identity_mismatch');
    assert.ok(!f.events.some(e => e.type === 'write'));
    const allowed = await f.managed.invokeFor({ ...principal, userId: 'other-user' }, input, { approve: async () => true });
    assert.equal(allowed.status, 'ok');
    assert.ok(f.events.filter(e => e.type === 'write').every(e => e.user === 'other-user'));
  } finally { await f.dispose(); }
});
