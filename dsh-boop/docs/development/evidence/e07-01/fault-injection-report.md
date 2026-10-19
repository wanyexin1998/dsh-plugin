# E07-01 · 故障注入与回归证据（准备阶段）

> 任务：E07-01（故障注入与回归编排）· 状态：**准备阶段完成，最终 Gate E07-01 NOT_RUN**
> 环境：Windows（`win32`/x64）· Node `v24.18.0` · DSH `0.2.1-rc.2`（installed payload）
> 仓库：见 `regression-*.json` 的 `git.head`；本文件记录 2026-10-18 的运行。
> **这不是发布认证。** 端到端 Gate E07-01 还需要 Desktop/Electron、真实浏览器三屏/深浅主题截图、IME/触屏、
> macOS/Linux 等环境；本文件所有结论只覆盖"本机 Windows + 真实 rc.2.1 Web 宿主"。

## 0. 本轮新增

| 交付 | 路径 |
|---|---|
| 一键回归编排 | `tools/run-regression.mjs`（offline / host / real 三组独立报告，写证据 JSON，失败非零退出） |
| 故障注入 1/3：SIGKILL 中途杀进程 + 重启 + 快照恢复 | `tests/host/e07-01-fault-kill-restart.test.mjs` |
| 故障注入 2/3：模型路由不可达 | `tests/host/e07-01-fault-model-down.test.mjs` |
| 故障注入 3/3：审批并发 + 伪造绑定 | `tests/host/e07-01-fault-approval-concurrency.test.mjs` |
| 兼容矩阵 | `docs/development/regression/compatibility-matrix.md` |
| 机器可读证据 | `docs/development/evidence/e07-01/regression-*.json`、`fault-*.json` |

所有宿主测试使用 `.work/test-runs/e07-01-*` 下的**独立** `$DSH_HOME`；用户真实 `~/.dsh` 未被读取或修改。

## 1. 场景结果总表

| # | 场景 | 结果 | 关键事实 |
|---|---|---|---|
| 1 | SIGKILL 中途杀进程 → 同 DSH_HOME 重启 | **PASS（5/5）** | 新进程恢复门禁 `entries=[]`、`adoptedMessageIds=[]`；durable `turn/end=interrupted`、assistant=0；重启后 2.5s head 不变（无自动重放）、无 claim；显式冷启动 resolve 也没有执行任何旧命令；4 份 DB（live/快照/被杀文件/恢复后）`integrity_check` 全 ok；scopeId/schema 不变；旧行可读；用户 Session head 不变 |
| 2 | 模型路由不可达（闭合本地端口） | **PASS（4/4）** | `turn/end = "error: Connection error."`（非 completed）；assistant=0（无外部回退回复）；1 个 turn/start、5 次 Host 内部 `llm/retry` 后收敛；恰好 1 次 claim；`writeMode.enabled=false`、`dispatch.available=false`；确定性 Stop 仍可用且如实 noop；用户 Session/turn 未被触碰 |
| 3 | 审批并发 + 伪造绑定 | **PASS（4/4）** | 并发两次 decide：恰好 1 次 `allowed`、另一次 `already-handled`（idempotent，existingStatus=allowed）；DB 只有 1 条 decision audit、consumed_at 一次；action/outbox 未派发；伪造 payloadHash → `APPROVAL_STALE/payload-changed`，伪造 nonce → `nonce-mismatch`，均 `markedInvalid:false` 且合法卡仍可在之后正常批准；用户 Session 未被触碰 |
| 4 | 一键回归编排（offline + host） | **PASS / real SKIPPED（过滤运行）**；**全量 host 组 109/110（外部失败）** | `regression-2026-10-17T20-17-32-215Z.json`：offline **307/307**、host-filter `e07-01` **13/13**、real `SKIPPED`；`regression-2026-10-17T20-20-07-692Z.json`：全量 offline 307/307 + host **109/110**，唯一失败为 **`tests/host/e05-01-scheduler-in-host.test.mjs`**（"this Host owns the writer lease"，并行 E05-01 工作项，非本任务文件；已原样报告，未隐藏/未归因于 E07-01） |

