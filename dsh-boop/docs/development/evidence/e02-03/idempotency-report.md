# E02-03 / G03 · AT-13 重复/断连对账与跨 turn 幂等 · 证据报告

> 结论先行：**G03 的"自定义来源 / messageId / 队列 / flush / 对账"链路已在真实 rc.2.1 宿主 +
> 真实 Qwen 上闭环**：同一 actionId/messageId 重试绝不换 ID、不重复投递；`outcome_unknown`
> 先做 durable 对账，三态结论（accepted / not-delivered / indeterminate）如实落账；重复
> reconcile 幂等；**绝不自动把 unknown 当成功、绝不自动重试**。
> 建议：**G03 判 PASS**（附两个已如实记录的边界，见 §6）。最终放行仍由 E07-01 统一判定。
>
> 证据类型：真实宿主 + 真实模型运行；崩溃窗口的**账本行**由测试直接 SQLite 重写（已披露），
> 但 durable Session 日志始终是真实 Agent 自己写的记录。

## 1. 环境与运行

| 项 | 值 |
|---|---|
| 宿主 | 已安装 DSH payload `0.2.1-rc.2`（`.work/test-host/payload-0.2.1/dsh`，只读提取） |
| 模型路由 | hand-declared `llm-pi-ai`（`qwen-local` / `qwen3.8-27b` / `openai-completions` / `http://172.26.0.49:8000/v1`）；`BOOP_QWEN_KEY` 为固定占位串（服务无凭证），**无真实密钥** |
| 测试进程 Node | v24.18.0；宿主运行时由 payload 自带 |
| 隔离 | 独立 `$DSH_HOME = .work/test-runs/g03-*`；用户真实 `~/.dsh` 未被读写 |
| 串行 | `--test-concurrency=1`（崩溃/重启场景必须串行） |
| 复现命令 | `$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"; $env:BOOP_QWEN_MODEL="qwen3.8-27b"; $env:BOOP_QWEN_KEY="boop-local-placeholder-not-a-secret"; node --test --test-concurrency=1 --test-force-exit tests/host/e02-03-idempotency-in-host.test.mjs` |
| 结果 | 真实模型运行 **6/6 PASS ×3 连续**（51.6–55.1s/次）；无模型 env 时 **5 PASS + 1 SKIP**（模型用例跳过、不伪造）；既有 `e02-03-real-dispatch` 回归 **5/5 PASS**；全量单测 **262/262 PASS** |

运行证据（`docs/development/evidence/e02-03/`）：

| 文件 | 说明 |
|---|---|
| `idempotency-2026-10-18T04-20-04-851Z.json` | **最终 PASS 运行**（含 pre-step gate 断言） |
| `idempotency-2026-10-18T04-17-35-315Z.json` / `...04-16-34-549Z.json` | 前两次连续 PASS 运行（修复后、gate 断言前） |
| `idempotency-2026-10-18T04-18-39-157Z.json` | 无模型 env 运行：5 PASS + 1 SKIP |
| `idempotency-2026-10-18T04-12-51-510Z.json` | **失败的首轮尝试**（保留作历史）：暴露两个真实缺陷，见 §2.3 |

## 2. 实现（write scope 内）

### 2.1 `src/host/dispatch/dispatcher.ts`

1. **同一 action/message id 幂等**（AT-13）
   - envelope 的 `messageId` 恒等于 `action.id`；重试不可能铸造新 ID。
   - action 已 delivered（`accepted/running/settled` 或 outbox `accepted`）时，重试返回
     `{kind:'duplicate', reason:'ALREADY_ACCEPTED', messageId}`，**不再调用 transport**。
   - action 为 `outcome_unknown` 时先走 durable 对账：证据证明已投递 → `duplicate`
     （`RECONCILED_DELIVERED`）；证据不足 → `unknown`（不重发）；只有证明 not-delivered 的
     **显式**重试才会用同一 ID 再投递。
   - outbox 仍在 `sending`（有活跃租约）→ `unknown / DELIVERY_IN_FLIGHT`，不抢不猜。
