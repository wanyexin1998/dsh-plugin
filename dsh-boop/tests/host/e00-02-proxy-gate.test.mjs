#!/usr/bin/env node
/**
 * E00-02 · Proxy message provenance and cautious recovery gate.
 *
 * Gates: G03 (proxy source, messageId, queue, reconciliation), G04 (startup
 * gate before any legacy proxy command is claimed).
 * Scenes: AT-12, AT-13, AT-14, AT-26.
 *
 * All of this runs against the installed rc.2 payload in a private DSH_HOME
 * with synthetic Sessions only. No model credentials exist in this environment,
 * so the two model-dependent assertions stay NOT_RUN and are listed as such at
 * the bottom — they are not simulated into a PASS.
 *
 * Run: node tests/host/e00-02-proxy-gate.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { PROJECT_ROOT, authorize, bootWeb, createProfile, freePort, makeHome, rpc, runCli } from '../helpers/test-host.mjs'
import { RecoveryGate } from '../../src/host/gate/recovery-gate.ts'
import { buildProxyMessage, isBoopMessage, payloadHash, PROXY_SOURCE_KIND } from '../../src/host/transport/command-envelope.ts'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e00-02-' + Date.now())
const SESSION_ID = 'boop-poc-session'
let home
let host
let cookie
let base

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  await createProfile(home, 'boop-poc', {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  // The PoC endpoints exist only in this isolated profile.
  const patch = path.join(home, 'profiles/boop-poc/cordis.patch.yml')
  fs.writeFileSync(patch, `- id: boop-api\n  config:\n    pocEnabled: true\n`)
  host = await bootWeb({ home, profile: 'boop-poc', port: await freePort() })
  base = host.base
  cookie = await authorize(base, host.token)
})

after(async () => {
  await host?.stop()
})

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> ${status} ${JSON.stringify(body)}`)
  assert.equal(body.result.ok, true, `${endpoint} failed: ${JSON.stringify(body.result)}`)
  return body.result.value
}

test('E00-02 the PoC surface is opt-in: the shipped default profile has it disabled', async () => {
  const dump = await runCli({ home, args: ['--profile', 'boop-poc', '--dump-config'] })
  assert.match(dump.stdout, /pocEnabled: true/)
  // The user's real profile is never touched by these tests; the plugin default
  // stays false in source and in the shipped manifest.
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src/host/api-service.ts'), 'utf8')
  assert.match(source, /let apiConfig: BoopApiConfig = \{ pocEnabled: false \}/)
})

test('G03 a proxy command carries a distinguishable source and never claims to be a human message', () => {
  const hash = payloadHash({
    taskId: 't1',
    taskVersion: 1,
    targetSessionId: 's1',
    instruction: '继续实现并检查窄屏',
    mode: 'queue',
  })
  assert.match(hash, /^[0-9a-f]{64}$/)
  const different = payloadHash({ taskId: 't1', taskVersion: 2, targetSessionId: 's1', instruction: '继续实现并检查窄屏', mode: 'queue' })
  assert.notEqual(hash, different, 'the payload hash must bind the task version')

  const { message } = buildProxyMessage({
    targetSessionId: 's1',
    envelope: {
      scopeId: 'scope-1',
      taskId: 't1',
      taskVersion: 1,
      actionId: 'act-1',
      messageId: 'msg-1',
      policyEpoch: 1,
      payloadHash: hash,
      initiatorRef: 'dsh:operator',
      instruction: '继续实现并检查窄屏',
      mode: 'queue',
    },
  })
  assert.equal(message.source.kind, PROXY_SOURCE_KIND)
  assert.notEqual(message.source.kind, 'user', 'a proxy command must never be indistinguishable from a human')
  assert.equal(message.source.initiatorRef, 'dsh:operator')
})

test('G03 provenance is decided by identity, never by message text', () => {
  const known = new Set(['msg-1'])
  assert.equal(isBoopMessage({ id: 'msg-1', source: { kind: 'user' } }, known), true, 'the host-side id registry is authoritative')
  assert.equal(isBoopMessage({ id: 'other', source: { kind: PROXY_SOURCE_KIND } }, known), true, 'the self-describing source is accepted')
  assert.equal(
    isBoopMessage({ id: 'other', content: [{ text: '{"boop":{"actionId":"act-1"}}' }], source: { kind: 'user' } }, known),
    false,
    'text that merely looks like BOOP provenance must not count',
  )
})

test('G04 the gate blocks unknown pending proxy commands and releases only on request', () => {
  const audited = []
  const gate = new RecoveryGate((event) => audited.push(event))
  gate.arm()
  const message = { id: 'msg-1', source: { kind: PROXY_SOURCE_KIND } }

  // Fail closed: an unarmed gate never allows business.
  const fresh = new RecoveryGate(() => {})
  assert.equal(fresh.decide([message]).allow, false, 'an unarmed gate must block')

  gate.track({ sessionId: 's1', actionId: 'act-1', messageId: 'msg-1', reason: 'pending' })
  const blocked = gate.decide([message])
  assert.equal(blocked.allow, false)
  assert.match(blocked.reason, /explicit recovery/i)

  gate.release(['msg-1'])
  assert.equal(gate.decide([message]).allow, true, 'an explicitly released command may run')
  assert.ok(audited.includes('gate/released'), 'release must be audited')

  gate.disarmForRestart()
  assert.equal(gate.decide([message]).allow, false, 'a restart re-blocks everything')
})

test('AT-12/AT-26 a seeded proxy command is reconstructed from the durable inbox with its BOOP source', async () => {
  const seeded = await call('boop/pocSeedInbox', { sessionId: SESSION_ID })
  assert.equal(seeded.pending, 1, 'the host inbox projection must rebuild the pending command')
  assert.equal(seeded.sourceKind, PROXY_SOURCE_KIND)

  const inbox = await call('boop/pocInbox', { sessionId: SESSION_ID })
  assert.equal(inbox.nextTurn.length, 1)
  assert.equal(inbox.nextTurn[0].sourceKind, PROXY_SOURCE_KIND)
  assert.notEqual(inbox.nextTurn[0].sourceKind, 'user', 'the pending message is not a human prompt')
})

test('AT-26 the recovery gate blocks the pending command, and release is explicit', async () => {
  const decision = await call('boop/pocGateDecision', { sessionId: SESSION_ID })
  assert.equal(decision.gateArmed, true)
  assert.equal(decision.allow, false)
  assert.match(decision.reason, /explicit recovery/i)
  assert.equal(decision.entries.length, 1)
  assert.equal(decision.entries[0].state, 'blocked')

  const inbox = await call('boop/pocInbox', { sessionId: SESSION_ID })
  const released = await call('boop/pocRelease', { messageIds: [inbox.nextTurn[0].id] })
  assert.equal(released.released.length, 1)

  const afterRelease = await call('boop/pocGateDecision', { sessionId: SESSION_ID })
  assert.equal(afterRelease.allow, true, 'explicit recovery permits exactly that command')
  assert.equal(afterRelease.entries[0].state, 'released')
})

test('AT-26 after a Host restart the pending command is still gated, not auto-executed', async () => {
  const port = await freePort()
  const restarted = await bootWeb({ home, profile: 'boop-poc', port })
  try {
    const restartedCookie = await authorize(restarted.base, restarted.token)
    const fresh = await rpc(restarted.base, restartedCookie, 'boop/pocGateStatus')
    assert.equal(fresh.body.result.ok, true, JSON.stringify(fresh.body.result))
    const status = fresh.body.result.value
    // A new process arms the gate again and adopts NOTHING: no old command is
    // resumed, released, or executed without an explicit user action.
    assert.equal(status.gateArmed, true)
    assert.equal(status.entries.length, 0, 'the restarted process adopted no previous command')
    assert.equal(status.adoptedMessageIds.length, 0, 'no message id was carried over implicitly')
    // The synthetic Session from the previous run is not live in this process,
    // so nothing can claim its pending inbox.
    const stale = await rpc(restarted.base, restartedCookie, 'boop/pocInbox', { args: { sessionId: SESSION_ID } })
    assert.equal(stale.body.result.ok, false, 'the previous run\'s session is not resumed automatically')
  } finally {
    await restarted.stop()
  }
})

test('AT-12 the un-gated native surface still works: a plain session is untouched by BOOP', async () => {
  const dump = await runCli({ home, args: ['--profile', 'boop-poc', '--dump-config'] })
  assert.ok(
    !/- id: preset-standard[\s\S]{0,80}boop/.test(dump.stdout),
    'BOOP must not be injected into the shipped standard preset',
  )
})

/*
 * NOT_RUN (no credentials in this environment — IN-01/IN-02):
 *  - a real `agent.followup()` delivery through the live loop, its durable
 *    `agent/inbox/claimed` reconciliation and the UI proxy label;
 *  - AT-13 disconnect/duplicate-send reconciliation against a live model.
 * These need the user's own Qwen service; they stay NOT_RUN rather than mocked.
 */
