# E00-02 · G04 收口：`agent/pre-step` 运行时门控（真实 rc.2.1 宿主）

> 任务：G04 收口（task-17）· 环境：Windows x64 · Node `v24.18.0` · DSH `0.2.1-rc.2`（installed payload）
> 证据：`docs/development/evidence/e00-02/pre-step-<ts>.json`（机器可读）· 本文件（结论/命令/限制）
> 测试：`tests/host/e00-02-pre-step-gate.test.mjs`（`--test-concurrency=1`，独立 `$DSH_HOME` `.work/test-runs/g04-*`）
> 本轮结果：**7 passed / 1 skipped（真实模型 opt-in 未配置 env，未伪造）/ 0 failed**；`boopControl/recovery.runtimeEnforcement.composed` 现由真实注册状态驱动 = `true`。

## 1. 钩子选择（官方扩展点，非内部类）

从 installed payload 的生成 Cordis 表面（`@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`）
与 `@deepseek-ai/dsh-agent/README.md` 交叉确认：

| 项 | 实测契约 |
|---|---|
| 钩子名 | **`agent/pre-step`** |
| 分发模式 | **waterfall**（唯一能在模型调用前否决 step 的官方 seam；`agent/inbox/*` 是 emit，不能否决） |
| 签名 | `(this: Scoped<Agent>, payload: { agent, messages: UserMessage[], turn, step, signal }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>` |
| 决策类型 | `PreStepDecision = { kind: 'reject' } \| { kind: 'enter', messages, startsRequestSeries? }` |
| 监听注册 | `ctx.on('agent/pre-step', async (payload, next) => …)`（payload 官方 README 生成区；本行按此行注册） |
| 时机 | `turn/start` 与 inbox claim 之后；`step/start`、`agent/request`、`prepareCall()` 与任何模型请求 **之前** |

`agent/request` 更晚（已在 step admission 之后，无法否决），`tools/pre-execute` 已在模型输出之后，因此
`agent/pre-step` 是本需求唯一的正确钩子。

## 2. 实现

- 新行 **`boop-gate`**（`cordis.patch.yml` 加一行，name `./lib/pre-step-api.js`；`build.mjs` 宿主入口加一项）。
- `src/host/gate/pre-step.ts`：framework-free `PreStepRuntimeGate`
  - 只对 BOOP 来源消息动作：`isBoopMessage(message, knownIds)`（`source.kind === 'boop-command'` 或 host 侧
    minted messageId 登记表）；普通用户消息 **原样 `next()` 透传，绝不拦截**。
  - 未释放的 tracked 命令：**等待人类显式 release**（可配置 `waitTimeoutMs`，默认 120s；可被 turn signal 取消），
    而不是直接把已 claim 的消息拒掉——这样 E04-03 的 `release` 能放行**同一条**已 claim 消息。
  - 释放后放行一次：messageId 记入进程级 `consumed` 集合；再次 claim 同一 id → fail-closed 拒绝（绝不第二次执行）。
  - fail-closed：gate 未装备/账本不可读/超时/已执行/进程未跟踪（重启后旧命令）→ `{kind:'reject'}`，无 step、无模型。
  - 每次放行/拦截写审计（`gate/pre-step-allowed` / `gate/pre-step-blocked`，经 BOOP 账本 audit sink）。
- `src/host/gate/pre-step-api.ts`：Cordis 行 `boop-gate`
  - 注册 `agent/pre-step` 监听；
  - `ctx.provide('boopGateRuntime', { composed, hook, status(), enforcement() })`；
  - Remote namespace **`boopGate`** 的只读 `status()`（单层 `result.value`，`{args:{request}}` wire）。
- 控制面最小改动（`src/host/control.ts` / `control-api.ts`）：
  - `ControlPort.runtimeEnforcement()` 读取 `boopGateRuntime` 的**实时注册状态**；
  - `recovery.runtimeEnforcement` 由硬编码 `false` 改为真实事实（`composed=true` + 注册说明）；
  - release 回执文案按真实注册状态区分“运行时已放行一次” vs “只改门禁账本”。

