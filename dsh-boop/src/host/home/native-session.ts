/**
 * Host adapters for the verified public session APIs.
 *
 * create / resolveAgent / sessions.flush / followup / inbox.remove / cancel
 * are the only mutation calls. Observation reads sessionQuery and the live
 * agent status. A loaded session is not treated as a running agent.
 */

import type { HomeNative } from './service.ts'
import type { CatalogSession, ContextEvent, DelegationPorts, TargetObservation } from '../delegation/service.ts'
import { contextFromEvents, interpretTarget, logContainsMessage, type OfficialEvent, type OfficialHeader } from './observe-facts.ts'

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

function dispose(observed: any): void {
  try { observed?.[Symbol.dispose]?.() } catch { observed?.dispose?.() }
}

function workspaceMap(ctx: any): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const registry = optionalService(ctx, 'workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    for (const workspace of workspaces) {
      const id = String(workspace?.id ?? '')
      if (id === '') continue
      for (const sessionId of workspace?.sessionIds ?? []) map.set(String(sessionId), id)
    }
  } catch {
    /* unknown workspace stays null */
  }
  return map
}

function homeSessionId(ctx: any, scopeId: string): string | null {
  try {
    const db = ctx.boop?.storage?.()?.db?.db
    if (!db || scopeId === '') return null
    const row = db.prepare(`SELECT session_id FROM home_binding_history WHERE scope_id = ? AND closed_at IS NULL`).get(scopeId) as { session_id?: string } | undefined
    return row?.session_id ? String(row.session_id) : null
  } catch {
    return null
  }
}

function agentStatusOf(ctx: any, sessionId: string): 'idle' | 'running' | 'unknown' {
  const live = ctx.sessions?.get?.(sessionId)
  const status = live?.agent?.status ?? live?.status
  if (status === 'running') return 'running'
  if (status === 'idle') return 'idle'
  return 'unknown'
}

function inboxMessages(ctx: any, sessionId: string): any[] {
  const projections = optionalService(ctx, 'sessionProjections')
  const session = ctx.sessions?.get?.(sessionId)
  const state = session && projections?.stateOf?.(session, 'inbox')
  return [...(state?.['next-turn'] ?? []), ...(state?.['next-step'] ?? [])]
}

async function readObservation(ctx: any, sessionId: string): Promise<{ header: OfficialHeader; events: OfficialEvent[]; revision: string | null } | null> {
  const query = optionalService(ctx, 'sessionQuery')
  if (!query?.observeSession && !query?.readSession) return null
  let observed: any = null
  let header: OfficialHeader = {}
  let events: OfficialEvent[] = []
  let revision: string | null = null
  try {
    if (typeof query.observeSession === 'function') {
      observed = await query.observeSession(sessionId, { projectionMode: 'all' })
      header = (observed?.header ?? {}) as OfficialHeader
      events = Array.isArray(observed?.events) ? observed.events as OfficialEvent[] : []
      revision = observed?.revision == null ? null : String(observed.revision)
    }
  } catch {
    header = {}
    events = []
  } finally {
    dispose(observed)
    observed = null
  }
  try {
    if (typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      const durable = (snapshot?.session ?? snapshot?.header ?? {}) as OfficialHeader
      const durableEvents = Array.isArray(snapshot?.events) ? snapshot.events as OfficialEvent[] : []
      if (durableEvents.length > events.length) events = durableEvents
      if (!header.id && durable.id) header = durable
    }
  } catch {
    /* a durable read failure keeps the live observation */
  }
  if (!header.id && events.length === 0) return null
  return { header, events, revision }
}

export function createHomeNative(ctx: any): HomeNative {
  return {
    async observe(sessionId) {
      const empty = { exists: false, subagent: false, archived: false, preset: null, cwd: null }
      const read = await readObservation(ctx, sessionId)
      if (!read) return empty
      const header = read.header
      const projections = optionalService(ctx, 'sessionProjections')
      const live = ctx.sessions?.get?.(sessionId) ?? null
      let preset = typeof header.agentPreset === 'string' ? header.agentPreset : null
      if (!preset && projections?.stateOf && live) {
        try {
          const value = projections.stateOf(live, 'agentPreset')
          if (typeof value === 'string') preset = value
          else if (value && typeof value === 'object') {
            const id = (value as { id?: unknown; presetId?: unknown }).id ?? (value as { presetId?: unknown }).presetId
            if (typeof id === 'string') preset = id
          }
        } catch {
          preset = null
        }
      }
      const cwd = typeof header.cwd === 'string' ? header.cwd : typeof live?.cwd === 'string' ? live.cwd : null
      return {
        exists: Boolean(header.id || live),
        subagent: header.origin === 'subagent' || typeof header.parentSession === 'string',
        archived: false,
        preset,
        cwd,
      }
    },
    async resolve(sessionId) {
      try {
        const found = await ctx.sessionController?.resolveAgent?.(sessionId)
        if (!found || found.error) return { ok: false, agent: null }
        const agent = found.agent ?? found
        return { ok: Boolean(agent), agent }
      } catch {
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
        const llm = optionalService(ctx, 'llm')
        const providers = await llm?.listProviders?.()
        if (Array.isArray(providers) && providers.length > 0) return true
      } catch {
        /* a missing llm service is not a configured model */
      }
      try {
        const models = ctx.modelDirectory?.list?.() ?? ctx.models?.list?.()
        if (Array.isArray(models) && models.length > 0) return true
      } catch {
        /* unknown directories stay unavailable */
      }
      return false
    },
  }
}

