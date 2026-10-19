// vitest.config.ts
import { defineConfig } from "file:///E:/dsh-plugin/dsh-data-ide/node_modules/.pnpm/vitest@2.1.8_@types+node@22.20.5_jsdom@25.0.1/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  // Match the bundler's JSX runtime so specs and bundles agree.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/tests/**/*.spec.{ts,tsx}"],
    setupFiles: ["tests/setup/jsdom-cm.ts"],
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkU6XFxcXGRzaC1wbHVnaW5cXFxcZHNoLWRhdGEtaWRlXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJFOlxcXFxkc2gtcGx1Z2luXFxcXGRzaC1kYXRhLWlkZVxcXFx2aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9FOi9kc2gtcGx1Z2luL2RzaC1kYXRhLWlkZS92aXRlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZXN0L2NvbmZpZydcclxuXHJcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XHJcbiAgLy8gTWF0Y2ggdGhlIGJ1bmRsZXIncyBKU1ggcnVudGltZSBzbyBzcGVjcyBhbmQgYnVuZGxlcyBhZ3JlZS5cclxuICBlc2J1aWxkOiB7IGpzeDogJ2F1dG9tYXRpYycgfSxcclxuICB0ZXN0OiB7XHJcbiAgICBpbmNsdWRlOiBbJ3BhY2thZ2VzLyoqL3Rlc3RzLyoqLyouc3BlYy57dHMsdHN4fSddLFxyXG4gICAgc2V0dXBGaWxlczogWyd0ZXN0cy9zZXR1cC9qc2RvbS1jbS50cyddLFxyXG4gICAgZW52aXJvbm1lbnQ6ICdub2RlJyxcclxuICAgIC8vIFZpdGUncyBTU1IgY2FjaGUgd3JpdGVzIGludG8gJVRFTVAlOyBvbiB0aGlzIFdpbmRvd3MgaG9zdCB0aGF0IHdyaXRlXHJcbiAgICAvLyBpbnRlcm1pdHRlbnRseSBmYWlscyB3aXRoIEVQRVJNIGFuZCBzaWxlbnRseSBkcm9wcyBhIHNwZWMgZmlsZSBmcm9tIHRoZVxyXG4gICAgLy8gcnVuLiBSdW5uaW5nIGZyb20gYSByZXBvLWxvY2FsIGNhY2hlIGRpcmVjdG9yeSBrZWVwcyB0aGUgZ2F0ZSBkZXRlcm1pbmlzdGljLlxyXG4gICAgY2FjaGU6IHsgZGlyOiAnbm9kZV9tb2R1bGVzLy52aXRlc3QtY2FjaGUnIH0sXHJcbiAgICBwb29sOiAnZm9ya3MnLFxyXG4gICAgcG9vbE9wdGlvbnM6IHsgZm9ya3M6IHsgc2luZ2xlRm9yazogdHJ1ZSB9IH0sXHJcbiAgICBjb3ZlcmFnZToge1xyXG4gICAgICBwcm92aWRlcjogJ3Y4JyxcclxuICAgICAgcmVwb3J0ZXI6IFsndGV4dCcsICdsY292J10sXHJcbiAgICAgIHJlcG9ydHNEaXJlY3Rvcnk6ICdjb3ZlcmFnZScsXHJcbiAgICAgIGluY2x1ZGU6IFsncGFja2FnZXMvKiovc3JjLyoqLyoudHMnLCAncGFja2FnZXMvKiovc3JjLyoqLyoudHN4JywgJ3BhY2thZ2VzLyoqL21jcC8qKi8qLnRzJ10sXHJcbiAgICAgIC8vIFR5cGUtb25seSBtb2R1bGVzIGVtaXQgbm8gcnVudGltZSBjb2RlOyB0aGUgc3Bhd25lZCBwcm9jZXNzIGVudHJ5IHJ1bnNcclxuICAgICAgLy8gb3V0IG9mIHByb2Nlc3MgYW5kIGlzIGNvdmVyZWQgZW5kIHRvIGVuZCBieSB0ZXN0cy9tY3Atc3Bhd24uc3BlYy50cy5cclxuICAgICAgZXhjbHVkZTogWycqKi90ZXN0cy8qKicsICcqKi8qLmQudHMnLCAnKiovc3JjL2NsaWVudC9jb250cmFjdC9ob3N0LnRzJywgJyoqL21jcC9lbnRyeS50cyddLFxyXG4gICAgICAvLyBwZXItZmlsZSAxMDAlIChwYWNrYWdlcy9jbGllbnQvQUdFTlRTLm1kIEwxMTcpOyB1bnJlYWNoYWJsZSBkZWZlbnNpdmVcclxuICAgICAgLy8gYXJtcyBuZWVkIGAvKiB2OCBpZ25vcmUgLS0gPHJlYXNvbj4gKi9gLlxyXG4gICAgICB0aHJlc2hvbGRzOiB7IHBlckZpbGU6IHRydWUsIHN0YXRlbWVudHM6IDEwMCwgYnJhbmNoZXM6IDEwMCwgZnVuY3Rpb25zOiAxMDAsIGxpbmVzOiAxMDAgfSxcclxuICAgIH0sXHJcbiAgfSxcclxufSlcclxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUEwUSxTQUFTLG9CQUFvQjtBQUV2UyxJQUFPLHdCQUFRLGFBQWE7QUFBQTtBQUFBLEVBRTFCLFNBQVMsRUFBRSxLQUFLLFlBQVk7QUFBQSxFQUM1QixNQUFNO0FBQUEsSUFDSixTQUFTLENBQUMsc0NBQXNDO0FBQUEsSUFDaEQsWUFBWSxDQUFDLHlCQUF5QjtBQUFBLElBQ3RDLGFBQWE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUliLE9BQU8sRUFBRSxLQUFLLDZCQUE2QjtBQUFBLElBQzNDLE1BQU07QUFBQSxJQUNOLGFBQWEsRUFBRSxPQUFPLEVBQUUsWUFBWSxLQUFLLEVBQUU7QUFBQSxJQUMzQyxVQUFVO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixVQUFVLENBQUMsUUFBUSxNQUFNO0FBQUEsTUFDekIsa0JBQWtCO0FBQUEsTUFDbEIsU0FBUyxDQUFDLDJCQUEyQiw0QkFBNEIseUJBQXlCO0FBQUE7QUFBQTtBQUFBLE1BRzFGLFNBQVMsQ0FBQyxlQUFlLGFBQWEsa0NBQWtDLGlCQUFpQjtBQUFBO0FBQUE7QUFBQSxNQUd6RixZQUFZLEVBQUUsU0FBUyxNQUFNLFlBQVksS0FBSyxVQUFVLEtBQUssV0FBVyxLQUFLLE9BQU8sSUFBSTtBQUFBLElBQzFGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
