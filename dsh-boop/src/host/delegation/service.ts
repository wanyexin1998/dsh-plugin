/**
 * The one delegation controller.
 *
 * Task, action, outbox, result, and acceptance rows are written here. Native
 * calls happen outside the SQL transaction. A lost response stays unknown and
 * is not retried by sending the instruction again.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { BoopDatabase } from '../persistence/database.ts'
import {
  failReply,
  okReply,
  textOf,
  type AccessUpdateArgs,
  type AccessView,
  type ConfirmArgs,
  type ContextView,
  type ContinueArgs,
  type DispatchArgs,
  type HomeCapabilities,
  type Reply,
  type StopArgs,
  type TaskPage,
  type TaskView,
  type WorkCandidate,
  type WorkCatalog,
} from '../../shared/mvp-contract.ts'
import { formatSessionReferenceMention } from '../../shared/session-mention.ts'
import { projectTask, type ProjectionInput, type ProjectionResult } from './projection.ts'
import type { ExecutionState } from '../../shared/mvp-contract.ts'

export interface TrustedCall {
  originRef: string
  originKind: 'user' | 'ui'
  mainSessionId: string
  bindingVersion: number
  policyEpoch: number
  holder: string
  fence: number
  toolCallId?: string
}

export interface CatalogSession {
  sessionId: string
  workspaceId: string | null
  title: string
  workspaceTitle: string | null
  activity: 'idle' | 'running' | 'unknown'
  lastActivityAt: string | null
  preview: string | null
  archived: boolean
  subagent: boolean
  home: boolean
}

export interface TargetObservation {
  reachable: boolean
  busy: boolean
  pendingHuman: boolean
  archived: boolean
  subagent: boolean
  home: boolean
  title: string
  workspaceId: string | null
  workspaceTitle: string | null
  sourceGeneration: string
  headSeq: number
  latestDirectUserSeq: number
  latestDirectUserMessageId: string | null
  pendingMessage: boolean
  turnId: string | null
  turnTerminal: boolean
  ownership: 'not_started' | 'exclusive' | 'mixed' | 'user_takeover' | 'unknown' | 'ended'
  approvalId: string | null
  summary: string | null
  deliverable: boolean
  checks: ProjectionResult['checks']
  artifacts: ProjectionResult['artifacts']
  missing: string[]
  evidenceSeq: number
}

export interface ContextEvent {
  seq: number
  text: string
  sessionId: string
  sourceGeneration: string
}

export interface DelegationPorts {
  now(): string
  nowMs(): number
  fenceOk(call: TrustedCall): boolean
  listSessions(query: string): Promise<CatalogSession[]>
  observe(sessionId: string): Promise<TargetObservation | null>
  readEvents(sessionId: string, limit: number, beforeSeq: number | null): Promise<ContextEvent[]>
  excluded(sessionId: string): boolean
  hostCanRead(sessionId: string): boolean | 'unknown'
  followup(sessionId: string, message: { id: string; role: 'user'; content: unknown; source: unknown }): Promise<'enqueued' | 'before-enqueue'>
  flush(sessionId: string): Promise<boolean>
  pending(sessionId: string, messageId: string): Promise<boolean>
  visible(sessionId: string, messageId: string): Promise<boolean>
  remove(sessionId: string, messageId: string): Promise<boolean>
  cancelTurn(sessionId: string): Promise<void>
  mainIdle(): Promise<boolean>
}

const OCCUPYING = ['dispatching', 'accepted', 'running', 'outcome_unknown']

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function payloadHash(input: {
  targetSessionId: string
  goal: string
  instruction: string
  criteria: string[]
  exclusions: string[]
  taskVersion: number
  policyEpoch: number
}): string {
  return hash({
    criteria: input.criteria,
    exclusions: input.exclusions,
    goal: input.goal,
    instruction: input.instruction,
    policyEpoch: input.policyEpoch,
    targetSessionId: input.targetSessionId,
    taskVersion: input.taskVersion,
  })
}

export class DelegationService {
  private ticking: Promise<void> | null = null
  private readonly db: BoopDatabase
  private readonly scopeId: string
  private readonly ports: DelegationPorts
  private readonly workspaces = new Map<string, string | null>()

  constructor(db: BoopDatabase, scopeId: string, ports: DelegationPorts) {
    this.db = db
    this.scopeId = scopeId
    this.ports = ports
  }

  bootRecover(): void {
    this.ensureSlot()
    const rows = this.db.db
      .prepare(
        `SELECT id FROM action WHERE scope_id = ? AND managed_v2 = 1 AND state IN ('dispatching','accepted','running','outcome_unknown')`,
      )
      .all(this.scopeId) as Array<{ id: string }>
    if (rows.length > 1) {
      this.db.db
        .prepare(
          `UPDATE execution_slot SET state = 'recovery_barrier', action_id = NULL, holder = NULL, fencing_token = NULL,
           slot_revision = slot_revision + 1, reason = 'multiple-inflight', updated_at = ? WHERE scope_id = ?`,
        )
        .run(this.ports.now(), this.scopeId)
      return
    }
    if (rows.length === 1) {
      this.db.db
        .prepare(
          `UPDATE execution_slot SET state = 'held', action_id = ?, slot_revision = slot_revision + 1, reason = 'recovered', updated_at = ?
           WHERE scope_id = ? AND state != 'held'`,
        )
        .run(rows[0]!.id, this.ports.now(), this.scopeId)
    }
  }

  inheritAccess(ownerId: string, grantRef: string): AccessView {
    const existing = this.readAccess()
    if (existing) return existing
    const now = this.ports.now()
    this.db.db
      .prepare(
        `INSERT INTO source_access(scope_id,mode,workspace_ids_json,session_ids_json,granted_by,grant_ref,policy_epoch,updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(this.scopeId, 'all_authorized', '[]', '[]', `host-inherited:${ownerId}`, grantRef, 1, now)
    return this.readAccess()!
  }

  readAccess(): AccessView | null {
    const row = this.db.db.prepare('SELECT * FROM source_access WHERE scope_id = ?').get(this.scopeId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return {
      mode: row.mode as AccessView['mode'],
      workspaceIds: JSON.parse(String(row.workspace_ids_json)) as string[],
      sessionIds: JSON.parse(String(row.session_ids_json)) as string[],
      policyEpoch: Number(row.policy_epoch),
      grantedBy: String(row.granted_by),
      inherited: String(row.granted_by).startsWith('host-inherited:'),
    }
  }

  async setAccess(args: AccessUpdateArgs, call: TrustedCall): Promise<Reply<'boop.access', AccessView>> {
    if (call.originKind !== 'ui') {
      return failReply('boop.access', { code: 'SCOPE_DENIED', message: '工作范围只能在设置里由你自己调整。', retryable: false }, args.requestId)
    }
    if (!this.ports.fenceOk(call)) {
      return failReply('boop.access', { code: 'WRITER_FENCE_LOST', message: '当前数据连接已换人保管，这次没有改范围。', retryable: true }, args.requestId)
    }
    const current = this.readAccess()
    if (!current || current.policyEpoch !== args.expectedPolicyEpoch) {
      return failReply('boop.access', { code: 'TASK_VERSION_CONFLICT', message: '范围刚刚变过，请看一下最新范围再保存。', retryable: true }, args.requestId)
    }
    const nextEpoch = current.policyEpoch + 1
    await this.db.write(() => {
      this.db.db
        .prepare(
          `UPDATE source_access SET mode = ?, workspace_ids_json = ?, session_ids_json = ?, granted_by = ?, grant_ref = ?, policy_epoch = ?, updated_at = ?
           WHERE scope_id = ? AND policy_epoch = ?`,
        )
        .run(args.mode, JSON.stringify(args.workspaceIds), JSON.stringify(args.sessionIds), 'user-settings', args.requestId, nextEpoch, this.ports.now(), this.scopeId, current.policyEpoch)
      this.db.db.prepare('UPDATE scopes SET policy_epoch = ? WHERE scope_id = ?').run(nextEpoch, this.scopeId)
    })
    return okReply('boop.access', this.readAccess()!, { requestId: args.requestId })
  }

  canRead(sessionId: string, workspaceId: string | null): 'allow' | 'deny' | 'unknown' {
    if (this.ports.excluded(sessionId)) return 'deny'
    const host = this.ports.hostCanRead(sessionId)
    if (host === 'unknown') return 'unknown'
    if (host === false) return 'deny'
    const access = this.readAccess()
    if (!access) return 'unknown'
    if (access.mode === 'none') return 'deny'
    if (access.mode === 'selected') {
      if (access.sessionIds.includes(sessionId)) return 'allow'
      const workspace = workspaceId ?? this.workspaces.get(sessionId) ?? null
      if (workspace && access.workspaceIds.includes(workspace)) return 'allow'
      return 'deny'
    }
    return 'allow'
  }

  private rememberWorkspace(sessionId: string, workspaceId: string | null): void {
    this.workspaces.set(sessionId, workspaceId)
  }

  capabilities(send: boolean): HomeCapabilities {
    const access = this.readAccess()
    const readable = access !== null && access.mode !== 'none'
    return {
      send,
      readSources: readable,
      delegate: readable,
      stop: true,
      reasonCodes: readable ? [] : ['SOURCE_ACCESS_REQUIRED'],
    }
  }

  async catalog(input: {
    mode: 'work' | 'tasks' | 'capabilities'
    query?: string
    limit?: number
    originUserMessageId: string | null
    sourceSeq: number | null
    capabilities: HomeCapabilities
  }): Promise<Reply<'boop.catalog', WorkCatalog | { mode: 'tasks'; tasks: TaskView[]; truncated: boolean } | { mode: 'capabilities'; capabilities: HomeCapabilities }>> {
    if (input.mode === 'capabilities') return okReply('boop.catalog', { mode: 'capabilities', capabilities: input.capabilities })
    if (input.mode === 'tasks') {
      const page = this.list()
      return okReply('boop.catalog', { mode: 'tasks', tasks: page.items.slice(0, 5), truncated: page.items.length > 5 })
    }
    const limit = Math.min(5, Math.max(1, input.limit ?? 5))
    const sessions = await this.ports.listSessions(input.query ?? '')
    const candidates: WorkCandidate[] = []
    let truncated = false
    for (const session of sessions) {
      if (session.home || session.archived || session.subagent) continue
      this.rememberWorkspace(session.sessionId, session.workspaceId)
      if (this.canRead(session.sessionId, session.workspaceId) !== 'allow') continue
      if (candidates.length >= limit) {
        truncated = true
        break
      }
      const mention = formatSessionReferenceMention({ sessionId: session.sessionId, label: session.title })
      candidates.push({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        title: session.title,
        workspaceTitle: session.workspaceTitle,
        mention,
        selectionKey: hash({ sessionId: session.sessionId, origin: input.originUserMessageId, at: input.sourceSeq }).slice(0, 24),
        activity: session.activity,
        lastActivityAt: session.lastActivityAt,
        preview: session.preview && session.preview.length > 0 ? session.preview.slice(0, 160) : null,
      })
    }
    const data: WorkCatalog = {
      mode: 'work',
      originUserMessageId: input.originUserMessageId,
      sourceSeq: input.sourceSeq,
      generatedAt: this.ports.now(),
      candidates,
      truncated,
    }
    return okReply('boop.catalog', data)
  }

  async readContext(input: {
    targetSessionId?: string
    taskId?: string
    question?: string
    beforeSeq?: number
    limit?: number
    call: TrustedCall
  }): Promise<Reply<'boop.context', ContextView>> {
    if (input.call.originKind !== 'user') {
      return failReply('boop.context', { code: 'SCOPE_DENIED', message: '读取上下文需要来自你刚刚发出的消息。', retryable: false })
    }
    const targetSessionId = input.targetSessionId ?? this.targetOf(input.taskId)
    if (!targetSessionId) {
      return failReply('boop.context', { code: 'TARGET_NOT_FOUND', message: '没有找到要读取的会话。', retryable: false })
    }
    const observed = await this.ports.observe(targetSessionId)
    if (!observed || !observed.reachable) {
      return failReply('boop.context', { code: 'TARGET_NOT_FOUND', message: '这个会话现在读不到。', retryable: true })
    }
    if (observed.archived) return failReply('boop.context', { code: 'TARGET_ARCHIVED', message: '这个会话已归档，不能继续委托。', retryable: false })
    if (observed.subagent || observed.home) {
      return failReply('boop.context', { code: 'TARGET_NOT_ORDINARY', message: '只能委托一个普通的已有会话。', retryable: false })
    }
    const access = this.canRead(targetSessionId, observed.workspaceId)
    this.rememberWorkspace(targetSessionId, observed.workspaceId)
    if (access !== 'allow') {
      return failReply('boop.context', {
        code: access === 'unknown' ? 'SOURCE_ACCESS_REQUIRED' : 'SCOPE_DENIED',
        message: access === 'unknown' ? '还不能确认可以读取这个会话。' : '这个会话不在波波可以读取的范围内。',
        retryable: false,
      })
    }
    const limit = Math.min(80, Math.max(1, input.limit ?? 80))
    const events = await this.ports.readEvents(targetSessionId, limit, input.beforeSeq ?? null)
    let body = ''
    const kept: ContextEvent[] = []
    for (const event of events) {
      if (body.length + event.text.length > 24_000) break
      kept.push(event)
      body += `${event.text}\n`
    }
    const id = `ctx_${randomUUID()}`
    const created = this.ports.now()
    const expires = new Date(this.ports.nowMs() + 5 * 60_000).toISOString()
    const contextHash = hash({ body, head: observed.headSeq, user: observed.latestDirectUserSeq, generation: observed.sourceGeneration })
    await this.db.write(() => {
      this.db.db
        .prepare(
          `INSERT INTO context_snapshot(id,scope_id,main_session_id,origin_message_id,target_session_id,source_generation,head_seq,latest_user_seq,latest_user_message_id,policy_epoch,context_hash,refs_json,created_at,expires_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          this.scopeId,
          input.call.mainSessionId,
          input.call.originRef,
          targetSessionId,
          observed.sourceGeneration,
          observed.headSeq,
          observed.latestDirectUserSeq,
          observed.latestDirectUserMessageId,
          input.call.policyEpoch,
          contextHash,
          JSON.stringify(kept.map((event) => event.seq)),
          created,
          expires,
        )
    })
    const view: ContextView = {
      targetSessionId,
      taskId: input.taskId ?? null,
      contextToken: id,
      sourceGeneration: observed.sourceGeneration,
      headSeq: observed.headSeq,
      latestDirectUserSeq: observed.latestDirectUserSeq,
      body: body.trim(),
      evidence: kept.map((event) => ({ sessionId: event.sessionId, sourceGeneration: event.sourceGeneration, seq: event.seq })),
      truncated: kept.length < events.length,
      nextBeforeSeq: kept.length > 0 ? kept[0]!.seq : null,
      memoryFreshness: 'current',
    }
    return okReply('boop.context', view)
  }

  async prepare(args: DispatchArgs, call: TrustedCall): Promise<Reply<'boop.dispatch', { taskId: string; actionId: string; appliedTaskVersion: number; disposition: 'queued'; productState: TaskView['productState']; reasonCode: string | null }>> {
    if (call.originKind !== 'user') {
      return failReply('boop.dispatch', { code: 'SCOPE_DENIED', message: '只有你发出的消息才能形成委托。', retryable: false }, args.requestId)
    }
    if (!this.ports.fenceOk(call)) {
      return failReply('boop.dispatch', { code: 'WRITER_FENCE_LOST', message: '当前数据连接已换人保管，这次没有新建工作。', retryable: true }, args.requestId)
    }
    const digest = payloadHash({ ...args, criteria: args.criteria ?? [], exclusions: args.exclusions ?? [], taskVersion: 1, policyEpoch: call.policyEpoch })
    const replay = this.receipt('dispatch', call.originRef, args.requestId)
    if (replay && replay.payload_hash !== digest) {
      return failReply('boop.dispatch', { code: 'REQUEST_ID_CONFLICT', message: '同一次请求的内容和上次不一样，没有另建工作。', retryable: false, taskId: replay.task_id ?? undefined }, args.requestId)
    }
    if (replay?.task_id) {
      const view = this.detail(replay.task_id)
      return okReply('boop.dispatch', {
        taskId: replay.task_id,
        actionId: String(replay.action_id),
        appliedTaskVersion: Number(replay.applied_task_version),
        disposition: 'queued',
        productState: view?.productState ?? 'queued',
        reasonCode: null,
      }, { requestId: args.requestId, replayed: true })
    }
    const snapshot = this.snapshot(args.contextToken)
    if (!snapshot) return failReply('boop.dispatch', { code: 'CONTEXT_REQUIRED', message: '需要先读取这个会话的近况。', retryable: true }, args.requestId)
    if (snapshot.target_session_id !== args.targetSessionId || snapshot.main_session_id !== call.mainSessionId) {
      return failReply('boop.dispatch', { code: 'CONTEXT_REQUIRED', message: '读取到的上下文和这次目标对不上。', retryable: true }, args.requestId)
    }
    if (Date.parse(snapshot.expires_at) <= this.ports.nowMs()) {
      return failReply('boop.dispatch', { code: 'CONTEXT_EXPIRED', message: '刚才读到的内容已过期，需要再读一次。', retryable: true }, args.requestId)
    }
    if (String(snapshot.origin_message_id) !== call.originRef || snapshot.main_session_id !== call.mainSessionId) {
      return failReply('boop.dispatch', { code: 'CONTEXT_REQUIRED', message: '读取到的上下文和这次消息对不上。', retryable: true }, args.requestId)
    }
    if (Number(snapshot.policy_epoch) !== call.policyEpoch) {
      return failReply('boop.dispatch', { code: 'CONTEXT_CHANGED', message: '读取范围变了，需要按新范围再读一次。', retryable: true }, args.requestId)
    }
    const observed = await this.ports.observe(args.targetSessionId)
    if (!observed?.reachable) return failReply('boop.dispatch', { code: 'TARGET_NOT_FOUND', message: '没有找到这个会话。', retryable: true }, args.requestId)
    this.rememberWorkspace(args.targetSessionId, observed.workspaceId)
    if (observed.home || observed.subagent) return failReply('boop.dispatch', { code: 'TARGET_NOT_ORDINARY', message: '不能把波波自己或子代理当成执行会话。', retryable: false }, args.requestId)
    if (observed.archived) return failReply('boop.dispatch', { code: 'TARGET_ARCHIVED', message: '这个会话已归档。', retryable: false }, args.requestId)
    if (
      String(snapshot.source_generation) !== observed.sourceGeneration
      || Number(snapshot.head_seq) !== observed.headSeq
      || Number(snapshot.latest_user_seq) !== observed.latestDirectUserSeq
    ) {
      return failReply('boop.dispatch', { code: 'CONTEXT_CHANGED', message: '原会话里有了新的要求，需要再读一次近况。', retryable: true }, args.requestId)
    }
    const access = this.canRead(args.targetSessionId, observed.workspaceId)
    if (access !== 'allow') {
      return failReply('boop.dispatch', { code: 'SCOPE_DENIED', message: '这个会话不在可以委托的范围内。', retryable: false }, args.requestId)
    }
    if (!this.ports.fenceOk(call)) {
      return failReply('boop.dispatch', { code: 'WRITER_FENCE_LOST', message: '当前数据连接已换人保管，这次没有新建工作。', retryable: true }, args.requestId)
    }
    const taskId = `tsk_${randomUUID()}`
    const actionId = `act_${randomUUID()}`
    const now = this.ports.now()
    await this.db.write(() => {
      this.ensureSlot()
      this.db.db
        .prepare(
          `INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at,state_seq,engine_version,stop_requested)
           VALUES(?,?,?,'active','not_requested',1,?,?,?,?,?,0,2,0)`,
        )
        .run(taskId, this.scopeId, args.goal, JSON.stringify(args.criteria ?? []), JSON.stringify(args.exclusions ?? []), call.originRef, now, now)
      this.db.db
        .prepare(`INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)`)
        .run(taskId, this.scopeId, 1, JSON.stringify(args), call.originRef, now)
      this.db.db
        .prepare(`INSERT INTO task_target(task_id,scope_id,workspace_id,session_id,role,resource_key) VALUES(?,?,?,?,?,?)`)
        .run(taskId, this.scopeId, observed.workspaceId, args.targetSessionId, 'executor-v2', `executor-v2:${args.targetSessionId}`)
      this.db.db
        .prepare(
          `INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at,managed_v2)
           VALUES(?,?,?,?,?,?,?,'planned',?,NULL,?,?,?,?,1)`,
        )
        .run(actionId, this.scopeId, taskId, 1, args.targetSessionId, digest, JSON.stringify(args), actionId, call.policyEpoch, call.originRef, now, now)
      this.db.db.prepare(`INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,'prepared',0)`).run(actionId, this.scopeId)
      this.db.db
        .prepare(
          `INSERT INTO action_runtime(action_id,scope_id,context_id,main_session_id,main_binding_version,origin_message_id,origin_turn_id,tool_call_id,target_generation,latest_user_seq,dispatch_policy,queue_reason,ownership,stop_requested,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,'when_idle',NULL,'not_started',0,?)`,
        )
        .run(actionId, this.scopeId, args.contextToken, call.mainSessionId, call.bindingVersion, call.originRef, 'tool', call.toolCallId ?? null, observed.sourceGeneration, observed.latestDirectUserSeq, now)
      this.db.db
        .prepare(
          `INSERT INTO request_receipt(scope_id,operation,origin_ref,request_id,payload_hash,task_id,action_id,applied_task_version,response_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(this.scopeId, 'dispatch', call.originRef, args.requestId, digest, taskId, actionId, 1, JSON.stringify({ taskId, actionId }), now)
    })
    const view = this.detail(taskId)
    return okReply('boop.dispatch', {
      taskId,
      actionId,
      appliedTaskVersion: 1,
      disposition: 'queued',
      productState: view?.productState ?? 'queued',
      reasonCode: null,
    }, { requestId: args.requestId })
  }

  async tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.tickOnce().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async tickOnce(): Promise<void> {
    this.ensureSlot()
    const slot = this.slot()
    if (!slot || slot.state === 'recovery_barrier') return
    if (slot.state === 'held' && slot.action_id) {
      await this.observeHeld(slot.action_id)
      return
    }
    const queued = this.db.db
      .prepare(
        `SELECT a.id, a.task_id, a.target_session_id, a.created_at
         FROM action a
         JOIN command_outbox o ON o.action_id = a.id AND o.scope_id = a.scope_id
         WHERE a.scope_id = ? AND a.managed_v2 = 1 AND a.state = 'planned' AND o.state = 'prepared'
         ORDER BY a.created_at, a.id`,
      )
      .all(this.scopeId) as Array<{ id: string; task_id: string; target_session_id: string }>
    const ready: Array<{ id: string; target_session_id: string }> = []
    for (const action of queued) {
      const task = this.taskRow(action.task_id)
      if (!task || Number(task.stop_requested) === 1) continue
      const row = this.actionRow(action.id)
      if (!this.ports.fenceOk(this.leaseCall())) {
        this.rejectPlanned(action.id)
        continue
      }
      const access = this.readAccess()
      if (!access || Number(row?.policy_epoch) !== access.policyEpoch) {
        this.rejectPlanned(action.id)
        continue
      }
      const observed = await this.ports.observe(action.target_session_id)
      if (!observed?.reachable || observed.archived || observed.subagent || observed.home) {
        this.rejectPlanned(action.id)
        continue
      }
      this.rememberWorkspace(action.target_session_id, observed.workspaceId)
      if (this.canRead(action.target_session_id, observed.workspaceId) !== 'allow') {
        this.rejectPlanned(action.id)
        continue
      }
      const runtime = this.runtime(action.id)
      if (runtime && (observed.sourceGeneration !== runtime.target_generation || observed.latestDirectUserSeq !== Number(runtime.latest_user_seq))) {
        this.setQueue(action.id, 'context_changed')
        continue
      }
      if (observed.busy || observed.pendingHuman) {
        this.setQueue(action.id, 'target_busy')
        continue
      }
      ready.push(action)
    }
    const chosen = ready[0]
    if (!chosen || this.slot()?.state !== 'free') {
      for (const action of ready) this.setQueue(action.id, 'global_slot')
      return
    }
    for (const action of ready.slice(1)) this.setQueue(action.id, 'global_slot')
    const claimed = await this.claim(chosen.id)
    if (!claimed) return
    await this.sendClaimed(chosen.id, chosen.target_session_id)
  }

  private async sendClaimed(actionId: string, sessionId: string): Promise<void> {
    const action = this.actionRow(actionId)
    if (!action) return
    const observed = await this.ports.observe(sessionId)
    const access = this.readAccess()
    const runtime = this.runtime(actionId)
    const task = this.taskRow(String(action.task_id))
    const blocked = !this.ports.fenceOk(this.leaseCall())
      || !access
      || Number(action.policy_epoch) !== access.policyEpoch
      || Number(task?.stop_requested) === 1
      || !observed?.reachable
      || observed.archived
      || observed.subagent
      || observed.home
      || this.canRead(sessionId, observed.workspaceId) !== 'allow'
      || (runtime && (observed.sourceGeneration !== runtime.target_generation || observed.latestDirectUserSeq !== Number(runtime.latest_user_seq)))
    if (blocked) {
      await this.db.write(() => {
        this.db.db.prepare(`UPDATE action SET state = 'rejected', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'dispatching'`).run(this.ports.now(), actionId, this.scopeId)
        this.db.db.prepare(`UPDATE command_outbox SET state = 'cancelled' WHERE action_id = ? AND scope_id = ?`).run(actionId, this.scopeId)
        this.releaseSlot(actionId)
      })
      return
    }
    const args = JSON.parse(String(action.payload_json)) as DispatchArgs
    const message = {
      id: actionId,
      role: 'user' as const,
      content: [
        { type: 'text', text: args.instruction },
        { type: 'text', text: JSON.stringify({ boop: { taskId: action.task_id, actionId, taskVersion: action.task_version, exclusions: args.exclusions ?? [] } }) },
      ],
      source: { kind: 'boop-command', scopeId: this.scopeId, taskId: action.task_id, actionId, initiatorRef: action.origin_ref, policyEpoch: action.policy_epoch },
    }
    let outcome: 'enqueued' | 'before-enqueue' | 'unknown' = 'unknown'
    try {
      outcome = await this.ports.followup(sessionId, message)
    } catch {
      outcome = 'unknown'
    }
    if (outcome === 'before-enqueue') {
      await this.db.write(() => {
        this.db.db.prepare(`UPDATE action SET state = 'planned', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'dispatching'`).run(this.ports.now(), actionId, this.scopeId)
        this.db.db.prepare(`UPDATE command_outbox SET state = 'prepared' WHERE action_id = ? AND scope_id = ?`).run(actionId, this.scopeId)
        this.releaseSlot(actionId)
      })
      return
    }
    if (outcome === 'enqueued') {
      // The target claims this inbox row before pre-step, so pending() is already
      // false and the log does not contain it yet. Downgrading to outcome_unknown
      // here makes the gate fail closed (not-tracked) and ends the turn blocked.
      const now = this.ports.now()
      this.db.db.prepare(`UPDATE action SET state = 'accepted', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'dispatching'`).run(now, actionId, this.scopeId)
      this.db.db.prepare(`UPDATE command_outbox SET state = 'accepted' WHERE action_id = ? AND scope_id = ?`).run(actionId, this.scopeId)
      try {
        await this.ports.flush(sessionId)
      } catch {
        /* observation still follows the accepted command */
      }
      return
    }
    await this.db.write(() => {
      this.db.db.prepare(`UPDATE action SET state = 'outcome_unknown', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'dispatching'`).run(this.ports.now(), actionId, this.scopeId)
      this.db.db.prepare(`UPDATE command_outbox SET state = 'unknown' WHERE action_id = ? AND scope_id = ?`).run(actionId, this.scopeId)
    })
  }

  private async observeHeld(actionId: string): Promise<void> {
    const action = this.actionRow(actionId)
    if (!action) return
    const observed = await this.ports.observe(String(action.target_session_id))
    if (!observed) return
    const now = this.ports.now()
    const messageSeen = await this.ports.visible(String(action.target_session_id), String(action.message_id))
    const sameTurn = action.turn_id != null && observed.turnId != null && String(action.turn_id) === String(observed.turnId)
    if (!observed.turnTerminal || (!messageSeen && !sameTurn)) {
      await this.db.write(() => {
        const state = !observed.turnTerminal && observed.turnId ? 'running' : String(action.state)
        const turnId = !observed.turnTerminal ? observed.turnId : null
        this.db.db.prepare(`UPDATE action SET state = ?, turn_id = COALESCE(?, turn_id), updated_at = ? WHERE id = ? AND scope_id = ?`).run(state, turnId, now, actionId, this.scopeId)
        this.db.db
          .prepare(`UPDATE action_runtime SET ownership = ?, native_approval_id = ?, observed_through_seq = ?, updated_at = ? WHERE action_id = ? AND scope_id = ?`)
          .run(observed.ownership, observed.approvalId, observed.headSeq, now, actionId, this.scopeId)
        this.db.db.prepare(`UPDATE task SET state_seq = state_seq + 1, updated_at = ? WHERE id = ? AND scope_id = ?`).run(now, action.task_id, this.scopeId)
      })
      return
    }
    await this.finishAction(actionId, observed)
  }

  private async finishAction(actionId: string, observed: TargetObservation): Promise<void> {
    const action = this.actionRow(actionId)
    if (!action) return
    const logical = `${actionId}:${observed.evidenceSeq}:final`
    const existing = this.db.db.prepare(`SELECT id FROM task_result WHERE scope_id = ? AND logical_key = ?`).get(this.scopeId, logical) as { id?: string } | undefined
    if (existing?.id) {
      await this.db.write(() => this.releaseIfHeld(actionId, 'already-recorded'))
      return
    }
    const resultId = `res_${randomUUID()}`
    const nativeMessageId = `boopres_${resultId}`
    const deliverable = observed.deliverable && Boolean(observed.summary && observed.summary.trim().length > 0)
    const now = this.ports.now()
    const runtime = this.runtime(actionId)
    await this.db.write(() => {
      this.db.db.prepare(`UPDATE action SET state = 'settled', turn_id = COALESCE(?, turn_id), updated_at = ? WHERE id = ? AND scope_id = ?`).run(observed.turnId, now, actionId, this.scopeId)
      this.db.db.prepare(`UPDATE command_outbox SET state = 'accepted' WHERE action_id = ? AND scope_id = ? AND state IN ('sending','prepared','accepted')`).run(actionId, this.scopeId)
      this.db.db
        .prepare(`UPDATE action_runtime SET ownership = 'ended', terminal_seq = ?, observed_through_seq = ?, updated_at = ? WHERE action_id = ? AND scope_id = ?`)
        .run(observed.evidenceSeq, observed.headSeq, now, actionId, this.scopeId)
      this.db.db
        .prepare(
          `INSERT INTO task_result(id,scope_id,task_id,task_version,action_id,logical_key,kind,source_generation,event_seq,turn_id,outcome,deliverable,summary,artifacts_json,evidence_json,checks_json,missing_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          resultId,
          this.scopeId,
          action.task_id,
          action.task_version,
          actionId,
          logical,
          'final',
          observed.sourceGeneration,
          observed.evidenceSeq,
          observed.turnId,
          deliverable ? 'completed' : 'inconclusive',
          deliverable ? 1 : 0,
          observed.summary ?? '已收到回复，结果还需要核对。',
          JSON.stringify(observed.artifacts),
          JSON.stringify([{ sessionId: action.target_session_id, sourceGeneration: observed.sourceGeneration, seq: observed.evidenceSeq }]),
          JSON.stringify(observed.checks),
          JSON.stringify(observed.missing),
          now,
        )
      this.db.db
        .prepare(
          `INSERT INTO result_outbox(result_id,scope_id,native_message_id,target_main_session_id,target_binding_version,state,attempt,updated_at)
           VALUES(?,?,?,?,?,'pending',0,?)`,
        )
        .run(resultId, this.scopeId, nativeMessageId, runtime?.main_session_id ?? '', Number(runtime?.main_binding_version ?? 1), now)
      this.db.db.prepare(`UPDATE task SET state_seq = state_seq + 1, updated_at = ? WHERE id = ? AND scope_id = ?`).run(now, action.task_id, this.scopeId)
      this.releaseIfHeld(actionId, 'settled')
    })
  }

  async deliver(): Promise<void> {
    if (!(await this.ports.mainIdle())) return
    const rows = this.db.db
      .prepare(`SELECT result_id, native_message_id, target_main_session_id, state FROM result_outbox WHERE scope_id = ? AND state IN ('pending','sending','unknown') ORDER BY updated_at`)
      .all(this.scopeId) as Array<{ result_id: string; native_message_id: string; target_main_session_id: string; state: string }>
    for (const row of rows) {
      if (await this.ports.visible(row.target_main_session_id, row.native_message_id)) {
        this.db.db.prepare(`UPDATE result_outbox SET state = 'sent', updated_at = ? WHERE result_id = ? AND scope_id = ?`).run(this.ports.now(), row.result_id, this.scopeId)
        continue
      }
      if (await this.ports.pending(row.target_main_session_id, row.native_message_id)) {
        this.db.db.prepare(`UPDATE result_outbox SET state = 'sending', updated_at = ? WHERE result_id = ? AND scope_id = ? AND state = 'pending'`).run(this.ports.now(), row.result_id, this.scopeId)
        continue
      }
      if (row.state !== 'pending') continue
      this.db.db.prepare(`UPDATE result_outbox SET state = 'sending', updated_at = ? WHERE result_id = ? AND scope_id = ? AND state = 'pending'`).run(this.ports.now(), row.result_id, this.scopeId)
      const result = this.db.db.prepare(`SELECT summary, task_id FROM task_result WHERE id = ? AND scope_id = ?`).get(row.result_id, this.scopeId) as { summary?: string; task_id?: string } | undefined
      const message = {
        id: row.native_message_id,
        role: 'user' as const,
        content: [{ type: 'text', text: `波波带回结果：${result?.summary ?? ''}` }],
        source: { kind: 'boop-result', resultId: row.result_id, actionId: null, taskId: result?.task_id ?? null },
      }
      let outcome: 'enqueued' | 'before-enqueue' | 'unknown' = 'unknown'
      try {
        outcome = await this.ports.followup(row.target_main_session_id, message)
      } catch {
        outcome = 'unknown'
      }
      if (outcome !== 'enqueued') {
        this.db.db.prepare(`UPDATE result_outbox SET state = 'unknown', updated_at = ? WHERE result_id = ?`).run(this.ports.now(), row.result_id)
        continue
      }
      const flushed = await this.ports.flush(row.target_main_session_id)
      const seen = flushed && ((await this.ports.pending(row.target_main_session_id, row.native_message_id)) || (await this.ports.visible(row.target_main_session_id, row.native_message_id)))
      this.db.db
        .prepare(`UPDATE result_outbox SET state = ?, attempt = attempt + 1, updated_at = ? WHERE result_id = ? AND scope_id = ?`)
        .run(seen ? 'sent' : 'unknown', this.ports.now(), row.result_id, this.scopeId)
    }
  }

  async stop(args: StopArgs, call: TrustedCall): Promise<Reply<'boop.control', { taskId: string; appliedTaskVersion: number; actionId: string | null; operation: 'stop'; disposition: 'stopped' | 'stop_requested' | 'stopped_future_only'; productState: TaskView['productState']; reasonCode: string | null }>> {
    if (!this.ports.fenceOk(call)) {
      return failReply('boop.control', { code: 'WRITER_FENCE_LOST', message: '当前数据连接已换人保管，停止请求没有发出。', retryable: true }, args.requestId)
    }
    const task = this.taskRow(args.taskId)
    if (!task) return failReply('boop.control', { code: 'TARGET_NOT_FOUND', message: '没有找到这件工作。', retryable: false }, args.requestId)
    if (Number(task.version) !== args.expectedTaskVersion) {
      return failReply('boop.control', { code: 'TASK_VERSION_CONFLICT', message: '工作内容已经变过，请看最新进展再停止。', retryable: true, taskId: args.taskId }, args.requestId)
    }
    const rows = this.actions(args.taskId)
    await this.db.write(() => {
      this.db.db.prepare(`UPDATE task SET stop_requested = 1, state_seq = state_seq + 1, updated_at = ? WHERE id = ? AND scope_id = ?`).run(this.ports.now(), args.taskId, this.scopeId)
      for (const action of rows) {
        this.db.db.prepare(`UPDATE action_runtime SET stop_requested = 1, updated_at = ? WHERE action_id = ? AND scope_id = ?`).run(this.ports.now(), action.id, this.scopeId)
        if (action.state === 'planned' || action.state === 'rejected') {
          this.db.db.prepare(`UPDATE action SET state = 'stopped', updated_at = ? WHERE id = ? AND scope_id = ? AND state IN ('planned','rejected')`).run(this.ports.now(), action.id, this.scopeId)
          this.db.db.prepare(`UPDATE command_outbox SET state = 'cancelled' WHERE action_id = ? AND scope_id = ? AND state IN ('prepared','blocked')`).run(action.id, this.scopeId)
          this.releaseIfHeld(action.id, 'stopped-before-send')
        }
      }
    })
    const live = rows.filter((action) => OCCUPYING.includes(String(action.state)))
    if (live.length === 0) return this.controlReply(args, 'stopped', null)
    let futureOnly = false
    let requested = false
    for (const action of live) {
      const observed = await this.ports.observe(String(action.target_session_id))
      if (observed && (observed.ownership === 'user_takeover' || observed.ownership === 'mixed')) {
        await this.db.write(() => {
          this.db.db.prepare(`UPDATE action_runtime SET ownership = ?, updated_at = ? WHERE action_id = ? AND scope_id = ?`).run(observed.ownership, this.ports.now(), action.id, this.scopeId)
        })
        futureOnly = true
        continue
      }
      if (observed?.pendingMessage && !observed.turnId) {
        const removed = await this.ports.remove(String(action.target_session_id), String(action.message_id))
        const flushed = await this.ports.flush(String(action.target_session_id))
        const still = await this.ports.pending(String(action.target_session_id), String(action.message_id))
        if (removed && flushed && !still) {
          await this.db.write(() => {
            this.db.db.prepare(`UPDATE action SET state = 'stopped', updated_at = ? WHERE id = ? AND scope_id = ?`).run(this.ports.now(), action.id, this.scopeId)
            this.db.db.prepare(`UPDATE command_outbox SET state = 'cancelled' WHERE action_id = ? AND scope_id = ?`).run(action.id, this.scopeId)
            this.releaseIfHeld(action.id, 'removed-pending')
          })
          continue
        }
      }
      if (observed?.ownership === 'exclusive' && observed.turnId && !observed.turnTerminal) {
        await this.ports.cancelTurn(String(action.target_session_id))
      }
      requested = true
    }
    if (futureOnly && !requested) return this.controlReply(args, 'stopped_future_only', 'STOP_OWNERSHIP_CHANGED')
    const stillLive = this.actions(args.taskId).some((action) => OCCUPYING.includes(String(action.state)))
    if (!stillLive) return this.controlReply(args, 'stopped', null)
    return this.controlReply(args, 'stop_requested', null)
  }

  async revise(args: ContinueArgs, call: TrustedCall): Promise<Reply<'boop.control', { taskId: string; appliedTaskVersion: number; actionId: string | null; operation: 'continue'; disposition: 'queued'; productState: TaskView['productState']; reasonCode: string | null }>> {
    if (call.originKind !== 'user') {
      return failReply('boop.control', { code: 'SCOPE_DENIED', message: '继续处理需要你补充要求后再发送。', retryable: false }, args.requestId)
    }
    const task = this.taskRow(args.taskId)
    if (!task) return failReply('boop.control', { code: 'TARGET_NOT_FOUND', message: '没有找到这件工作。', retryable: false }, args.requestId)
    if (Number(task.version) !== args.expectedTaskVersion) {
      return failReply('boop.control', { code: 'TASK_VERSION_CONFLICT', message: '工作已经有新版本，请基于最新内容继续。', retryable: true, taskId: args.taskId, appliedTaskVersion: Number(task.version) }, args.requestId)
    }
    const latest = this.latestAction(args.taskId)
    if (latest?.state === 'outcome_unknown') {
      return failReply('boop.control', { code: 'OUTCOME_UNKNOWN', message: '上一件的执行结果还不明确，不能另起一条把旧的绕过去。', retryable: true, taskId: args.taskId }, args.requestId)
    }
    const snapshot = this.snapshot(args.contextToken)
    if (!snapshot || Date.parse(snapshot.expires_at) <= this.ports.nowMs()) {
      return failReply('boop.control', { code: 'CONTEXT_EXPIRED', message: '需要重新读取近况后再继续。', retryable: true }, args.requestId)
    }
    const target = String(this.targetOf(args.taskId) ?? snapshot.target_session_id)
    if (snapshot.target_session_id !== target) {
      return failReply('boop.control', { code: 'CONTEXT_REQUIRED', message: '继续处理不能换成另一个会话。', retryable: false }, args.requestId)
    }
    const nextVersion = Number(task.version) + 1
    const actionId = `act_${randomUUID()}`
    const now = this.ports.now()
    const goal = args.goal ?? String(task.goal)
    const criteria = args.criteria ?? this.stringList(task.criteria_json)
    const exclusions = args.exclusions ?? this.stringList(task.exclusions_json)
    const revision = { ...args, goal, criteria, exclusions }
    const digest = payloadHash({ targetSessionId: target, goal, instruction: args.instruction, criteria, exclusions, taskVersion: nextVersion, policyEpoch: call.policyEpoch })
    const queueReason = latest && OCCUPYING.includes(String(latest.state)) ? 'previous_action' : null
    try {
    await this.db.write(() => {
      const changed = this.db.db
        .prepare(
          `UPDATE task SET version = ?, goal = ?, criteria_json = ?, exclusions_json = ?, lifecycle = 'active', verification = 'not_requested', stop_requested = 0, state_seq = state_seq + 1, updated_at = ?
           WHERE id = ? AND scope_id = ? AND version = ?`,
        )
        .run(nextVersion, goal, JSON.stringify(criteria), JSON.stringify(exclusions), now, args.taskId, this.scopeId, args.expectedTaskVersion)
      if (!changed.changes) throw new Error('TASK_VERSION_CONFLICT')
      this.db.db.prepare(`INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)`).run(args.taskId, this.scopeId, nextVersion, JSON.stringify(revision), call.originRef, now)
      this.db.db
        .prepare(
          `INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,policy_epoch,origin_ref,created_at,updated_at,managed_v2)
           VALUES(?,?,?,?,?,?,?,'planned',?,?,?,?,?,1)`,
        )
        .run(actionId, this.scopeId, args.taskId, nextVersion, target, digest, JSON.stringify(revision), actionId, call.policyEpoch, call.originRef, now, now)
      this.db.db.prepare(`INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,'prepared',0)`).run(actionId, this.scopeId)
      this.db.db
        .prepare(
          `INSERT INTO action_runtime(action_id,scope_id,context_id,main_session_id,main_binding_version,origin_message_id,origin_turn_id,target_generation,latest_user_seq,queue_reason,ownership,stop_requested,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,'not_started',0,?)`,
        )
        .run(actionId, this.scopeId, args.contextToken, call.mainSessionId, call.bindingVersion, call.originRef, 'tool', snapshot.source_generation, snapshot.latest_user_seq, queueReason, now)
    })
    } catch (error) {
      if (error instanceof Error && error.message === 'TASK_VERSION_CONFLICT') {
        return failReply('boop.control', { code: 'TASK_VERSION_CONFLICT', message: '工作已经有新版本，请基于最新内容继续。', retryable: true, taskId: args.taskId }, args.requestId)
      }
      throw error
    }
    const view = this.detail(args.taskId)
    return okReply('boop.control', {
      taskId: args.taskId,
      appliedTaskVersion: nextVersion,
      actionId,
      operation: 'continue',
      disposition: 'queued',
      productState: view?.productState ?? 'queued',
      reasonCode: queueReason,
    }, { requestId: args.requestId })
  }

  async confirm(args: ConfirmArgs, call: TrustedCall): Promise<Reply<'boop.confirm', { acceptanceId: string; taskId: string; resultId: string; appliedTaskVersion: number; acceptedAt: string; verificationChangedToPassed: false }>> {
    if (call.originKind !== 'ui' || args.decision !== 'accept') {
      return failReply('boop.confirm', { code: 'SCOPE_DENIED', message: '确认收下只能由你在页面上操作。', retryable: false }, args.requestId)
    }
    const replay = this.receipt('confirm', call.originRef, args.requestId)
    if (replay) {
      const saved = JSON.parse(String(replay.response_json)) as { acceptanceId: string; appliedTaskVersion: number; acceptedAt: string; resultId: string }
      if (replay.payload_hash !== hash(args)) {
        return failReply('boop.confirm', { code: 'REQUEST_ID_CONFLICT', message: '这次确认和上次不是同一件事。', retryable: false, appliedTaskVersion: saved.appliedTaskVersion }, args.requestId)
      }
      return okReply('boop.confirm', { ...saved, taskId: args.taskId, verificationChangedToPassed: false }, { requestId: args.requestId, replayed: true })
    }
    const task = this.taskRow(args.taskId)
    const result = this.db.db.prepare(`SELECT * FROM task_result WHERE id = ? AND scope_id = ?`).get(args.resultId, this.scopeId) as any
    if (!task || !result || result.task_id !== args.taskId) {
      return failReply('boop.confirm', { code: 'RESULT_NOT_CONFIRMABLE', message: '没有可确认的交付结果。', retryable: false }, args.requestId)
    }
    if (Number(task.version) !== args.expectedTaskVersion || Number(result.task_version) !== args.expectedTaskVersion) {
      return failReply('boop.confirm', { code: 'RESULT_VERSION_CONFLICT', message: '这个结果属于较早的一版，不能当作当前版本已确认。', retryable: false, appliedTaskVersion: Number(result.task_version) }, args.requestId)
    }
    if (Number(result.deliverable) !== 1 || result.kind !== 'final') {
      return failReply('boop.confirm', { code: 'RESULT_NOT_CONFIRMABLE', message: '这还不是一份可以收下的结果。', retryable: false }, args.requestId)
    }
    const existing = this.db.db.prepare(`SELECT * FROM task_acceptance WHERE task_id = ? AND scope_id = ? AND task_version = ?`).get(args.taskId, this.scopeId, args.expectedTaskVersion) as any
    if (existing && existing.result_id !== args.resultId) {
      return failReply('boop.confirm', { code: 'ACCEPTANCE_CONFLICT', message: '这一版已经确认过另一份结果。', retryable: false, appliedTaskVersion: args.expectedTaskVersion }, args.requestId)
    }
    if (existing && existing.result_id === args.resultId) {
      return okReply('boop.confirm', {
        acceptanceId: String(existing.id),
        taskId: args.taskId,
        resultId: args.resultId,
        appliedTaskVersion: args.expectedTaskVersion,
        acceptedAt: String(existing.accepted_at),
        verificationChangedToPassed: false,
      }, { requestId: args.requestId, replayed: true })
    }
    const acceptanceId = `acc_${randomUUID()}`
    const acceptedAt = this.ports.now()
    const checksBefore = String(result.checks_json)
    await this.db.write(() => {
      this.db.db
        .prepare(
          `INSERT INTO task_acceptance(id,scope_id,task_id,task_version,result_id,owner_id,request_id,origin_ref,accepted_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(acceptanceId, this.scopeId, args.taskId, args.expectedTaskVersion, args.resultId, call.holder, args.requestId, call.originRef, acceptedAt)
      this.db.db
        .prepare(
          `UPDATE task SET lifecycle = 'completed', verification = CASE WHEN verification = 'passed' THEN 'passed' ELSE 'waived' END, state_seq = state_seq + 1, updated_at = ?
           WHERE id = ? AND scope_id = ? AND version = ?`,
        )
        .run(acceptedAt, args.taskId, this.scopeId, args.expectedTaskVersion)
      this.db.db
        .prepare(
          `INSERT INTO request_receipt(scope_id,operation,origin_ref,request_id,payload_hash,task_id,action_id,applied_task_version,response_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(this.scopeId, 'confirm', call.originRef, args.requestId, hash(args), args.taskId, result.action_id, args.expectedTaskVersion, JSON.stringify({ acceptanceId, appliedTaskVersion: args.expectedTaskVersion, acceptedAt, resultId: args.resultId }), acceptedAt)
    })
    const checksAfter = String((this.db.db.prepare(`SELECT checks_json FROM task_result WHERE id = ?`).get(args.resultId) as { checks_json: string }).checks_json)
    if (checksAfter !== checksBefore) throw new Error('confirm rewrote check evidence')
    return okReply('boop.confirm', {
      acceptanceId,
      taskId: args.taskId,
      resultId: args.resultId,
      appliedTaskVersion: args.expectedTaskVersion,
      acceptedAt,
      verificationChangedToPassed: false,
    }, { requestId: args.requestId })
  }

  async reconcile(taskId?: string): Promise<void> {
    const ids = taskId
      ? [taskId]
      : (this.db.db.prepare(`SELECT DISTINCT task_id FROM action WHERE scope_id = ? AND managed_v2 = 1 AND state = 'outcome_unknown'`).all(this.scopeId) as Array<{ task_id: string }>).map((row) => row.task_id)
    for (const id of ids) {
      const action = this.latestAction(id)
      if (!action) continue
      const observed = await this.ports.observe(String(action.target_session_id))
      if (!observed?.reachable) continue
      if (observed.pendingMessage) {
        await this.db.write(() => {
          this.db.db.prepare(`UPDATE action SET state = 'accepted', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'outcome_unknown'`).run(this.ports.now(), action.id, this.scopeId)
        })
        continue
      }
      if (observed.turnId && !observed.turnTerminal) continue
      if (observed.turnTerminal) {
        await this.finishAction(String(action.id), observed)
        continue
      }
      if (!observed.pendingMessage && !observed.turnId) {
        await this.db.write(() => {
          this.db.db.prepare(`UPDATE action SET state = 'settled', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'outcome_unknown'`).run(this.ports.now(), action.id, this.scopeId)
          const resultId = `res_${randomUUID()}`
          this.db.db
            .prepare(
              `INSERT INTO task_result(id,scope_id,task_id,task_version,action_id,logical_key,kind,source_generation,event_seq,outcome,deliverable,summary,artifacts_json,evidence_json,checks_json,missing_json,created_at)
               VALUES(?,?,?,?,?,?, 'final', ?,0,'inconclusive',0,?,?,?,?,?,?)`,
            )
            .run(resultId, this.scopeId, id, action.task_version, action.id, `${action.id}:reconcile:inconclusive`, observed.sourceGeneration, '已核对：没有找到仍在执行的请求，但也不能证明它没执行过。', '[]', '[]', '[]', JSON.stringify(['执行痕迹不完整']), this.ports.now())
          this.db.db.prepare(`UPDATE task SET lifecycle = 'recovery_required', state_seq = state_seq + 1, updated_at = ? WHERE id = ? AND scope_id = ?`).run(this.ports.now(), id, this.scopeId)
          this.releaseIfHeld(String(action.id), 'reconciled-inconclusive')
        })
      }
    }
  }

  list(): TaskPage {
    const ids = this.db.db.prepare(`SELECT id FROM task WHERE scope_id = ? ORDER BY updated_at DESC`).all(this.scopeId) as Array<{ id: string }>
    return { items: ids.map((row) => this.detail(row.id)).filter((item): item is TaskView => item !== null), nextCursor: null, syncedAt: this.ports.now() }
  }

  detail(taskId: string): TaskView | null {
    const task = this.taskRow(taskId)
    if (!task) return null
    const target = this.db.db.prepare(`SELECT * FROM task_target WHERE task_id = ? AND scope_id = ? AND role = 'executor-v2'`).get(taskId, this.scopeId) as any
    const legacyTarget = target ?? (this.db.db.prepare(`SELECT * FROM task_target WHERE task_id = ? AND scope_id = ? LIMIT 1`).get(taskId, this.scopeId) as any)
    const action = this.displayAction(taskId)
    const runtime = action ? this.runtime(String(action.id)) : undefined
    const result = this.db.db
      .prepare(`SELECT * FROM task_result WHERE task_id = ? AND scope_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(taskId, this.scopeId) as any
    const outbox = result
      ? (this.db.db.prepare(`SELECT state FROM result_outbox WHERE result_id = ? AND scope_id = ?`).get(result.id, this.scopeId) as { state?: string } | undefined)
      : undefined
    const acceptance = this.db.db
      .prepare(`SELECT * FROM task_acceptance WHERE task_id = ? AND scope_id = ? AND task_version = ?`)
      .get(taskId, this.scopeId, task.version) as any
    const slot = this.slot()
    const input: ProjectionInput = {
      taskId,
      taskVersion: Number(task.version),
      stateSeq: Number(task.state_seq ?? 0),
      title: String(task.goal),
      updatedAt: String(task.updated_at),
      engineVersion: Number(task.engine_version ?? 1),
      recovery: slot?.state === 'recovery_barrier' || String(task.lifecycle) === 'recovery_required',
      target: {
        sessionId: String(legacyTarget?.session_id ?? ''),
        workspaceId: legacyTarget?.workspace_id == null ? null : String(legacyTarget.workspace_id),
        sessionTitle: '原会话',
        workspaceTitle: null,
      },
      action: action
        ? {
            actionId: String(action.id),
            executionState: action.state as ExecutionState,
            stopRequested: Number(task.stop_requested) === 1 || Number(runtime?.stop_requested ?? 0) === 1,
            queueReason: runtime?.queue_reason == null ? null : String(runtime.queue_reason),
            ownership: String(runtime?.ownership ?? 'not_started'),
            nativeApprovalId: runtime?.native_approval_id == null ? null : String(runtime.native_approval_id),
          }
        : null,
      result: result
        ? {
            resultId: String(result.id),
            taskVersion: Number(result.task_version),
            actionId: String(result.action_id),
            kind: result.kind as ProjectionResult['kind'],
            outcome: result.outcome as ProjectionResult['outcome'],
            deliverable: Number(result.deliverable) === 1,
            summary: String(result.summary),
            artifacts: JSON.parse(String(result.artifacts_json)),
            evidence: JSON.parse(String(result.evidence_json)),
            checks: JSON.parse(String(result.checks_json)),
            missing: JSON.parse(String(result.missing_json)),
            deliveryState: (outbox?.state as ProjectionResult['deliveryState']) ?? 'pending',
            createdAt: String(result.created_at),
          }
        : null,
      acceptance: acceptance
        ? { acceptanceId: String(acceptance.id), acceptedAt: String(acceptance.accepted_at), appliedTaskVersion: Number(acceptance.task_version) }
        : null,
    }
    return projectTask(input)
  }

  private async controlReply(
    args: StopArgs,
    disposition: 'stopped' | 'stop_requested' | 'stopped_future_only',
    reasonCode: string | null,
  ): Promise<Reply<'boop.control', { taskId: string; appliedTaskVersion: number; actionId: string | null; operation: 'stop'; disposition: 'stopped' | 'stop_requested' | 'stopped_future_only'; productState: TaskView['productState']; reasonCode: string | null }>> {
    const view = this.detail(args.taskId)
    return okReply('boop.control', {
      taskId: args.taskId,
      appliedTaskVersion: args.expectedTaskVersion,
      actionId: view?.latestAction?.actionId ?? null,
      operation: 'stop',
      disposition,
      productState: view?.productState ?? 'needs_attention',
      reasonCode,
    }, { requestId: args.requestId })
  }

  private ensureSlot(): void {
    this.db.db
      .prepare(
        `INSERT INTO execution_slot(scope_id,state,action_id,slot_revision,updated_at)
         SELECT ?, 'free', NULL, 0, ? WHERE NOT EXISTS (SELECT 1 FROM execution_slot WHERE scope_id = ?)`,
      )
      .run(this.scopeId, this.ports.now(), this.scopeId)
  }

  private slot(): { state: string; action_id: string | null; slot_revision: number } | null {
    return (this.db.db.prepare(`SELECT state, action_id, slot_revision FROM execution_slot WHERE scope_id = ?`).get(this.scopeId) as
      | { state: string; action_id: string | null; slot_revision: number }
      | undefined) ?? null
  }

  private async claim(actionId: string): Promise<boolean> {
    const slot = this.slot()
    if (!slot || slot.state !== 'free') return false
    const revision = slot.slot_revision
    let claimed = false
    await this.db.write(() => {
      const slotUpdate = this.db.db
        .prepare(
          `UPDATE execution_slot SET state = 'held', action_id = ?, slot_revision = slot_revision + 1, reason = NULL, updated_at = ?
           WHERE scope_id = ? AND state = 'free' AND slot_revision = ?`,
        )
        .run(actionId, this.ports.now(), this.scopeId, revision)
      const actionUpdate = this.db.db
        .prepare(`UPDATE action SET state = 'dispatching', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'planned'`)
        .run(this.ports.now(), actionId, this.scopeId)
      const outboxUpdate = this.db.db
        .prepare(`UPDATE command_outbox SET state = 'sending', attempt = attempt + 1 WHERE action_id = ? AND scope_id = ? AND state = 'prepared'`)
        .run(actionId, this.scopeId)
      if (!slotUpdate.changes || !actionUpdate.changes || !outboxUpdate.changes) throw new Error('claim missed')
      claimed = true
    }).catch(() => {
      claimed = false
    })
    return claimed
  }

  private releaseSlot(actionId: string): void {
    this.releaseIfHeld(actionId, 'released')
  }

  private releaseIfHeld(actionId: string, reason: string): void {
    this.db.db
      .prepare(
        `UPDATE execution_slot SET state = 'free', action_id = NULL, holder = NULL, fencing_token = NULL, slot_revision = slot_revision + 1, reason = ?, updated_at = ?
         WHERE scope_id = ? AND state = 'held' AND action_id = ?`,
      )
      .run(reason, this.ports.now(), this.scopeId, actionId)
  }

  private setQueue(actionId: string, reason: string): void {
    this.db.db.prepare(`UPDATE action_runtime SET queue_reason = ?, updated_at = ? WHERE action_id = ? AND scope_id = ?`).run(reason, this.ports.now(), actionId, this.scopeId)
  }

  private taskRow(taskId: string): any {
    return this.db.db.prepare(`SELECT * FROM task WHERE id = ? AND scope_id = ?`).get(taskId, this.scopeId)
  }

  private actionRow(actionId: string): any {
    return this.db.db.prepare(`SELECT * FROM action WHERE id = ? AND scope_id = ?`).get(actionId, this.scopeId)
  }

  private latestAction(taskId: string): any {
    return this.actions(taskId)[0]
  }

  private displayAction(taskId: string): any {
    const rows = this.actions(taskId)
    return rows.find((row) => OCCUPYING.includes(String(row.state))) ?? rows[0]
  }

  private actions(taskId: string): any[] {
    return this.db.db
      .prepare(`SELECT * FROM action WHERE task_id = ? AND scope_id = ? ORDER BY created_at DESC, id DESC`)
      .all(taskId, this.scopeId) as any[]
  }

  private stringList(value: unknown): string[] {
    try {
      const parsed = JSON.parse(String(value ?? '[]'))
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
    } catch {
      return []
    }
  }

  private leaseCall(): TrustedCall {
    return { originRef: 'lease', originKind: 'ui', mainSessionId: '', bindingVersion: 1, policyEpoch: 1, holder: '', fence: 0 }
  }

  private rejectPlanned(actionId: string): void {
    this.db.db.prepare(`UPDATE action SET state = 'rejected', updated_at = ? WHERE id = ? AND scope_id = ? AND state = 'planned'`).run(this.ports.now(), actionId, this.scopeId)
    this.db.db.prepare(`UPDATE command_outbox SET state = 'cancelled' WHERE action_id = ? AND scope_id = ? AND state IN ('prepared','blocked')`).run(actionId, this.scopeId)
  }

  private runtime(actionId: string): any {
    return this.db.db.prepare(`SELECT * FROM action_runtime WHERE action_id = ? AND scope_id = ?`).get(actionId, this.scopeId)
  }

  private snapshot(id: string): any {
    return this.db.db.prepare(`SELECT * FROM context_snapshot WHERE id = ? AND scope_id = ?`).get(id, this.scopeId)
  }

  private targetOf(taskId: string | undefined): string | null {
    if (!taskId) return null
    const row = this.db.db.prepare(`SELECT session_id FROM task_target WHERE task_id = ? AND scope_id = ? AND role = 'executor-v2'`).get(taskId, this.scopeId) as { session_id?: string } | undefined
    return row?.session_id ?? null
  }

  private receipt(operation: string, originRef: string, requestId: string): any {
    return this.db.db
      .prepare(`SELECT * FROM request_receipt WHERE scope_id = ? AND operation = ? AND origin_ref = ? AND request_id = ?`)
      .get(this.scopeId, operation, originRef, requestId)
  }
}

export function userCall(partial: Partial<TrustedCall> & Pick<TrustedCall, 'originRef' | 'mainSessionId'>): TrustedCall {
  return {
    originKind: 'user',
    bindingVersion: 1,
    policyEpoch: 1,
    holder: 'test',
    fence: 1,
    ...partial,
  }
}

export function requireText(value: unknown, max: number): string | null {
  return textOf(value, max)
}
