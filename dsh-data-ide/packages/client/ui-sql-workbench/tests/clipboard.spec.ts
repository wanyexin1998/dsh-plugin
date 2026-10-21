// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText, setCopyFailureHandler } from '../src/client/clipboard.ts'

const original = { clipboard: navigator.clipboard, exec: document.execCommand }

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: original.clipboard, configurable: true })
  document.execCommand = original.exec
  setCopyFailureHandler(undefined)
  for (const scratch of [...document.querySelectorAll('textarea')]) scratch.remove()
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('uses the async clipboard when it exists', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyText('hello')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand in a non-secure context', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand

    await expect(copyText('fallback')).resolves.toBe(true)

    expect(exec).toHaveBeenCalledWith('copy')
    // The scratch textarea does not stay in the DOM.
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('falls back when the clipboard API exists but refuses', async () => {
    // The reported case: `navigator.clipboard` is present, `writeText` rejects
    // with NotAllowedError, and the old code left an unhandled rejection.
    const writeText = vi.fn(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand

    await expect(copyText('denied')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalled()
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('reports a failure when both strategies are refused', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand
    const handler = vi.fn()
    setCopyFailureHandler(handler)

    await expect(copyText('nope')).resolves.toBe(false)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0]).toContain('复制失败')
  })

  it('survives an execCommand that throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = vi.fn(() => {
      throw new Error('blocked')
    }) as unknown as typeof document.execCommand
    const handler = vi.fn()
    setCopyFailureHandler(handler)

    await expect(copyText('x')).resolves.toBe(false)

    expect(handler).toHaveBeenCalled()
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('fails cleanly when the platform has no execCommand either', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true })
    const handler = vi.fn()
    setCopyFailureHandler(handler)

    await expect(copyText('y')).resolves.toBe(false)

    expect(handler).toHaveBeenCalled()
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})
