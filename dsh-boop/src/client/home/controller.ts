/**
 * Home page owner: one ensureHome call, one retained SessionReference, and
 * task refreshes that do not replace that reference.
 */

import type { HomeView, TaskView } from '../../shared/mvp-contract.ts'

export interface HomeCall {
  (endpoint: string, args?: Record<string, unknown>): Promise<any>
}

export interface RetainedSession {
  id: string
  release(): void
  ready: Promise<unknown>
  /** The host SessionReference. SessionProvider needs this object, not a wrapper. */
  native: unknown
}

export interface HomeHost {
  call: HomeCall
  retain(sessionId: string, signal: AbortSignal): RetainedSession
  connection: {
    getSnapshot(): string | undefined
    subscribe(listener: () => void): () => void
    reconnect(): void
  }
  selectPanel(id: string): void
  openSource(sessionId: string): void
  insertReference(input: { mention: string; label: string }): Promise<boolean>
  setDraftText(text: string): Promise<boolean>
}

export interface HomeSnapshot {
  phase: 'loading' | 'ready' | 'repair' | 'unavailable'
  message: string
  home: HomeView | null
  reference: RetainedSession | null
  bindingVersion: number | null
  tasks: TaskView[]
  summary: TaskView[]
  drawer: 'closed' | 'work' | 'settings'
  advanced: boolean
  connection: string
  notice: string | null
  generation: number
}

type Listener = () => void

const EMPTY: HomeSnapshot = {
  phase: 'loading',
  message: '正在准备你的波波…',
  home: null,
  reference: null,
  bindingVersion: null,
  tasks: [],
  summary: [],
  drawer: 'closed',
  advanced: false,
  connection: 'connected',
  notice: null,
  generation: 0,
}

export class HomeController {
  private snapshot: HomeSnapshot = { ...EMPTY, tasks: [], summary: [] }
  private listeners = new Set<Listener>()
  private generation = 0
  private abort: AbortController | null = null
  private unsubscribe: (() => void) | null = null
  private reference: RetainedSession | null = null
  private readonly host: HomeHost

  constructor(host: HomeHost) {
    this.host = host
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): HomeSnapshot => this.snapshot

  async mount(): Promise<void> {
    const generation = ++this.generation
    this.abort?.abort()
    this.abort = new AbortController()
    this.unsubscribe?.()
    this.unsubscribe = this.host.connection.subscribe(() => {
      this.patch({ connection: this.host.connection.getSnapshot() ?? 'unknown' })
    })
    this.patch({
      phase: 'loading',
      message: '正在准备你的波波…',
      connection: this.host.connection.getSnapshot() ?? 'connected',
      generation,
    })
    const reply = await this.host.call('boop/ensureHome', { request: { requestId: `home-${generation}` } })
    if (generation !== this.generation) return
    const view = reply?.data ?? reply?.value?.data ?? reply?.value
    if (!view || view.state !== 'ready' || typeof view.mainSessionId !== 'string') {
      this.patch({
        phase: view?.state === 'unavailable' ? 'unavailable' : 'repair',
        message: view?.message ?? '波波的历史连接需要恢复，原记录仍保留。',
        home: view ?? null,
      })
      return
    }
    const retained = this.host.retain(view.mainSessionId, this.abort.signal)
    try {
      await retained.ready
    } catch {
      if (generation === this.generation) retained.release()
      return
    }
    if (generation !== this.generation) {
      retained.release()
      return
    }
    this.reference = retained
    const needsModel = view.capabilities?.send === false && (view.capabilities?.reasonCodes ?? []).includes('MODEL_UNAVAILABLE')
    this.patch({
      phase: 'ready',
      message: needsModel ? '先连接一个模型，就可以开始和我聊了。' : '我是波波。你可以和我聊想法，也可以让我继续推进已有项目。',
      home: view,
      reference: retained,
      bindingVersion: view.bindingVersion,
      advanced: needsModel,
    })
    await this.refreshTasks()
  }

  destroy(): void {
    this.generation += 1
    this.abort?.abort()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.reference?.release()
    this.reference = null
    this.patch({ reference: null, phase: 'loading' })
  }

  async refreshTasks(): Promise<void> {
    const generation = this.generation
    const reference = this.reference
    const reply = await this.host.call('boopTasks/listV2', { request: {} })
    if (generation !== this.generation || reference !== this.reference) return
    const page = reply?.data ?? reply?.value?.data ?? reply?.value
    const items = Array.isArray(page?.items) ? page.items as TaskView[] : []
    this.patch({ tasks: items, summary: items.slice(0, 3) })
  }

  setDrawer(drawer: HomeSnapshot['drawer'], advanced?: boolean): void {
    this.patch({ drawer, ...(advanced === undefined ? {} : { advanced }) })
  }

  toggleAdvanced(): void {
    this.patch({ advanced: !this.snapshot.advanced })
  }

  reconnect(): void {
    this.host.connection.reconnect()
  }

  openSource(sessionId: string): void {
    this.host.openSource(sessionId)
  }

  async insertCandidate(mention: string, label: string): Promise<boolean> {
    return this.host.insertReference({ mention, label })
  }

  async continueTask(task: TaskView): Promise<boolean> {
    const text = `继续处理「${task.title}」。还要补充：`
    return this.host.setDraftText(text)
  }

  async stopTask(task: TaskView): Promise<void> {
    if (this.snapshot.connection === 'disconnected') {
      this.patch({ notice: '停止请求还没送到，连接恢复后可以再试。' })
      return
    }
    await this.host.call('boopTasks/stop', {
      request: {
        requestId: `stop-${task.taskId}-${task.taskVersion}`,
        taskId: task.taskId,
        expectedTaskVersion: task.taskVersion,
      },
    })
    await this.refreshTasks()
  }

  async confirmTask(task: TaskView): Promise<void> {
    if (!task.latestResult || this.snapshot.connection === 'disconnected') return
    await this.host.call('boopTasks/confirm', {
      request: {
        requestId: `confirm-${task.latestResult.resultId}`,
        taskId: task.taskId,
        expectedTaskVersion: task.taskVersion,
        resultId: task.latestResult.resultId,
        decision: 'accept',
      },
    })
    await this.refreshTasks()
  }

  async reconcileTask(task: TaskView): Promise<void> {
    await this.host.call('boopTasks/reconcile', { request: { taskId: task.taskId } })
    await this.refreshTasks()
  }

  private patch(partial: Partial<HomeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }
}

export const HOME_PANEL_KEY = 'boop.home'
export const HOME_INTENT_KEY = 'boop.home.intent'
