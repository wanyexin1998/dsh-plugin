/**
 * Spool writer for agent deliveries (MCP half).
 *
 * The MCP server has no host context and no back-channel: the only path the host
 * already publishes to it is the runtime spec file's location (`--dsh-data-ide-specs`).
 * The spool therefore lives beside that file, and the host tails the very same
 * directory (docs/10 §13.1). Writes are `.tmp` + `rename` so the host never reads
 * a partial envelope.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AgentDelivery } from '../src/execute/agent-delivery.ts'

/** Directory the host tails, derived from the spec file it already passes in. */
export function outboxDirFor(specPath: string): string {
  return join(dirname(specPath), 'agent-outbox')
}

/**
 * Write one envelope and return its path.
 *
 * `Date.now()` leads the filename so a lexical sort is also a chronological
 * order, which is what the host's tail loop relies on.
 */
export async function writeDelivery(dir: string, delivery: AgentDelivery): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = `${String(Date.now()).padStart(13, '0')}-${process.pid}-${randomUUID().slice(0, 8)}.json`
  const target = join(dir, name)
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(delivery), 'utf8')
  await rename(temporary, target)
  return target
}
