import { describe, expect, it } from 'vitest'

import { OVERSCAN, ROW_HEIGHT, VIRTUAL_THRESHOLD, rowWindow, scrollTopForRow } from '../src/client/rowwindow.ts'

describe('rowWindow: small pages', () => {
  it('renders everything below the threshold', () => {
    expect(rowWindow(VIRTUAL_THRESHOLD, 0, 400)).toEqual({ start: 0, end: VIRTUAL_THRESHOLD, topPad: 0, bottomPad: 0 })
  })

  it('treats an empty page as an empty window', () => {
    expect(rowWindow(0, 0, 400)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 })
  })
})

describe('rowWindow: large pages', () => {
  const total = 5000

  it('starts at the top with overscan above, and pads what is below', () => {
    const win = rowWindow(total, 0, 300)

    expect(win.start).toBe(0)
    // One viewport (300/30 = 10 rows) plus overscan on both sides.
    expect(win.end).toBe(10 + OVERSCAN * 2)
    expect(win.topPad).toBe(0)
    expect(win.bottomPad).toBe((total - win.end) * ROW_HEIGHT)
  })

  it('follows the scroll position', () => {
    const win = rowWindow(total, 30 * 100, 300)

    expect(win.start).toBe(100 - OVERSCAN)
    expect(win.topPad).toBe(win.start * ROW_HEIGHT)
    expect(win.end).toBe(win.start + 10 + OVERSCAN * 2)
  })

  it('stops at the end and pads above instead', () => {
    const win = rowWindow(total, 30 * (total - 4), 300)

    expect(win.end).toBe(total)
    expect(win.bottomPad).toBe(0)
    expect(win.start).toBe(Math.floor((30 * (total - 4)) / ROW_HEIGHT) - OVERSCAN)
  })

  it('falls back to a screenful when the container has no height yet', () => {
    // jsdom (and a collapsed pane) report 0; the first rows must still render.
    const win = rowWindow(total, 0, 0)

    expect(win.start).toBe(0)
    expect(win.end).toBe(20 + OVERSCAN * 2)
  })

  it('ignores a negative scroll offset', () => {
    expect(rowWindow(total, -50, 300).start).toBe(0)
  })

  it('honours custom metrics', () => {
    const win = rowWindow(total, 0, 400, { rowHeight: 40, threshold: 10, overscan: 1 })

    expect(win.start).toBe(0)
    // 400/40 = 10 visible rows, plus one overscan row on each side.
    expect(win.end).toBe(12)
  })
})

describe('scrollTopForRow', () => {
  it('leaves the view alone when the row is already visible', () => {
    expect(scrollTopForRow(5, 0, 300)).toBe(0)
  })

  it('scrolls up to a row above the viewport', () => {
    expect(scrollTopForRow(2, 300, 300)).toBe(60)
  })

  it('scrolls down just enough for a row below it', () => {
    // Row 20 ends at 630; a 300px viewport starting at 0 must move to 330.
    expect(scrollTopForRow(20, 0, 300)).toBe(330)
  })

  it('accepts a custom row height', () => {
    expect(scrollTopForRow(20, 0, 400, 40)).toBe(440)
  })
})
