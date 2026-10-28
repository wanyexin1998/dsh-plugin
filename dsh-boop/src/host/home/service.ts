/**
 * Real BOOP home identity.
 *
 * A ledger binding is not proof that the native Session exists or still has the
 * BOOP preset. ensureHome finds or creates one physical Session and only then
 * returns ready. The client retains that id; it does not create one itself.
 */

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BoopDatabase } from '../persistence/database.ts'
import { failReply, okReply, type HomeCapabilities, type HomeView, type Reply } from '../../shared/mvp-contract.ts'
import { installHomeReferenceGuard, type ReferencePolicy } from './reference-guard.ts'

export interface HomeNative {
  observe(sessionId: string): Promise<{ exists: boolean; subagent: boolean; archived: boolean; preset: string | null; cwd: string | null }>
  resolve(sessionId: string): Promise<{ ok: boolean; agent: { session: unknown; ctx?: { on?: Function } } | null }>
  create(input: { sessionId: string; cwd: string; agentPreset: 'boop' }): Promise<{ sessionId: string }>
  flush(session: unknown): Promise<boolean>
  modelAvailable(): Promise<boolean>
}

export interface HomeServiceOptions {
  db: BoopDatabase
  scopeId: string
  ownerId: string
  dshHome: string
  native: HomeNative
  policy: ReferencePolicy
  now?: () => string
  fenceOk?: () => boolean
}

export class HomeService {
  private inflight: Promise<Reply<'boop.home', HomeView>> | null = null
  private readonly db: BoopDatabase
  private readonly scopeId: string
  private readonly ownerId: string
  private readonly cwd: string
  private readonly native: HomeNative
  private readonly policy: ReferencePolicy
  private readonly now: () => string
  private readonly fenceOk: () => boolean
  private guardReady = false

  constructor(options: HomeServiceOptions) {
    this.db = options.db
    this.scopeId = options.scopeId
    this.ownerId = options.ownerId
    this.cwd = path.join(options.dshHome, 'boop', 'home')
    this.native = options.native
    this.policy = options.policy
    this.now = options.now ?? (() => new Date().toISOString())
    this.fenceOk = options.fenceOk ?? (() => false)
  }

  /** The one open home binding. A scopes id that disagrees is not an identity. */
  currentIdentity(): { sessionId: string; bindingVersion: number } | null {
    const bound = this.binding()
    const main = this.scopeMain()
    if (!bound || !main || bound.session_id !== main) return null
    return { sessionId: bound.session_id, bindingVersion: bound.binding_version }
  }

