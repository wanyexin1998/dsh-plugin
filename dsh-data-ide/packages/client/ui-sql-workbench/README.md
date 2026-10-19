# dsh-data-ide

DeepSeek Harness（0.1.7-rc.2）右栏的**SQL 工作台**插件：数据连接、SQL 编辑、查询结果网格、脚本 git，外加一个随插件安装的 MCP server（`serverName: sql`，工具以 `mcp__sql__*` 暴露给 agent）。

当前进度：**M0**——右栏页面类型已能在真实宿主注册，MCP 侧提供 `ping` 探活工具。连接管理 / SQL 执行 / 结果网格分别在 M1 / M2 落地。

## 安装（开发期）

```bash
# 在本仓构建产物
pnpm build

# 装进独立 profile（不污染日常使用的 web profile）
dsh plugin --profile dev-sql add link:E:\dsh-plugin\dsh-data-ide\packages\client\ui-sql-workbench

# 启动（首次会自动打开浏览器）
node <dsh-harness>/apps/cli/lib/bin.js --profile dev-sql --port 62370
```

装进日常 profile 前请确认：该 profile 的 `package.json` 会被改写，并执行一次 `pnpm install`。

## 两条容易踩的规则

1. **不声明任何 `@deepseek-ai/dsh*` 的 `peerDependencies`。**
   dsh 0.1.7 会对声明了这些 peer 的插件做 semver 门禁，不匹配就**整包跳过**（`packages/boot/plugin-manager/src/index.ts:301-302`）；而未声明 `peerDependencies` 的包免检（`app-boot/src/plugin-compatibility.ts:69`）。产品兼容性改由运行期守卫 `src/client/guard.ts` 兜底：宿主缺少右栏页面类型注册表时，打印可读原因并跳过注册。

2. **`lib/client.js` 不是 ES 模块。**
   浏览器端通过 `window.__ModuleLoader__.load({ id, factory })` 注册，React 等由壳模块表 `require` 提供（没有 `react/jsx-runtime`），样式在 factory 内注入。构建脚本 `build.mjs` 负责这层包装，回归测试 `tests/client-bundle.spec.ts` 守住它。

## 目录

```
src/index.ts          node 半（宿主侧生命周期，M0 为空）
src/client/           浏览器半：右栏页面类型 + 两个 keyed seat + 守卫 + 文案 + 样式
mcp/                  MCP server（stdio）：server.ts / entry.ts / tools.ts
tests/                vitest，per-file 100% 覆盖率
cordis.patch.yml      向 profile 插入插件行与 mcp-sql 行
```

详细工程约定见仓库根 `AGENTS.md` 与 `docs/06-PLUGIN-ENGINEERING.md`。
