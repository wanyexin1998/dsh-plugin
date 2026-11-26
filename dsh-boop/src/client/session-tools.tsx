/**
 * Native model + permission controls, hosted in the right Sidebar.
 *
 * The composer seats stay the host's; they are only hidden under `[data-boop-chat]`.
 * These selects call the same session APIs (`/permission`, `selectModel`).
 */
import React from 'react'
import { BOOP_AGENT_PRESET_ID, type MainSessionStore } from './main-session.ts'
import { useMainSessionState } from './header.tsx'

export interface SessionToolsHost {
  sessions?: {
    list?: {
      getSnapshot?: () => { byId?: Record<string, unknown> }
      subscribe?: (listener: () => void) => () => void
    }
    binding?: (sessionId: string) => { session?: { command?: (text: string) => Promise<{ ok?: boolean; error?: { message?: string } }> } } | undefined
    selectModel?: (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => Promise<{ ok?: boolean; error?: { message?: string } }>
  } | null
  remote?: {
    permissionPresets?: { catalog?: () => Promise<unknown> }
    agentPresets?: { select?: (sessionId: string, presetId: string) => Promise<unknown> }
  } | null
  modelDirectories?: {
    directoryFor?: (sessionId: string) => {
      load?: () => Promise<unknown>
      select?: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>
      store?: { getSnapshot?: () => ModelDirectorySnapshot; subscribe?: (listener: () => void) => () => void }
    }
  } | null
}

interface PermissionOption {
  value: string
  name: string
}

interface ModelOption {
  provider: string
  model: string
  label: string
}

interface ModelDirectorySnapshot {
  groups?: Array<{ id?: string; name?: string; models?: Array<{ id?: string; name?: string }> }>
  current?: { provider?: string; model?: string; reasoningEffort?: string } | null
}

export interface BoopSessionToolsProps {
  observer?: MainSessionStore
  host?: SessionToolsHost | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function permissionOptionsOf(catalog: unknown): PermissionOption[] {
  const record = asRecord(catalog)
  const fromRoot = Array.isArray(record?.options) ? record!.options : null
  const fromValue = Array.isArray(asRecord(record?.value)?.options) ? (asRecord(record?.value)!.options as unknown[]) : null
  const nested = fromRoot ?? fromValue ?? []
  const options: PermissionOption[] = []
  for (const entry of nested) {
    const row = asRecord(entry)
    const value = typeof row?.value === 'string' ? row.value : ''
    if (value === '') continue
    const name = typeof row?.name === 'string' && row.name !== '' ? row.name : value
    options.push({ value, name })
  }
  return options
}

function permissionLabel(value: string, name: string): string {
  switch (value) {
    case 'read-only':
      return '只读'
    case 'workspace-write':
      return '工作区可写'
    case 'danger-full-access':
      return '完全访问'
    case 'auto':
      return 'Auto review'
    default:
      return name
  }
}

function currentPermission(row: unknown): string {
  const record = asRecord(row)
  const values = asRecord(record?.projectionValues)
  const raw = values?.permissions ?? record?.permissions
  if (typeof raw === 'string') return raw
  const nested = asRecord(raw)
  return typeof nested?.currentValue === 'string' ? nested.currentValue : ''
}

function currentPreset(row: unknown): string {
  const values = asRecord(asRecord(row)?.projectionValues)
  return typeof values?.agentPreset === 'string' ? values.agentPreset : ''
}

function modelOptionsOf(snapshot: ModelDirectorySnapshot | null | undefined): ModelOption[] {
  const options: ModelOption[] = []
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : []
  for (const group of groups) {
    const provider = typeof group?.id === 'string' ? group.id : ''
    if (provider === '') continue
    const models = Array.isArray(group.models) ? group.models : []
    for (const model of models) {
      const id = typeof model.id === 'string' ? model.id : ''
      if (id === '') continue
      const name = typeof model.name === 'string' && model.name !== '' ? model.name : id
      options.push({ provider, model: id, label: `${name}` })
    }
  }
  return options
}

function needsRiskConfirm(preset: string): boolean {
  return preset === 'danger-full-access' || preset === 'auto'
}

function modelSignature(snapshot: ModelDirectorySnapshot | null): string {
  const current = snapshot?.current
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : []
  const listed: string[] = []
  for (const group of groups) {
    const provider = typeof group?.id === 'string' ? group.id : ''
    const models = Array.isArray(group?.models) ? group.models : []
    for (const model of models) {
      if (typeof model?.id === 'string' && model.id !== '') listed.push(`${provider}::${model.id}`)
    }
  }
  return `${current?.provider ?? ''}::${current?.model ?? ''}|${listed.join(',')}`
}

/**
 * Read a host store without `useSyncExternalStore`. Several host snapshots are a
 * new object on every read; handing that to React loops until the sidebar body
 * crashes and the pane is left blank.
 */
function useHostValue<T>(subscribe: ((listener: () => void) => unknown) | undefined, read: () => T, signature: (value: T) => string, fallback: T): T {
  const readRef = React.useRef(read)
  const signatureRef = React.useRef(signature)
  readRef.current = read
  signatureRef.current = signature
  const [value, setValue] = React.useState<T>(fallback)
  React.useEffect(() => {
    const pull = (): void => {
      let next: T
      try {
        next = readRef.current()
      } catch {
        return
      }
      setValue((prev) => (signatureRef.current(prev) === signatureRef.current(next) ? prev : next))
    }
    pull()
    if (typeof subscribe !== 'function') return
    let unsubscribe: unknown
    try {
      unsubscribe = subscribe(pull)
    } catch {
      return
    }
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [subscribe])
  return value
}

export function BoopSessionTools({ observer, host }: BoopSessionToolsProps): React.ReactElement {
  const state = useMainSessionState(observer)
  const sessionId = state?.activeSessionId ?? state?.mainSessionId ?? null
  const sessions = host?.sessions
  const [permissionCatalog, setPermissionCatalog] = React.useState<PermissionOption[]>([])
  const [permissionError, setPermissionError] = React.useState<string | null>(null)
  const [modelError, setModelError] = React.useState<string | null>(null)
  const [presetHint, setPresetHint] = React.useState<string | null>(null)

  const readSession = React.useCallback((): unknown => {
    if (!sessionId) return null
    try {
      return sessions?.list?.getSnapshot?.()?.byId?.[sessionId] ?? null
    } catch {
      return null
    }
  }, [sessions, sessionId])
  const sessionRow = useHostValue(
    sessions?.list?.subscribe,
    readSession,
    (row) => `${currentPermission(row)}|${currentPreset(row)}`,
    null,
  )

  const directory = React.useMemo(() => {
    if (!sessionId || typeof host?.modelDirectories?.directoryFor !== 'function') return null
    try {
      return host.modelDirectories.directoryFor(sessionId)
    } catch {
      return null
    }
  }, [host, sessionId])

  const readModels = React.useCallback((): ModelDirectorySnapshot | null => {
    try {
      return directory?.store?.getSnapshot?.() ?? null
    } catch {
      return null
    }
  }, [directory])
  const modelSnap = useHostValue(directory?.store?.subscribe, readModels, modelSignature, null)

  React.useEffect(() => {
    let disposed = false
    const load = host?.remote?.permissionPresets?.catalog
    if (typeof load !== 'function') return () => {
      disposed = true
    }
    void Promise.resolve(load()).then(
      (catalog) => {
        if (!disposed) setPermissionCatalog(permissionOptionsOf(catalog))
      },
      (error: unknown) => {
        if (!disposed) setPermissionError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      disposed = true
    }
  }, [host])

  React.useEffect(() => {
    if (!directory || typeof directory.load !== 'function') return
    void directory.load().catch((error: unknown) => {
      setModelError(error instanceof Error ? error.message : String(error))
    })
  }, [directory])

  const permissionValue = currentPermission(sessionRow)
  const presetValue = currentPreset(sessionRow)
  const models = modelOptionsOf(modelSnap)
  const currentModel = modelSnap?.current
  const currentModelId = currentModel?.provider && currentModel.model ? `${currentModel.provider}::${currentModel.model}` : ''

  const onPermission = (value: string): void => {
    if (!sessionId || value === '' || value === permissionValue) return
    if (needsRiskConfirm(value) && typeof window.confirm === 'function' && !window.confirm(value === 'auto' ? '开启 Auto review？该模式会降低确认步骤。' : '开启完全访问？该模式会减少确认步骤。')) {
      return
    }
    setPermissionError(null)
    const command = sessions?.binding?.(sessionId)?.session?.command
    if (typeof command !== 'function') {
      setPermissionError('当前会话还不能切换审批方式')
      return
    }
    void command(`/permission ${value}`).then(
      (result) => {
        if (result && result.ok === false) setPermissionError(result.error?.message ?? '审批方式切换失败')
      },
      (error: unknown) => {
        setPermissionError(error instanceof Error ? error.message : String(error))
      },
    )
  }

  const onModel = (packed: string): void => {
    if (!sessionId || packed === '' || packed === currentModelId) return
    const at = packed.indexOf('::')
    const provider = at === -1 ? '' : packed.slice(0, at)
    const model = at === -1 ? packed : packed.slice(at + 2)
    if (provider === '' || model === '') return
    setModelError(null)
    const select = directory?.select
    const fallback = sessions?.selectModel
    const run = typeof select === 'function'
      ? select({ provider, model })
      : typeof fallback === 'function'
        ? fallback({ sessionId, provider, model })
        : null
    if (run === null) {
      setModelError('当前会话还不能切换模型')
      return
    }
    void Promise.resolve(run).then(
      (result) => {
        const record = asRecord(result)
        if (record && record.ok === false) setModelError(typeof asRecord(record.error)?.message === 'string' ? String(asRecord(record.error)!.message) : '模型切换失败')
      },
      (error: unknown) => {
        setModelError(error instanceof Error ? error.message : String(error))
      },
    )
  }

  const onPreset = (): void => {
    if (!sessionId) return
    const select = host?.remote?.agentPresets?.select
    if (typeof select !== 'function') {
      setPresetHint('会话已经开始后不能改 Agent 预设。')
      return
    }
    setPresetHint(null)
    void Promise.resolve(select(sessionId, BOOP_AGENT_PRESET_ID)).then(
      (result) => {
        const record = asRecord(result)
        if (record && record.ok === false) setPresetHint('这个会话已经开始，不能再改成 BOOP 模式。语音仍走工作区说明。')
        else setPresetHint(null)
      },
      () => {
        setPresetHint('这个会话已经开始，不能再改成 BOOP 模式。语音仍走工作区说明。')
      },
    )
  }

  if (!sessionId) {
    return <p data-boop-tools="">打开主会话后，模型和审批方式会出现在这里。</p>
  }

  return (
    <div data-boop-tools="" aria-label="会话模型与审批">
      <label className="boop-tools-field">
        <span>审批方式</span>
        <select
          aria-label="审批方式"
          value={permissionCatalog.some((option) => option.value === permissionValue) ? permissionValue : ''}
          onChange={(event) => onPermission(event.target.value)}
        >
          <option value="" disabled>
            {permissionCatalog.length === 0 ? '正在读取…' : '选择审批方式'}
          </option>
          {permissionCatalog.map((option) => (
            <option key={option.value} value={option.value}>
              {permissionLabel(option.value, option.name)}
            </option>
          ))}
        </select>
        {permissionError ? <span data-tone="bad">{permissionError}</span> : null}
      </label>
      <label className="boop-tools-field">
        <span>模型</span>
        <select
          aria-label="模型"
          value={models.some((option) => `${option.provider}::${option.model}` === currentModelId) ? currentModelId : ''}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="" disabled>
            {models.length === 0 ? '正在读取…' : '选择模型'}
          </option>
          {models.map((option) => (
            <option key={`${option.provider}::${option.model}`} value={`${option.provider}::${option.model}`}>
              {option.label}
            </option>
          ))}
        </select>
        {modelError ? <span data-tone="bad">{modelError}</span> : null}
      </label>
      <div className="boop-tools-field">
        <span>Agent 预设</span>
        <p className="boop-tools-preset">
          {presetValue === BOOP_AGENT_PRESET_ID ? 'BOOP 模式' : presetValue === '' ? '尚未读取' : presetValue === 'standard' ? '标准模式' : presetValue}
        </p>
        {presetValue !== BOOP_AGENT_PRESET_ID ? (
          <button type="button" className="boop-tools-switch" onClick={onPreset}>
            改成 BOOP 模式
          </button>
        ) : null}
        {presetHint ? <span data-tone="warn">{presetHint}</span> : null}
      </div>
    </div>
  )
}
