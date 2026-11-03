import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { RelayClient } from './client.js'
import { enterpriseConnection, profileRobotDirectory, type EnterpriseConnection } from './connection-config.js'
import { readState, saveState } from './state.js'
import { startRobotGateway } from './robot.js'
import { withRecoverableFileLock } from '../file-lock.js'
import { loadDingTalkAccountCredentials, saveDingTalkAccountCredentials } from '../setup-state.js'
import { Outbound } from '../outbound.js'
import type { DingTalkIdentity } from '../identity.js'

interface Personal {
  clientId: string
  corpId: string
  credentialId: string
  enabled: boolean
}
interface Options {
  root: string
  home: string
  profile: string
  enterprise?: unknown
  identity(): DingTalkIdentity | undefined
}
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const origin = 'http://127.0.0.1:19878'

/** UI configuration and transport lifetimes are separate: disconnect never deletes app credentials. */
export class RobotConnection extends RelayClient {
  readonly directory: string
  private enterprise?: EnterpriseConnection
  private personal?: Personal
  private problem?: string
  private gateway?: Awaited<ReturnType<typeof startRobotGateway>>
  private release?: () => void
  private lease?: Promise<void>
  private timer?: NodeJS.Timeout
  private enabling = false
  private releaseDevice?: () => void
  private deviceLease?: Promise<void>
  private closed = false
  private pending?: Promise<unknown>
  constructor(private options: Options) {
    const directory = profileRobotDirectory(options.root, options.profile)
    super(join(directory, 'relay-device.json'), options.identity)
    this.directory = directory
    try {
      this.enterprise = enterpriseConnection(options.enterprise)
    } catch {
      this.problem = 'enterprise_configuration_invalid'
    }
    try {
      this.personal = readState<Personal | undefined>(join(directory, 'personal.json'), undefined)
    } catch {
      this.problem = 'local_configuration_invalid'
    }
    if (options.enterprise !== undefined && this.personal?.enabled) this.problem = 'mode_conflict'
  }
  override status() {
    const transport = super.status()
    const enterpriseMode = this.options.enterprise !== undefined
    return {
      ...transport,
      url: '',
      mode: enterpriseMode ? 'enterprise' : 'personal',
      displayName: this.enterprise?.displayName ?? '个人机器人',
      configured: enterpriseMode || !!this.personal,
      hosting: !!this.gateway,
      callbackUrl: enterpriseMode ? undefined : `${origin}/relay/callback`,
      status:
        this.problem ??
        (!enterpriseMode && !this.personal
          ? 'unconfigured'
          : transport.status === 'connected' && this.gateway && this.gateway.status().stream !== 'connected'
            ? 'connecting'
            : transport.status),
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending || this.closed) return Promise.reject(new Error('robot_busy'))
    const pending = work()
    this.pending = pending
    return pending.finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
  }
  async configure(data: { clientId: string; clientSecret: string }) {
    return this.serial(async () => {
      if (this.options.enterprise !== undefined) throw new Error('enterprise_managed')
      if (!this.releaseDevice) throw new Error('device_in_use')
      if (this.gateway) throw new Error('stop_before_configure')
      const identity = this.options.identity()
      if (!identity) throw new Error('auth_required')
      if (
        !data ||
        typeof data.clientId !== 'string' ||
        typeof data.clientSecret !== 'string' ||
        !/^[A-Za-z0-9._-]{1,200}$/.test(data.clientId) ||
        !data.clientSecret.trim() ||
        data.clientSecret.length > 4096
      )
        throw new Error('invalid_credentials')
      const outbound = new Outbound(data, () => undefined)
      try {
        await outbound.token()
      } catch {
        throw new Error('invalid_credentials')
      }
      const credentialId = `p-${fingerprint(this.directory)}`
      await saveDingTalkAccountCredentials(this.options.home, credentialId, data, { layout: 'v1' })
      await super.disconnect()
      this.personal = { clientId: data.clientId, corpId: identity.corpId, credentialId, enabled: false }
      saveState(join(this.directory, 'personal.json'), this.personal)
      this.problem = undefined
      await this.prepareGateway()
      return this.status()
    })
  }
  private async prepareGateway() {
    if (this.gateway) return
    const personal = this.personal
    if (!personal) throw new Error('robot_not_configured')
    const credentials = await loadDingTalkAccountCredentials(this.options.home, personal.credentialId)
    if (!credentials || credentials.clientId !== personal.clientId) throw new Error('invalid_credentials')
    const directory = join(this.options.root, 'gateways', fingerprint(personal.clientId))
    // Hold the existing recoverable lock for the full gateway lifetime, not just startup.
    await new Promise<void>((resolve, reject) => {
      this.lease = withRecoverableFileLock(
        join(directory, 'runtime.lock'),
        async () => {
          try {
            this.gateway = await startRobotGateway(
              {
                ...credentials,
                corpId: personal.corpId,
                stateDirectory: directory,
                publicOrigin: origin,
                host: '127.0.0.1',
                port: 19878,
              },
              true,
            )
            await new Promise<void>((done) => {
              this.release = done
              resolve()
            })
          } finally {
            await this.gateway?.close()
            this.gateway = undefined
          }
        },
        { timeoutMs: 500, label: 'robot gateway' },
      ).catch(() => {
        reject(new Error('gateway_in_use'))
        this.problem = 'gateway_in_use'
      })
    })
  }
  override async connect(_url?: string) {
    return this.serial(async () => {
      if (
        ['enterprise_configuration_invalid', 'local_configuration_invalid', 'mode_conflict', 'device_in_use'].includes(
          this.problem ?? '',
        )
      )
        throw new Error(this.problem)
      const identity = this.options.identity()
      if (!identity) throw new Error('auth_required')
      if (identity.corpId !== (this.enterprise?.corpId ?? this.personal?.corpId)) throw new Error('identity_mismatch')
      this.problem = undefined
      if (!this.enterprise) await this.prepareGateway()
      const result = await super.connect(this.enterprise?.gatewayUrl ?? `${origin.replace('http:', 'ws:')}/relay`)
      this.monitor()
      return { ...result, ...this.status() }
    })
  }
  private monitor() {
    clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.activate()
    }, 500).unref()
  }
  private async activate() {
    if (
      this.closed ||
      this.problem ||
      this.enabling ||
      !this.gateway ||
      !this.personal ||
      super.status().status !== 'connected'
    )
      return
    this.enabling = true
    try {
      await this.gateway.enable()
      if (!this.closed && !this.personal.enabled) {
        this.personal.enabled = true
        saveState(join(this.directory, 'personal.json'), this.personal)
      }
    } catch {
      this.problem = 'stream_failed'
    } finally {
      this.enabling = false
    }
  }
  override async start(callbacks: Parameters<RelayClient['start']>[0]) {
    if (this.problem) return
    try {
      await new Promise<void>((resolve, reject) => {
        this.deviceLease = withRecoverableFileLock(
          join(this.directory, 'receiver.lock'),
          () =>
            new Promise<void>((done) => {
              this.releaseDevice = done
              resolve()
            }),
          { timeoutMs: 500 },
        ).catch(() => {
          this.problem = 'device_in_use'
          reject(new Error('device_in_use'))
        })
      })
      // A changed enterprise target must not reuse a token issued by another gateway.
      const saved = readState<{ url?: string }>(join(this.directory, 'relay-device.json'), {})
      const target = this.enterprise ? fingerprint(JSON.stringify(this.enterprise)) : undefined
      const previous = readState<{ target?: string }>(join(this.directory, 'target.json'), {})
      if (this.enterprise && (saved.url !== this.enterprise.gatewayUrl || previous.target !== target))
        await super.disconnect()
      saveState(join(this.directory, 'target.json'), { target })
      // Register message handlers even if local hosting cannot start yet. UI retry
      // must recover a complete receiver after a port conflict is resolved.
      await super.start(callbacks)
      this.monitor()
      if (this.personal?.enabled && !this.enterprise) {
        await this.prepareGateway()
        await this.gateway!.enable()
      }
    } catch {
      this.problem ||= 'gateway_unavailable'
    }
  }
  async stopHosting() {
    return this.serial(async () => {
      if (this.options.enterprise !== undefined) throw new Error('enterprise_managed')
      if (!this.releaseDevice) throw new Error('device_in_use')
      await super.disconnect()
      clearInterval(this.timer)
      this.release?.()
      await this.lease
      this.release = undefined
      if (this.personal) {
        this.personal.enabled = false
        saveState(join(this.directory, 'personal.json'), this.personal)
      }
      this.problem = undefined
      return this.status()
    })
  }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    super.stop()
    await this.pending?.catch(() => undefined)
    this.release?.()
    await this.lease
    this.releaseDevice?.()
    await this.deviceLease
  }
}
