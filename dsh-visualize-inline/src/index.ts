import { VISUALIZE_GUIDANCE, VISUALIZE_V2_GUIDANCE, VISUALIZE_V2_P1_GUIDANCE } from './guidance.ts'

interface SystemPromptContext {
  systemPrompt: {
    section(options: {
      name: string
      order: number
      text: string
      interpolate: false
      retirement: string
    }): unknown
  }
}

export const name = 'dsh-visualize-inline'
export const inject = ['systemPrompt']

export function apply(ctx: SystemPromptContext, config?: { enabled?: boolean; v2?: boolean }): void {
  if (config?.enabled === false) return
  ctx.systemPrompt.section({
    name: 'dsh-visualize-inline:output',
    order: 100,
    text: config?.v2 === false ? VISUALIZE_GUIDANCE : `${VISUALIZE_GUIDANCE}\n\n${VISUALIZE_V2_GUIDANCE}\n\n${VISUALIZE_V2_P1_GUIDANCE}`,
    interpolate: false,
    retirement: 'Visualize Inline 已停用；不要再输出 visualize 围栏。',
  })
}
