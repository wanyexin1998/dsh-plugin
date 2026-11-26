/**
 * Identity of the DSH process that is actually running this plugin.
 *
 * The web test payload has no commit file of its own, so a plain Node process
 * keeps the rc.2 baseline the host suite asserts. The desktop shell's asar
 * root carries both the version and `dshBuildCommit`; reading that file is how
 * the board stays honest on a checked desktop build without a compatibility exemption.
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
  '0.2.2-rc.1': 'c59d10aff167ad7eefead4b3a9082fb57c8fbfe8',
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

/** The `dsh` CLI package when this process was started as `node <payload>/lib/bin.js`. */
function cliPackage(): Record<string, unknown> | null {
  const entry = process.argv[1]
  if (!entry) return null
  const dir = path.dirname(entry)
  for (const file of [path.join(dir, 'package.json'), path.join(dir, '..', 'package.json')]) {
    const parsed = readPackage(file)
    if (parsed?.name === '@deepseek-ai/dsh' && typeof parsed.version === 'string' && parsed.version !== '') return parsed
  }
  return null
}

/** Version and commit of this process, or the rc.2 baseline when no DSH package is visible. */
export function readHostIdentity(): HostIdentity {
  const source = desktopRootPackage() ?? cliPackage()
  const version = typeof source?.version === 'string' && source.version !== '' ? source.version : BASELINE.version
  const declared =
    typeof source?.dshBuildCommit === 'string' && source.dshBuildCommit !== ''
      ? source.dshBuildCommit
      : KNOWN_COMMITS[version]
  return { version, commit: declared || BASELINE.commit }
}
