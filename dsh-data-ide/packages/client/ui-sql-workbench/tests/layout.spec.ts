import { describe, expect, it } from 'vitest'

import { DEFAULT_LAYOUT, parseLayout } from '../src/client/state/layout.ts'
import {
  EDITOR_HEIGHT_DEFAULT,
  EDITOR_HEIGHT_MIN,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MIN,
} from '../src/client/split.ts'

const bounds = { maxTreeWidth: 480, maxEditorHeight: 600 }

describe('parseLayout', () => {
  it('falls back to the defaults for anything unreadable', () => {
    expect(parseLayout(null, bounds)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout('nope', bounds)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout([], bounds)).toEqual(DEFAULT_LAYOUT)
  })

  it('reads a complete document', () => {
    expect(parseLayout({ treeOpen: false, treeWidth: 320, editorHeight: 300 }, bounds)).toEqual({
      treeOpen: false,
      treeWidth: 320,
      editorHeight: 300,
    })
  })

  it('treats a missing or false treeOpen correctly', () => {
    expect(parseLayout({ treeWidth: 320 }, bounds).treeOpen).toBe(true)
    expect(parseLayout({ treeOpen: false }, bounds).treeOpen).toBe(false)
  })

  it('clamps in-range-but-too-large values to the live workspace', () => {
    expect(parseLayout({ treeWidth: 900, editorHeight: 900 }, bounds).treeWidth).toBe(480)
    expect(parseLayout({ treeWidth: 900, editorHeight: 900 }, bounds).editorHeight).toBe(600)
  })

  it('clamps too-small positive values up to the minimum', () => {
    expect(parseLayout({ treeWidth: 10, editorHeight: 10 }, bounds).treeWidth).toBe(TREE_WIDTH_MIN)
    expect(parseLayout({ treeWidth: 10, editorHeight: 10 }, bounds).editorHeight).toBe(EDITOR_HEIGHT_MIN)
  })

  it('sends 0, negatives and non-finite numbers back to the default', () => {
    const broken = parseLayout({ treeWidth: 0, editorHeight: -5 }, bounds)
    expect(broken.treeWidth).toBe(TREE_WIDTH_DEFAULT)
    expect(broken.editorHeight).toBe(EDITOR_HEIGHT_DEFAULT)

    const infinite = parseLayout({ treeWidth: Number.POSITIVE_INFINITY, editorHeight: Number.NaN }, bounds)
    expect(infinite.treeWidth).toBe(TREE_WIDTH_DEFAULT)
    expect(infinite.editorHeight).toBe(EDITOR_HEIGHT_DEFAULT)
  })

  it('never returns a size above the bound even when the bound is smaller than the minimum', () => {
    const tiny = { maxTreeWidth: 100, maxEditorHeight: 50 }
    const parsed = parseLayout({ treeWidth: 300, editorHeight: 300 }, tiny)
    // The minimum wins: a panel this small cannot honour a 100px tree.
    expect(parsed.treeWidth).toBe(TREE_WIDTH_MIN)
    expect(parsed.editorHeight).toBe(EDITOR_HEIGHT_MIN)
  })
})
