import { afterEach, describe, expect, it } from 'vitest'

import { classes, ensureStyles, resetStylesForTests } from '../src/client/styles.ts'

/** Minimal stand-in for the browser document the factory runs inside. */
function fakeDocument() {
  const appended: { attributes: Record<string, string>; textContent: string }[] = []
  return {
    appended,
    createElement: () => ({
      attributes: {} as Record<string, string>,
      textContent: '',
      setAttribute(key: string, value: string) {
        this.attributes[key] = value
      },
    }),
    head: {
      append(element: { attributes: Record<string, string>; textContent: string }) {
        appended.push(element)
      },
    },
  }
}

const originalDocument = globalThis.document

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document')
  } else {
    Object.assign(globalThis, { document: originalDocument })
  }
})

describe('ensureStyles', () => {
  it('appends the stylesheet once, marked as ours', () => {
    const document = fakeDocument()
    Object.assign(globalThis, { document })

    ensureStyles('.sqlWorkbenchPanel { color: red }')
    ensureStyles('.sqlWorkbenchPanel { color: red }')

    expect(document.appended).toHaveLength(1)
    expect(document.appended[0]?.attributes['data-dsh-data-ide']).toBe('')
    expect(document.appended[0]?.textContent).toContain('sqlWorkbenchPanel')
  })

  it('does nothing outside a browser (node-side import of the same module)', () => {
    Reflect.deleteProperty(globalThis, 'document')

    expect(() => ensureStyles('.x {}')).not.toThrow()
  })

  it('injects again after the test seam forgets the first injection', () => {
    resetStylesForTests()
    const document = fakeDocument()
    Object.assign(globalThis, { document })

    ensureStyles('.a {}')
    resetStylesForTests()
    ensureStyles('.b {}')

    expect(document.appended).toHaveLength(2)
  })
})

describe('classes', () => {
  it('maps every key to the literal class name', () => {
    // The build inlines the stylesheet as text, so the CSS default import is not
    // a class map; components read names through this accessor instead.
    expect(classes.pager).toBe('pager')
    expect(classes['sqlWorkbenchPanel']).toBe('sqlWorkbenchPanel')
    expect(classes.whateverTheStylesheetDeclares).toBe('whateverTheStylesheetDeclares')
  })
})
