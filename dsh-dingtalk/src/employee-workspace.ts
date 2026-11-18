import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { HostAgent } from './host.js'
import type { DingTalkIdentity } from './identity.js'

const firstBatchTools = new Set([
  'load_workspace_dependencies',
  'todo_write',
  'get_goal',
  'exit_plan_mode',
  'working_directory',
  'present',
  'visualize',
])

export function employeeWorkspaceTool(name: string): boolean {
  return firstBatchTools.has(name)
}

interface DirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

function visiblePath(root: string, path: string): boolean {
  return (
    within(root, path) &&
    !relative(root, path)
      .split(sep)
      .some((segment) => segment.startsWith('.'))
  )
}

function identity(path: string): DirectoryIdentity {
  const info = statSync(path, { bigint: true })
  if (!info.isDirectory()) throw new Error('employee_workspace_not_directory')
  return info
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Cellgent's employee volume has two mounts of the same directory. */
export function cellgentWorkspaceRoots(
  configured: string,
  seat: DingTalkIdentity,
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
): { volume: readonly string[]; selection: readonly string[] } | undefined {
  if (
    env.CELLGENT_DINGTALK_CORP_ID !== seat.corpId ||
    env.CELLGENT_DINGTALK_USER_ID !== seat.userId ||
    env.DSH_DINGTALK_CONNECTOR_SOCKET !== '/run/dsh-connector/dsh.sock' ||
    cwd !== '/workspace' ||
    home !== '/home/cellgent'
  )
    return undefined
  if (!sameDirectory(identity(cwd), identity(home))) return undefined
  const canonical = realpathSync(configured)
  const mount = [cwd, home].find((dir) => visiblePath(dir, resolve(configured)) && visiblePath(dir, canonical))
  if (!mount) return undefined
  const subdirectory = relative(mount, canonical)
  const aliases = [resolve(cwd, subdirectory), resolve(home, subdirectory)]
  if (aliases.some((alias) => realpathSync(alias) !== alias || !sameDirectory(identity(canonical), identity(alias))))
    return undefined
  return { volume: [cwd, home], selection: aliases }
}

export interface WorkspaceExecution {
  readonly agent?: HostAgent
  readonly name: string
  readonly arguments?: unknown
}

/** The authenticated Web seat and its bound IM channel use one employee-volume check. */
export class EmployeeWorkspace {
  private readonly roots: ReadonlyArray<{ configured: string; canonical: string; directory: DirectoryIdentity }>

  constructor(roots: readonly string[]) {
    this.roots = roots.map((configured) => {
      const canonical = realpathSync(configured)
      return { configured, canonical, directory: identity(canonical) }
    })
  }

  directory(path: string): string {
    const canonical = realpathSync(path)
    if (
      !this.roots.some(
        (root) =>
          visiblePath(root.configured, resolve(path)) &&
          visiblePath(root.canonical, canonical) &&
          realpathSync(root.configured) === root.canonical &&
          sameDirectory(identity(root.canonical), root.directory),
      )
    )
      throw new Error('im_workspace_outside_root')
    identity(canonical)
    return canonical
  }

  reason(exec: WorkspaceExecution): string | undefined {
    if (!employeeWorkspaceTool(exec.name)) return undefined
    try {
      if (!exec.agent) return 'employee_workspace_context_unavailable'
      const cwd = this.current(exec.agent)
      // The host visualization service resolves files against the Session header.
      const base = exec.name === 'visualize' ? this.directory(exec.agent.session?.header.cwd ?? '') : cwd
      this.checkArguments(exec.name, base, exec.arguments)
    } catch {
      return 'employee_workspace_access_denied: 请在本人获得授权的工作区内使用此工具。'
    }
    return undefined
  }

  current(agent: HostAgent): string {
    const session = agent.session
    const service = (agent.ctx as { get?(name: string): unknown }).get?.('workingDirectory') as
      { get(session: object): string } | undefined
    if (!session || session.id !== agent.id || !service?.get) throw new Error('employee_workspace_context_unavailable')
    return this.directory(service.get(session))
  }

  private file(cwd: string, input: unknown, destination = false): void {
    if (typeof input !== 'string') return
    const target = resolve(cwd, input)
    if (input.split(sep).includes('..') || !visiblePath(cwd, target)) throw new Error('employee_workspace_path_denied')
    // Resolve the existing parent before checkout so a symlink cannot select a foreign directory.
    const canonical = destination ? resolve(realpathSync(dirname(target)), basename(target)) : realpathSync(target)
    if (!visiblePath(cwd, canonical)) throw new Error('employee_workspace_path_denied')
  }

  private checkArguments(name: string, cwd: string, value: unknown): void {
    if (value === null || typeof value !== 'object') return
    const args = value as Record<string, unknown>
    if (name === 'working_directory' && typeof args.cd === 'string') {
      this.directory(resolve(cwd, args.cd))
    }
    if (name === 'present' && Array.isArray(args.files)) {
      for (const file of args.files) if (file && typeof file === 'object' && 'path' in file) this.file(cwd, file.path)
    }
    if (name === 'visualize') {
      this.file(cwd, args.sourcePath)
      this.file(cwd, args.dataPath)
      this.file(cwd, args.targetPath, true)
      if (args.authoring && typeof args.authoring === 'object' && 'path' in args.authoring)
        this.file(cwd, args.authoring.path)
    }
  }
}

/** Register the employee check on the host's global tool plane, shared by both entry points. */
export function installEmployeeWorkspace(
  ctx: { get(name: string): unknown },
  workspace: EmployeeWorkspace,
): () => void {
  const tools = ctx.get('tools') as { guard(check: (exec: WorkspaceExecution) => string | undefined): () => void }
  return tools.guard((exec) => workspace.reason(exec))
}
