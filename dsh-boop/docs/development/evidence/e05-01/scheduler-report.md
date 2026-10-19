# E05-01 · 前后台调度、原生自动化与巡检报告

> 运行时间：2026-10-17T20:15–20:16Z（本地 2026-10-18 04:15 起）
> 执行：`tests/unit/e05-01-scheduler.test.mjs`、`tests/host/e05-01-scheduler-in-host.test.mjs`、`tests/host/e05-01-scheduler-real.test.mjs`（本报告同目录 JSON 由真实运行写出）
> 结论：**PASS** — 调度核心/巡检/原生自动化行在真实 rc.2.1 宿主可用；真实 Qwen 后台批次（复用 E03-02 extractor + 单许可 permits）一次调用完成抽取提交，水位/证据/零重复均实测。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| `src/host/scheduler.ts`：P2<P3<P4 优先级、2s 同主题合并、单许可串行、前台阻断新后台批次、有限重试退避、格式失败停批、精确 pause/resume/cancel、重启空队列 | **PASS**（单元 27/27 覆盖） |
| `src/host/patrol.ts`：只读补偿巡检（租约/水位/待决审批/unknown outbox/恢复门禁/原生绑定/模型路由），只出事实与告警 | **PASS**（单元 + in-host 只读实测：账本行数前后不变、modelCalls=0） |
| `src/host/scheduler-api.ts`：独立行 `boop-scheduler`，namespace `boopScheduler`，单层 result.value：status/pause/resume/cancel/patrolNow/automation(+PoC pocRunBackground) | **PASS**（in-host 7/7） |
| 原生 Schedule 绑定（注册/取消/状态；不覆盖用户 schedule；缺失显式 unavailable） | **PASS**（真实 `schedule/catalog` 仅 1 条 BOOP 任务；unbind 只删自己的 id） |
| P1 前台接线（真实 user/message → foreground；turn/end → idle） | **PASS**（真实测试观测 `foregroundObserved: true`） |
| 真实 Qwen 后台批次（1 次调用，经共享 permit + extractor + committer） | **PASS**：3 事实提交，3.8–4.0s，watermark 17 = durable head，证据 seq=8 真实用户消息 |
| 第二次批次 | **no-op，0 次模型调用**，无重复事实/快照 |
| 写模式 | **仍为 false**；确定性的 pause/resume/cancel 在写模式关闭时可用并写 `audit_event`（actor=system） |
| 测试 | unit **27/27**（全单元 **225/225**）；in-host **7/7**（×2）；真实 opt-in **3/3**（×3 次连续，每次恰好 2 次短模型调用）；无 env 时 3 SKIP（不伪造）；`node build.mjs` 通过 |

原始 JSON：[real-background-2026-10-17T20-15-58-348Z.json](real-background-2026-10-17T20-15-58-348Z.json)

## 1. 环境（隔离，绝不触碰用户 ~/.dsh）

| 项 | 值 |
|---|---|
| 宿主 | DSH Desktop `0.2.1-rc.2`（payload `.work/test-host/payload-0.2.1/dsh`） |
| Node / OS | v24.18.0 · win32 x64 |
| DSH_HOME | `.work/test-runs/e05-01-*`（每次新建；profile `boop-sched` / `boop-sched-real`） |
| 真实模型 | vLLM `http://172.26.0.49:8000/v1`、`qwen3.8-27b`、`max_model_len=196608`、**无凭证**（BOOP 侧 `credentialRef: none`） |
| 真实 profile 配置 | 行 `llm-pi-ai` + `agent-default-model`（仅用于生成真实 fixture turn）；行 `boop-scheduler`：`pocEnabled: true`、`patrolTimer: false`、`mergeWindowMs: 200`、`maxJobAttempts: 1`、`softTimeoutMs: 45000`、`modelRoute {providerId, modelId, baseUrl, credentialRef: none, contextWindowTokens: 196608}`；Session 持久化临时改 `compression: none` 便于按原文取证（生产配置未改） |

## 2. 交付接口

### 2.1 `src/host/scheduler.ts`（无框架、可注入时钟/定时器）

