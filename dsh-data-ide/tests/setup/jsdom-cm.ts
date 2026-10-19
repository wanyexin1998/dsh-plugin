/**
 * jsdom gaps that CodeMirror needs filled.
 *
 * jsdom implements no layout: `Range.prototype.getClientRects` is missing, and
 * CodeMirror's measurement pass calls it from a rAF callback — which surfaces as
 * an *unhandled* error (tests still pass, but the run is reported dirty and can
 * mask real failures).
 *
 * Returning empty rects is the documented workaround: CodeMirror then treats the
 * editor as unmeasured, which is exactly what a layout-less DOM is.
 */

const emptyRects = (): DOMRectList => {
  const list = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* empty() {
      // no rects in a layout-less DOM
    },
  }
  return list as unknown as DOMRectList
}

const emptyRect = (): DOMRect => new DOMRect(0, 0, 0, 0)

if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect = emptyRect
  Range.prototype.getClientRects = emptyRects
}

if (typeof Element !== 'undefined') {
  Element.prototype.getClientRects = emptyRects
}
