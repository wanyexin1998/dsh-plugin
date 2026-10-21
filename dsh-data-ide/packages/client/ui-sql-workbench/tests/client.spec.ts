import { describe, expect, it, vi } from 'vitest'

import { apply, inject } from '../src/client/index.ts'
import { workbenchApi } from '../src/client/api.ts'
import { TAB_BODY_SLOT, TAB_ID, TAB_KIND, TAB_NS, TAB_TITLE_SLOT } from '../src/client/contract/constants.ts'
import type { ClientContext, SidebarRightTabDefinition } from '../src/client/contract/host.ts'

interface Registration {
  readonly name: string
  readonly key?: string
  readonly locale?: string
  readonly inject?: (...args: unknown[]) => Record<string, unknown>
}

interface Harness {
  readonly ctx: ClientContext
  readonly effects: string[]
  readonly definitions: SidebarRightTabDefinition[]
  readonly registrations: Registration[]
  readonly injected: string[]
  /** Kinds passed to `sidebarRight.openTab`, in order. */
  readonly opened: string[]
}

function harness(options: { readonly supported?: boolean; readonly api?: unknown } = {}): Harness {
  const effects: string[] = []
  const definitions: SidebarRightTabDefinition[] = []
  const registrations: Registration[] = []
  const injected: string[] = []
  const opened: string[] = []
  const supported = options.supported ?? true

  const ctx = {
    effect<T>(setup: () => T, label = ''): T {
      effects.push(label)
      return setup()
    },
    slots: {
      inject(slot: string, register: () => () => void): () => void {
        injected.push(slot)
        return register()
      },
      register(registration: Registration): () => void {
        registrations.push(registration)
        return () => {}
      },
    },
    locale: {
      register: () => () => {},
      bind: () => (id: string) => id,
    },
    ...(options.api === undefined ? {} : { sqlWorkbench: options.api }),
    ...(supported
      ? {
          sidebarRight: {
            openTab: (kind: string) => { opened.push(kind) },
            openResource: () => {},
          },
          sidebarRightTabs: {
            register(definition: SidebarRightTabDefinition): () => void {
              definitions.push(definition)
              return () => {}
            },
          },
        }
      : {}),
  } as unknown as ClientContext

  return { ctx, effects, definitions, registrations, injected, opened }
}

describe('client half', () => {
  it('declares the host services it needs', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
  })

  it('reads a missing host service as absent, even when the context throws', () => {
    expect(workbenchApi({})).toBeUndefined()

    const throwing = Object.defineProperty({}, 'sqlWorkbench', {
      get() {
        throw new Error('service lookup is not allowed here')
      },
    })

    // A host context that rejects unknown property access must not break boot.
    expect(workbenchApi(throwing as unknown as Record<string, unknown>)).toBeUndefined()
  })

  it('registers copy, one page type and both keyed seats', () => {
    const h = harness()

    apply(h.ctx)

    expect(h.effects).toEqual([
      'dsh-data-ide: tab copy',
      'dsh-data-ide: sidebar tab type',
      'dsh-data-ide: sidebar tab body',
      'dsh-data-ide: sidebar tab title',
      'dsh-data-ide: open shortcut',
    ])
    expect(h.definitions).toHaveLength(1)
    const definition = h.definitions[0]!
    expect(definition.id).toBe(TAB_ID)
    expect(definition.kind).toBe(TAB_KIND)
    expect(definition.multiple).toBe(false)
    expect(definition.title('')).toBe('tab.title')
    expect(definition.guide?.map(entry => entry.id)).toEqual([TAB_ID])
    expect(definition.guide?.[0]?.title()).toBe('tab.title')
    expect(definition.guide?.[0]?.description?.()).toBe('tab.guide')
    expect(definition.guide?.[0]?.icon).toBeTypeOf('function')
    expect(h.injected).toEqual([TAB_BODY_SLOT, TAB_TITLE_SLOT])
    expect(h.registrations[0]).toMatchObject({ name: TAB_BODY_SLOT, key: TAB_ID, locale: 'dsh-data-ide.tab' })
    expect(h.registrations[1]).toEqual({ name: TAB_TITLE_SLOT, key: TAB_ID })
  })

  it('hands the body seat the in-process service when the context has one', () => {
    const api = { list: async () => [] }
    const h = harness({ api })
    apply(h.ctx)

    // `inject` must be a function: the host calls it to build the entry's props
    // (`TypeError: inject is not a function` crashed the seat when it was a record).
    const inject = h.registrations[0]?.inject
    expect(inject).toBeTypeOf('function')
    expect((inject as () => unknown)()).toEqual({ api })
  })

  it('falls back to the HTTP transport when the node service is absent', () => {
    const h = harness()
    apply(h.ctx)

    // The web frontend runs in another process, so this is the normal case.
    const props = (h.registrations[0]?.inject as () => Record<string, unknown>)()
    expect(props['api']).toMatchObject({
      list: expect.any(Function),
      execute: expect.any(Function),
      cancel: expect.any(Function),
    })
  })

  it('reports a registration failure instead of failing the whole entry', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const posts: string[] = []
    vi.stubGlobal('fetch', (input: string, init?: { body?: string }) => {
      posts.push(`${input}|${init?.body ?? ''}`)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    const host = harness()
    // A host whose slot service explodes on first use.
    const broken = {
      ...(host.ctx as unknown as Record<string, unknown>),
      get slots(): never {
        throw new Error('slots unavailable')
      },
    } as unknown as ClientContext

    expect(() => { apply(broken) }).not.toThrow()
    expect(logged.mock.calls[0]?.[0]).toContain('客户端注册失败')
    expect(posts[0]).toContain('/dsh-data-ide/client-error')
    expect(posts[0]).toContain('slots unavailable')

    vi.unstubAllGlobals()
    logged.mockRestore()
  })

  it('survives a host without fetch when reporting the failure', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = harness()
    const broken = {
      ...(host.ctx as unknown as Record<string, unknown>),
      get slots(): never {
        throw new Error('no slots')
      },
    } as unknown as ClientContext

    vi.stubGlobal('fetch', undefined)

    expect(() => { apply(broken) }).not.toThrow()
    vi.unstubAllGlobals()
    logged.mockRestore()
  })

  it('reports a non-Error throw and a rejected report', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = harness()
    const broken = {
      ...(host.ctx as unknown as Record<string, unknown>),
      get slots(): never {
        throw 'plain string failure'
      },
    } as unknown as ClientContext

    vi.stubGlobal('fetch', () => Promise.reject(new Error('route missing')))

    expect(() => { apply(broken) }).not.toThrow()
    expect(logged.mock.calls[0]?.[0]).toContain('plain string failure')
    // The rejected diagnostics post must not become an unhandled rejection.
    await Promise.resolve()

    vi.unstubAllGlobals()
    logged.mockRestore()
  })

  it('fails closed when the host has no right-sidebar registry', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ supported: false })

    apply(h.ctx)

    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toContain('sidebarRight')
    expect(h.definitions).toHaveLength(0)
    expect(h.registrations).toHaveLength(0)
    error.mockRestore()
  })

  it('registers copy before the guard runs, so the message can be localised later', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ supported: false })

    apply(h.ctx)

    expect(h.effects).toEqual(['dsh-data-ide: tab copy'])
    error.mockRestore()
  })
})

describe('locale namespace', () => {
  it('is stable, because the keyed seats address the page type by id', () => {
    expect(TAB_NS).toBe('dsh-data-ide.tab')
    expect(TAB_ID).toBe('dsh-data-ide.sql-workbench')
    expect(TAB_KIND).toBe(TAB_ID)
  })
})