- 优先级：**P0**（确定性暂停/撤销 → 由控制入口直接执行，不等模型）、**P1**（用户输入=状态：前台期间不启动新后台批次，在跑批次标记 `pauseAfter` 到安全边界结束，不声称服务端抢占）、**P2 任务结果核查** > **P3 Session 记忆更新** > **P4 历史学习**（队列已就绪，见 NOT_RUN）。
- 合并：同 `topicKey` 事件在 **idle 2s** 窗口内合并为 1 批（`mergedEvents` 计数），同主题已在队列/运行中则只挂计数，不重复唤醒。
- 单并发：所有批次的模型调用经 `permits.ts` 的 **1 个共享许可**（45s 软超时/取消/退避由 permits 提供）；批与批串行，`maxBatchesPerIdleWindow` 限流，**完成的批次绝不自我入队**（无自唤醒循环）。
- 失败策略：`timeout/unavailable/failed →` 指数退避重试至 `maxJobAttempts`；`invalid-output` 重试，`halted`（extractor 连续 2 次格式失败）→ **丢弃批次并保留水位**；`cancelled` 记审计。
- 确定性控制：`pause/resume/cancel(scope)`，`scope = all | {kind:task|action|session,id}` 精确匹配、拒绝缺 id；如实报告 `queuedRemoved/abortRequested/alreadyFinished/stillRunning` 与"未声称服务端停止"的 note；全部审计。
- 内存队列：重启即空，**不补跑旧后台写任务**。
- `NativeAutomationBinding`：原生 `schedule` 服务**按需解析**（行挂载顺序原因）；只创建/删除 1 个带固定 marker 的任务（daily 09:00 Asia/Shanghai），已存在同 marker 任务时**收养不重复创建**；title 被改动/已消失时**拒绝删除**；服务缺失 → `unavailable`，绝不暗造旁路定时任务（03§77）。

### 2.2 `src/host/patrol.ts`（只读）

`runPatrol(ports, {intervalMs})` 输出 `{readOnly:true, modelCalls:0, writeMode, lease, cursors, approvals, outbox, gate, native, modelRoute, alerts[], notDone[]}`：
- 租约失守 → warn；恢复门禁未 arm → **blocking**；门禁 blocked 条目 → warn（需人工 release，巡检不 release）；
- 水位 gap → warn、dirty/processing → info（真实 P3 工作）；审批过期仍 pending → warn；unknown outbox → warn（需对账，不自动重发）；
- 任一面不可读 → `available:false + reason`（绝不当成空且健康，FE-11）；
- `notDone` 显式声明未执行任何业务动作/自动恢复/模型调用/水位推进。

### 2.3 `src/host/scheduler-api.ts` + 行

- 行 `boop-scheduler`（`cordis.patch.yml`）与构建入口（`build.mjs`）。
- Remote `boopScheduler`：`status`（写模式/门禁/队列/许可/最近批次/巡检/原生绑定）、`pause/resume/cancel`、`patrolNow`、`automation{bind|unbind|status}`、PoC-only `pocRunBackground`（默认关闭）。
- P1 接线：`ctx.on('session/event')` → `user/message`(source=user) 置前台、`turn/end` 回 idle（真实测试取证）。
- P3 批次：`MemoryExtractor`（E03-02，12k 输入估算/2k 输出/45s 软超时）+ `MemoryCommitter` + `LedgerCursorStore`，模型经 `ModelPermits` 单许可；每批审计实际 provider/model。
- **observation batch 适配器**：见 §4.1。
- 巡检定时器默认 60s（可配，`unref`），只读；测试 profile 关闭以保确定性。
- 审计：`repo.audit` 写 `audit_event`（sink=ledger；不可写时 memory 回退并如实报告）。

## 3. 真实运行实测（最终运行，session `session-0d6650ab…`）

fixture：真实 `session/create` + `session/prompt`（1 次真实 turn，回复 OK），durable JSONL head **17**，用户消息 seq **8**。

| 断言 | 实测 |
|---|---|
| P1 前台 | 用户消息期间 `status.scheduler.foreground.active=true`（真实观测），`turn/end` 后回到 idle |
| 后台批次 | `pocRunBackground` → `state=completed`，`batch.status=committed`，`applied=3`，**1 次模型调用**（provider `qwen-local`/model `qwen3.8-27b`），**3841ms** |
| 水位 | batch.watermark `-1 → 17`，== durable head；`source_cursor.through_seq=17,state=dirty`；不越界 |
| 证据 | 3 × `fact_evidence`：`session_id` 正确、`seq=8`（真实 user/message）、落在窗口内 |
| 快照 | `memory_snapshot` version 1（3 事实，其中 1 条 open_item active、2 条 decision disputed —— committer 既有判定，见 §5） |
| 第二次批次 | `no-op`，**0 次模型调用**，事实/快照不新增 |
| 写模式 | `false`（G03/G04/G05/G06/G08/G09 未 PASS）且后台仍按隔离 profile 显式开启 |
| 模型调用预算 | 每次运行恰好 **2 次**短调用（fixture turn 1 + 抽取 1） |

## 4. 真实验证中发现的问题（如实记录）