2. **durable 对账（`reconcileUnknown` / `reconcileAction`）**
   - 证据源：`user/message`（id/actionId/source.kind/seq）、`agent/inbox/spliced`（插入消息 id）、
     inbox projection 中仍 pending 的 id；`agent/inbox/claimed` 明确不作为 durable 证据。
   - 三态：`accepted`（正向证据）→ action/outbox 落 `accepted` 并写审计
     `dispatch/reconciled-delivered`；`not-delivered`（**仅当** 完整可读日志 + 无痕迹 +
     调用方声明 clean restart）→ action `planned` / outbox `blocked` 并写审计
     `dispatch/reconciled-not-delivered`（**不自动重试**）；其余 `indeterminate`（不改账本）。
   - 幂等：第二次调用观察到同一结论返回 `changed:false`，**不产生第二条审计**。
   - 对账窗口以 action 的**不可变 `created_at`** 为锚（`actionCreatedAt` 只读回调），
     不用会被"标记 unknown"改写的 `updated_at`——否则会漏掉崩溃前的投递证据
     （首轮失败暴露的缺陷之一，已修复）。
3. **flush 前置**：投递 accepted 后先把目标 Session 持久化日志 flush 再落账
   `accepted`；对账读证据前也先 flush。SIGKILL 后仍能从 durable 日志证明投递
   （正是 AT-13 "已接收但 DB 未标记 → 依据同 messageId/source 补记"）。

### 2.2 `src/host/transport/dsh-adapter.ts`

- 新增 `readDurableTrace(sessionId, {sinceMs, maxRawReads, clean})`：只读、有界
  （`listEvents` body-free 索引 + 仅对候选事件 `readEvent`）+ inbox projection 的 pending ids；
  返回 available/truncated/inbox 可观测性等事实，绝不臆造。
- `enqueueProxy` 增加第二道防线：同一 messageId 已在 durable inbox pending 时**不再插入**，
  返回 `{accepted:true, duplicate:true}`（dispatcher 仍是第一道，账本层）。

### 2.3 首轮失败暴露并修复的真实问题（如实记录）

1. **对账窗口锚点错误**：原先用 `action.updated_at` 计算 since；崩溃重启时
   `reconcileOutbox()` 会把 `sending→outcome_unknown` 并改写 `updated_at` 到重启时刻，
   导致崩溃前的 durable 投递事件落在窗口之外 → 对账误判 indeterminate。改用不可变
   `created_at`（并提供 `actionCreatedAt` 只读回调）。
2. **G04 pre-step gate 未放行**：本 bundle 已挂载 `boop-gate`（真实 `agent/pre-step` waterfall），
   BOOP 代理命令未被 track/release 时 **fail-closed**（`turn/end(reason=blocked)`）。
   PoC reconcile 的显式重试现在先 `gate.track(...)` + `gate.release([messageId])`（与真实
   planned-command 流程的 operator 放行同义），把命令**送过**gate 而不是绕过它；
   最终证据里 `boopGate/status` 显示 `registered:true, composed:true, lastDecision:allow,
   consumedMessageIds` 含该 id。

### 2.4 `src/host/api-service.ts`（仅新增 PoC 端点）

`pocReconcile(request)`（`pocEnabled` 默认 false，生产语义不变）：

- `{ actionId }`：boot `reconcile()`（sending→unknown，不重发）→ 证据对账该 action；
- `{ actionId, retry:true }`：**显式**重试已存在的 action id（先 track+release gate），
  已投递返回 duplicate、unknown 先对账、not-delivered 才用同一 ID 再投递；
- `{ sessionId }` / `{ actionIds }`：按会话/列表对账未知动作；
- `cleanRestart:true`：操作方声明上次 Host 是优雅停止——absent evidence 才可判 not-delivered；
- 返回 `boot`、`dispatch`、`report`（含每项 verdict/evidence/seq/head/candidates/truncated）与
  `ledgerWritable`；账本只读（崩溃后租约未过期）时如实返回 `reason:'ledger-read-only'`。

## 3. 已验证的具体事实（最终 PASS 运行）