export function createDelegationPorts(ctx: any, scopeId: string, now: () => string): DelegationPorts {
  const known = new Set<string>()
  const seen = new Set<string>()
  return {
    now,
    nowMs: () => Date.parse(now()),
    fenceOk() {
      try {
        const storage = ctx.boop?.storage?.()
        return storage?.checkWrite?.().ok === true
      } catch {
        return false
      }
    },
    async listSessions() {
      const query = optionalService(ctx, 'sessionQuery')
      const rows = await query?.listSessions?.()
      if (!Array.isArray(rows)) return []
      const workspaces = workspaceMap(ctx)
      const home = homeSessionId(ctx, scopeId)
      const listed: CatalogSession[] = []
      for (const row of rows) {
        const header = (row?.header ?? row) as OfficialHeader
        const sessionId = String(header.id ?? row?.id ?? '')
        if (sessionId === '') continue
        seen.add(sessionId)
        const status = agentStatusOf(ctx, sessionId)
        let title = sessionId
        try {
          const snapshot = typeof query.readTitle === 'function' ? await query.readTitle(sessionId) : null
          const text = snapshot?.title ?? snapshot?.text
          if (typeof text === 'string' && text.trim().length > 0) title = text
        } catch {
          title = sessionId
        }
        listed.push({
          sessionId,
          workspaceId: workspaces.get(sessionId) ?? null,
          title,
          workspaceTitle: null,
          activity: status === 'running' ? 'running' : status === 'idle' ? 'idle' : 'unknown',
          lastActivityAt: typeof header.createdAt === 'number' ? new Date(header.createdAt).toISOString() : null,
          preview: null,
          archived: false,
          subagent: header.origin === 'subagent' || typeof header.parentSession === 'string',
          home: home != null && sessionId === home,
        })
      }
      return listed
    },
    async observe(sessionId): Promise<TargetObservation | null> {
      const read = await readObservation(ctx, sessionId)
      if (!read) return null
      seen.add(sessionId)
      const workspaces = workspaceMap(ctx)
      const pending = inboxMessages(ctx, sessionId).some((message) => message?.source?.kind === 'boop-command' || message?.source?.kind === 'boop-result')
      let title = String(read.header.id ?? sessionId)
      try {
        const query = optionalService(ctx, 'sessionQuery')
        const snapshot = typeof query?.readTitle === 'function' ? await query.readTitle(sessionId) : null
        const text = snapshot?.title ?? snapshot?.text
        if (typeof text === 'string' && text.trim().length > 0) title = text
      } catch {
        /* the id remains the visible title */
      }
      return interpretTarget({
        header: read.header,
        events: read.events,
        agentStatus: agentStatusOf(ctx, sessionId),
        workspaceId: workspaces.get(sessionId) ?? null,
        title,
        homeSessionId: homeSessionId(ctx, scopeId),
        revision: read.revision,
        pendingMessage: pending,
      })
    },
    async readEvents(sessionId, limit, beforeSeq): Promise<ContextEvent[]> {
      const read = await readObservation(ctx, sessionId)
      if (!read) return []
      const generation = read.revision ?? `${read.header.id ?? sessionId}:${read.header.version ?? ''}:${read.header.createdAt ?? ''}`
      return contextFromEvents(read.events, sessionId, generation, limit, beforeSeq)
    },
    excluded(sessionId) {
      try {
        const db = ctx.boop?.storage?.()?.db?.db
        if (!db || scopeId === '') return true
        const rules = db.prepare(`SELECT mode, source_fingerprint FROM forget_rule WHERE scope_id = ?`).all(scopeId) as Array<{ mode?: string; source_fingerprint?: string }>
        for (const rule of rules) {
          if (rule.mode === 'exclude_scope' || rule.source_fingerprint === '*') return true
          if (rule.mode === 'exclude_source' && rule.source_fingerprint === sessionId) return true
        }
        const cursor = db.prepare(`SELECT 1 AS hit FROM source_cursor WHERE scope_id = ? AND session_id = ? AND state = 'excluded' LIMIT 1`).get(scopeId, sessionId)
        return Boolean(cursor)
      } catch {
        return true
      }
    },
    hostCanRead(sessionId) {
      if (!optionalService(ctx, 'sessionQuery')) return 'unknown'
      return seen.has(sessionId) ? true : 'unknown'
    },
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
      return inboxMessages(ctx, sessionId).some((message) => message?.id === messageId)
    },
    async visible(sessionId, messageId) {
      const read = await readObservation(ctx, sessionId)
      if (!read) return false
      return logContainsMessage(read.events, messageId)
    },
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
    async mainIdle() {
      const home = homeSessionId(ctx, scopeId)
      if (!home) return false
      return agentStatusOf(ctx, home) !== 'running'
    },
  }
}

export function rememberKnownMessage(ctx: any, messageId: string): void {
  try { ctx.boop?.proxyMessageIds?.().push?.(messageId) } catch { /* registry is a snapshot */ }
}
