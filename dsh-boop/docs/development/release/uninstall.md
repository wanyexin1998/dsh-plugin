# BOOP 停用与卸载指南（准备版）

> 状态：**准备材料**。真实 profile 的停用/卸载演练在 E07-02 证据里为 `NOT_RUN`。
> 本文只给步骤，不代替用户执行。

## 1. 先分清三类数据（冻结 03§19）

卸载前必须能区分：

| 数据 | 位置 | 卸载时默认处理 |
|---|---|---|
| BOOP 自有账本 | `$DSH_HOME\boop\boop.sqlite`（任务/动作/审批/审计/记忆索引/读取水位） | **保留**；只有用户再次明确确认才删除 |
| DSH 主聊天/任务 Session、原生工作区注册 | DSH 原生数据目录 | 不动；BOOP 从不删除它们 |
| 用户项目文件 | 用户自己的目录 | 不动；BOOP 不删除任何项目文件 |

停用（关闭能力）与卸载（移除插件）是两件事：**默认只停能力并保留数据**。

## 2. 停用（保留全部数据，推荐第一步）

Web 插件页把 `dsh-boop` 开关关闭；或从 `$DSH_HOME\profiles\<profile>\package.json` 的
`dsh.profile.bundles` 中移除 `dsh-boop`（保留 `dependencies` 里的包，便于以后启用）。重启 DSH 后：

- BOOP 行不再加载，`/api/boop/*`、`/api/boopTasks/*`、`/api/boopControl/*` 不再提供；
- `$DSH_HOME\boop\` 数据保留；
- DSH Session、原生工作区、项目文件完全不受影响；
- 没有后台进程残留：BOOP 全部逻辑运行在 DSH Host 进程内，没有独立服务/调度进程。

```powershell
# 只读确认停用结果（不启动 Host）
dsh --profile web --dump-config | Select-String -Pattern 'dsh-boop'
# 期望：无输出（该 bundle 不再装配）
```

## 3. 卸载（移除插件包）

```powershell
# 1) 停止 DSH
# 2) 从 profile 移除包（先停用；CLI 会把参数转发给 profile 目录里的 pnpm）
dsh plugin --profile web remove dsh-boop
# 3) 启动 DSH 确认 BOOP 端点不存在（401/404 属预期）
dsh web
```

卸载后：

- 已停用的 bundle 选择与 BOOP 自有数据都可以保留；`pnpm remove` 只处理包依赖。
- 若 `$DSH_HOME\profiles\<profile>\cordis.patch.yml` 中有手工加入的 BOOP 覆盖，按需删除；
  **不要改其他插件的行**。

## 4. 删除 BOOP 自有数据（单独、显式、可恢复）

只有在用户明确要求"清理 BOOP 数据"时才做：

```powershell
# 1) 停止 DSH；先备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$env:USERPROFILE\.dsh\boop" "$env:USERPROFILE\.dsh\boop.bak-$stamp" -Recurse
# 2) 经用户再次确认后再删除
Remove-Item "$env:USERPROFILE\.dsh\boop" -Recurse
```

删除 `$DSH_HOME\boop\` **只**删除 BOOP 自有账本；**不会**删除 DSH Session、主聊天、
原生工作区注册或任何项目文件。删除不可逆（除非保留备份）。

## 5. 未完成/未验证（NOT_RUN）

- 真实用户 profile 的停用/卸载演练。
- Desktop（Electron 持有 profile）的卸载路径：使用 Desktop 自带插件管理，`NOT_RUN`。
- 卸载后遗留的 BOOP 主 Session（`boop-main`）作为普通 DSH Session 保留；如用户要求清理，
  需用 DSH 原生 Session 管理操作（BOOP 不删除 Session）。
