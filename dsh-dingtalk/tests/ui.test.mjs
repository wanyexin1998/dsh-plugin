import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionSection, ToolView } from '../lib/client/index.js';
function store(status) { const snap = { status, pending: false }; return { get: () => snap, subscribe: () => () => {} }; }
test('settings and compact cards cover structured states without exposing internal identities', () => {
  for (const [state, reasonCode, expected] of [
    ['unlinked', 'not_connected', '尚未连接钉钉'], ['authorizing', 'authorization_pending', '等待钉钉授权'],
    ['unknown', 'connection_unknown', '暂无法确认连接'], ['reauth_required', 'authorization_expired', '授权已失效'],
    ['identity_mismatch', 'identity_mismatch', '授权账号不一致'], ['org_cli_disabled', 'org_cli_disabled', '企业尚未开通 CLI 权限'],
    ['unknown', 'org_policy_denied', '组织数据权限策略限制'], ['unknown', 'scope_authorization_required', '需要补充数据授权'],
    ['user_cancelled', 'user_cancelled', '已取消本次授权'], ['auth_timeout', 'auth_timeout', '授权已超时'],
  ]) {
    for (const compact of [true, false]) {
      const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state, reasonCode }), compact }));
      assert.ok(html.includes(expected)); assert.ok(!html.includes('钉钉已连接'));
      if (compact) { assert.ok(!html.includes('解除连接')); assert.ok(!html.includes('可用能力：')); }
    }
  }
  const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'unknown', reasonCode: 'connection_unknown' }), language: 'en' }));
  assert.match(html, /Connection could not be verified/); assert.match(html, /Connect DingTalk/);
});
test('result cards default to collapsed text, escape remote markup, and do not render connection management', () => {
  const html = renderToStaticMarkup(React.createElement(ToolView, { store: store({ state: 'connected' }), phase: 'result', callId: 'test', block: { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', data: '<script>malicious()</script>' }) }] } }));
  assert.match(html, /<details/); assert.ok(!html.includes('<details open'));
  assert.ok(!html.includes('<script>malicious')); assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('连接钉钉')); assert.ok(!html.includes('解除连接'));
});
