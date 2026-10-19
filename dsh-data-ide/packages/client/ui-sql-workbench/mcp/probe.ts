/**
 * Connection probing — the three-state result the UI and the agent both show
 * (docs/01 R1, docs/05 §3.1).
 *
 * The transport is injected so the state machine can be tested without a
 * database; `probe-mysql.ts` supplies the real mysql2 implementation.
 */

import type { ConnectionSpec } from '../src/host/runtime-specs.ts'
import type { DatabaseInfo } from '../src/datasource/model.ts'

export interface ProbeError {
  readonly code: 'AUTH_FAILED' | 'NETWORK_UNREACHABLE' | 'TIMEOUT' | 'DRIVER_MISSING' | 'UNKNOWN'
  readonly message: string
  readonly hint?: string
}

export type ProbeOutcome =
  | { readonly state: 'YES'; readonly info: DatabaseInfo }
  | { readonly state: 'NO'; readonly error: ProbeError }
  | { readonly state: 'UNSURE'; readonly error: ProbeError }

/** Transport contract: open a connection, report product facts, close. */
export interface ConnectionProbe {
  (spec: ConnectionSpec): Promise<ProbeOutcome>
}

/** Classify a driver-level failure into the three-state vocabulary. */
export function classifyProbeError(error: unknown): ProbeError {
  const code = (error as { readonly code?: unknown } | undefined)?.code
  const raw = (error as { readonly message?: unknown } | undefined)?.message
  const message = typeof raw === 'string' ? raw : String(error)

  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 28000) {
    return { code: 'AUTH_FAILED', message, hint: '检查用户名与密码；若账号限定来源 IP，还需确认客户端白名单' }
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') {
    return { code: 'NETWORK_UNREACHABLE', message, hint: '确认内网可达：主机名、端口（MySQL 3306 / Doris 9030）与 VPN' }
  }
  if (code === 'PROTOCOL_CONNECTION_LOST' || code === 'ETIMEDOUT_WRITE') {
    return { code: 'TIMEOUT', message, hint: '连接建立超时，可稍后重试或调大 connectTimeout' }
  }
  if (code === 'MODULE_NOT_FOUND') {
    return { code: 'DRIVER_MISSING', message, hint: 'mysql2 未随包正确安装' }
  }
  return { code: 'UNKNOWN', message }
}

/** True when the probe proved the credentials and server both work. */
export function isSuccess(outcome: ProbeOutcome): outcome is { readonly state: 'YES'; readonly info: DatabaseInfo } {
  return outcome.state === 'YES'
}