  ensureHome(request: { requestId?: string } = {}): Promise<Reply<'boop.home', HomeView>> {
    if (this.inflight) return this.inflight
    this.inflight = this.ensureOnce(request.requestId).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private lostFence(requestId?: string): Reply<'boop.home', HomeView> | null {
    if (this.fenceOk()) return null
    return failReply('boop.home', { code: 'WRITER_FENCE_LOST', message: '当前数据连接已换人保管，没有改动波波的身份。', retryable: true }, requestId)
  }

  private async ensureOnce(requestId?: string): Promise<Reply<'boop.home', HomeView>> {
    const blocked = this.lostFence(requestId)
    if (blocked) return blocked
    const bound = this.binding()
    const main = this.scopeMain()
    if (bound && main && bound.session_id !== main) {
      return okReply('boop.home', this.repair('HOME_REPAIR_REQUIRED', main, '波波的主会话记录不一致，没有再创建一个。'), { requestId })
    }
    if (bound && !main) {
      return okReply('boop.home', this.repair('HOME_REPAIR_REQUIRED', bound.session_id, '波波的主会话记录不完整，没有再创建一个。'), { requestId })
    }
    if (bound && main) {
      const checked = await this.verifyExisting(bound.session_id, bound.binding_version)
      if (this.lostFence(requestId)) return this.lostFence(requestId)!
      if (checked && checked.state === 'ready') return okReply('boop.home', checked, { requestId })
      return okReply('boop.home', checked && checked.state !== 'ready' ? checked : this.repair('HOME_REPAIR_REQUIRED', bound.session_id), { requestId })
    }
    if (main) {
      const version = (this.maxVersion() ?? 0) + 1
      const checked = await this.verifyExisting(main, version)
      if (this.lostFence(requestId)) return this.lostFence(requestId)!
      if (checked?.state === 'ready') {
        try {
          this.bind(main, version)
        } catch {
          return okReply('boop.home', this.repair('HOME_REPAIR_REQUIRED', main, '原来的主会话还在，这次没有把它换成另一个。'), { requestId })
        }
        return okReply('boop.home', checked, { requestId })
      }
      return okReply('boop.home', checked && checked.state !== 'ready' ? checked : this.repair('HOME_REPAIR_REQUIRED', main, '原来的主会话还不能用，没有另建一个。'), { requestId })
    }
    const journal = this.journal()
    if (journal?.returned_session_id || journal?.requested_session_id) {
      const sessionId = journal.returned_session_id || journal.requested_session_id
      const recovered = await this.verifyExisting(sessionId, journal.expected_binding_version)
      if (this.lostFence(requestId)) return this.lostFence(requestId)!
      if (recovered?.state === 'ready') {
        try {
          this.bind(sessionId, journal.expected_binding_version)
        } catch {
          return okReply('boop.home', this.repair('HOME_REPAIR_REQUIRED', sessionId), { requestId })
        }
        return okReply('boop.home', recovered, { requestId })
      }
      if (recovered) return okReply('boop.home', recovered, { requestId })
    }
    if (this.lostFence(requestId)) return this.lostFence(requestId)!
    return okReply('boop.home', await this.provision(journal?.requested_session_id ?? null), { requestId })
  }

  private async verifyExisting(sessionId: string, bindingVersion: number): Promise<HomeView | null> {
    const resolved = await this.native.resolve(sessionId)
    if (!resolved.ok || !resolved.agent) return this.repair('HOME_REPAIR_REQUIRED', sessionId, '找不到已经创建的波波会话。')
    const facts = await this.native.observe(sessionId)
    if (facts.subagent || facts.archived) return this.repair('TARGET_NOT_ORDINARY', sessionId, '波波的主会话不能是子代理或已归档会话。')
    if (facts.preset && facts.preset !== 'boop') return this.repair('PRESET_UNAVAILABLE', sessionId, '主会话没有挂上 boop 预设。')
    if (!facts.preset) return this.repair('PRESET_UNAVAILABLE', sessionId, '还不能确认主会话的预设。')
    const observedCwd = typeof facts.cwd === 'string' ? path.resolve(facts.cwd) : ''
    if (observedCwd.length === 0 || this.fingerprint(observedCwd) !== this.fingerprint(path.resolve(this.cwd))) {
      return this.repair('HOME_REPAIR_REQUIRED', sessionId, '主会话的工作目录和波波记录不一致。')
    }
    this.guardReady = installHomeReferenceGuard(resolved.agent, this.policy)
    if (!this.guardReady) return this.repair('HOME_REPAIR_REQUIRED', sessionId, '主会话的引用保护没有装上。')
    const flushed = await this.native.flush(resolved.agent.session ?? sessionId)
    if (!flushed) return this.repair('NATIVE_DURABILITY_UNAVAILABLE', sessionId, '主会话没有完成持久化。')
    return this.ready(sessionId, bindingVersion)
  }

  private async provision(requested: string | null): Promise<HomeView> {
    const requestedSessionId = requested ?? `boop-home-${randomUUID()}`
    const version = (this.maxVersion() ?? 0) + 1
    const now = this.now()
    const key = `prov_${randomUUID()}`
    this.db.db
      .prepare(
        `INSERT INTO home_provisioning(scope_id,provision_key,expected_binding_version,requested_session_id,returned_session_id,legacy_session_id,stage,error_code,created_at,updated_at)
         VALUES(?,?,?,?,NULL,NULL,'prepared',NULL,?,?)
         ON CONFLICT(scope_id) DO UPDATE SET
           requested_session_id = excluded.requested_session_id,
           expected_binding_version = excluded.expected_binding_version,
           stage = 'prepared',
           updated_at = excluded.updated_at
         WHERE home_provisioning.stage IN ('prepared','repair_required')`,
      )
      .run(this.scopeId, key, version, requestedSessionId, now, now)
    if (!this.fenceOk()) {
      this.markRepair('WRITER_FENCE_LOST', null)
      return this.repair('WRITER_FENCE_LOST', requestedSessionId, '当前数据连接已换人保管，没有创建波波的会话。')
    }
    let created: { sessionId: string }
    try {
      created = await this.native.create({ sessionId: requestedSessionId, cwd: this.cwd, agentPreset: 'boop' })
    } catch (error) {
      this.markRepair('NATIVE_UNAVAILABLE', null)
      return this.repair('NATIVE_UNAVAILABLE', requestedSessionId, error instanceof Error ? error.message : '创建主会话失败。')
    }
    this.db.db
      .prepare(`UPDATE home_provisioning SET returned_session_id = ?, stage = 'native_created', updated_at = ? WHERE scope_id = ?`)
      .run(created.sessionId, this.now(), this.scopeId)
    if (!this.fenceOk()) {
      this.markRepair('WRITER_FENCE_LOST', created.sessionId)
      return this.repair('WRITER_FENCE_LOST', created.sessionId, '会话已经创建，但数据连接换人了，没有把它登记成波波。')
    }
    if (created.sessionId !== requestedSessionId) {
      this.markRepair('HOME_REPAIR_REQUIRED', created.sessionId)
      return this.repair('HOME_REPAIR_REQUIRED', created.sessionId)
    }
    const verified = await this.verifyExisting(created.sessionId, version)
    if (!verified || verified.state !== 'ready') {
      this.markRepair(verified && 'reasonCode' in verified ? verified.reasonCode : 'HOME_REPAIR_REQUIRED', created.sessionId)
      return verified && verified.state !== 'ready' ? verified : this.repair('HOME_REPAIR_REQUIRED', created.sessionId)
    }
    try {
      this.bind(created.sessionId, version)
    } catch (error) {
      this.markRepair('HOME_REPAIR_REQUIRED', created.sessionId)
      return this.repair('HOME_REPAIR_REQUIRED', created.sessionId, error instanceof Error ? error.message : undefined)
    }
    return this.ready(created.sessionId, version)
  }

  private bind(sessionId: string, version: number): void {
    if (!this.fenceOk()) throw new Error('WRITER_FENCE_LOST')
    const existing = this.binding()
    if (existing?.session_id === sessionId && this.scopeMain() === sessionId) {
      this.db.db.prepare(`UPDATE home_provisioning SET stage = 'bound', updated_at = ? WHERE scope_id = ?`).run(this.now(), this.scopeId)
      return
    }
    this.db.db.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.db.db.prepare(`UPDATE scopes SET main_session_id = ? WHERE scope_id = ? AND (main_session_id IS NULL OR main_session_id = ?)`).run(sessionId, this.scopeId, sessionId)
      if (updated.changes !== 1) throw new Error('HOME_IDENTITY_CONFLICT')
      this.db.db
        .prepare(
          `INSERT INTO home_binding_history(scope_id,binding_version,session_id,previous_session_id,preset_id,cwd_fingerprint,context_ref,opened_at,closed_at)
           VALUES(?,?,?,NULL,'boop',?,NULL,?,NULL)`,
        )
        .run(this.scopeId, version, sessionId, this.fingerprint(this.cwd), this.now())
      this.db.db.prepare(`UPDATE home_provisioning SET stage = 'bound', returned_session_id = ?, updated_at = ? WHERE scope_id = ?`).run(sessionId, this.now(), this.scopeId)
      this.db.db.exec('COMMIT')
    } catch (error) {
      try { this.db.db.exec('ROLLBACK') } catch { /* keep the original error */ }
      throw error
    }
  }

