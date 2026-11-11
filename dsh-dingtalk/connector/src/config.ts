import { isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { parseLimits, DEFAULT_LIMITS } from '../../enhancements/src/shared/config.js'
import type { ExecutionLimits } from '../../enhancements/src/shared/config.js'

export interface OAuthConfig {
  publicOrigin: string
  listenPort: number
  trustedOrigins: string[]
  tlsCert?: string
  tlsKey?: string
  /** Test-only finalize barrier used to inject a cancellation after the exchange commit. */
  testFinalizeGate?: string
}
export interface ProxyConfig {
  http: string
  https: string
  noProxy?: string
}
export interface ConnectorConfig {
  stateDirectory: string
  dwsBinary: string
  dwsLock?: string
  /** Test-only replacement CLI; only parsed in explicit test mode. */
  testDwsBinary?: string
  transport: 'unix' | 'loopback'
  loopbackPort: number
  testTransport: boolean
  testIdentity: boolean
  testEnvironment?: Record<string, string>
  testProvider?: string
  /** Test-only persistence barrier used to inject a cancellation right before the commit. */
  testCommitGate?: string
  socketMode: number
  limits: ExecutionLimits
  proxy?: ProxyConfig
  oauth?: OAuthConfig
  shutdownGraceMs: number
}
const absolute = (value: string): boolean =>
  isAbsolute(value) && !/^(\\\\|\/\/)/.test(value) && !/[\u0000-\u001f]/.test(value)
const integer = (name: string, value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || value === '') return fallback
  if (!/^\d{1,9}$/.test(value)) throw new Error(`invalid ${name}`)
  const parsed = Number(value)
  if (parsed < min || parsed > max) throw new Error(`invalid ${name}`)
  return parsed
}
const httpsOrigin = (value: string): string => {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error('invalid trusted origin')
  return url.origin
}
function parseOAuthEnv(env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  const names = [
    'DSH_CONNECTOR_OAUTH_PUBLIC_ORIGIN',
    'DSH_CONNECTOR_OAUTH_LISTEN_PORT',
    'DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS',
    'DSH_CONNECTOR_OAUTH_TLS_CERT',
    'DSH_CONNECTOR_OAUTH_TLS_KEY',
  ] as const
  if (names.every((name) => !env[name])) return undefined
  const origin = env.DSH_CONNECTOR_OAUTH_PUBLIC_ORIGIN
  const trusted = env.DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS
  const port = env.DSH_CONNECTOR_OAUTH_LISTEN_PORT
  if (!origin || !trusted || !port) throw new Error('incomplete DSH_CONNECTOR_OAUTH configuration')
  const publicOrigin = httpsOrigin(origin)
  const origins = trusted
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (origins.length === 0 || origins.length > 32) throw new Error('invalid DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS')
  const normalized = [
    ...new Set(
      origins.map((value) => {
        const url = new URL(value)
        if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
          throw new Error('invalid DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS')
        return url.origin
      }),
    ),
  ]
  for (const value of normalized) if (!value.startsWith('https://')) throw new Error('trusted origins must be https')
  const cert = env.DSH_CONNECTOR_OAUTH_TLS_CERT,
    key = env.DSH_CONNECTOR_OAUTH_TLS_KEY
  if ((cert && !key) || (!cert && key)) throw new Error('incomplete DSH_CONNECTOR_OAUTH_TLS configuration')
  if (cert && (!absolute(cert) || !absolute(key!))) throw new Error('DSH_CONNECTOR_OAUTH_TLS paths must be absolute')
  const finalizeGate = env.DSH_CONNECTOR_TEST_FINALIZE_GATE
  if (finalizeGate !== undefined) {
    if (env.DSH_CONNECTOR_ALLOW_TEST_TRANSPORT !== '1' && env.DSH_CONNECTOR_TEST_IDENTITY !== '1')
      throw new Error('DSH_CONNECTOR_TEST_FINALIZE_GATE requires an explicit test mode')
    if (!absolute(finalizeGate)) throw new Error('DSH_CONNECTOR_TEST_FINALIZE_GATE must be absolute')
  }
  return {
    publicOrigin,
    listenPort: integer('DSH_CONNECTOR_OAUTH_LISTEN_PORT', port, 8787, 1, 65535),
    trustedOrigins: normalized,
    ...(cert ? { tlsCert: cert, tlsKey: key! } : {}),
    ...(finalizeGate ? { testFinalizeGate: finalizeGate } : {}),
  }
}
export function parseConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const stateRaw =
    env.DSH_CONNECTOR_STATE_DIR ||
    (process.platform === 'win32'
      ? `${homedir()}\\AppData\\Local\\dsh-dingtalk-connector`
      : '/var/lib/dsh-dingtalk-connector')
  if (!absolute(stateRaw)) throw new Error('DSH_CONNECTOR_STATE_DIR must be an absolute path')
  const dwsBinary = env.DSH_CONNECTOR_DWS_BINARY
  if (!dwsBinary || !absolute(dwsBinary))
    throw new Error('DSH_CONNECTOR_DWS_BINARY must be an absolute preinstalled path')
  const lock = env.DSH_DINGTALK_DWS_LOCK
  if (lock !== undefined && !absolute(lock)) throw new Error('DSH_DINGTALK_DWS_LOCK must be an absolute path')
  const transport = env.DSH_CONNECTOR_TRANSPORT || 'unix'
  if (transport !== 'unix' && transport !== 'loopback') throw new Error('invalid DSH_CONNECTOR_TRANSPORT')
  const testTransport = env.DSH_CONNECTOR_ALLOW_TEST_TRANSPORT === '1'
  if (transport === 'loopback' && !testTransport)
    throw new Error('loopback transport is test-only; set DSH_CONNECTOR_ALLOW_TEST_TRANSPORT=1')
  const socketModeRaw = env.DSH_CONNECTOR_SOCKET_MODE || '0600'
  if (socketModeRaw !== '0600' && socketModeRaw !== '0660') throw new Error('invalid DSH_CONNECTOR_SOCKET_MODE')
  const limits = parseLimits({
    ...DEFAULT_LIMITS,
    timeoutMs: integer('DSH_CONNECTOR_TIMEOUT_MS', env.DSH_CONNECTOR_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs, 100, 120000),
    maxOutputBytes: integer(
      'DSH_CONNECTOR_MAX_OUTPUT_BYTES',
      env.DSH_CONNECTOR_MAX_OUTPUT_BYTES,
      DEFAULT_LIMITS.maxOutputBytes,
      1024,
      2097152,
    ),
    queueLimit: integer('DSH_CONNECTOR_QUEUE_LIMIT', env.DSH_CONNECTOR_QUEUE_LIMIT, DEFAULT_LIMITS.queueLimit, 0, 32),
    queueTimeoutMs: integer(
      'DSH_CONNECTOR_QUEUE_TIMEOUT_MS',
      env.DSH_CONNECTOR_QUEUE_TIMEOUT_MS,
      DEFAULT_LIMITS.queueTimeoutMs,
      50,
      60000,
    ),
  })
  const proxyUrl = env.DSH_CONNECTOR_PROXY_URL
  let proxy: ProxyConfig | undefined
  if (proxyUrl) {
    const url = new URL(proxyUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || /[\u0000-\u001f]/.test(proxyUrl))
      throw new Error('invalid DSH_CONNECTOR_PROXY_URL')
    proxy = {
      http: proxyUrl,
      https: proxyUrl,
      ...(env.DSH_CONNECTOR_NO_PROXY ? { noProxy: env.DSH_CONNECTOR_NO_PROXY } : {}),
    }
    if (proxy.noProxy && /[\u0000-\u001f]/.test(proxy.noProxy)) throw new Error('invalid DSH_CONNECTOR_NO_PROXY')
  }
  const oauth = parseOAuthEnv(env)
  const testIdentity = env.DSH_CONNECTOR_TEST_IDENTITY === '1'
  const testMode = testTransport || testIdentity
  const testEnvironment = parseTestEnvironment(env, testMode)
  const testProvider =
    testMode && env.DSH_CONNECTOR_TEST_PROVIDER_URL ? httpsSafeUrl(env.DSH_CONNECTOR_TEST_PROVIDER_URL) : undefined
  const testBinaryRaw = env.DSH_CONNECTOR_TEST_DWS_BINARY
  if (testBinaryRaw !== undefined && !testMode)
    throw new Error('DSH_CONNECTOR_TEST_DWS_BINARY requires an explicit test mode')
  if (testBinaryRaw !== undefined && !absolute(testBinaryRaw))
    throw new Error('DSH_CONNECTOR_TEST_DWS_BINARY must be absolute')
  const testCommitGate = env.DSH_CONNECTOR_TEST_COMMIT_GATE
  if (testCommitGate !== undefined && !testMode)
    throw new Error('DSH_CONNECTOR_TEST_COMMIT_GATE requires an explicit test mode')
  if (testCommitGate !== undefined && (!absolute(testCommitGate) || /[\u0000-\u001f]/.test(testCommitGate)))
    throw new Error('DSH_CONNECTOR_TEST_COMMIT_GATE must be absolute')
  return {
    stateDirectory: stateRaw.replaceAll('\\', '/'),
    dwsBinary: dwsBinary.replaceAll('\\', '/'),
    ...(lock ? { dwsLock: lock.replaceAll('\\', '/') } : {}),
    ...(testBinaryRaw ? { testDwsBinary: testBinaryRaw.replaceAll('\\', '/') } : {}),
    transport: transport as 'unix' | 'loopback',
    loopbackPort:
      transport === 'loopback'
        ? integer('DSH_CONNECTOR_LOOPBACK_PORT', env.DSH_CONNECTOR_LOOPBACK_PORT, 8791, 1, 65535)
        : 0,
    testTransport,
    testIdentity,
    ...(testCommitGate ? { testCommitGate } : {}),
    ...(testEnvironment ? { testEnvironment } : {}),
    ...(testProvider ? { testProvider } : {}),
    socketMode: Number.parseInt(socketModeRaw, 8),
    limits,
    ...(proxy ? { proxy } : {}),
    ...(oauth ? { oauth } : {}),
    shutdownGraceMs: integer('DSH_CONNECTOR_SHUTDOWN_GRACE_MS', env.DSH_CONNECTOR_SHUTDOWN_GRACE_MS, 5000, 100, 60000),
  }
}
function httpsSafeUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.username || url.password)
    throw new Error('invalid test provider URL')
  return url.href
}
/** Explicitly enabled test-only DWS environment. Never read unless test transport/identity is on. */
function parseTestEnvironment(env: NodeJS.ProcessEnv, testMode: boolean): Record<string, string> | undefined {
  const raw = env.DSH_CONNECTOR_TEST_DWS_ENV
  if (!raw) return undefined
  if (!testMode) throw new Error('DSH_CONNECTOR_TEST_DWS_ENV requires an explicit test mode')
  if (raw.length > 16384) throw new Error('invalid DSH_CONNECTOR_TEST_DWS_ENV')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('invalid DSH_CONNECTOR_TEST_DWS_ENV')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid DSH_CONNECTOR_TEST_DWS_ENV')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 64) throw new Error('invalid DSH_CONNECTOR_TEST_DWS_ENV')
  const output: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
      typeof item !== 'string' ||
      item.length > 4096 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item)
    )
      throw new Error('invalid DSH_CONNECTOR_TEST_DWS_ENV')
    // Credentials must never be smuggled through the test environment.
    if (/token|secret|password|code|cookie/i.test(key)) throw new Error('invalid DSH_CONNECTOR_TEST_DWS_ENV')
    output[key] = item
  }
  return output
}
