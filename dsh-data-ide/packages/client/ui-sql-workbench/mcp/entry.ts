/**
 * Spawned entry of the MCP server.
 *
 * Kept separate from `server.ts` so the server module stays import-safe (no
 * top-level await) for unit and in-memory tests; this file is what the
 * profile's `mcp-sql` row executes, and `tests/mcp-spawn.spec.ts` drives it
 * end to end as a real child process.
 */

import { main } from './server.ts'

await main()
