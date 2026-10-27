import { flushSync } from 'react-dom'

const OPENERS = ['更多查询操作', '更多结果操作', '连接操作'] as const

function poke(button: HTMLElement): void {
  flushSync(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Find a control, opening the overflow menu that holds it when it is closed. */
export function findLabeled(label: string): HTMLElement | undefined {
  const read = (): HTMLElement | null => document.querySelector(`[aria-label="${label}"]`)
  if (read() !== null) return read() as HTMLElement
  for (const opener of OPENERS) {
    const button = document.querySelector(`[aria-label="${opener}"]`) as HTMLElement | null
    if (button === null || button.getAttribute('aria-expanded') === 'true') continue
    poke(button)
    if (read() !== null) return read() as HTMLElement
    poke(button)
  }
  return undefined
}

/** Find a button by its visible text, opening 连接 when the action lives there. */
export function findButtonText(text: string): HTMLElement | undefined {
  const match = (): HTMLElement | undefined =>
    [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text) as HTMLElement | undefined
  if (match() !== undefined) return match()
  const opener = document.querySelector('[aria-label="连接操作"]') as HTMLElement | null
  if (opener === null || opener.getAttribute('aria-expanded') === 'true') return undefined
  poke(opener)
  return match()
}
