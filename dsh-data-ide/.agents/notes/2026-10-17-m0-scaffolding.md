# Agent Note — M0 脚手架与注册（2026-10-17）

## 做了什么

从零建立外部插件包 `dsh-data-ide`（`packages/client/ui-sql-workbench/`），完成三件事：右栏页面类型注册、MCP server（`ping`）、测试与门禁骨架；并在真实 dsh 0.1.7-rc.2 上验证到「人看得见 tab、agent 调得到工具」。

## 三个改变原计划的发现

1. **宿主基线整体切换**（用户拍板）：原定 `codex/presentation-v2` 的 `session.pane.right` 只存在于 0.1.1/0.1.2-rc.1 的未合入分支；用户实际运行的 0.1.7-rc.2 已改为 `sidebarRightTabs` + `sidebar.right.pane.tab`。`requestCapacity`、per-pane 右栏、对话分屏在该版本均不存在 → 相应验收项与风险（R1/R2/R10）重写。
2. **浏览器半不走 ESM**：`lib/client.js` 必须是 classic script，通过 `window.__ModuleLoader__.load({id, factory})` 注册，React 走壳模块表（没有 `react/jsx-runtime`），样式在 factory 内注入。首版 ESM 产物在浏览器里报 `import failed`，改为宿主契约后通过，并补了 `tests/client-bundle.spec.ts` 固化。
3. **0.1.7 有兼容性硬门禁**：声明 `@deepseek-ai/dsh*` peerDeps 且不匹配 → 整包跳过（同机器上 dsh-workbench 正因此被跳过）。本包因此**零 peerDependencies**，产品兼容改由运行期守卫兜底。

## 验证证据

| 验收 | 证据 |
|---|---|
| 注册链路 | dsh 0.1.7-rc.2 + dev-sql profile：右栏出现「SQL 工作台」入口（用户确认） |
| MCP 自动激活 | 宿主 spawn `…/profiles/dev-sql/node_modules/dsh-data-ide/lib/mcp/server.js` |
| AC-5 | agent 实调 `mcp__sql__ping` → `{"ok":true,"pong":"pong","server":"dsh-data-ide","at":"2026-10-17T06:37:28.789Z"}` |
| 质量 | 9 文件 32 用例，per-file 100%；`tools/precommit.sh` 六项全绿 |

## 环境侧踩坑（已写进 memory）

- WorkBuddy 注入的 `NODE_OPTIONS`（fs/language shim）会让 pnpm 在 node_modules 内 rename 报 `ERR_PNPM_EPERM`、让 vitest 写文件报错 → 构建与测试一律 `unset NODE_OPTIONS`。
- pnpm 11 的 `ERR_PNPM_IGNORED_BUILDS` 会让 `dsh plugin add` 返回非零，从而**阻断 bundle reconcile**；profile 的 `pnpm-workspace.yaml` 需声明 `onlyBuiltDependencies`。
- `plugin add` 失败时包会装上但不进 `dsh.profile.bundles`；缺 app 的 profile 会让 CLI 静默挂死（0 CPU、无端口、无日志）。

## 下一步（M1）

S2 spike（mysql2 × Doris 差异矩阵）→ 存储层（storage-json 三文档）→ 凭据层（`ctx.credentials`，key 规范化）→ 连接 CRUD UI + 三态测试 → `list_datasources` / `test_connection`。
