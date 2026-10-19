import { describe, expect, it } from 'vitest'

import {
  EDITOR_HEIGHT_DEFAULT,
  EDITOR_HEIGHT_MIN,
  KEYBOARD_STEP,
  PANEL_GAP,
  RESULT_HEIGHT_MIN,
  RIGHT_COLUMN_MIN,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MIN,
  clampSize,
  maxEditorHeight,
  maxTreeWidth,
  resizeEditor,
  resizeTree,
} from '../src/client/split.ts'

describe('clampSize', () => {
  it('keeps a value inside its band', () => {
    expect(clampSize(200, 168, 400)).toBe(200)
    expect(clampSize(100, 168, 400)).toBe(168)
    expect(clampSize(900, 168, 400)).toBe(400)
  })

  it('survives an inverted band (max below min)', () => {
    expect(clampSize(200, 168, 100)).toBe(168)
  })
})

describe('maxTreeWidth', () => {
  it('leaves the editor column its minimum plus the gap', () => {
    expect(maxTreeWidth(1200)).toBe(1200 - RIGHT_COLUMN_MIN - PANEL_GAP)
  })

  it('falls back to a fixed ceiling before layout', () => {
    // jsdom, or a collapsed pane: no width to work from.
    expect(maxTreeWidth(0)).toBe(TREE_WIDTH_DEFAULT + 240)
  })

  it('never returns less than the minimum, even in a narrow sidebar', () => {
    expect(maxTreeWidth(300)).toBe(TREE_WIDTH_MIN)
  })
})

describe('maxEditorHeight', () => {
  it('leaves the result panel room to be usable', () => {
    expect(maxEditorHeight(800)).toBe(800 - RESULT_HEIGHT_MIN - PANEL_GAP)
  })

  it('falls back before layout', () => {
    // Default height plus a generous ceiling, for a pane with no measurement.
    expect(maxEditorHeight(0)).toBe(EDITOR_HEIGHT_DEFAULT + 400)
  })

  it('never goes below the editor minimum', () => {
    expect(maxEditorHeight(120)).toBe(EDITOR_HEIGHT_MIN)
  })
})

describe('resizeTree', () => {
  it('follows the pointer inside the band', () => {
    expect(resizeTree(TREE_WIDTH_DEFAULT, 40, 1200)).toBe(TREE_WIDTH_DEFAULT + 40)
    expect(resizeTree(TREE_WIDTH_DEFAULT, -40, 1200)).toBe(TREE_WIDTH_DEFAULT - 40)
  })

  it('stops at the minimum and at the editor column’s floor', () => {
    expect(resizeTree(TREE_WIDTH_DEFAULT, -500, 1200)).toBe(TREE_WIDTH_MIN)
    expect(resizeTree(TREE_WIDTH_DEFAULT, 900, 1200)).toBe(1200 - RIGHT_COLUMN_MIN - PANEL_GAP)
  })

  it('works before layout, where the width is 0', () => {
    expect(resizeTree(TREE_WIDTH_DEFAULT, 60, 0)).toBe(TREE_WIDTH_DEFAULT + 60)
  })
})

describe('resizeEditor', () => {
  it('follows the pointer and stops at both ends', () => {
    expect(resizeEditor(200, 30, 800)).toBe(230)
    expect(resizeEditor(200, -400, 800)).toBe(EDITOR_HEIGHT_MIN)
    expect(resizeEditor(200, 900, 800)).toBe(800 - RESULT_HEIGHT_MIN - PANEL_GAP)
  })
})

describe('constants', () => {
  it('keep the keyboard nudge small enough to be precise', () => {
    expect(KEYBOARD_STEP).toBeGreaterThan(0)
    expect(KEYBOARD_STEP).toBeLessThanOrEqual(24)
  })
})
