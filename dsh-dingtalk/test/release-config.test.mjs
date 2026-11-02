import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('定制插件指向大仓库子目录，保持 private 且不配置 Actions', () => {
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/wanyexin1998/dsh-plugin.git',
    directory: 'dsh-dingtalk',
  })
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.bugs.url, 'https://github.com/wanyexin1998/dsh-plugin/issues')
  assert.equal(existsSync(new URL('../.github/workflows', import.meta.url)), false)
  assert.equal(existsSync(new URL('../../.github/workflows', import.meta.url)), false)
  assert.equal(existsSync(new URL('../.git', import.meta.url)), false)
})

test('同一个安装包保留官方入口和 Web 入口及来源许可', () => {
  assert.equal(packageJson.name, '@wanyexin1998/dsh-dingtalk')
  for (const name of ['.', './a2ui', './web', './client']) assert.ok(packageJson.exports[name])
  assert.match(patch, /@wanyexin1998\/dsh-dingtalk/)
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /MIT License/)
  assert.match(readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'), /DingTalk-Real-AI/)
})
