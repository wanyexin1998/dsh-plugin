/**
 * BOOP's own workspace directory.
 *
 * It lives under this plugin's server tree (`<package>/server/workspace`),
 * not in a user-chosen project. Only the BOOP main Session uses it as cwd.
 * The directory is never registered as a visible left-sidebar workspace:
 * the panellist row above workspaces is the only entry into the main Session.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BOOP_WORKSPACE_TITLE = 'BOOP'

export function boopPluginRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = path.dirname(from)
  for (let hop = 0; hop < 6; hop += 1) {
    const manifest = path.join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
        if (parsed.name === 'dsh-boop') return dir
      } catch {
        /* a broken manifest is not this package; keep walking */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(path.dirname(from), '..')
}

export function boopWorkspacePath(from?: string): string {
  return path.join(boopPluginRoot(from), 'server', 'workspace')
}

export function ensureBoopWorkspaceDirectory(from?: string): string {
  const dir = boopWorkspacePath(from)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface BoopWorkspaceBinding {
  path: string
  workspaceId: string | null
  /** Why the directory is not a visible workspace. Null when concealment succeeded. */
  reason: string | null
}

interface WorkspaceRecord {
  id?: unknown
  workspaceId?: unknown
  path?: unknown
  sessionIds?: unknown
  attachSession?: (sessionId: string) => Promise<void>
}

interface WorkspaceRegistryLike {
  create?: (dir: string, title: string) => Promise<WorkspaceRecord>
  delete?: (id: string) => Promise<unknown>
  resolveByPath?: (dir: string) => Promise<WorkspaceRecord | undefined>
  list?: () => WorkspaceRecord[]
}

function registryOf(ctx: any): WorkspaceRegistryLike | null {
  const direct = ctx?.workspaceRegistry
  if (direct && (typeof direct.create === 'function' || typeof direct.delete === 'function' || typeof direct.list === 'function')) {
    return direct as WorkspaceRegistryLike
  }
  try {
    const reflected = ctx?.reflect?.get?.('workspaceRegistry', false)
    if (reflected && (typeof reflected.create === 'function' || typeof reflected.delete === 'function' || typeof reflected.list === 'function')) {
      return reflected as WorkspaceRegistryLike
    }
  } catch {
    /* the registry is optional; a missing one is not a boot failure */
  }
  return null
}

function workspaceIdOf(workspace: WorkspaceRecord | null | undefined): string | null {
  const raw = workspace?.id ?? workspace?.workspaceId
  if (typeof raw === 'string' && raw !== '') return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

export function sameWorkspaceDir(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const normalize = (value: string) => value.replace(/[\\/]+$/g, '').replace(/\\/g, '/').toLowerCase()
  return normalize(left) === normalize(right)
}

export function sessionCwdOf(ctx: any, sessionId: string): string | null {
  try {
    const live = ctx?.sessions?.get?.(sessionId)
    const cwd = live?.header?.cwd ?? live?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
  } catch {
    /* a missing live Session is not a bind failure */
  }
  return null
}

/**
 * Drop a leftover BOOP workspace registration so it does not appear in the
 * left sidebar. The directory and Session logs stay on disk.
 */
export async function concealBoopWorkspaceRegistration(ctx: any, dir: string = ensureBoopWorkspaceDirectory()): Promise<void> {
  const registry = registryOf(ctx)
  if (!registry) return
  let existing: WorkspaceRecord | null = null
  try {
    if (typeof registry.resolveByPath === 'function') existing = (await registry.resolveByPath(dir)) ?? null
  } catch {
    existing = null
  }
  if (!existing && typeof registry.list === 'function') {
    try {
      existing = (registry.list() ?? []).find((row) => sameWorkspaceDir(typeof row.path === 'string' ? row.path : null, dir)) ?? null
    } catch {
      existing = null
    }
  }
  const id = workspaceIdOf(existing)
  if (!id || typeof registry.delete !== 'function') return
  try {
    await registry.delete(id)
  } catch (error) {
    ctx?.logger?.warn?.('[boop] could not hide the BOOP workspace registration', error)
  }
}

/** Create the directory and make sure it is not listed as a workspace. */
export async function ensureBoopWorkspace(ctx: any): Promise<BoopWorkspaceBinding> {
  const dir = ensureBoopWorkspaceDirectory()
  const registry = registryOf(ctx)
  if (!registry) {
    return { path: dir, workspaceId: null, reason: 'workspace-registry-unavailable' }
  }
  await concealBoopWorkspaceRegistration(ctx, dir)
  return { path: dir, workspaceId: null, reason: null }
}

/** The BOOP directory. Session membership is by cwd, not a visible workspace. */
export async function boopWorkspaceRecord(
  ctx: any,
): Promise<{ path: string; workspaceId: string | null; sessionIds: string[] }> {
  const ensured = await ensureBoopWorkspace(ctx)
  return { path: ensured.path, workspaceId: null, sessionIds: [] }
}

/**
 * The main Session keeps this directory as cwd. There is no visible workspace
 * to attach to; a leftover registration is dropped instead.
 */
export async function bindMainSessionWorkspace(
  ctx: any,
  _sessionId: string,
): Promise<{ ok: boolean; path: string; workspaceId: string | null; attached: boolean; reason: string | null }> {
  const ensured = await ensureBoopWorkspace(ctx)
  return {
    ok: true,
    path: ensured.path,
    workspaceId: null,
    attached: false,
    reason: 'workspace-unlisted',
  }
}
