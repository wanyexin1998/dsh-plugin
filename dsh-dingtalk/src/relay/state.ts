import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function readState<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error: any) {
    if (error.code === 'ENOENT') return fallback
    throw new Error('invalid_relay_state')
  }
}
export function saveState(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}
