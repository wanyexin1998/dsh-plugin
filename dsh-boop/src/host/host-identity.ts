/**
 * Identity of the DSH process that is actually running this plugin.
 *
 * The web test payload has no commit file of its own, so a plain Node process
 * keeps the rc.2 baseline the host suite asserts. The desktop shell's asar
 * root carries both the version and `dshBuildCommit`; reading that file is how
 * the board stays honest on 0.2.1-rc.3 without a compatibility exemption.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

export interface HostIdentity {
  version: string
  commit: string
}

function readPackage(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function desktopRootPackage(): Record<string, unknown> | null {
  const root = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'package.json')
  const parsed = readPackage(root)
  if (parsed?.name !== '@deepseek-ai/dsh-desktop') return null
  return parsed
}

/**
 * Version and commit of this process.
 * A missing desktop package or build commit is `unknown`. A version string is
 * never used to invent the other release's commit.
 */
export function readHostIdentity(): HostIdentity {
  const desktop = desktopRootPackage()
  if (desktop) {
    return {
      version: typeof desktop.version === 'string' && desktop.version !== '' ? desktop.version : 'unknown',
      commit: typeof desktop.dshBuildCommit === 'string' && desktop.dshBuildCommit !== '' ? desktop.dshBuildCommit : 'unknown',
    }
  }
  try {
    const require = createRequire(path.join(process.cwd(), 'package.json'))
    const pkg = require('@deepseek-ai/dsh/package.json') as { version?: unknown; dshBuildCommit?: unknown }
    return {
      version: typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown',
      commit: typeof pkg.dshBuildCommit === 'string' && pkg.dshBuildCommit !== '' ? pkg.dshBuildCommit : 'unknown',
    }
  } catch {
    return { version: 'unknown', commit: 'unknown' }
  }
}
