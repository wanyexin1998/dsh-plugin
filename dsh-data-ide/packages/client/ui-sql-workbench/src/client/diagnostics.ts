/**
 * On-page diagnostics for the browser half.
 *
 * Plugin activation errors normally reach only the browser console, which the
 * person running the harness may never open — the symptom is a blank pane plus
 * a one-line "entry did not activate" in the boot screen. This module turns any
 * uncaught error or rejected promise in the page into a visible, copyable line,
 * so a screenshot carries the reason.
 *
 * It is deliberately tiny and dependency-free: it must work even when the rest
 * of the panel fails to import.
 */

const OVERLAY_ID = 'dsh-data-ide-diagnostics'

/** Append (or update) the fixed overlay with one more line. */
function show(message: string): void {
  if (typeof document === 'undefined') return
  let box = document.getElementById(OVERLAY_ID)
  if (box === null) {
    box = document.createElement('div')
    box.id = OVERLAY_ID
    box.setAttribute('data-dsh-data-ide', 'diagnostics')
    box.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      'z-index:2147483647',
      'max-width:60vw',
      'max-height:40vh',
      'overflow:auto',
      'padding:8px 10px',
      'border-radius:8px',
      'background:rgba(180,20,20,.94)',
      'color:#fff',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:pre-wrap',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    ].join(';')
    document.body.append(box)
  }
  const line = document.createElement('div')
  line.textContent = `dsh-data-ide: ${message}`
  box.append(line)
}

/** Install the traps once per page. */
export function installDiagnostics(): void {
  if (typeof window === 'undefined') return
  // Not every carrier is a full browser window (the bundle is also materialized
  // under a bare module-loader shim in tests and headless harnesses).
  if (typeof window.addEventListener !== 'function') return
  const flag = '__dshDataIdeDiagnostics'
  const holder = window as unknown as Record<string, unknown>
  if (holder[flag] === true) return
  holder[flag] = true

  window.addEventListener('error', event => {
    const detail = event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : String(event.message)
    show(`页面错误 — ${detail}`)
  })
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}` : String(event.reason)
    show(`未处理的 Promise 拒绝 — ${reason}`)
  })
}

/** Report a failure where the person can see it, as well as in the console. */
export function reportFailure(message: string): void {
  show(`注册失败 — ${message}`)
}
