import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionSection, ToolView } from '../lib/client/index.js';
function store(status, extra = {}) { const snap = { status, pending: false, checked: true, refreshing: false, ...extra }; return { get: () => snap, subscribe: () => () => {} }; }
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
  assert.match(html, /Connection could not be verified/); assert.match(html, /Refresh status/);
});
test('successful and ordinary failed queries use quiet inline feedback, never connection cards or raw results', () => {
  const html = renderToStaticMarkup(React.createElement(ToolView, { store: store({ state: 'connected' }), phase: 'result', callId: 'test', block: { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', data: '<script>malicious()</script>' }) }] } }));
  assert.match(html, /已完成/); assert.ok(!html.includes('<details')); assert.ok(!html.includes('dsh-dt-card"'));
  assert.ok(!html.includes('malicious'));
  assert.ok(!html.includes('连接钉钉')); assert.ok(!html.includes('解除连接'));
  for (const reasonCode of ['invalid_cli_output', 'queue_timeout', 'execution_timeout', 'service_unavailable']) {
    const failed = renderToStaticMarkup(React.createElement(ToolView, { store: store({ state: 'connected' }), phase: 'result', callId: reasonCode, block: { content: [{ type: 'text', text: JSON.stringify({ status: 'failed', reasonCode, retryable: false }) }] } }));
    assert.ok(!failed.includes('dsh-dt-card"')); assert.ok(!failed.includes('<button')); assert.ok(!failed.includes('连接钉钉'));
  }
});


test('first check and first read failure never suggest reconnecting or start authorization', () => {
  for (const compact of [true, false]) {
    const render = extra => renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'unknown' }, extra), compact }));
    for (const refreshing of [false, true]) {
      const html = render({ checked: false, refreshing });
      assert.match(html, /检查中/);
      assert.doesNotMatch(html, />重连<|aria-label="连接钉钉"/);
      assert.match(html, /aria-busy="true"/);
    }
    const failed = render({ refreshError: 'service_unavailable' });
    assert.match(failed, /连接状态读取失败/);
    assert.match(failed, /aria-label="刷新状态"/);
    assert.doesNotMatch(failed, />重连<|授权已失效|aria-label="连接钉钉"/);
  }
});

test('background refresh and failure retain the account and label historical evidence honestly', () => {
  const status = { state: 'connected', account: { displayName: '示例账号', organizationName: '示例企业' } };
  const checkedAt = '2026-01-01T10:00:00Z';
  for (const extra of [{ refreshing: true }, { refreshError: 'service_unavailable' }, { refreshError: 'execution_timeout' }]) {
    const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store(status, { checkedAt, ...extra }) }));
    assert.match(html, /dsh-dt-account/);
    assert.match(html, /示例账号/); assert.match(html, /示例企业/);
    assert.match(html, /上次确认已连接/); assert.match(html, /上次确认：/);
    assert.match(html, /datetime="2026-01-01T10:00:00Z"/i);
    assert.match(html, extra.refreshing ? /刷新中 · 保留上次确认状态。/ : /读取失败 · 状态待更新，请重试。/);
    assert.doesNotMatch(html, />重连<|aria-label="连接钉钉"/);
  }
  const recovered = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store(status, { checkedAt }) }));
  assert.match(recovered, /钉钉已连接/); assert.doesNotMatch(recovered, /上次确认已连接|读取失败 ·|刷新中 ·/);
  const cancelled = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store(status, { checkedAt, error: 'user_cancelled' }) }));
  assert.match(cancelled, /示例账号/); assert.match(cancelled, /已取消本次授权/);
});

test('compact prompt uses refresh for unknown service health and respects explicit authorization failures', () => {
  for (const reasonCode of [undefined, 'service_unavailable', 'connection_unknown']) {
    const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'unknown', reasonCode }), compact: true }));
    assert.match(html, /aria-label="刷新状态"/); assert.doesNotMatch(html, /aria-label="连接钉钉"|>重连</);
  }
  for (const [state, reasonCode] of [['unlinked', undefined], ['reauth_required', 'authorization_expired'], ['identity_mismatch', 'identity_mismatch']]) {
    const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state, reasonCode }), compact: true }));
    assert.match(html, /aria-label="连接钉钉"/); assert.doesNotMatch(html, /钉钉已连接/);
  }
  const scoped = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'connected' }), compact: true, errorReason: 'scope_authorization_required' }));
  assert.match(scoped, /需要补充数据授权/); assert.match(scoped, /aria-label="连接钉钉"/);
});

test('initial preparation and transaction recovery take priority over first status check', () => {
  for (const [extra, expected] of [[{ checked: false, pending: true, preparing: true }, '正在准备连接'], [{ checked: false, transaction: { transactionId: 'synthetic' }, status: { state: 'authorizing', reasonCode: 'authorization_pending' } }, '等待钉钉授权']]) {
    const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'unknown' }, extra), compact: true }));
    assert.match(html, new RegExp(expected)); assert.match(html, /取消本次授权/); assert.doesNotMatch(html, />检查中<|>重连</);
  }
});

test('checking and stale notices have English translations and live status semantics', () => {
  for (const [extra, expected] of [[{ checked: false }, 'Checking'], [{ checkedAt: '2026-01-01T10:00:00Z', refreshError: 'service_unavailable' }, 'Read failed · Status needs updating. Retry.']]) {
    const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'unknown' }, extra), compact: true, language: 'en' }));
    assert.ok(html.includes(expected)); assert.match(html, /aria-live="polite"/);
  }
});


test('failed revocation shows blocked state and explicit retry, uncertain actions show historical connection', () => {
  for (const compact of [true, false]) {
    const status = { state: 'connected', account: { displayName: '示例账号' } };
    const blocked = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store(status, { error: 'revocation_failed' }), compact }));
    assert.match(blocked, /连接已阻断，撤销尚未完成/); assert.match(blocked, /aria-label="重试解除连接"/);
    assert.doesNotMatch(blocked, /钉钉已连接|可继续刚才的查询。|示例账号/);
    const uncertain = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store(status, { error: 'execution_timeout' }), compact }));
    assert.match(uncertain, /上次确认已连接/); assert.doesNotMatch(uncertain, /可继续刚才的查询。/);
  }
});


test('stale connected compact prompts offer refresh retry without OAuth', () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionSection, { store: store({ state: 'connected' }, { checkedAt: '2026-01-01T10:00:00Z', refreshError: 'service_unavailable' }), compact: true }));
  assert.match(html, /上次确认已连接/); assert.match(html, /aria-label="刷新状态"/);
  assert.doesNotMatch(html, /aria-label="连接钉钉"|>重连</);
});
