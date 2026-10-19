# BOOP 升级指南（准备版）

> 状态：**准备材料**。升级演练在 E07-02 证据里明确为 `NOT_RUN`，最终放行等待 E07-01。
> 本文只给步骤，不代替用户执行。

## 1. 升级前必须做的事

1. **记录当前状态**
   - 当前插件版本（`$DSH_HOME\profiles\<profile>\package.json` 中 `dsh-boop` 依赖版本；
     本地 tarball 安装时记录 tarball 的文件名与 sha256）。
   - 当前 tarball 与对应 `*.package.json` 清单（升级失败要回滚到它）。
   - `$DSH_HOME\boop\boop.sqlite` 的 `meta.schema_version`（当前实现为 `1`）。
2. **停止 DSH**（同一 profile 不要在运行时替换插件包；无 HMR 时不会热生效）。
3. **做一致备份**（二选一，推荐第一种）：

```powershell
# 方式 1（推荐）：用 SQLite 一致性快照，不直接拷贝活跃 WAL
#   在 DSH 停止后执行；<目标> 必须是尚不存在的路径
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});db.prepare('VACUUM INTO ?').run(process.argv[2]);db.close()" `
  "$env:USERPROFILE\.dsh\boop\boop.sqlite" `
  "$env:USERPROFILE\.dsh\boop\backup-before-upgrade.sqlite"

# 方式 2：确认进程已退出后，整体复制目录
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$env:USERPROFILE\.dsh\boop" "$env:USERPROFILE\.dsh\boop.bak-$stamp" -Recurse
```

> 该 `VACUUM INTO` 一致性备份机制已在**合成账本**上验证（`docs/development/evidence/e07-02/backup-check.json`），
> 对真实用户账本的备份/恢复演练仍是 `NOT_RUN`。

## 2. 升级步骤

```powershell
# 1) 构建并校验新包
node build.mjs
node tools/package-boop.mjs
Get-FileHash .\dist\dsh-boop-<new-version>.tgz -Algorithm SHA256   # 对照清单 tarball.sha256

# 2)（DSH 已停止）通过 Web 插件页 Update，或 CLI 覆盖安装：
dsh plugin --profile web add "C:\absolute\path\to\dsh-boop-<new-version>.tgz"

# 3) 确认 $DSH_HOME\profiles\web\package.json 中
#    - dependencies 指向新 tarball/版本
#    - dsh.profile.bundles 仍含 "dsh-boop"（升级不应改变启用状态）
# 4) 启动
dsh web
```

## 3. 升级后验证

| 检查 | 期望 |
|---|---|
| 启动日志 | 无 `did not activate` / `failed to import` / 兼容性跳过 |
| `dsh --profile web --dump-config` | BOOP 行仍在且唯一 |
| `boop/bootstrap` | 返回能力矩阵与门账本；`writeModeEnabled` 仍按门账本为 `false`（写模式不因升级自动打开） |
| 数据 | 任务/审批/记忆数据仍在：`$DSH_HOME\boop\boop.sqlite` 的 `meta.schema_version` 与行数符合预期 |
| 普通 Session | 侧栏、聊天、原生工作区不受影响 |

## 4. 升级失败 → 回滚

任何启动失败、数据异常或门账本不一致，**立即按 `rollback.md` 回滚**：

1. 停止 DSH；
2. 重新安装旧 tarball；
3. 只用备份快照恢复 `$DSH_HOME\boop\`（**不要让旧插件直接打开新 schema**）；
4. 启动并按 `rollback.md` 验证。

## 5. Schema / 迁移规则（冻结 03§19）

- 升级检查 schema 兼容区间；**任何破坏式迁移前必须先做可恢复备份**并做 FK/integrity 检查。
- 当前实现只包含 schema `1`，尚无真实跨版本迁移；本文不宣称任何降级路径可用。
- 不支持"旧插件直接打开新 schema"的降级；降级一律走"恢复备份快照"。
- 数据路径固定为 `$DSH_HOME\boop\`；`scopeId` 由规范化 `$DSH_HOME` + 本地 owner 派生，
  **不要通过复制数据库到另一个 `$DSH_HOME` 来迁移**（会形成另一个数据域，需显式迁移）。

## 6. 未验证（NOT_RUN）

- 真实 profile 上升级成功/失败/回滚三条分支的端到端演练。
- DSH 版本变化带来的兼容性升级（每次宿主升级都必须重新对齐并复跑证据，旧证据只作历史）。
- 跨 schema 版本迁移与降级。
