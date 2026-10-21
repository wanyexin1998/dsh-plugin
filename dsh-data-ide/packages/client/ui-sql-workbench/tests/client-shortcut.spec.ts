// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { apply } from '../src/client/index.ts'
import { TAB_KIND } from '../src/client/contract/constants.ts'
import type { ClientContext, SidebarRightTabDefinition } from '../src/client/contract/host.ts'

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})

describe('client workbench shortcut', () => {
  it('opens the SQL workbench on Ctrl+Shift+L', () => {
    const opened: string[] = []
    const ctx = {
      effect<T>(setup: () => T): T {
        const result = setup()
        if (typeof result === 'function') disposers.push(result as () => void)
        return result
      },
      slots: {
        inject: (_slot: string, register: () => () => void) => register(),
        register: () => () => undefined,
      },
      locale: {
        register: () => () => undefined,
        bind: () => (id: string) => id,
      },
      sidebarRight: {
        openTab: (kind: string) => opened.push(kind),
        openResource: () => undefined,
      },
      sidebarRightTabs: {
        register: (_definition: SidebarRightTabDefinition) => () => undefined,
      },
    } as unknown as ClientContext

    apply(ctx)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true }))

    expect(opened).toEqual([TAB_KIND])
  })
})
