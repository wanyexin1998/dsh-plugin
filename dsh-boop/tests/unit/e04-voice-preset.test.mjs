#!/usr/bin/env node
/**
 * M0 voice contract: the BOOP Agent preset owns the persona, not DSH's default.
 *
 * Run: node --test tests/unit/e04-voice-preset.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

test('the voice contract lives in the BOOP Agent preset persona, not the global DSH persona', () => {
  const preset = read('presets/boop.patch.yml')
  const cordis = read('cordis.patch.yml')

  assert.match(preset, /^# BOOP agent preset/m)
  assert.match(preset, /id: boop/)
  assert.match(preset, /name: BOOP 模式/)
  assert.match(preset, /name: '@deepseek-ai\/dsh-persona'/)
  assert.match(preset, /熟同事/)
  assert.match(preset, /默认不超过五句/)
  assert.match(preset, /最多一个问题/)
  assert.match(preset, /不要从以下几个方面展开/)
  assert.match(preset, /boop_note/)
  assert.match(preset, /原 Agent 自称完成不等于已验证/)
  assert.match(preset, /agentPreset: boop/)
  assert.match(preset, /suffix: ""/)
  assert.doesNotMatch(preset, /Your working directory is/)

  assert.match(cordis, /never override native persona, default preset/)
  assert.doesNotMatch(cordis, /name: '@deepseek-ai\/dsh-persona'/)
  assert.doesNotMatch(preset, /id: preset-standard/)
})

test('the BOOP workspace ships a short AGENTS.md so an already-started main Session still sees the contract', () => {
  const agents = read('server/workspace/AGENTS.md')
  assert.match(agents, /熟同事/)
  assert.match(agents, /默认不超过五句/)
  assert.match(agents, /notes\/\*\.md/)
  assert.ok(agents.length < 1200, 'workspace instructions stay a reminder, not a second product spec')
})