## 3. 真实宿主测试矩阵（`tests/host/e00-02-pre-step-gate.test.mjs`）

| # | 断言 | 结果 |
|---|---|---|
| 1 | `boop-gate` 行恰好一次；无激活告警；`boopGate/status.registered=true`、`hook=agent/pre-step`、`mode=waterfall`；控制面 `recovery.runtimeEnforcement.composed=true`；未释放命令在真实 gate 账本中 `blocked` | **PASS** |
| 2 | 未释放 BOOP 命令被 hold：durable 日志只有 `turn/start` + inbox splice，**无 `step/start`、无 `user/message` 提交、无 `request/header`、无 assistant**；无 turn/end（仍在等待） | **PASS** |
| 3 | `boopControl/release` 精确释放该 messageId → **同一已 claim 消息**被准入一次：出现 `step/start`、`request/header`，durable `user/message` 中该 messageId 恰好 1 条且 `sourceKind=boop-command`；gate 计数 `allowed=1`、`consumedMessageIds=[该 id]`；随后普通唤醒不再重复执行（仍 1 条、无重复 claim） | **PASS** |
| 4 | 无关普通用户 Session 的消息正常执行（`step/start` + `request/header` + `user/message`，`sourceKind!=boop-command`），gate `passThroughBatches` 增加、无拦截 | **PASS** |
| 5a | 超时 fail-closed（`waitTimeoutMs=900`）：未释放命令 → `turn/end reason=blocked`，**无 step/无 request/无 user commit/无 assistant**；`lastDecision=release-timeout`；之后即使 release + 唤醒也**不执行**该命令（已 claim 丢弃，已知边界）；普通用户消息仍正常 | **PASS** |
| 5b | 门禁不可用 fail-closed（`simulateGateUnavailable:true`）：BOOP 命令立即 `blocked`（`gate-unavailable`），**无 step/无模型**；普通用户消息照常执行；`registered=true` 但 `gateAvailable=false`，`composed` 仍为 true（注册事实） | **PASS** |
| 6 | 写模式仍 `false`；控制面 `dispatch.available=false`；本行不派发任何东西 | **PASS** |
| 7 | 真实模型 opt-in：release 后恰好 1 条真实 `qwen-local` assistant 回复 | **SKIPPED**（未设置 `BOOP_QWEN_BASE_URL`/`BOOP_QWEN_MODEL`，不伪造） |

关键证据（脱敏 JSON 内的原文）：held 阶段事件为
`[permission/preset, sandbox/mode, approval/policy, agent/inbox/spliced, turn/start, agent/inbox/spliced]`；
release 后为
`[…, turn/start, agent/inbox/spliced, step/start, system/message, user/message×4, request/header, request/context, assistant/attempt, step/end, turn/end]`。

## 4. 诚实边界（不在测试里掩盖，供 STATUS/评审记录）

1. **`turn/start` 无法避免**：rc.2.1 的 loop 在 `preStep()` 之前已写 `turn/start`，且 inbox claim 已把消息从
   inbox 移除。因此 "未释放 → 不产生 turn/start" 的原始措辞与真实契约不符；本实现的保证是
   **无 `step/start`、无 `user/message` 提交、无模型请求、无 assistant**，turn 以 `reason=blocked` 结束。
   durable `turn/start` + `turn/end(blocked)` 会留下，已如实作为断言与证据。
2. **被拒绝/超时的 claim 不能复活**：rc.2.1 claim 已经从 inbox 删除该批消息，没有官方的“unclaim”。本实现因此
   对“未释放但被跟踪”的命令采用**有界等待 release**（保证 E04-03 release 可放行同一条消息），
   超时/门禁不可用/进程未跟踪才 reject（消息丢弃）。可信的“重启后重新投递/可释放”需要额外的
   durable inbox re-admission 设计，**NOT implemented（NOT_RUN）**。
