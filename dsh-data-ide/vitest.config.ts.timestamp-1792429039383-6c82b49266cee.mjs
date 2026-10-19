// vitest.config.ts
import { defineConfig } from "file:///E:/dsh-plugin/dsh-data-ide/node_modules/.pnpm/vitest@2.1.8_@types+node@22.20.5_jsdom@25.0.1/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  // Match the bundler's JSX runtime so specs and bundles agree.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/tests/**/*.spec.{ts,tsx}"],
    environment: "node",
    // Vite's SSR cache writes into %TEMP%; on this Windows host that write
    // intermittently fails with EPERM and silently drops a spec file from the
    // run. Running from a repo-local cache directory keeps the gate deterministic.
    cache: { dir: "node_modules/.vitest-cache" },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["packages/**/src/**/*.ts", "packages/**/src/**/*.tsx", "packages/**/mcp/**/*.ts"],
      // Type-only modules emit no runtime code; the spawned process entry runs
      // out of process and is covered end to end by tests/mcp-spawn.spec.ts.
      exclude: ["**/tests/**", "**/*.d.ts", "**/src/client/contract/host.ts", "**/mcp/entry.ts"],
      // per-file 100% (packages/client/AGENTS.md L117); unreachable defensive
      // arms need `/* v8 ignore -- <reason> */`.
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkU6XFxcXGRzaC1wbHVnaW5cXFxcZHNoLWRhdGEtaWRlXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJFOlxcXFxkc2gtcGx1Z2luXFxcXGRzaC1kYXRhLWlkZVxcXFx2aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9FOi9kc2gtcGx1Z2luL2RzaC1kYXRhLWlkZS92aXRlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZXN0L2NvbmZpZydcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgLy8gTWF0Y2ggdGhlIGJ1bmRsZXIncyBKU1ggcnVudGltZSBzbyBzcGVjcyBhbmQgYnVuZGxlcyBhZ3JlZS5cbiAgZXNidWlsZDogeyBqc3g6ICdhdXRvbWF0aWMnIH0sXG4gIHRlc3Q6IHtcbiAgICBpbmNsdWRlOiBbJ3BhY2thZ2VzLyoqL3Rlc3RzLyoqLyouc3BlYy57dHMsdHN4fSddLFxuICAgIGVudmlyb25tZW50OiAnbm9kZScsXG4gICAgLy8gVml0ZSdzIFNTUiBjYWNoZSB3cml0ZXMgaW50byAlVEVNUCU7IG9uIHRoaXMgV2luZG93cyBob3N0IHRoYXQgd3JpdGVcbiAgICAvLyBpbnRlcm1pdHRlbnRseSBmYWlscyB3aXRoIEVQRVJNIGFuZCBzaWxlbnRseSBkcm9wcyBhIHNwZWMgZmlsZSBmcm9tIHRoZVxuICAgIC8vIHJ1bi4gUnVubmluZyBmcm9tIGEgcmVwby1sb2NhbCBjYWNoZSBkaXJlY3Rvcnkga2VlcHMgdGhlIGdhdGUgZGV0ZXJtaW5pc3RpYy5cbiAgICBjYWNoZTogeyBkaXI6ICdub2RlX21vZHVsZXMvLnZpdGVzdC1jYWNoZScgfSxcbiAgICBwb29sOiAnZm9ya3MnLFxuICAgIHBvb2xPcHRpb25zOiB7IGZvcmtzOiB7IHNpbmdsZUZvcms6IHRydWUgfSB9LFxuICAgIGNvdmVyYWdlOiB7XG4gICAgICBwcm92aWRlcjogJ3Y4JyxcbiAgICAgIHJlcG9ydGVyOiBbJ3RleHQnLCAnbGNvdiddLFxuICAgICAgcmVwb3J0c0RpcmVjdG9yeTogJ2NvdmVyYWdlJyxcbiAgICAgIGluY2x1ZGU6IFsncGFja2FnZXMvKiovc3JjLyoqLyoudHMnLCAncGFja2FnZXMvKiovc3JjLyoqLyoudHN4JywgJ3BhY2thZ2VzLyoqL21jcC8qKi8qLnRzJ10sXG4gICAgICAvLyBUeXBlLW9ubHkgbW9kdWxlcyBlbWl0IG5vIHJ1bnRpbWUgY29kZTsgdGhlIHNwYXduZWQgcHJvY2VzcyBlbnRyeSBydW5zXG4gICAgICAvLyBvdXQgb2YgcHJvY2VzcyBhbmQgaXMgY292ZXJlZCBlbmQgdG8gZW5kIGJ5IHRlc3RzL21jcC1zcGF3bi5zcGVjLnRzLlxuICAgICAgZXhjbHVkZTogWycqKi90ZXN0cy8qKicsICcqKi8qLmQudHMnLCAnKiovc3JjL2NsaWVudC9jb250cmFjdC9ob3N0LnRzJywgJyoqL21jcC9lbnRyeS50cyddLFxuICAgICAgLy8gcGVyLWZpbGUgMTAwJSAocGFja2FnZXMvY2xpZW50L0FHRU5UUy5tZCBMMTE3KTsgdW5yZWFjaGFibGUgZGVmZW5zaXZlXG4gICAgICAvLyBhcm1zIG5lZWQgYC8qIHY4IGlnbm9yZSAtLSA8cmVhc29uPiAqL2AuXG4gICAgICB0aHJlc2hvbGRzOiB7IHBlckZpbGU6IHRydWUsIHN0YXRlbWVudHM6IDEwMCwgYnJhbmNoZXM6IDEwMCwgZnVuY3Rpb25zOiAxMDAsIGxpbmVzOiAxMDAgfSxcbiAgICB9LFxuICB9LFxufSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBMFEsU0FBUyxvQkFBb0I7QUFFdlMsSUFBTyx3QkFBUSxhQUFhO0FBQUE7QUFBQSxFQUUxQixTQUFTLEVBQUUsS0FBSyxZQUFZO0FBQUEsRUFDNUIsTUFBTTtBQUFBLElBQ0osU0FBUyxDQUFDLHNDQUFzQztBQUFBLElBQ2hELGFBQWE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUliLE9BQU8sRUFBRSxLQUFLLDZCQUE2QjtBQUFBLElBQzNDLE1BQU07QUFBQSxJQUNOLGFBQWEsRUFBRSxPQUFPLEVBQUUsWUFBWSxLQUFLLEVBQUU7QUFBQSxJQUMzQyxVQUFVO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixVQUFVLENBQUMsUUFBUSxNQUFNO0FBQUEsTUFDekIsa0JBQWtCO0FBQUEsTUFDbEIsU0FBUyxDQUFDLDJCQUEyQiw0QkFBNEIseUJBQXlCO0FBQUE7QUFBQTtBQUFBLE1BRzFGLFNBQVMsQ0FBQyxlQUFlLGFBQWEsa0NBQWtDLGlCQUFpQjtBQUFBO0FBQUE7QUFBQSxNQUd6RixZQUFZLEVBQUUsU0FBUyxNQUFNLFlBQVksS0FBSyxVQUFVLEtBQUssV0FBVyxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQzFGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
