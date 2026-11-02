import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as host from '../lib/host/index.js';

test('real Cordis: host service loads, fails closed, unloads, and reloads cleanly', async () => {
  const saved = process.env.DSH_DINGTALK_CONFIG_FILE;
  delete process.env.DSH_DINGTALK_CONFIG_FILE;
  const ctx = new Context();
  try {
    for (let i = 0; i < 2; i++) {
      const fiber = await ctx.plugin(host, { mode: 'local' });
      const service = ctx.get('dingtalkConnection');
      assert.deepEqual(await service.status(), { state: 'unknown', reasonCode: 'cli_missing' });
      assert.deepEqual(await service.invoke({ operationId: 'identity.getSelf', args: {} }), { status: 'failed', reasonCode: 'cli_missing', retryable: false });
      await assert.rejects(service.beginAuthorization({}), { reasonCode: 'backend_not_ready' });
      assert.deepEqual(await service.disconnect(), { disconnected: false });
      await fiber.dispose();
      assert.equal(ctx.get('dingtalkConnection'), undefined);
      await assert.rejects(service.status(), { reasonCode: 'service_disposed' });
    }
  } finally { await ctx.fiber.dispose(); if (saved !== undefined) process.env.DSH_DINGTALK_CONFIG_FILE = saved; }
});

test('DSH platform Client registers a real settings slot; unloading leaves existing sections intact', async () => {
  const slots = new SlotCore();
  const owner = slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, () => null);
  const general = slots.register({ name: 'settings.section', id: 'general', order: 0, label: '通用' }, () => null);
  let client;
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, 'dsh-dingtalk');
    client = factory(name => { assert.equal(name, 'react'); return React; });
  } } } });
  const ctx = new Context();
  ctx.provide('slots', slots);
  try {
    for (let i = 0; i < 2; i++) {
      const fiber = await ctx.plugin(client, { mode: 'local' });
      assert.deepEqual(slots.entriesOfSlot('settings.section').map(entry => entry.options.id), ['general', 'dsh-dingtalk']);
      const html = renderToStaticMarkup(React.createElement(client.ConnectionSection, { close() {} }));
      assert.match(html, /连接功能尚未启用/);
      assert.match(html, /disabled=""/);
      assert.ok(!html.includes('已连接'));
      await fiber.dispose();
      assert.deepEqual(slots.entriesOfSlot('settings.section').map(entry => entry.options.id), ['general']);
    }
  } finally { await ctx.fiber.dispose(); general(); owner(); }
});
