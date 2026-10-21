/**
 * MCP side of the console registry (docs/10 §13.3).
 *
 * Reads the snapshot the host wrote next to the runtime spec. Every failure
 * degrades to `null` — "I do not know" — which the tools treat as "new console",
 * never as "refuse": a stale registry must not block the agent.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type ConsoleRegistry, parseConsoleRegistry } from '../src/execute/console-registry.ts'

/** `consoles.json` beside the spec file this process was started with. */
export function consoleRegistryPathFor(specPath: string): string {
  return join(dirname(specPath), 'consoles.json')
}

/** Read and validate the registry; `null` when missing or unusable. */
export async function loadConsoleRegistry(path: string): Promise<ConsoleRegistry | null> {
  try {
    return parseConsoleRegistry(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}
