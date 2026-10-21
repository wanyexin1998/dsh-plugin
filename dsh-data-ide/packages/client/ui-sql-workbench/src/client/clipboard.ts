/**
 * Clipboard write, with the two fallbacks that actually matter.
 *
 * Three environments show up in practice:
 *
 *  - the host webview, where `navigator.clipboard.writeText` works;
 *  - plain `http://127.0.0.1` harness builds, where the async clipboard API is
 *    missing and the old `execCommand('copy')` path is the only way;
 *  - environments where `navigator.clipboard` **exists but refuses** — Chromium
 *    without a user gesture, or an Electron permission policy. That case used to
 *    produce an unhandled rejection ("Failed to execute 'writeText' … permission
 *    denied") instead of a copy.
 *
 * So: await the write, fall back to `execCommand`, and when both fail tell the
 * caller (the panel shows a corner notice) rather than failing silently.
 */

/** Called when both strategies fail; the panel wires this to its corner notice. */
type CopyFailureHandler = (message: string) => void

let failureHandler: CopyFailureHandler | undefined

/** Register (or clear) the notifier used when a copy cannot happen. */
export function setCopyFailureHandler(handler: CopyFailureHandler | undefined): void {
  failureHandler = handler
}

/** The pre-Clipboard-API path: select a scratch textarea and copy it. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const scratch = document.createElement('textarea')
  scratch.value = text
  // Off-screen rather than hidden: a `display:none` node cannot be selected.
  scratch.style.position = 'fixed'
  scratch.style.top = '-1000px'
  scratch.setAttribute('readonly', '')
  document.body.append(scratch)
  scratch.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    // execCommand throws in some sandboxes instead of returning false.
    copied = false
  }
  scratch.remove()
  return copied
}

/**
 * Copy text, best effort.
 *
 * @returns `true` when something actually put the text on the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission or gesture problem: try the legacy path before giving up.
    }
  }
  if (legacyCopy(text)) return true
  failureHandler?.('复制失败：当前环境拒绝了剪贴板权限，请手动选中文本后按 Ctrl+C')
  return false
}