复现命令：

```powershell
node tools/run-regression.mjs --only=offline                      # 离线 unit+client
node tools/run-regression.mjs --only=offline,host --host-filter=e07-01
node --test --test-force-exit tests/host/e07-01-fault-kill-restart.test.mjs
node --test --test-force-exit tests/host/e07-01-fault-model-down.test.mjs
node --test --test-force-exit tests/host/e07-01-fault-approval-concurrency.test.mjs
```

## 2. 场景 1：SIGKILL 中途杀进程 + 重启 + 快照恢复

**步骤**：PoC profile 启动真实 `dsh web` → 创建两个真实 Session（受测 Session + 无关用户 Session）→ resolve Agent →
`boop/pocDispatch` 派发一条 host-minted BOOP proxy 命令 → 等 durable 日志出现 `turn/start`（确认杀在 turn 中）→
直接 SQLite 种入 `e07-*` task/action/approval fixture（已披露）→ 运行中 `VACUUM INTO` 快照并校验 →
`child.kill('SIGKILL')`（Windows = TerminateProcess，无优雅退出代码）→ 校验被杀文件完整性 →
删除陈旧 `-wal/-shm`、用快照覆盖恢复 → 同一 `$DSH_HOME` 重启 → 断言。

**实测（`fault-kill-restart-*.json`，最新一份）**：

- `killed`: `{ accepted:true, signal:"SIGKILL" }`；4 份 DB `integrity_check = ok`，`foreign_keys = []`。
- 重启后 gate：`gateArmed:true`、`entries:[]`、`adoptedMessageIds:[]`；`boopControl/recovery` 的 `pendingCount=0`。
- durable：`preKillEvents` 末尾为 `turn/start`；重启后追加 `turn/end`，`turnEnd:"interrupted"`，`assistantCount:0`，
  同一 messageId 在 durable 日志中最多出现 1 次，重启后 `claims:[]`。
- 自动性：重启后 2.5s `headSeq` 不变；显式 `pocResolveAgent` 冷启动后新增事件仅 `session/end-seed`，
  `executedAfterRestart:[]`、`claimsAfterResolve:[]`（没有把"没有自动重放"夸大为运行时门控已强制）。
- 恢复账本：`scopeIdBefore = scopeIdAfter`、`schemaVersionBefore = schemaVersionAfter = 1`、恢复到的主机
  `boopTasks/list.available=true` 且能读到 `e07-restore-task`。
- 用户 Session：重启前后 `headSeq=2` 不变；Stop 尝试后仍为 2。

**已知 / 未知（如实记录，不伪造）**：

1. **恢复后为只读（fail-safe）**：`bootstrap.storage.ok=false`，`lease:{held:false, holder:"dsh@<pid>", released:false}`，
   `control.ledger.writable=false`；`boopControl/stop` 返回 `accepted:false / CAPABILITY_UNAVAILABLE`。
   原因：`VACUUM INTO` 快照包含被杀进程**未过期**的 `runtime_lease` 行；重启进程不能接管，于是按 fail-closed 只读运行。
   **这不是安全缺陷，但恢复后不可写**——运维需要文档化的 lease 释放/等待路径；本任务不声称已实现自动接管。
2. **SIGKILL 可能丢失尚未落盘的 session 尾部**：多轮重复运行中有一次重启后的 durable head 低于杀前内存 head；
   测试把该情况作为 `durablePrefixPreserved:false` 的“未知结果窗口”如实记录（不发明成功、不重复 claim）。
3. `agent/pre-step` 运行时门控仍未接线（`runtimeEnforcement.composed:false`）：本场景只证明**没有自动重放/自动 claim**。

## 3. 场景 2：模型不可达

