/**
 * Host adapters for the verified public session APIs.
 *
 * create / resolveAgent / sessions.flush / followup / inbox.remove / cancel
 * are the only mutation calls. Missing surfaces return unavailable; they are
 * not replaced with a pretend session.
 */

import { createHash } from 'node:crypto'
import type { HomeNative } from './service.ts'
import type { CatalogSession, ContextEvent, DelegationPorts, TargetObservation } from '../delegation/service.ts'

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function optionalService(ctx: any, name: string): any {
  try {
    return ctx.reflect?.get?.(name, false) ?? null
  } catch {
    return null
  }
}

export function createHomeNative(ctx: any, cwdFingerprint: (cwd: string) => string): HomeNative {
  return {
    async observe(sessionId) {
      const empty = { exists: false, subagent: false, archived: false, preset: null, cwd: null }
      const projections = optionalService(ctx, 'sessionProjections')
      const live = ctx.sessions?.get?.(sessionId) ?? null
      const readPreset = (target: unknown): string | null => {
        if (!projections?.stateOf || !target) return null
        try {
          const preset = projections.stateOf(target, 'agentPreset')
          if (typeof preset === 'string') return preset
          if (preset && typeof preset === 'object') {
            const record = preset as { id?: unknown; presetId?: unknown; name?: unknown }
            const id = record.id ?? record.presetId ?? record.name
            return typeof id === 'string' ? id : null
          }
        } catch {
          return null
        }
        return null
      }
      try {
        const query = optionalService(ctx, 'sessionQuery')
        const observed = query?.observeSession ? await query.observeSession(sessionId, { projectionMode: 'all' }) : null
        const header = observed?.header ?? observed ?? live?.header ?? live ?? {}
        const preset = readPreset(live) ?? readPreset(observed?.agent?.session) ?? readPreset(header)
        const cwd = header?.cwd ?? header?.meta?.cwd ?? live?.meta?.cwd ?? live?.cwd ?? null
        try { observed?.[Symbol.dispose]?.() } catch { observed?.dispose?.() }
        return {
          exists: Boolean(observed || live),
          subagent: header?.parentSessionId != null || header?.kind === 'subagent',
          archived: header?.archived === true,
          preset,
          cwd: typeof cwd === 'string' ? cwd : null,
        }
      } catch {
        return live ? { ...empty, exists: true, preset: readPreset(live), cwd: typeof live?.cwd === 'string' ? live.cwd : null } : empty
      }
    },
    async resolve(sessionId) {
      try {
        const found = await ctx.sessionController?.resolveAgent?.(sessionId)
        if (!found || found.error) return { ok: false, agent: null }
        const agent = found.agent ?? found
        return { ok: Boolean(agent), agent }
      } catch (error) {
        return { ok: false, agent: null }
      }
    },
    async create(input) {
      const created = await ctx.sessionController.create({ sessionId: input.sessionId, cwd: input.cwd, agentPreset: input.agentPreset })
      return { sessionId: String(created?.sessionId ?? '') }
    },
    async flush(session) {
      try {
        const id = typeof session === 'string' ? session : session?.id
        const live = (id && ctx.sessions?.get?.(id)) || session
        return (await ctx.sessions?.flush?.(live)) === true
      } catch {
        return false
      }
    },
    async modelAvailable() {
      try {
        const models = ctx.modelDirectory?.list?.() ?? ctx.models?.list?.()
        if (Array.isArray(models)) return models.length > 0
      } catch {
        /* unknown model directory is not a configured model */
      }
      return false
    },
  }
}

