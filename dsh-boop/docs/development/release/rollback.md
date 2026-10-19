# BOOP 回滚指南（准备版）

> 状态：**准备材料**。回滚演练在 E07-02 证据里明确为 `NOT_RUN`，最终放行等待 E07-01。
> 本文只给步骤，不代替用户执行。

## 1. 什么时候回滚

出现以下任一情况，先回滚、再排查，不要继续在坏版本上操作：

- 升级后 DSH 启动出现 `did not activate` / `failed to import` / 兼容性拒绝；
- `boop/bootstrap` 能力矩阵或门账本与升级前不一致（例如写模式被意外打开）；
- `$DSH_HOME\boop\boop.sqlite` 打不开、`PRAGMA integrity_check` 失败、任务数据丢失；
- 任务/审批/看板行为出现无法接受的功能回归。

## 2. 回滚步骤

```powershell
# 1) 停止 DSH（确认进程已退出）
# 2) 保留坏版本现场：复制整个数据目录，便于事后排查
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$env:USERPROFILE\.dsh\boop" "$env:USERPROFILE\.dsh\boop.bad-$stamp" -Recurse

# 3) 重新安装升级前的 tarball（Web 插件页选择旧包，或 CLI）
dsh plugin --profile web add "C:\absolute\path\to\dsh-boop-<old-version>.tgz"
# 4) 确认 $DSH_HOME\profiles\web\package.json 的 dependencies 指回旧版本，
#    且 dsh.profile.bundles 仍含 "dsh-boop"

# 5) 只在确实需要时恢复数据：用升级前的一致性备份替换当前账本
#    （先确认 DSH 已停止；目标文件先移走，不要直接覆盖正在使用的文件）
Move-Item "$env:USERPROFILE\.dsh\boop\boop.sqlite" "$env:USERPROFILE\.dsh\boop\boop.sqlite.failed-$stamp"
Copy-Item "$env:USERPROFILE\.dsh\boop\backup-before-upgrade.sqlite" "$env:USERPROFILE\.dsh\boop\boop.sqlite"

# 6) 启动并验证
dsh web
```

若升级前的备份是**整个目录**（`boop.bak-<stamp>`），恢复时用该目录替换 `$DSH_HOME\boop`
（先移走当前目录，不要合并两份 SQLite）。

## 3. 回滚后验证

| 检查 | 期望 |
|---|---|
| `dsh --profile web --dump-config` | 旧版本 BOOP 行唯一、无兼容性跳过 |
| `boop/bootstrap` | 版本回到旧版；`writeModeEnabled` 按门账本为 `false` |
| 数据 | 任务/审批数量与升级前一致；`PRAGMA integrity_check` = `ok`、`foreign_key_check` 为空 |
| 普通 Session | 侧栏/聊天/原生工作区不受影响 |
| 门禁 | 恢复门禁已装备，不自动执行任何旧命令 |

一致性自检命令（DSH 停止时执行）：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare('PRAGMA integrity_check').get());console.log(db.prepare('PRAGMA foreign_key_check').all());db.close()" `
  "$env:USERPROFILE\.dsh\boop\boop.sqlite"
```

## 4. 明确边界

- **不要**用旧插件直接打开新 schema：先恢复升级前的备份快照，再启动旧版本。
- 回滚不会自动撤销升级期间已经发生的外部副作用（模型/Session 已执行的内容）；
  账本会如实保留历史，回滚只恢复数据与代码版本。
- 当前只有一个已构建版本、尚无真实跨版本迁移，因此"降级路径"本身仍是 `NOT_RUN`；
  本文档不宣称任何未演练的降级路径可用。

## 5. 未验证（NOT_RUN）

- 真实 profile 上"坏升级 → 回滚 → 验证"完整演练。
- 旧版本插件读取恢复后账本的兼容性（按冻结规则应先恢复旧 schema 备份再启动）。
- Desktop profile 的回滚（Desktop 插件管理由 Electron 自带命令负责）。

## 恢复快照后的租约处理（重要）

`VACUUM INTO` 快照会连同运行时协调表 `runtime_lease` 一起备份。若在**运行中**做快照，恢复时该行可能仍带未过期的 `expires_at`：

- 恢复后的首个 Host 会看到“另一个持有者仍有效”，按设计转为**只读**（fail-closed，不抢写、不静默恢复业务）；
- 正确做法二选一：
  1. 等待租约 TTL（15 秒）自然过期后再启动；或
  2. 在启动前用一个**只读诊断以外的新连接**执行 `UPDATE runtime_lease SET expires_at='0' WHERE scope_id='<scopeId>'`（该表是运行时协调状态，不是用户数据），然后再启动；
- 不要删除 `runtime_lease` 表或数据库文件；不要手工改 fencing token。
- 新版本已实现进程内租约心跳：活动 Host 的租约会被续期；只读第二 Host 关闭时不会再误释放主 Host 的租约。
