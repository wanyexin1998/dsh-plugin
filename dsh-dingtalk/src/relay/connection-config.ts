import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

export interface EnterpriseConnection {
  mode: 'enterprise'
  corpId: string
  clientId: string
  displayName: string
  gatewayUrl: string
  queryTools?: string[]
}

// Only reviewed operations can be enabled. The deployment must separately
// enforce read-only database grants and the user's permitted data scope.
const queryTools = new Set([
  'mcp__wren__semantic_instructions',
  'mcp__wren__list_semantic_models',
  'mcp__wren__describe_semantic_model',
  'mcp__wren__list_semantic_cubes',
  'mcp__wren__describe_semantic_cube',
  'mcp__wren__dry_plan_only',
  'mcp__wren__run_semantic_sql',
  'mcp__wren__run_cube_query',
  'mcp__openmetadata__search_metadata',
  'mcp__openmetadata__get_entity_details',
  'mcp__doris__get_db_list',
  'mcp__doris__get_db_table_list',
  'mcp__doris__get_table_schema',
  'mcp__doris__exec_query',
])

/** Whether the named tool has been reviewed for enterprise query profiles. */
export function reviewedQueryTool(name: string): boolean {
  return queryTools.has(name)
}

/** Presence is intentional: invalid enterprise settings must never fall back to personal mode. */
export function enterpriseConnection(value: unknown): EnterpriseConnection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('enterprise_configuration_invalid')
  const data = value as Record<string, unknown>
  if (
    data.mode !== 'enterprise' ||
    Object.keys(data).some(
      (key) => !['mode', 'corpId', 'clientId', 'displayName', 'gatewayUrl', 'queryTools'].includes(key),
    )
  )
    throw new Error('enterprise_configuration_invalid')
  for (const key of ['corpId', 'clientId', 'displayName', 'gatewayUrl']) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 2048)
      throw new Error('enterprise_configuration_invalid')
  }
  if (
    data.queryTools !== undefined &&
    (!Array.isArray(data.queryTools) ||
      !data.queryTools.every((item) => typeof item === 'string' && reviewedQueryTool(item)))
  )
    throw new Error('enterprise_configuration_invalid')
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
