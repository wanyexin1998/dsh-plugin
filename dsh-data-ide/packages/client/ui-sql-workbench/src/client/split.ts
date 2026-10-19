/**
 * Pane geometry for the workbench: three panels, two sashes.
 *
 * The layout follows the same rules as the `dsh-split` workbench (Dockview with
 * `theme.gap: 12`): panels are cards separated by a *gap*, not by a divider
 * line — the sash is transparent and only shows a grip while hovered or
 * dragged. Rounding and spacing are restrained on purpose; the panel borders
 * that used to separate the areas are gone.
 *
 * Pure functions: the drag maths must be testable without a DOM, and jsdom has
 * no layout to measure.
 */

/** Gap between panels, in px. Mirrors `--sql-gap` in the stylesheet. */
export const PANEL_GAP = 8

/** Objects panel (left rail) width. */
export const TREE_WIDTH_DEFAULT = 244
export const TREE_WIDTH_MIN = 168
/** The right column keeps at least this much room when the rail is dragged wide. */
export const RIGHT_COLUMN_MIN = 320

/**
 * Editor pane height; the result pane takes what is left.
 *
 * The console tab strip lives inside this pane, so the default leaves room for
 * both the tabs and a usable code area.
 */
export const EDITOR_HEIGHT_DEFAULT = 224
export const EDITOR_HEIGHT_MIN = 96
export const RESULT_HEIGHT_MIN = 132

/** Keyboard nudge for a focused sash. */
export const KEYBOARD_STEP = 16

/** Clamp a pane size into its band. */
export function clampSize(value: number, min: number, max: number): number {
  // A max below min (a narrow pane) must not produce an inverted range.
  const ceiling = Math.max(min, max)
  return Math.min(ceiling, Math.max(min, value))
}

/**
 * Widest the objects panel may get before the editor column is squeezed.
 *
 * @param workspaceWidth - Measured workspace width; `0` means "not laid out yet"
 *   (jsdom, or a collapsed pane), where a fixed generous ceiling is used.
 */
export function maxTreeWidth(workspaceWidth: number): number {
  if (workspaceWidth <= 0) return TREE_WIDTH_DEFAULT + 240
  return Math.max(TREE_WIDTH_MIN, workspaceWidth - RIGHT_COLUMN_MIN - PANEL_GAP)
}

/**
 * Tallest the editor pane may get, leaving a usable result pane.
 *
 * @param workspaceHeight - Measured workspace height; `0` falls back to a
 *   generous ceiling for the same reason as {@link maxTreeWidth}.
 */
export function maxEditorHeight(workspaceHeight: number): number {
  if (workspaceHeight <= 0) return EDITOR_HEIGHT_DEFAULT + 400
  return Math.max(EDITOR_HEIGHT_MIN, workspaceHeight - RESULT_HEIGHT_MIN - PANEL_GAP)
}

/** New objects width after a horizontal drag of `deltaX` px. */
export function resizeTree(current: number, deltaX: number, workspaceWidth: number): number {
  return clampSize(current + deltaX, TREE_WIDTH_MIN, maxTreeWidth(workspaceWidth))
}

/** New editor height after a vertical drag of `deltaY` px. */
export function resizeEditor(current: number, deltaY: number, workspaceHeight: number): number {
  return clampSize(current + deltaY, EDITOR_HEIGHT_MIN, maxEditorHeight(workspaceHeight))
}
