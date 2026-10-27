/**
 * Identity of the DSH process that is actually running this plugin.
 *
 * The web test payload has no commit file of its own, so a plain Node process
 * keeps the rc.2 baseline the host suite asserts. The desktop shell's asar
 * root carries both the version and `dshBuildCommit`; reading that file is how
 * the board stays honest on 0.2.1-rc.3 without a compatibility exemption.
 */
import fs from 'node:fs'
import path from 'node:path'

const BASELINE = {
  version: '0.2.1-rc.2',
  commit: '332895e0f7c9d4dbfb29729f5eb367fa263ff986',
} as const

const KNOWN_COMMITS: Record<string, string> = {
  '0.2.1-rc.2': BASELINE.commit,
  '0.2.1-rc.3': 'be72761ee1a6736ebcdf4f3739363b083ae53c98',
}

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

/** Version and commit of this process, or the rc.2 baseline when no desktop package is visible. */
export function readHostIdentity(): HostIdentity {
  const desktop = desktopRootPackage()
  const version = typeof desktop?.version === 'string' && desktop.version !== '' ? desktop.version : BASELINE.version
  const declared =
    typeof desktop?.dshBuildCommit === 'string' && desktop.dshBuildCommit !== ''
      ? desktop.dshBuildCommit
      : KNOWN_COMMITS[version]
  return { version, commit: declared || BASELINE.commit }
}
