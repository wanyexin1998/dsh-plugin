import assert from 'node:assert/strict'

export function toolSurface(inherited = []) {
  let allow
  let mode = 'both'
  return {
    schemas() {
      const names = inherited.filter((name) => !allow || allow.has(name))
      return (mode === 'native' ? names : [...names, 'run_code']).map((name) => ({ name }))
    },
    restrict({ allow: names }) {
      assert.equal(allow, undefined)
      assert.ok(names.every((name) => inherited.includes(name)))
      allow = new Set(names)
      return () => {
        allow = undefined
      }
    },
    presentAs(value) {
      mode = value
      return () => {
        mode = 'both'
      }
    },
  }
}
