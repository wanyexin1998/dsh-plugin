/**
 * Panel layout: split sizes and object-browser state (docs/09 B3).
 *
 * Pure, so the clamping rules are testable without a DOM. A stored value may come
 * from a wider window, an older version, or a hand-edited file, so nothing is
 * trusted: every number is clamped and anything unreadable falls back to default.
 */

import { EDITOR_HEIGHT_DEFAULT, EDITOR_HEIGHT_MIN, TREE_WIDTH_DEFAULT, TREE_WIDTH_MIN } from '../split.ts'

export interface PanelLayout {
  readonly treeOpen: boolean
  readonly treeWidth: number
  readonly editorHeight: number
}

export const DEFAULT_LAYOUT: PanelLayout = {
  treeOpen: true,
  treeWidth: TREE_WIDTH_DEFAULT,
  editorHeight: EDITOR_HEIGHT_DEFAULT,
}

export interface LayoutBounds {
  readonly maxTreeWidth: number
  readonly maxEditorHeight: number
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, min: number, max: number): number {
  // `max` can be below `min` when the panel is tiny; min wins.
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Turn a stored document into a usable layout.
 *
 * @param raw - whatever the host returned (`null` when nothing was saved).
 * @param bounds - the live workspace limits; only the browser knows these.
 */
export function parseLayout(raw: unknown, bounds: LayoutBounds): PanelLayout {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_LAYOUT
  const record = raw as Record<string, unknown>
  // `0` / negative is not "the smallest allowed size", it is a broken document
  // (09 B3 asks for the default). Only in-range-but-valid numbers are clamped.
  const width = finite(record['treeWidth'])
  const height = finite(record['editorHeight'])
  return {
    treeOpen: record['treeOpen'] !== false,
    treeWidth:
      width === null || width <= 0
        ? TREE_WIDTH_DEFAULT
        : clamp(width, TREE_WIDTH_MIN, bounds.maxTreeWidth),
    editorHeight:
      height === null || height <= 0
        ? EDITOR_HEIGHT_DEFAULT
        : clamp(height, EDITOR_HEIGHT_MIN, bounds.maxEditorHeight),
  }
}
