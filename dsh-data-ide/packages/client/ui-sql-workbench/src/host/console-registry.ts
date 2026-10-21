/**
 * Host side of the console registry (docs/10 §13.3).
 *
 * The panel owns console ids; the MCP process needs them to refuse writing into
 * a user console. The host sits between them: it accepts the panel's snapshot on
 * a route and writes it atomically into the runtime directory the MCP server
 * already reads from.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  CONSOLE_REGISTRY_SCHEMA,
  type ConsoleEntry,
  type ConsoleRegistry,
} from '../execute/console-registry.ts'

/** `consoles.json` beside the runtime spec the MCP server is given. */
export function consoleRegistryPath(runtimeDir: string): string {
  return join(runtimeDir, 'consoles.json')
}

/** Build the document written to disk. */
export function buildRegistry(consoles: readonly ConsoleEntry[], now: Date = new Date()): ConsoleRegistry {
  return { schemaVersion: CONSOLE_REGISTRY_SCHEMA, updatedAt: now.toISOString(), consoles }
}

/** Write the snapshot atomically, so a reader never sees half a JSON object. */
export async function writeConsoleRegistry(
  path: string,
  consoles: readonly ConsoleEntry[],
  now: Date = new Date(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(buildRegistry(consoles, now)), 'utf8')
  await rename(temporary, path)
}