3. **进程未跟踪的旧 BOOP 命令 fail-closed**：重启后 RecoveryGate 账本是进程内的（E00-02 现状），
   新进程看到的 `boop-command` 消息没有 gate entry → 立即 reject（不执行），但 control `release` 也不认识该 id
   （未知 id 忽略）。即“重启后旧命令一定不执行”，但“释放后重新执行”不支持——属于已知限制，不是 PASS 项。
4. **同 Session 的用户消息可能被 hold 延迟**：一条未释放 BOOP 命令会让该 Session 的当前批在 pre-step 等待至
   `waitTimeoutMs`（默认 120s）；不同 Session 的用户消息不受影响（已测）。这是 fail-closed 代价，配置可调。
5. **锁粒度**：本门控是**进程内**的运行时强制；它不替代 DSH 自身的 sandbox/approval，也不阻止同进程恶意插件
   （与 03§10 的威胁模型一致）。

## 5. 回归影响（需要 Lead/文件 owner 处理，不在本任务写范围）

- `tests/host/e04-03-control-in-host.test.mjs:425` 仍断言
  `recovery.runtimeEnforcement.composed === false`（"pre-step runtime wiring stays honestly NOT composed"）。
  该断言现在**因真实注册而为 true**，运行结果：仅此 1 条失败（其余 E04-03 host 断言全过）。需要把该行改成
  `true` 并更新注释；**本任务写范围不含该文件，未修改**。
- `tests/host/e07-01-fault-kill-restart.test.mjs:280` 同样断言 `composed === false`
  （"pre-step runtime enforcement is still honestly NOT composed"）：现在实际为 `true`，该项失败、其余 4 项通过。
  需要把该断言改成 `true`（或改为读取 live 注册事实）；**该文件属于上一轮 E07-01 交付、不在本任务写范围**。
- `tests/host/e00-02-proxy-gate.test.mjs`：**8/8 PASS**（旧 RecoveryGate 行为不变）。
- `tests/unit/*.test.mjs`：**262/262 PASS**（control 单元测试的 fake port 没有 runtimeEnforcement → 仍为 false）。
- `node build.mjs`：PASS（`lib/pre-step-api.js` 新增；其余 bundle 正常）。

## 6. 复现

```powershell
node build.mjs
node --test --test-concurrency=1 --test-force-exit tests/host/e00-02-pre-step-gate.test.mjs
node --test --test-force-exit tests/host/e00-02-proxy-gate.test.mjs
node --test --test-force-exit tests/unit/*.test.mjs

# 真实模型 opt-in（可选；无 env 时相关用例 SKIP，不伪造）
$env:BOOP_QWEN_BASE_URL="http://<host>:8000/v1"; $env:BOOP_QWEN_MODEL="<model-id>"
node --test --test-concurrency=1 --test-force-exit tests/host/e00-02-pre-step-gate.test.mjs
```

## 7. G04 判定建议

- **可判 PASS（运行时拦截语义）**：钩子为官方 `agent/pre-step` waterfall；未释放 BOOP 命令在模型调用前被拦截
  （无 step/无 user commit/无模型请求）；显式 release 后同一消息恰好执行一次且不重复；普通用户消息不受影响；
  门禁不可用/超时对 BOOP 命令 fail-closed；控制面 `runtimeEnforcement.composed` 由真实注册状态驱动。
- **保留为已知限制/NOT_RUN**（不得写成 PASS）：重启后旧命令的可再投递/可释放（需 durable re-admission）、
  真实模型 opt-in 回复（本轮无 env SKIP）、Desktop/浏览器与跨平台回归、`turn/start` 不可避免的 rc.2.1 边界。
- 若评审要求严格的 "未释放不产生 turn/start"，当前 rc.2.1 没有更早的官方 waterfall；需要 Host 侧新增 seam
  或接受 turn/start+turn/end(blocked) 边界（本文件已如实标注）。
