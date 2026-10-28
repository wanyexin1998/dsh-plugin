import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { BOOP_HOME_CSS } from '../../src/client/home/home-styles.ts'

const root = path.resolve(import.meta.dirname, '../..')

test('conversation islands are capped at half the chat column', () => {
  assert.match(BOOP_HOME_CSS, /max-width: 50%/)
  assert.match(BOOP_HOME_CSS, /\.boop-island\[data-expanded="true"\] \{ width: 50%; \}/)
  const session = fs.readFileSync(path.join(root, 'src/client/home/BoopSession.tsx'), 'utf8')
  assert.match(session, /layout="island"/)
  assert.match(session, /className="boop-islands"/)
  const card = fs.readFileSync(path.join(root, 'src/client/home/WorkCard.tsx'), 'utf8')
  assert.match(card, /layout === 'island'/)
  const candidates = fs.readFileSync(path.join(root, 'src/client/home/TargetCandidates.tsx'), 'utf8')
  assert.match(candidates, /className="boop-islands"/)
  assert.equal(candidates.includes('className="boop-card"'), false)
})