### 3.1 正常路径 + 重复派发同一 ID（无新 ID）

- `dispatch.kind=accepted`；`actionId == messageId == act_16b9ee37-…`（宿主铸造，重试不换）。
- 再次 `retry:true` → `{kind:'duplicate', reason:'ALREADY_ACCEPTED', messageId:同一 id}`；
  durable 日志仍 **splice 插入 1 次**、user/message 至多 1 次、ledger `accepted/accepted`。
- 无模型 env 下同样成立（delivery 由 durable splice 证明）。

### 3.2 AT-13 崩溃窗口（真实 SIGKILL）+ durable 对账

- 真实投递成功并 flush 后，把账本行改为 `dispatching / sending`（**fixture 窗口**，disclosed）→
  `child.kill('SIGKILL')`（`signal:'SIGKILL'`，无优雅关闭）。
- 等待 writer lease TTL（15s）后重启同一 `$DSH_HOME`：`storage.ok=true`、scopeId/schema 不变。
- boot `reconcile()` 把 sending 行标为 `outcome_unknown`（不重发）；证据对账：
  `verdict:accepted`、`reason:durable-evidence`、`evidence.kind:durable-inbox-splice`、
  `seq:14`（`candidates:7`、`truncated:false`）、同 ID 落 `accepted/accepted`，审计
  `dispatch/reconciled-delivered` **恰好 1 条**。
- 重复对账：`changed:false`、`report.idempotent:true`、审计仍 1 条。
- 新进程仍按账本 dedupe：再次 `retry:true` → `duplicate / ALREADY_ACCEPTED`。
- 重启后 durable 只有 1 次 splice 插入、至多 1 条 user/message；新进程 0 claim；head 冻结
  （无自动 replay）。

### 3.3 真正丢失的发送：not-delivered 必须"干净重启"证明，且不自动重试

- 账本 `outcome_unknown`、durable 无任何 trace；`cleanRestart:true` →
  `verdict:not-delivered`（`candidates:0`、日志可读且未截断）→ action `planned`、outbox `blocked`、
  审计 1 条；重复对账 `changed:false`。
- 对账**没有**自动重试（durable 仍无 trace）。
- 显式 `retry:true` 后用**同一 actionId=messageId** 投递成功（seed 前无其它 id 产生），
  durable 恰好 1 次插入。

### 3.4 三态诚实（indeterminate）

- 同样的"无痕迹"证据，若不声明 clean restart → `indeterminate`（reason
  `clean-restart-not-attested`），账本保持 `outcome_unknown`、不写任何东西；
  加上声明后才 `not-delivered` —— 证明判定由**证据+授权**决定，不是猜测。
- 目标 Session 不存在（`session-not-readable; session-missing`）→ `indeterminate`、账本不动。

### 3.5 真实模型端到端 + G04 运行时门禁

- 真实模型 turn：runtime claim **恰好 1 次**（sourceKind `boop-command`、actionId 一致）、
  durable `user/message` **1 条**（seq 39，source.kind `boop-command`）、assistant
  `provider=qwen-local, model=qwen3.8-27b, text="\n\nBOOP-OK"`、`turn/end=completed`（同一 turn）。
- pre-step gate（G04 行）事实：`registered:true, composed:true, armed:true, lastDecision.allow`、
  `consumedMessageIds` 含该 id、`counters{boopMessages:3, allowed:3, blocked:0}`。
- 执行后再次重复派发同一 ID → `duplicate`；2s 后 user/message=1、splice=1、claim=1，
  **没有第二次执行**。

## 4. 测试文件

`tests/host/e02-03-idempotency-in-host.test.mjs`（新增，6 个用例，串行）：

1. harness 就绪（账本可写、pocReconcile 可用、G04 pre-step gate 已组合）；
2. 正常路径 accepted + 同 ID duplicate；
3. 真实 SIGKILL 崩溃窗口 → durable 对账 accepted → 重复对账幂等 → 跨进程 dedupe；
4. 丢失发送 → clean restart 下 not-delivered（不自动重试）→ 显式同 ID 重试成功；
5. 三态：未声明/缺失 Session → indeterminate（账本不动）；
6. 真实模型：claim 一次、user/message 一次、BOOP-OK 回复、duplicate 不二次执行、
   pre-step gate allow/consumed。

