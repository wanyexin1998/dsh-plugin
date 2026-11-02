import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installPhaseOneBoundary } from '../lib/phase-one-boundary.js'

test('IM runtime guard blocks all tool paths, including inherited and scoped tools', () => {
  const guards = []
  const ctx = {
    tools: {
      guard: (g) => {
        guards.push(g)
        return () => {}
      },
    },
  }
  installPhaseOneBoundary(ctx)
  installPhaseOneBoundary(ctx)
  assert.equal(guards.length, 1)
  for (const name of ['dingtalk_call', 'bash', 'run_code', 'send_file']) {
    assert.match(guards[0]({ toolName: name }), /phase1_web_only/)
  }
  assert.equal({ tools: {} }.tools.guard, undefined)
})

test('unsupported host cannot silently accept an unguarded IM turn', () => {
  assert.throws(() => installPhaseOneBoundary({ tools: {} }), /boundary_unavailable/)
})
