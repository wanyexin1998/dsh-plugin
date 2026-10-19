/**
 * Row windowing for the result grid.
 *
 * DataGrip never needs this: it pages at a few hundred rows and calls that the
 * limit (`Limit page size to`). This panel can ask for 5000 rows per page, and
 * rendering 5000 × N `<td>` nodes is what made big pages feel stuck — the DOM,
 * not the network, was the cost. So the page stays 5000 rows in memory and only
 * a window of it is in the document.
 *
 * All arithmetic lives here as plain functions: jsdom has no layout, so the
 * component-level behaviour is verified by calling these.
 */

/** Row height, matching `.table td { height: 30px }`. */
export const ROW_HEIGHT = 30

/** Below this many rows, rendering everything is cheaper than windowing. */
export const VIRTUAL_THRESHOLD = 200

/** Rows rendered beyond the viewport, so a fast scroll does not show blanks. */
export const OVERSCAN = 8

/** What slice of the row list belongs in the DOM right now. */
export interface RowWindow {
  /** First row of the slice (inclusive). */
  readonly start: number
  /** Last row of the slice (exclusive). */
  readonly end: number
  /** Spacer height above the slice, in px. */
  readonly topPad: number
  /** Spacer height below the slice, in px. */
  readonly bottomPad: number
}

/**
 * Compute the slice to render.
 *
 * @param total - Rows in the page (after filtering).
 * @param scrollTop - Scroll offset of the grid's scroll container.
 * @param viewportHeight - Visible height of that container; `0` (jsdom, or a
 *   collapsed pane) falls back to a screenful so the first rows still render.
 */
export function rowWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  options: { readonly rowHeight?: number; readonly threshold?: number; readonly overscan?: number } = {},
): RowWindow {
  const rowHeight = options.rowHeight ?? ROW_HEIGHT
  const threshold = options.threshold ?? VIRTUAL_THRESHOLD
  const overscan = options.overscan ?? OVERSCAN
  if (total <= threshold) return { start: 0, end: total, topPad: 0, bottomPad: 0 }

  const height = viewportHeight > 0 ? viewportHeight : rowHeight * 20
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan)
  const count = Math.ceil(height / rowHeight) + overscan * 2
  const end = Math.min(total, first + count)
  return {
    start: first,
    end,
    topPad: first * rowHeight,
    bottomPad: Math.max(0, (total - end) * rowHeight),
  }
}

/**
 * Scroll offset that brings `row` into view, leaving it where it is when it is
 * already visible.
 *
 * Arrow-key navigation moves the selection one row at a time; without this the
 * selected cell can walk off the top of a windowed grid.
 */
export function scrollTopForRow(
  row: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = ROW_HEIGHT,
): number {
  const top = row * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight
  return scrollTop
}
