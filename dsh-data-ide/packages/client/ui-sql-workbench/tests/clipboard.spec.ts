// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from '../src/client/clipboard.ts'

const original = { clipboard: navigator.clipboard, exec: document.execCommand }

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: original.clipboard, configurable: true })
  document.execCommand = original.exec
  for (const scratch of [...document.querySelectorAll('textarea')]) scratch.remove()
})

describe('copyText', () => {
  it('uses the async clipboard when it exists', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    copyText('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand in a non-secure context', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand

    copyText('fallback')

    expect(exec).toHaveBeenCalledWith('copy')
    // The scratch textarea does not stay in the DOM.
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})
