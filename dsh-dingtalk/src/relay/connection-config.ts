import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

export interface EnterpriseConnection {
  mode: 'enterprise'
  corpId: string
  clientId: string
  displayName: string
  gatewayUrl: string
}

/** Presence is intentional: invalid enterprise settings must never fall back to personal mode. */
export function enterpriseConnection(value: unknown): EnterpriseConnection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('enterprise_configuration_invalid')
  const data = value as Record<string, unknown>
  if (
    data.mode !== 'enterprise' ||
    Object.keys(data).some((key) => !['mode', 'corpId', 'clientId', 'displayName', 'gatewayUrl'].includes(key))
  )
    throw new Error('enterprise_configuration_invalid')
  for (const key of ['corpId', 'clientId', 'displayName', 'gatewayUrl']) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 2048)
      throw new Error('enterprise_configuration_invalid')
  }
  let url: URL
  try {
    url = new URL(data.gatewayUrl as string)
  } catch {
    throw new Error('enterprise_configuration_invalid')
  }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/relay')
    throw new Error('enterprise_configuration_invalid')
  return data as unknown as EnterpriseConnection
}

export function profileRobotDirectory(root: string, profile: string): string {
  return join(root, 'profiles', createHash('sha256').update(resolve(profile)).digest('hex').slice(0, 24))
}
