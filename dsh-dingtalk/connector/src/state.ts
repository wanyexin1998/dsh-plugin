import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConnectionServiceError } from '../../enhancements/src/shared/models.js'
import { provisionPrivateRuntime } from '../../enhancements/src/host/privacy.js'
import { parseProfile } from '../../enhancements/src/shared/connector.js'

export interface BindingEntry {
  corpId: string
  userId: string
  createdAt: string
}
interface BindingsFile {
  version: 1
  bindings: Record<string, BindingEntry>
}
export interface UserPaths {
  root: string
  home: string
  dwsConfig: string
  keychain: string
  bindingFile: string
  refreshLock: string
  capabilityToken: string
}
const CALLER = /^[a-z0-9][a-z0-9-]{1,62}$/
/** Connector-private persistent volume. Nothing outside the Connector process reads these paths. */
export class ConnectorState {
  constructor(readonly root: string) {}
  get bindingsPath(): string {
    return join(this.root, 'bindings.json')
  }
  get adminTokenPath(): string {
    return join(this.root, 'admin.token')
  }
  get socketsDirectory(): string {
    return join(this.root, 'sockets')
  }
  get callersDirectory(): string {
    return join(this.root, 'callers')
  }
  get oauthDirectory(): string {
    return join(this.root, 'oauth')
  }
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('connector state directory must be a real directory')
    if ((info.mode & 0o077) !== 0 && process.platform !== 'win32') await chmod(this.root, 0o700)
    for (const directory of [this.socketsDirectory, this.callersDirectory, this.oauthDirectory])
      await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await lstat(this.bindingsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.writeBindings({ version: 1, bindings: {} })
    }
    await this.adminToken()
  }
  async readBindings(): Promise<BindingsFile> {
    try {
      const info = await stat(this.bindingsPath)
      if (!info.isFile() || info.size > 65536) throw new Error('invalid bindings file')
      const value = JSON.parse(await readFile(this.bindingsPath, 'utf8')) as BindingsFile
      if (
        value.version !== 1 ||
        !value.bindings ||
        typeof value.bindings !== 'object' ||
        Array.isArray(value.bindings) ||
        Object.keys(value.bindings).length > 256
      )
        throw new Error('invalid bindings file')
      for (const [callerId, entry] of Object.entries(value.bindings)) {
        if (!CALLER.test(callerId)) throw new Error('invalid bindings file')
        const profile = parseProfile(`${entry.corpId}:${entry.userId}`)
        if (profile.corpId !== entry.corpId || profile.userId !== entry.userId) throw new Error('invalid bindings file')
      }
      return value
    } catch {
      throw new Error('connector bindings are unreadable')
    }
  }
  private async writeBindings(value: BindingsFile): Promise<void> {
    const temporary = join(this.root, `.bindings-${randomBytes(8).toString('hex')}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(value))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.bindingsPath)
      if (process.platform !== 'win32') await chmod(this.bindingsPath, 0o600)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
  async setBinding(callerId: string, profile: { corpId: string; userId: string }): Promise<void> {
    if (!CALLER.test(callerId)) throw new Error('invalid caller id')
    parseProfile(`${profile.corpId}:${profile.userId}`)
    const value = await this.readBindings()
    value.bindings[callerId] = { corpId: profile.corpId, userId: profile.userId, createdAt: new Date().toISOString() }
    await this.writeBindings(value)
    await this.provisionUser(callerId)
    await this.ensureCapabilityToken(callerId)
  }
  async removeBinding(callerId: string): Promise<boolean> {
    if (!CALLER.test(callerId)) throw new Error('invalid caller id')
    const value = await this.readBindings()
    if (!value.bindings[callerId]) return false
    delete value.bindings[callerId]
    await this.writeBindings(value)
    return true
  }
  /** Unbind must invalidate the loopback capability token; a later re-bind issues a new one. */
  async removeCapabilityToken(callerId: string): Promise<void> {
    if (!CALLER.test(callerId)) throw new Error('invalid caller id')
    const paths = await this.userPaths(callerId)
    await unlink(paths.capabilityToken).catch(() => {})
  }
  async userPaths(callerId: string): Promise<UserPaths> {
    if (!CALLER.test(callerId)) throw new Error('invalid caller id')
    const root = join(this.callersDirectory, callerId)
    return {
      root,
      home: join(root, 'home'),
      dwsConfig: join(root, 'dws'),
      keychain: join(root, 'keychain'),
      bindingFile: join(root, 'binding.json'),
      refreshLock: join(root, 'refresh.lock'),
      capabilityToken: join(root, 'capability.token'),
    }
  }
  async provisionUser(callerId: string): Promise<UserPaths> {
    const paths = await this.userPaths(callerId)
    await provisionPrivateRuntime(paths.root)
    for (const directory of [paths.home, paths.keychain]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(directory, 0o700)
    }
    return paths
  }
  /**
   * Fail closed when the private volume cannot be written. Revocation and binding state must be
   * durable; a Connector that cannot persist it must not serve a stale `revoked:false` binding.
   */
  async assertWritable(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const probe = join(this.root, `.writable-${randomUUID()}`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(probe, 'wx', 0o600)
      await handle.writeFile('ok')
      await handle.sync()
      await handle.close()
      handle = undefined
      await unlink(probe)
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(probe).catch(() => {})
      throw error instanceof ConnectionServiceError ? error : new ConnectionServiceError('service_unavailable')
    }
  }
  async adminToken(): Promise<string> {
    try {
      const info = await lstat(this.adminTokenPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('invalid admin token file')
      const token = (await readFile(this.adminTokenPath, 'utf8')).trim()
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid admin token')
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const token = randomBytes(32).toString('hex')
      await writeFile(this.adminTokenPath, token, { flag: 'wx', mode: 0o600 })
      if (process.platform !== 'win32') await chmod(this.adminTokenPath, 0o600)
      return token
    }
  }
  async ensureCapabilityToken(callerId: string): Promise<string> {
    const paths = await this.userPaths(callerId)
    try {
      const token = (await readFile(paths.capabilityToken, 'utf8')).trim()
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid capability token')
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const token = randomBytes(32).toString('hex')
      await writeFile(paths.capabilityToken, token, { flag: 'wx', mode: 0o600 })
      if (process.platform !== 'win32') await chmod(paths.capabilityToken, 0o600)
      return token
    }
  }
  /** Cooperative refresh lock so one user never runs two token refreshes/exchanges at once. */
  async withRefreshLock<T>(callerId: string, action: () => Promise<T>): Promise<T> {
    const paths = await this.userPaths(callerId)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 2 && !handle; attempt++) {
      try {
        handle = await open(paths.refreshLock, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const info = await stat(paths.refreshLock)
          if (Date.now() - info.mtimeMs > 120000) await unlink(paths.refreshLock)
        } catch {
          /* retry once */
        }
      }
    }
    if (!handle) throw new Error('authorization_busy')
    try {
      return await action()
    } finally {
      await handle.close().catch(() => {})
      await unlink(paths.refreshLock).catch(() => {})
    }
  }
  /** Opaque per-caller directory hash for diagnostics; never leaks an identity or token. */
  callerHash(callerId: string): string {
    return createHash('sha256').update(callerId).digest('hex').slice(0, 12)
  }
}
export { constants }