  private async ready(sessionId: string, bindingVersion: number): Promise<HomeView> {
    const send = this.guardReady && (await this.native.modelAvailable())
    const access = this.db.db.prepare('SELECT mode FROM source_access WHERE scope_id = ?').get(this.scopeId) as { mode?: string } | undefined
    const readable = access?.mode === 'all_authorized' || access?.mode === 'selected'
    const reasonCodes = [
      ...(send ? [] : ['MODEL_UNAVAILABLE']),
      ...(readable ? [] : ['SOURCE_ACCESS_REQUIRED']),
    ]
    const capabilities: HomeCapabilities = {
      send,
      readSources: readable,
      delegate: readable,
      stop: true,
      reasonCodes,
    }
    return { state: 'ready', mainSessionId: sessionId, bindingVersion, capabilities }
  }

  private repair(reasonCode: string, sessionId?: string | null, message?: string): HomeView {
    return {
      state: 'repair_required',
      reasonCode,
      message: message ?? '波波的历史连接需要恢复，原记录仍保留。',
      retryable: reasonCode !== 'VERSION_UNSUPPORTED',
      ...(sessionId ? { mainSessionId: sessionId } : {}),
    }
  }

  private markRepair(code: string, returned: string | null): void {
    this.db.db
      .prepare(`UPDATE home_provisioning SET stage = 'repair_required', error_code = ?, returned_session_id = COALESCE(?, returned_session_id), updated_at = ? WHERE scope_id = ?`)
      .run(code, returned, this.now(), this.scopeId)
  }

  private scopeMain(): string | null {
    const row = this.db.db.prepare(`SELECT main_session_id FROM scopes WHERE scope_id = ?`).get(this.scopeId) as { main_session_id?: string | null } | undefined
    return row?.main_session_id ? String(row.main_session_id) : null
  }

  private binding(): { session_id: string; binding_version: number } | undefined {
    return this.db.db
      .prepare(`SELECT session_id, binding_version FROM home_binding_history WHERE scope_id = ? AND closed_at IS NULL`)
      .get(this.scopeId) as { session_id: string; binding_version: number } | undefined
  }

  private journal(): { stage: string; error_code: string | null; requested_session_id: string; returned_session_id: string | null; expected_binding_version: number } | undefined {
    return this.db.db.prepare(`SELECT stage, error_code, requested_session_id, returned_session_id, expected_binding_version FROM home_provisioning WHERE scope_id = ?`).get(this.scopeId) as
      | { stage: string; error_code: string | null; requested_session_id: string; returned_session_id: string | null; expected_binding_version: number }
      | undefined
  }

  private maxVersion(): number | null {
    const row = this.db.db.prepare(`SELECT MAX(binding_version) AS v FROM home_binding_history WHERE scope_id = ?`).get(this.scopeId) as { v: number | null }
    return row?.v ?? null
  }

  private fingerprint(value: string): string {
    return createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 32)
  }
}
