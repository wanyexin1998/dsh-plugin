import theme from './theme.css'
import { VisualizeFence } from './VisualizeFence.tsx'

interface SlotContext {
  slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: { name: string; key: string; id: string }, component: unknown): unknown
  }
  effect(callback: () => unknown, label: string): unknown
}

export const inject = ['slots']

export function apply(ctx: SlotContext, config?: { enabled?: boolean }): void {
  if (config?.enabled === false) return
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'dsh-visualize-inline')
    style.textContent = theme
    document.head.appendChild(style)
    return () => style.remove()
  }, 'visualize-inline: theme')
  ctx.effect(() => ctx.slots.inject('conversation.chat.markdown.fence', () =>
    ctx.slots.register({
      name: 'conversation.chat.markdown.fence',
      key: 'visualize',
      id: 'dsh-visualize-inline',
    }, VisualizeFence),
  ), 'visualize-inline: markdown fence')
}
