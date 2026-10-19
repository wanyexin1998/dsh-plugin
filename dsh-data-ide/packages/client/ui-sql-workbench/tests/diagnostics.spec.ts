// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installDiagnostics, reportFailure } from '../src/client/diagnostics.ts'

const OVERLAY_ID = 'dsh-data-ide-diagnostics'

afterEach(() => {
  document.getElementById(OVERLAY_ID)?.remove()
  delete (window as unknown as Record<string, unknown>)['__dshDataIdeDiagnostics']
})

describe('on-page diagnostics', () => {
  it('shows an uncaught error in a fixed overlay', () => {
    installDiagnostics()

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }))

    const box = document.getElementById(OVERLAY_ID)
    expect(box?.textContent).toContain('页面错误')
    expect(box?.textContent).toContain('boom')
    expect(box?.getAttribute('data-dsh-data-ide')).toBe('diagnostics')
  })

  it('shows a rejected promise, string reasons included', () => {
    installDiagnostics()

    // jsdom has no PromiseRejectionEvent; the trap only reads `reason`.
    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = 'plain string'
    window.dispatchEvent(event)

    expect(document.getElementById(OVERLAY_ID)?.textContent).toContain('plain string')
  })

  it('shows an Error rejection with its name and message', () => {
    installDiagnostics()

    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = new RangeError('bad range')
    window.dispatchEvent(event)

    expect(document.getElementById(OVERLAY_ID)?.textContent).toContain('RangeError: bad range')
  })

  it('reuses one overlay and appends lines', () => {
    installDiagnostics()

    reportFailure('first')
    reportFailure('second')

    const box = document.getElementById(OVERLAY_ID)
    expect(box?.children).toHaveLength(2)
    expect(box?.textContent).toContain('注册失败 — first')
    expect(box?.textContent).toContain('注册失败 — second')
  })

  it('reports a bare error event without an Error object', () => {
    installDiagnostics()

    window.dispatchEvent(new ErrorEvent('error', { message: 'script failed to load' }))

    expect(document.getElementById(OVERLAY_ID)?.textContent).toContain('script failed to load')
  })

  it('does nothing outside a browser', () => {
    vi.stubGlobal('window', undefined)
    expect(() => { installDiagnostics() }).not.toThrow()
    vi.unstubAllGlobals()

    // A bare carrier without event targets is not a page either.
    vi.stubGlobal('window', {})
    expect(() => { installDiagnostics() }).not.toThrow()
    vi.unstubAllGlobals()

    vi.stubGlobal('document', undefined)
    expect(() => { reportFailure('no document') }).not.toThrow()
    vi.unstubAllGlobals()
  })

  it('installs the traps once per page', () => {
    const add = vi.spyOn(window, 'addEventListener')

    installDiagnostics()
    installDiagnostics()

    // Two traps (error + rejection), installed once.
    expect(add).toHaveBeenCalledTimes(2)
    add.mockRestore()
  })
})