无模型 env 时用例 6 `SKIP`（跳过原因写明），其余照常真实执行。

## 5. 其他回归

- `node --test tests/unit/*.test.mjs` → **262/262 PASS**（含既有 `e02-dispatch` 11/11，行为兼容）。
- `node --test tests/host/e02-03-real-dispatch.test.mjs`（既有真实派发/重启不重放）→ **5/5 PASS**。
- `node build.mjs` 成功（api 行 78.0KB 含新端点）。

## 6. G03 判定建议与边界（NOT_RUN / 残留）

**建议：G03 判 PASS** —— 依据冻结 G03 定义（自定义来源 / messageId / 队列 / flush / 对账）：
真实来源与 durable provenance 由既有 E02-03 证据覆盖；本轮补齐了 messageId 重试幂等、
断连/崩溃 durable 对账、三态如实、重复对账幂等、绝不自动重试/升级，并在真实宿主+真实模型上实测。

**两个必须如实记录的边界（不阻塞 G03 定义，但发布前需决策）**：

1. **Host 无跨进程/跨 turn 的 messageId 去重**（NOT_RUN）：DSH inbox 没有这种去重；
   BOOP 的去重层 = dispatcher 账本状态 + adapter pending-inbox 防线（均已实测）。
   若绕过 BOOP 工具直接向 Session 注入重复 id，Host 不会阻止——BOOP 不声称覆盖该边界。
2. **生产 boot 生命周期未自动调用证据对账**（残留集成项）：`reconcileUnknown` 已实现并在
   PoC 端点真实运行，但回滚/重启后的"自动对账"尚未在启动流程里接线；且"优雅停止"标记
   （clean-restart 依据）当前由调用方/测试声明。建议 E07-01/E05-01 把它接入 boot
   （带持久 clean-shutdown 标记），在此之前不要声称"重启自动对账"。
3. 崩溃窗口的**账本行**为测试 fixture 重写（PoC 无法在 RPC 事务内确定性 SIGKILL 到该窗口）；
   durable 投递证据是真实 Agent 日志。`agent/inbox/claimed` 非 durable，运行时 claim 只作
   辅助观测（PoC claim feed）。
4. 未覆盖：多 Host 并发下的 reconcile、长会话（>200 候选事件）的截断路径、真实 Desktop
   Electron 环境（E07-01）。

## 7. 建议 STATUS 文案（供 Lead 统一写入）

> **E02-03 / G03 收口（AT-13 重复/断连对账 + 跨 turn 幂等）**：真实 rc.2.1 宿主 + 真实 Qwen
> **6/6 PASS ×3 连续**（51–55s/次；无模型 env 时 5 PASS + 1 SKIP）。实现：dispatcher 账本层
> 幂等（同 action/message id 重试绝不换 ID、duplicate 不重发）、durable 三态对账
> （user/message + splice 对 + inbox projection；accepted / not-delivered / indeterminate）、
> 失败发送仅在 clean-restart 证明下判 not-delivered 且**绝不自动重试**、重复 reconcile 幂等
> （changed:false、审计不重复）、投递前后 flush 保证崩溃可对账；PoC-only `pocReconcile`
> 端点默认关闭。真实 SIGKILL 重启后：账本 unknown 行由 durable 证据补记为 accepted、同 ID、
> 审计 1 条、新进程零重放；真实模型回复 BOOP-OK 且 claim/user-message 各 1 次、duplicate 不二次
> 执行；G04 pre-step gate 实测 allow/consumed（命令送过 gate 而非绕过）。**G03 具备 PASS 证据**
> （最终由 E07-01 汇总）。**NOT_RUN/边界**：Host 无跨进程 messageId 去重（BOOP 层已覆盖）、
> 生产 boot 自动对账与持久 clean-shutdown 标记未接线、多 Host 并发 reconcile、>200 候选截断
> 路径、Desktop Electron 环境。