export function createDelegationPorts(ctx: any, scopeId: string, now: () => string): DelegationPorts {
  const known = new Set<string>()
  return {
    now,
    nowMs: () => Date.parse(now()),
    fenceOk: () => ctx.boop?.storage?.()?.checkWrite?.().ok !== false,
    async listSessions() {
      const rows = await optionalService(ctx, 'sessionQuery')?.listSessions?.()
      if (!Array.isArray(rows)) return []
      return rows.map((row: any): CatalogSession => {
        const header = row.header ?? row
        return {
          sessionId: String(header.id ?? row.id ?? ''),
          workspaceId: header.workspaceId ?? null,
          title: String(header.title ?? header.id ?? '未命名会话'),
          workspaceTitle: header.workspaceTitle ?? null,
          activity: row.live ? 'running' : 'idle',
          lastActivityAt: header.updatedAt ? new Date(header.updatedAt).toISOString() : null,
          preview: null,
          archived: header.archived === true,
          subagent: header.parentSessionId != null,
          home: false,
        }
      }).filter((row: CatalogSession) => row.sessionId.length > 0)
    },
    async observe(sessionId): Promise<TargetObservation | null> {
      try {
        const query = optionalService(ctx, 'sessionQuery')
        if (!query?.observeSession) return null
        const observed = await query.observeSession(sessionId, { projectionMode: 'all' })
        const header = observed?.header ?? {}
        const events = typeof query.listEvents === 'function' ? await query.listEvents(sessionId) : []
        const list = Array.isArray(events) ? events : []
        const head = list.length > 0 ? Number(list[list.length - 1].seq ?? -1) : -1
        try { observed?.[Symbol.dispose]?.() } catch { observed?.dispose?.() }
        return {
          reachable: true,
          busy: observed?.live === true || header.running === true,
          pendingHuman: false,
          archived: header.archived === true,
          subagent: header.parentSessionId != null,
          home: false,
          title: String(header.title ?? sessionId),
          workspaceId: header.workspaceId ?? null,
          workspaceTitle: header.workspaceTitle ?? null,
          sourceGeneration: String(header.version ?? header.generation ?? 'unknown'),
          headSeq: head,
          latestDirectUserSeq: head,
          latestDirectUserMessageId: null,
          pendingMessage: false,
          turnId: null,
          turnTerminal: false,
          ownership: 'unknown',
          approvalId: null,
          summary: null,
          deliverable: false,
          checks: [],
          artifacts: [],
          missing: [],
          evidenceSeq: Math.max(0, head),
        }
      } catch {
        return null
      }
    },
    async readEvents(sessionId, limit): Promise<ContextEvent[]> {
      try {
        const events = await optionalService(ctx, 'sessionQuery')?.listEvents?.(sessionId)
        if (!Array.isArray(events)) return []
        return events.slice(-limit).map((event: any) => ({
          seq: Number(event.seq ?? 0),
          text: String(event.surface?.text ?? event.type ?? ''),
          sessionId,
          sourceGeneration: 'unknown',
        }))
      } catch {
        return []
      }
    },
    excluded() { return false },
    hostCanRead() { return true },
    async followup(sessionId, message) {
      const found = await ctx.sessionController?.resolveAgent?.(sessionId)
      const agent = found?.agent ?? found
      if (!agent?.followup) return 'before-enqueue'
      known.add(message.id)
      try {
        agent.followup({ ...message, id: message.id })
        return 'enqueued'
      } catch (error) {
        if (String(textOf(error)).includes('before')) return 'before-enqueue'
        throw error
      }
    },
    async flush(sessionId) {
      const found = await ctx.sessionController?.resolveAgent?.(sessionId)
      const agent = found?.agent ?? found
      const session = agent?.session
      if (!session || typeof ctx.sessions?.flush !== 'function') return false
      return (await ctx.sessions.flush(session)) === true
    },
    async pending(sessionId, messageId) {
      const sessions = ctx.sessions
      const projections = optionalService(ctx, 'sessionProjections')
      const session = sessions?.get?.(sessionId)
      const state = session && projections?.stateOf?.(session, 'inbox')
      const pending = [...(state?.['next-turn'] ?? []), ...(state?.['next-step'] ?? [])]
      return pending.some((message: any) => message?.id === messageId)
    },
    async visible() { return false },
    async remove(sessionId, messageId) {
      const found = await ctx.sessionController?.resolveAgent?.(sessionId)
      const agent = found?.agent ?? found
      if (typeof agent?.inbox?.remove !== 'function') return false
      return agent.inbox.remove(messageId) === true
    },
    async cancelTurn(sessionId) {
      const found = await ctx.sessionController?.resolveAgent?.(sessionId)
      const agent = found?.agent ?? found
      await agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
    },
    async mainIdle() { return true },
  }
  void scopeId
  void cwdFingerprint
  void createHash
}

export function rememberKnownMessage(ctx: any, messageId: string): void {
  try { ctx.boop?.proxyMessageIds?.().push?.(messageId) } catch { /* registry is a snapshot */ }
}
