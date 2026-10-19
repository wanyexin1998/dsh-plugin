// Runs vitest with coverage in a child process whose NODE_OPTIONS is cleared.
//
// Why this exists: WorkBuddy's CLI injects `NODE_OPTIONS=--require=…node-safe-delete-shim.cjs`,
// which routes every `fs.rm` through a trash binary. Vitest's coverage provider
// wipes `coverage/` with `fs.rm` before the run, so the shim turns a routine
// cleanup into `spawnSync …/genie-trash ETIMEDOUT` (and, on this host, a blocked
// `wmic.exe`), failing the whole gate before a single test runs.
//
// Clearing NODE_OPTIONS for the child is the narrowest fix: it only affects the
// vitest process tree, and it is also what `tools/precommit.sh` already does.

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const env = { ...process.env }
delete env.NODE_OPTIONS

const child = spawn(
  process.execPath,
  [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root, env },
)

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
