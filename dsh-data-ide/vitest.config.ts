import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Match the bundler's JSX runtime so specs and bundles agree.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/**/tests/**/*.spec.{ts,tsx}'],
    setupFiles: ['tests/setup/jsdom-cm.ts'],
    environment: 'node',
    // Vite's SSR cache writes into %TEMP%; on this Windows host that write
    // intermittently fails with EPERM and silently drops a spec file from the
    // run. Running from a repo-local cache directory keeps the gate deterministic.
    cache: { dir: 'node_modules/.vitest-cache' },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/**/src/**/*.ts', 'packages/**/src/**/*.tsx', 'packages/**/mcp/**/*.ts'],
      // Type-only modules emit no runtime code; the spawned process entry runs
      // out of process and is covered end to end by tests/mcp-spawn.spec.ts.
      exclude: ['**/tests/**', '**/*.d.ts', '**/src/client/contract/host.ts', '**/mcp/entry.ts'],
      // per-file 100% (packages/client/AGENTS.md L117); unreachable defensive
      // arms need `/* v8 ignore -- <reason> */`.
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