**步骤**：profile hand-declare 唯一 `llm-pi-ai` 路由到 `http://127.0.0.1:9/v1`（闭合端口），`agent-default-model`
指向该 route；真实 Session resolve + `pocDispatch` 一条 BOOP 命令；等待 turn 收敛（≤60s）。

**实测（`fault-model-down-*.json`）**：

- `turn/end`：`"error: Connection error."`（Host 自己的 error taxonomy，原样记录）；`turnStarts:1`；
  `llmRetries:5`（Host 内建有限重试，测试只断言上限 12，不锁死具体次数）；`assistantCount:0`。
- 派发：`accepted:true`、`sourceKind:"boop-command"`；恰好 1 次 claim（无重复执行）。
- BOOP 只读：`boop/bootstrap.scope.writeModeEnabled=false`；`boopControl/state.dispatch.available=false`；
  `writeMode.blockedByGates` 直接读取真实门账本（本轮为 `G03,G04,G05,G06,G08,G09` 一类子集，不硬编码）。
- 确定性 Stop：`boopControl/stop {scope:'all'}` → `accepted:true, deterministic:true, requiresModel:false, stopped:[]`；
  如实返回“没有可停止的 BOOP 动作”（本场景无 ledger action），不假装成功。
- 用户 Session：head 不变、无 turn/start。

**未覆盖（NOT_RUN）**：真实服务的超时/限流/5xx 全谱（本轮用闭合端口模拟不可达）、真实模型恢复后的下轮重连。

## 4. 场景 3：审批并发与伪造

**步骤**：真实宿主 boot 后，直接 SQLite 种入两组 `e07-*` pending approval fixture（task/task_revision/action/
command_outbox/approval，已披露）；通过 `boopControl/approvals` 读取卡片上的**真实绑定**（payloadHash /
taskVersion / policyEpoch / nonce）；对同一审批并发两次 `decideApproval`；再做伪造 payloadHash / nonce，
最后用正确绑定批准。

**实测（`fault-approval-concurrency-*.json`）**：

- 并发：`outcomes = [ {accepted:true, outcome:"allowed"}, {accepted:false, outcome:"already-handled",
  idempotent:true, existingStatus:"allowed"} ]`；DB `status=allowed`、`consumedAt` 一次；
  `control/approval-decided` audit 恰好 1 行；`executed:false`、`dispatched:false`；
  action 仍 `awaiting_approval`、outbox 仍 `prepared`（审批不派发）。
- 伪造：payloadHash 错 → `APPROVAL_STALE / payload-changed / markedInvalid:false`；nonce 错 →
  `APPROVAL_STALE / nonce-mismatch / markedInvalid:false`；两次后 DB 仍 `pending`，随后正确绑定批准成功
  （合法卡未被伪造请求毁掉）。
- 用户 Session：head 不变；`boopControl/stop {scope:'session:<user>'}` 不停用户 turn
  （`policy.userTurnsStopped:false`，`foreignTurns:"not-inspected-never-stopped"`）。

## 5. 回归编排工具

`tools/run-regression.mjs`：

- 分组独立执行、独立报告：`offline`（unit+client）、`host`（hermetic，排除 real 命名的真实模型文件）、
  `real`（仅当 `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL` 存在；否则 `SKIPPED`，绝不伪造）。
- 每个分组记录：命令、文件清单、TAP/spec 计数（tests/pass/fail/skipped/duration_ms）、脱敏输出尾、超时与退出码。
- 环境/版本事实：node/platform/arch、DSH payload 版本与固定提交、`git rev-parse HEAD`、`git status` dirty 标记；
  不记录任何凭据值或 baseURL 值（只记录是否配置 + model id）。
- 证据：`docs/development/evidence/e07-01/regression-<ts>.json`；任一启用分组失败 → 进程非零退出；
  real 组 skip 不算失败。
