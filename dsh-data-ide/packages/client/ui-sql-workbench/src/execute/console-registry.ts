/**
 * Console registry: which consoles belong to the user, which to the agent.
 *
 * The MCP server has to answer "may I write into this console?" before it runs,
 * but consoles live in the browser. The panel therefore publishes a small
 * registry through the host into the runtime directory, next to the spec file the
 * server already reads (docs/10 §13.3). Unknown ids are treated as "new", so a
 * stale registry degrades to the old behaviour instead of blocking the agent.
 */

export const CONSOLE_REGISTRY_SCHEMA = 1 as const

export interface ConsoleEntry {
  readonly id: string
  readonly owner: 'user' | 'agent'
  readonly title: string
  readonly label?: string
}

export interface ConsoleRegistry {
  readonly schemaVersion: typeof CONSOLE_REGISTRY_SCHEMA
  readonly updatedAt: string
  readonly consoles: readonly ConsoleEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toEntry(value: unknown): ConsoleEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const owner = value['owner']
  const title = value['title']
  if (typeof id !== 'string' || id === '') return null
  if (owner !== 'user' && owner !== 'agent') return null
  if (typeof title !== 'string') return null
  const label = typeof value['label'] === 'string' ? value['label'] : undefined
  return { id, owner, title, ...(label === undefined ? {} : { label }) }
}

/** Parse a registry file; `null` means "missing or unusable". */
export function parseConsoleRegistry(raw: unknown): ConsoleRegistry | null {
  if (!isRecord(raw)) return null
  if (raw['schemaVersion'] !== CONSOLE_REGISTRY_SCHEMA) return null
  const updatedAt = raw['updatedAt']
  if (typeof updatedAt !== 'string') return null
  const consoles = Array.isArray(raw['consoles'])
    ? (raw['consoles'] as unknown[]).map(toEntry).filter((entry): entry is ConsoleEntry => entry !== null)
    : []
  return { schemaVersion: CONSOLE_REGISTRY_SCHEMA, updatedAt, consoles }
}

/** Owner of one console, or `null` when the registry does not know it. */
export function ownerOf(registry: ConsoleRegistry | null, id: string): 'user' | 'agent' | null {
  if (registry === null) return null
  return registry.consoles.find(entry => entry.id === id)?.owner ?? null
}
