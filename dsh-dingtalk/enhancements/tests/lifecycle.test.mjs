import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as host from '../lib/host/index.js';
import { sandbox } from '../scripts/g0/runtime.mjs';

test('real Cordis: host service loads, fails closed, unloads, and reloads cleanly', async () => {
  const saved = process.env.DSH_DINGTALK_CONFIG_FILE;
  const previousHome = process.env.DSH_HOME;
  const isolated = await sandbox(); process.env.DSH_HOME = isolated.root;
  delete process.env.DSH_DINGTALK_CONFIG_FILE;
  const ctx = new Context();
  try {
    for (let i = 0; i < 2; i++) {
      const fiber = await ctx.plugin(host, { mode: 'local' });
      const service = ctx.get('dingtalkConnection');
      assert.deepEqual(await service.status(), { state: 'unlinked', reasonCode: 'not_connected' });
      assert.deepEqual(await service.invoke({ operationId: 'identity.getSelf', args: {} }), { status: 'auth_required', reasonCode: 'not_connected' });
      await assert.rejects(service.beginAuthorization({}), { reasonCode: 'invalid_request' });
      await assert.rejects(service.disconnect(), { reasonCode: 'invalid_request' });
      await fiber.dispose();
      assert.equal(ctx.get('dingtalkConnection'), undefined);
      await assert.rejects(service.status(), { reasonCode: 'service_disposed' });
    }
  } finally { await ctx.fiber.dispose(); await isolated.dispose(); if (saved !== undefined) process.env.DSH_DINGTALK_CONFIG_FILE = saved; if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; }
});

test('DSH platform Client registers a real settings slot; unloading leaves existing sections intact', async () => {
  const slots = new SlotCore();
  const owner = slots.register({ name: 'root', children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' }, 'settings.section': { kind: 'list', scope: 'root' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } }, () => null);
  const general = slots.register({ name: 'settings.section', id: 'general', order: 0, label: '通用' }, () => null);
  let client;
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { AbortController, clearTimeout, window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, '@wanyexin1998/dsh-dingtalk');
    client = factory(name => { assert.equal(name, 'react'); return React; });
  } } } });
  const ctx = new Context();
  ctx.provide('slots', slots);
  ctx.provide('connection', { rpc: { call: async () => ({ ok: false }) } });
  ctx.provide('locale', { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} });
  try {
    for (let i = 0; i < 2; i++) {
      const fiber = await ctx.plugin(client, { mode: 'local' });
      assert.deepEqual(slots.entriesOfSlot('settings.section').map(entry => entry.options.id), ['general', 'dsh-dingtalk']);
      const html = renderToStaticMarkup(React.createElement(client.ConnectionSection, { store: { subscribe() { return () => {}; }, get() { return { status: { state: 'unlinked', reasonCode: 'not_connected' } }; } } }));
      assert.match(html, /尚未连接钉钉/);
      assert.equal(slots.entriesOfSlot('tool.call.toolview')[0].options.key, 'dingtalk_call');
      assert.deepEqual(slots.entriesOfSlot('conversation.chat.turnTail').map(entry => entry.options.id), ['dsh-dingtalk-authorization']);
      assert.ok(!html.includes('已连接'));
      await fiber.dispose();
      assert.deepEqual(slots.entriesOfSlot('settings.section').map(entry => entry.options.id), ['general']);
      assert.equal(slots.entriesOfSlot('conversation.chat.turnTail').length, 0);
    }
  } finally { await ctx.fiber.dispose(); general(); owner(); }
});