- 本机两次 evidence：
  - `regression-2026-10-17T20-17-32-215Z.json`（`--only=offline,host --host-filter=e07-01`）：
    offline **307/307**、host **13/13**、real **SKIPPED**，overall PASS。
  - `regression-2026-10-17T20-20-07-692Z.json`（`--only=offline,host`，全量 host 13 文件）：
    offline **307/307**、host **109/110**，overall FAIL。
    唯一失败为 **`tests/host/e05-01-scheduler-in-host.test.mjs`**
    （断言 "this Host owns the writer lease"，与本任务无关；属并行进行的 E05-01 工作项）。
    该失败被原样保留在 JSON 中，**不归因于 E07-01 故障注入，也不隐藏**；E07-01 三个故障文件在同一批中共 13/13 通过。
- 已知环境事实（同一次 evidence）：`git.head=a544841`、`git.dirty=true`（53 个并行 WIP 变更）——
  最终放行证据必须绑定干净候选 commit；本机证据只作准备阶段记录。

## 6. 结论与 NOT_RUN

**准备阶段结论**：故障注入工具链与三组场景在本机 Windows + DSH 0.2.1-rc.2 上可重复通过；
旧响应/重启/拒绝对话均按 fail-closed 与"已知/未知"如实报告。**这不等于 E07-01 放行。**

**本轮发现（供 Lead/负责人分派）**：

1. **恢复快照携带未过期 writer lease → 重启只读**：`VACUUM INTO` 快照若在 Host 运行中取得，会带上
   `runtime_lease` 行（holder=`dsh@<pid>`，未 released）。以该快照恢复后，新 Host 报
   `bootstrap.storage.ok=false`、`control.ledger.writable=false`，所有写命令 **fail-closed** 拒绝
   （`CAPABILITY_UNAVAILABLE`）。安全姿态正确，但"恢复后立即可写"的运维路径未实现/未文档化——
   建议在 E07/E08 或 STATUS 风险里登记：备份/恢复需同时处理 lease，或等待过期后重启。
2. **SIGKILL 可能丢失尚未落盘的 session 尾部**（多轮重复运行中观察到 1 次）：重启后 durable head 可能低于
   杀前内存 head。测试把它作为未知结果窗口如实记录（不发明成功，不重复 claim）；建议把"杀进程前 flush 边界"
   列入 E07-01 最终证据的已知限制。
3. **完整 host 组存在 1 个外部失败**：`tests/host/e05-01-scheduler-in-host.test.mjs`
   （"this Host owns the writer lease"）在 `regression-2026-10-17T20-20-07-692Z.json` 中失败；
   非本任务写范围文件，建议该工作项负责人排查（可能是并行 WIP 或本机资源竞争）。

**仍为 NOT_RUN（不得改为 PASS）**：

- Desktop Electron 安装/窗口按钮/分屏；真实浏览器 1280×800 / 1440×900 / 390×844 三屏与浅/深主题截图；
  IME / 触屏 / 200% 字号 / 屏幕阅读器。
- macOS / Linux 兼容性；IM 渠道（钉钉/飞书，无凭据）。
- `agent/pre-step` 恢复门控运行时强制（`runtimeEnforcement.composed:false`）；
- 真实模型服务的超时/限流/5xx 全谱与恢复后重连；真实模型 opt-in 组（本轮未配置 env，SKIPPED）。
- SIGKILL 后 writer lease 的自动接管/恢复路径（当前 fail-safe 只读，属已知限制）。
- 原始 40 场景/12 前端项/10 看板门的完整逐条矩阵（需要 M1 全门与 Desktop/浏览器环境）。

## 运行口径（重要）

- 宿主集成套件包含大量真实宿主启动与 pnpm profile 安装；并行执行测试文件时可能出现**环境级偶发失败**（例如某次行加载 404/临时目录锁），单文件复跑均通过。因此最终回归/放行证据一律使用 **`--test-concurrency=1`（串行）** 运行宿主套件；`tools/run-regression.mjs` 的 host/real 组已默认串行。
- 离线单元/客户端套件不启动宿主，可并行运行。
