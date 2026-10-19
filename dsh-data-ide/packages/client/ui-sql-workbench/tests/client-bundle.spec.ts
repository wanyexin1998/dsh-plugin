import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import { describe, expect, it } from 'vitest'

import type { ClientContext } from '../src/client/contract/host.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(packageRoot, 'lib/client.js')

interface Registration {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/**
 * Load the built browser bundle the way the shell does: as a classic script that
 * registers a factory through `window.__ModuleLoader__`, with React and friends
 * coming from the module table. An ESM-shaped bundle fails here — which is
 * exactly how the first attempt died in the browser (`import failed`).
 */
function loadBundle(): Registration {
  const registrations: Registration[] = []
  const windowStub = { __ModuleLoader__: { load: (entry: Registration) => registrations.push(entry) } }
  const run = new Function('window', readFileSync(bundlePath, 'utf8')) as (w: unknown) => void
  run(windowStub)
  const registration = registrations[0]
  if (registration === undefined) throw new Error('bundle did not call __ModuleLoader__.load')
  return registration
}

describe('built client bundle', () => {
  it('registers itself under the package name', () => {
    expect(existsSync(bundlePath)).toBe(true)
    expect(loadBundle().id).toBe('dsh-data-ide')
  })

  it('materializes to apply/inject without pulling anything but react', () => {
    const { factory } = loadBundle()
    const required: string[] = []

    const exports = factory(id => {
      required.push(id)
      if (id === 'react') return React
      throw new Error(`unexpected module-table request: ${id}`)
    })

    expect(typeof exports['apply']).toBe('function')
    expect(exports['inject']).toEqual(['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
    expect(new Set(required)).toEqual(new Set(['react']))
  })

  it('registers the tab type and both keyed seats when applied', () => {
    const { factory } = loadBundle()
    const exports = factory(() => React)
    const effects: string[] = []
    const registrations: { name: string; key?: string }[] = []
    const ctx = {
      effect<T>(setup: () => T, label = ''): T {
        effects.push(label)
        return setup()
      },
      slots: {
        inject: (_slot: string, register: () => () => void) => register(),
        register: (entry: { name: string; key?: string }) => {
          registrations.push(entry)
          return () => {}
        },
      },
      locale: { register: () => () => {}, bind: () => (id: string) => id },
      sidebarRight: { openTab: () => {}, openResource: () => {} },
      sidebarRightTabs: { register: () => () => {} },
    } as unknown as ClientContext

    ;(exports['apply'] as (ctx: ClientContext) => void)(ctx)

    expect(effects).toContain('dsh-data-ide: sidebar tab type')
    expect(registrations.map(entry => entry.key)).toEqual(['dsh-data-ide.sql-workbench', 'dsh-data-ide.sql-workbench'])
  })
})
