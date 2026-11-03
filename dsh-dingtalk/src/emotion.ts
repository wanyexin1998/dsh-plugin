import { feedbackCode, type ObserveFeedback } from './feedback.js'

/** Serialize transitions per message so a slow Thinking request cannot outlive Done. */
export class Emotion {
  private pending = new Map<string, Promise<void>>()
  constructor(
    private readonly token: () => Promise<string>,
    private readonly robotCode: string,
    private readonly log: (line: string) => void,
    private readonly observe?: ObserveFeedback,
  ) {}
  private transition(action: 'add' | 'recall' | 'done', openMsgId: string, openConversationId: string): Promise<void> {
    if (!openMsgId || !openConversationId) return Promise.resolve()
    const key = JSON.stringify([openConversationId, openMsgId])
    const task = (this.pending.get(key) ?? Promise.resolve()).then(async () => {
      const name = action === 'done' ? '🥳 Done' : '🤔思考中'
      try {
        const token = await this.token()
        const response = await fetch(
          `https://api.dingtalk.com/v1.0/robot/emotion/${action === 'recall' ? 'recall' : 'reply'}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
            body: JSON.stringify({
              robotCode: this.robotCode,
              openMsgId,
              openConversationId,
              emotionType: 2,
              emotionName: name,
              textEmotion: { emotionId: '2659900', emotionName: name, text: name, backgroundId: 'im_bg_1' },
            }),
            signal: AbortSignal.timeout(5000),
          },
        )
        this.observe?.(`emotion.${action}`, response.ok, response.ok ? 'ok' : feedbackCode(response.status))
        if (!response.ok) this.log(`emotion ${action} failed HTTP ${response.status}`)
        await response.body?.cancel()
      } catch (error) {
        this.observe?.(
          `emotion.${action}`,
          false,
          error instanceof Error && /Timeout|Abort/.test(error.name) ? 'timeout' : 'transport',
        )
        this.log(`emotion ${action} failed`)
      }
    })
    this.pending.set(key, task)
    void task.finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key)
    })
    return task
  }
  add(id: string, conversation: string): void {
    void this.transition('add', id, conversation)
  }
  recall(id: string, conversation: string): Promise<void> {
    return this.transition('recall', id, conversation)
  }
  done(id: string, conversation: string): Promise<void> {
    return this.transition('done', id, conversation)
  }
}
