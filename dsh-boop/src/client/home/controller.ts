/**
 * Home page owner: one ensureHome call, one retained SessionReference, and
 * task refreshes that do not replace that reference.
 */

import type { AccessView, HomeView, TaskView } from '../../shared/mvp-contract.ts'

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
  selectedTaskId: string | null
  access: AccessView | null
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
  selectedTaskId: null,
  access: null,
}

export class HomeController {
  private snapshot: HomeSnapshot = { ...EMPTY, tasks: [], summary: [] }
  private listeners = new Set<Listener>()
  private generation = 0
  private abort: AbortController | null = null
  private unsubscribe: (() => void) | null = null
  private reference: RetainedSession | null = null
  private poll: ReturnType<typeof setInterval> | null = null
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
      const connection = this.host.connection.getSnapshot() ?? 'unknown'
      const previous = this.snapshot.connection
      this.patch({ connection })
      if (previous !== 'connected' && connection === 'connected') void this.refreshTasks()
    })
    this.patch({
      phase: 'loading',
      message: '正在准备你的波波…',
      connection: this.host.connection.getSnapshot() ?? 'connected',
      generation,
    })
    const reply = await this.host.call('boop/ensureHome', { request: { requestId: `home-${generation}` } })
    if (generation !== this.generation) return
    if (reply?.ok === false && reply?.error?.message) {
      this.patch({ phase: 'repair', message: String(reply.error.message), home: null })
      return
    }
    const view = reply?.data ?? reply?.value?.data ?? reply?.value
    if (!view || view.state !== 'ready' || typeof view.mainSessionId !== 'string') {
      this.patch({
        phase: view?.state === 'unavailable' ? 'unavailable' : 'repair',
        message: view?.message ?? '波波的历史连接需要恢复，原记录仍保留。',
        home: view ?? null,
      })
      return
    }
    const retained = await this.openHome(view.mainSessionId, this.abort.signal)
    if (!retained) return
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
    await this.loadAccess()
    this.poll = setInterval(() => { void this.refreshTasks() }, 4000)
  }

  destroy(): void {
    this.generation += 1
    this.abort?.abort()
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.reference?.release()
    this.reference = null
    this.patch({ reference: null, phase: 'loading' })
  }

  private async openHome(sessionId: string, signal: AbortSignal): Promise<RetainedSession | null> {
    let last = '主会话还没有出现在列表里。'
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (signal.aborted) return null
      const retained = this.host.retain(sessionId, signal)
      try {
        await retained.ready
        return retained
      } catch (error) {
        retained.release()
        last = error instanceof Error ? error.message : String(error)
        if (!last.includes('unknown session') || attempt === 7) break
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    if (!signal.aborted) {
      this.patch({
        phase: 'repair',
        message: last.includes('unknown session')
          ? '波波的会话还没进入列表，原记录仍保留。'
          : last === 'Failed to fetch' || last.includes('NetworkError')
            ? '连接断开，恢复后会重新同步进展。'
            : '波波的历史连接需要恢复，原记录仍保留。',
      })
    }
    return null
  }

  async refreshTasks(): Promise<void> {
    const generation = this.generation
    const reference = this.reference
    let reply: any
    try {
      reply = await this.host.call('boopTasks/listV2', { request: {} })
    } catch {
      if (generation === this.generation) this.patch({ notice: '进展暂时没有同步，显示的是上次看到的状态。' })
      return
    }
    if (generation !== this.generation || reference !== this.reference) return
    const data = reply?.data ?? reply?.value?.data ?? reply?.value
    if (reply?.ok === false || data?.ok === false || !data || !Array.isArray(data.items)) {
      this.patch({ notice: data?.error?.message ?? reply?.error?.message ?? '进展暂时没有同步，显示的是上次看到的状态。' })
      return
    }
    const items = data.items as TaskView[]
    this.patch({ tasks: items, summary: items.slice(0, 3), notice: null })
  }

  setDrawer(drawer: HomeSnapshot['drawer'], advanced?: boolean): void {
    this.patch({ drawer, ...(advanced === undefined ? {} : { advanced }) })
    if (drawer === 'work') void this.refreshTasks()
    if (drawer === 'settings') void this.loadAccess()
  }

  selectTask(taskId: string): void {
    this.patch({ selectedTaskId: taskId, drawer: 'work' })
    void this.loadTask(taskId)
  }

  private async loadTask(taskId: string): Promise<void> {
    const generation = this.generation
    let reply: any
    try {
      reply = await this.host.call('boopTasks/detailV2', { request: { taskId } })
    } catch {
      if (generation === this.generation) this.patch({ notice: '详情暂时没有同步，显示的是上次看到的工作。' })
      return
    }
    if (generation !== this.generation) return
    const data = reply?.data ?? reply?.value?.data ?? reply?.value
    if (reply?.ok === false || data?.ok === false || typeof data?.taskId !== 'string') {
      this.patch({ notice: data?.error?.message ?? '详情暂时没有同步，显示的是上次看到的工作。' })
      return
    }
    const next = this.snapshot.tasks.some((task) => task.taskId === data.taskId)
      ? this.snapshot.tasks.map((task) => task.taskId === data.taskId ? data as TaskView : task)
      : [data as TaskView, ...this.snapshot.tasks]
    this.patch({ tasks: next, summary: next.slice(0, 3) })
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
    const reply = await this.host.call('boopTasks/stop', {
      request: {
        requestId: `stop-${task.taskId}-${task.taskVersion}`,
        taskId: task.taskId,
        expectedTaskVersion: task.taskVersion,
      },
    })
    const data = reply?.data ?? reply?.value?.data ?? reply?.value
    if (reply?.ok === false || data?.ok === false) {
      this.patch({ notice: data?.error?.message ?? reply?.error?.message ?? '停止没有确认，这件工作可能还在进行。' })
      return
    }
    await this.refreshTasks()
  }

  async confirmTask(task: TaskView): Promise<void> {
    if (!task.latestResult || this.snapshot.connection === 'disconnected') {
      this.patch({ notice: '现在不能确认收下。' })
      return
    }
    const reply = await this.host.call('boopTasks/confirm', {
      request: {
        requestId: `confirm-${task.latestResult.resultId}`,
        taskId: task.taskId,
        expectedTaskVersion: task.taskVersion,
        resultId: task.latestResult.resultId,
        decision: 'accept',
      },
    })
    const data = reply?.data ?? reply?.value?.data ?? reply?.value
    if (reply?.ok === false || data?.ok === false) {
      this.patch({ notice: data?.error?.message ?? reply?.error?.message ?? '确认没有完成，结果仍保持原样。' })
      return
    }
    await this.refreshTasks()
  }

  async reconcileTask(task: TaskView): Promise<void> {
    await this.host.call('boopTasks/reconcile', { request: { taskId: task.taskId } })
    await this.refreshTasks()
  }

  async loadAccess(): Promise<void> {
    try {
      const reply = await this.host.call('boopTasks/access', { request: {} })
      const data = reply?.data ?? reply?.value?.data ?? reply?.value
      if (data?.mode) this.patch({ access: data as AccessView })
    } catch {
      /* settings can still explain that the range is unconfirmed */
    }
  }

  async saveAccess(mode: AccessView['mode'], workspaceIds: string[], sessionIds: string[]): Promise<void> {
    const epoch = this.snapshot.access?.policyEpoch
    if (epoch == null) {
      this.patch({ notice: '还没有读到当前范围，没有保存。' })
      return
    }
    const reply = await this.host.call('boopTasks/setAccess', {
      request: {
        requestId: `access-${epoch}-${mode}`,
        expectedPolicyEpoch: epoch,
        mode,
        workspaceIds,
        sessionIds,
      },
    })
    const data = reply?.data ?? reply?.value?.data ?? reply?.value
    if (reply?.ok === false || data?.ok === false || !data?.mode) {
      this.patch({ notice: data?.error?.message ?? '范围没有改成。' })
      return
    }
    this.patch({ access: data as AccessView, notice: '已更新可访问的工作。' })
  }

  private patch(partial: Partial<HomeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }
}

export const HOME_PANEL_KEY = 'boop.home'
export const HOME_INTENT_KEY = 'boop.home.intent'
