/**
 * Clipboard write with a fallback.
 *
 * The async clipboard API only exists in secure contexts (`https`, `localhost`,
 * and the host's own webview). The panel also runs over plain `http://127.0.0.1`
 * in some harness builds, where `navigator.clipboard` is missing, so the old
 * `execCommand('copy')` path stays as the fallback.
 */
export function copyText(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    void navigator.clipboard.writeText(text)
    return
  }
  /* v8 ignore next -- documents always exist where this runs */
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return
  const scratch = document.createElement('textarea')
  scratch.value = text
  document.body.append(scratch)
  scratch.select()
  document.execCommand('copy')
  scratch.remove()
}