1. **`observe/host-reader.ts` 的 `listEvents` 只返回语义文档**，而观察平面 `readBatch` 要求**连续**事件记录 + `semantic` 标志 → 真实 Session 会被判为永久 `READ_GAP`（E03-02 真实测试用的是测试内文件 reader，返回全部事件，因此当时未暴露）。本任务在 `scheduler-api.ts` 内实现**只读 observation batch 适配器**（`sessionQuery.listEvents` 取 body-free 全量索引判连续性 + 一次 `readEvent` 窗口 ≤50 取正文/来源），复用同一 `LedgerCursorStore`；未修改 `host-reader.ts`（不在写范围）→ **建议 E03-01/后续 owner 修 source reader 契约**。
2. **原生 `schedule` 服务在行激活时可能尚未注册**（行挂载顺序）：绑定改为按需解析并使用真实 catalog 验证；状态在服务变为可用时自愈（`unavailable → unbound`）。
3. **`runtime_lease.expires_at` 是 epoch-ms 文本**（非 ISO）：巡检首版误报 `lease held:false`，已兼容两种编码（真实 in-host 断言 `held:true`）。
4. **committer 的 disputed 判定过宽**（既有 commit 层，E03-02 已报告）：同 kind 不同文本的 2 条真实 `decision` 被标 `disputed`（并非真正矛盾）。本任务不改 committer。
5. 原生绑定默认无 main Session 身份时 **pending-session**（不创建隐藏 Session）；真实测试先调用 `boop/mainSession` 再 bind。

## 5. 复现命令

```powershell
$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
$env:BOOP_QWEN_MODEL="qwen3.8-27b"
$env:BOOP_QWEN_KEY="boop-local-placeholder-not-a-secret"   # 宿主 fixture 用占位；BOOP 侧 credentialRef=none
$env:BOOP_EVIDENCE_DIR="docs/development/evidence/e05-01"  # 可选

node --test --test-force-exit tests/unit/e05-01-scheduler.test.mjs          # 27/27
node --test --test-force-exit tests/host/e05-01-scheduler-in-host.test.mjs  # 7/7（真实宿主，无模型）
node --test --test-force-exit tests/host/e05-01-scheduler-real.test.mjs     # 3/3（2 次真实调用）
node --test --test-force-exit tests/unit/*.mjs                              # 225/225 无回归
node build.mjs
```

无 env 时真实测试 3 个全部 **SKIP**（原因写明，绝不 fake PASS）。

## 6. 未覆盖 / NOT_RUN

1. **P2 任务结果核查 / P4 历史学习的实际 work**：调度核心（队列/优先级/暂停恢复/合并/限流）已就绪，但这两个 worker 的模型/控制器属后续批次（E03-03 执行、E04-03）；行状态如实标注 `background.wire=memory-only`，不伪造队列内容。
2. **60s 巡检定时器 cadence**：单元与 in-host 以显式 `patrolNow` 验证，测试 profile 关闭定时器保证确定性；长时间运行的真实 cadence 未测。
3. **真实并发（前台用户 turn 与后台批次同端点叠加）**：单许可串行在单元确定性时钟证明；不声称控制服务端/原 Agent 的并发（02§05）。
4. **原生 Schedule 的到期投递行为**（daily 09:00 实际上是否唤醒主 Session）：本任务只验证注册/取消/状态与"不覆盖用户任务"；到期投递需等到时或改时间，属 NOT_RUN（届时 BOOP 控制器仍需重新判断权限，不视为永久授权）。
5. **UI 侧调度面板**：不属本任务（客户端后续）。

## 7. 建议 STATUS 措辞（供 Lead，不直接改 STATUS.md）

> **E05-01 前后台调度、原生自动化与巡检：PASS。** 新增 `src/host/scheduler.ts`（P2<P3<P4 优先级、idle 2s 同主题合并、`permits.ts` 单许可串行、前台 P1 阻断新后台批次、有限退避重试、连续格式失败停批保留水位、精确 pause/resume/cancel、重启空队列）、`src/host/patrol.ts`（只读检查租约/水位/待决审批/unknown outbox/恢复门禁/原生绑定，只出事实告警，不自动恢复、不调模型）、`src/host/scheduler-api.ts`（行 `boop-scheduler`，namespace `boopScheduler`：status/pause/resume/cancel/patrolNow/automation + PoC-only 后台批次；P1 由真实 `session/event` 接线；原生 schedule 按需绑定、只建/删自己的 1 条任务、缺失显式 unavailable）。测试：单元 27/27（全单元 225/225）、真实宿主 7/7、真实 Qwen 后台批次 3/3 ×3 连续（每次 2 次短调用；3 事实、watermark 17=durable head、证据 seq=8、第二次 no-op 零调用、写模式仍 false）；`node build.mjs` 通过。发现并内部适配 `HostSourceReader.listEvents` 仅返回语义文档导致真实 Session 被判 READ_GAP 的集成缺陷（未改 host-reader，建议后续 owner 修契约）；committer 同 kind 不同文本被标 disputed 为既有 commit 层行为。NOT_RUN：P2/P4 实际 worker、60s cadence 长跑、原生到期投递、真实并发叠加。
