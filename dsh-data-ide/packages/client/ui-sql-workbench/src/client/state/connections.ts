/**
 * Connection-panel state machine.
 *
 * Kept free of React so the transitions (loading, editing, testing, the
 * three-state verdict) are unit-testable on their own; the panel component only
 * renders what this returns (docs/03 §5 交互状态矩阵).
 */

import type { DataSource } from '../../datasource/model.ts'
import { createDataSource, type Dbms, validateDataSource } from '../../datasource/model.ts'
import { type ConnectionDraft, type TestResult, type WorkbenchApi } from '../api.ts'

export type PanelPhase = 'loading' | 'ready' | 'error' | 'unavailable'

export interface PanelState {
  readonly phase: PanelPhase
  readonly connections: readonly DataSource[]
  readonly activeId: string | null
  /** Verdict of the most recent test, keyed by connection id. */
  readonly verdicts: Readonly<Record<string, TestResult>>
  /** Connection currently being probed, or null. */
  readonly testingId: string | null
  readonly editing: ConnectionDraft | null
  /** Empty unless the phase carries something to say. */
  readonly message: string
}

export const INITIAL_STATE: PanelState = {
  phase: 'loading',
  connections: [],
  activeId: null,
  verdicts: {},
  testingId: null,
  editing: null,
  message: '',
}

/** Load the connection list and the current selection. */
export async function load(api: WorkbenchApi): Promise<PanelState> {
  try {
    const [connections, activeId] = await Promise.all([api.list(), api.active()])
    return { ...INITIAL_STATE, phase: 'ready', connections, activeId }
  } catch (error) {
    return { ...INITIAL_STATE, phase: 'error', message: describe(error) }
  }
}

/** State when the host never provided the service. */
export function unavailable(message: string): PanelState {
  return { ...INITIAL_STATE, phase: 'unavailable', message }
}

/** Select a connection; the host persists the choice. */
export async function select(api: WorkbenchApi, state: PanelState, connId: string): Promise<PanelState> {
  await api.setActive(connId)
  return { ...state, activeId: connId }
}

/**
 * Run the three-state probe and remember its verdict.
 *
 * The host caches the result on the connection, so a reload shows the last
 * outcome even before the next test.
 */
export async function test(api: WorkbenchApi, state: PanelState, connId: string): Promise<PanelState> {
  const running = { ...state, testingId: connId }
  try {
    const result = await api.test(connId)
    return { ...running, testingId: null, verdicts: { ...running.verdicts, [connId]: result } }
  } catch (error) {
    return {
      ...running,
      testingId: null,
      verdicts: {
        ...running.verdicts,
        [connId]: { state: 'UNSURE', durationMs: 0, error: { code: 'UNKNOWN', message: describe(error) } },
      },
    }
  }
}

/** Open the editor for a new connection, pre-filled with engine defaults. */
export function startCreate(state: PanelState): PanelState {
  return { ...state, editing: { name: '', dbms: 'doris', host: '', port: 9030, username: '' } }
}

/** Open the editor for an existing connection. */
export function startEdit(state: PanelState, connId: string): PanelState {
  const existing = state.connections.find(entry => entry.id === connId)
  if (existing === undefined) return state
  return { ...state, editing: toDraft(existing) }
}

/** Close the editor without saving. */
export function cancelEdit(state: PanelState): PanelState {
  return { ...state, editing: null }
}

export type SaveOutcome =
  | { readonly ok: true; readonly state: PanelState; readonly connId: string }
  | { readonly ok: false; readonly field: string; readonly reason: string }

/**
 * Validate and persist a draft.
 *
 * The host owns defaults and persistence; the panel only refuses obviously
 * incomplete drafts so the user gets the error next to the field (03 §4.2).
 */
export async function save(api: WorkbenchApi, state: PanelState, draft: ConnectionDraft): Promise<SaveOutcome> {
  const validation = validateDataSource(draft)
  if (!validation.ok) return { ok: false, field: validation.field, reason: validation.reason }

  const saved = await api.save(draft)
  const connections = [...state.connections.filter(entry => entry.id !== saved.id), saved]
  const activeId = state.activeId ?? saved.id
  if (activeId !== state.activeId) await api.setActive(activeId)
  return { ok: true, connId: saved.id, state: { ...state, connections, activeId, editing: null } }
}

/** Delete a connection and drop its cached verdict. */
export async function remove(api: WorkbenchApi, state: PanelState, connId: string): Promise<PanelState> {
  await api.remove(connId)
  const { [connId]: _dropped, ...verdicts } = state.verdicts
  const connections = state.connections.filter(entry => entry.id !== connId)
  const activeId = state.activeId === connId ? (connections[0]?.id ?? null) : state.activeId
  if (state.activeId === connId) await api.setActive(activeId)
  return { ...state, connections, activeId, verdicts }
}

/** Engine defaults for a brand-new draft of the given engine. */
export function draftFor(dbms: Dbms, host = ''): ConnectionDraft {
  const base = createDataSource({ id: 'draft', name: '', dbms, host, username: '' })
  // A fresh draft has no database yet; the default only pins port and properties.
  return {
    name: '',
    dbms,
    host,
    port: base.port,
    username: '',
    driverProperties: base.driverProperties,
    writeEnabled: false,
  }
}

/** Editable projection of a stored connection. */
export function toDraft(source: DataSource): ConnectionDraft {
  return {
    id: source.id,
    name: source.name,
    dbms: source.dbms,
    host: source.host,
    port: source.port,
    ...(source.database === undefined ? {} : { database: source.database }),
    username: source.username,
    driverProperties: source.driverProperties,
    writeEnabled: source.writeEnabled,
    ...(source.comment === undefined ? {} : { comment: source.comment }),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
