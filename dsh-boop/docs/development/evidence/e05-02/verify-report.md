# E05-02 · 证据验收与有限自愈报告

> 运行时间：2026-10-18T04:10–04:18Z（本地 2026-10-18 12:10 起）
> 执行：`tests/unit/e05-02-verifier.test.mjs`、`tests/host/e05-02-verify-in-host.test.mjs`（本报告同目录 JSON 由真实宿主运行写出）
> 结论：**PASS** — 验收引擎按保守语义工作（口头完成不算通过、错版本证据 stale、无法判定 unknown），有限自愈只出预览、写模式关闭时 `CAPABILITY_UNAVAILABLE + 审计 + 不派发`，失败指纹达到上限后停止继续修复；真实 rc.2.1 宿主行/工具/只读性已实测。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| `src/host/verify/verifier.ts`：证据链验收（用户标准 → 产物版本 → durable 证据 → 未覆盖项），结论 `passed/failed/partial/unknown/stale` | **PASS**（单元覆盖） |
| AT-16：Agent 口头完成 / turn 结束**永远不是通过**；显式失败检查优先 → `failed` | **PASS**（单测 + 真实宿主） |
| AT-17：证据版本与目标 taskVersion 不一致 → `stale`；source generation 变化 → `stale`；均为 `pending` 推荐值，绝不 green | **PASS**（单测 + 真实宿主：v1 证据对 v2 任务、generation 变更） |
| 无法判定 → `unknown`（无证据/无验收标准/任务不存在/账本不可读/action outcome_unknown 均阻断通过） | **PASS**（单测 + 真实宿主 TASK_NOT_FOUND） |
| 失败指纹（无路径/时间/序号噪声）+ attempt 计数；同一 fingerprint 达到上限（默认 2）→ 停止继续派发/自愈、保留状态（AT-18） | **PASS**（单测 + 真实宿主 3 次调用 attempt 1→2→3，limitReached 后 `stop-dispatch` / `ATTEMPT_LIMIT_REACHED`） |
| `src/host/verify/self-heal.ts`：有限自愈**预览**（fingerprint/attempt/blockedByGates/executed:false；修复不扩范围、每次新假设、不绕过 dispatcher） | **PASS**（单测；真实宿主 `previewHeal` → `CAPABILITY_UNAVAILABLE`、`executed:false`、`dispatchAllowed:false`、`audit.sink=ledger`） |
| `src/host/verify/verify-api.ts` 独立行 `boop-verify`（namespace `boopVerify`：verify/previewHeal/status，单层 result.value） | **PASS**（in-host 7/7：行唯一、无激活告警、真实结论、匿名 401、写模式仍 false） |
| `boop_verify` 工具注册进真实工具目录（只读，不执行命令、不读任意文件） | **PASS**（`boopVerify/status.tool.registered=true`；并修复既有缺陷，见 §5） |
| 验收**只读**：verify 多次调用账本行数完全不变（0 ledger writes） | **PASS**（真实宿主：13 张表行数 before==after；JSON 已记录） |
| 自愈绝不在 write mode 关闭时执行/派发 | **PASS**（真实宿主 + 单测） |
| 测试 | unit **23/23**（全单元 **262/262**）；in-host **7/7**；`node build.mjs` 通过；E00-01 回归 **11/11** |

原始 JSON：[verify-2026-10-18T04-18-46-392Z.json](verify-2026-10-18T04-18-46-392Z.json)

## 1. 环境（隔离，绝不触碰用户 ~/.dsh）

| 项 | 值 |
|---|---|
| 宿主 | DSH Desktop `0.2.1-rc.2`（payload `.work/test-host/payload-0.2.1/dsh`） |
| Node / OS | v24.18.0 · win32 x64 |
| DSH_HOME | `.work/test-runs/e05-02-*`（每次新建；profile `boop-verify`，`boop-verify.config.maxAttempts: 2`） |
| 模型 | **无模型调用**（验收/自愈为模板化确定性逻辑；无需 opt-in 真实模型） |
| fixture 披露 | 两次 boot：boot1 让真实 Host 创建账本/scope → 停止 → **测试进程直接向隔离 ledger SQLite 种入** task/task_revision/action/fact/fact_version/fact_evidence/fact_consumption/source_cursor（清掉 boot1 残留的 writer lease 以便 boot2 可审计）→ boot2 跑验收断言。fixture 仅存在于 `.work/test-runs/**`，生产数据未动 |

fixture：TASK_A（v1，action v1，证据 generation 当前，2 条验收标准）；TASK_B（task v2，证据/action 为 v1 → 版本 stale）；TASK_C（v1，证据来自旧 generation → generation stale）。

## 2. 交付接口

### 2.1 `verifier.ts`（无框架，端口只读，可注入时钟/attempt ledger）

- 输入 `{taskId, evidenceRefs?, checks?, claim?}`：证据地址严格解析 `session:<id>#seq:<n>` / `fact:<id>@<version>`；其它自由文本只作为 **Agent claim**（非证据）；`checks` 是**已经运行过的检查结果**（`<index>:<passed|failed|unknown>[:detail]` 或对象），BOOP 从不执行测试命令。
- 结论链：失败检查 → `failed`；任一证据版本/generation stale → `stale`；全部验收项覆盖 + 证据版本匹配 + generation 可验证 + action 结果可用 → `passed`；部分覆盖 → `partial`；其余 → `unknown`。`waived`/cancelled/draft/无验收标准/任务不存在/账本不可读一律不绿。
- 输出事实：逐项 criteria 结论、`coverage`、`gates{criteriaCovered,evidenceVersionMatched,evidenceCurrent,noAgentClaimOnly}`、`uncovered`、`gaps`、`fingerprint`、`attempt`、`attemptLimit`、`limitReached`、`halted`、`nextAction`、`limitations`、**`ledgerWrites: 0`**、`recommendedVerification`（passed/failed/pending/waived，绝不替用户决定）。
- 失败指纹：`sha256(v1|task:<id>|conclusion|failed:[indices]|gaps:sorted)` 截断 32 hex —— 无路径/时间/消息序号噪声，顺序稳定；只有 `failed` 计入 attempt（stale/unknown 不消耗修复预算）。

### 2.2 `self-heal.ts`（纯函数，只出计划）

- `planSelfHeal({verification, writeMode, maxAttempts})` → `{fingerprint, attempt, maxAttempts, limitReached, code, executed:false, dispatchAllowed, blockedByGates, candidates[], revalidateCriteria[], stoppedBecause[], note}`。
- 规则：passed → `NO_REPAIR_NEEDED`；limit 达到 → `ATTEMPT_LIMIT_REACHED` 且 **零候选**；写模式关闭 → `CAPABILITY_UNAVAILABLE` 但保留诚实预览；stale 证据 → `refresh-evidence`（明确“不要用过期证据声称通过”）；未覆盖 → `investigate`；claim-only → `ask-user`/`investigate`；候选均 `requiresNewHypothesis:true`，写明不得扩范围；`executed` 恒为 false，实际派发只能走 dispatcher（本模块绝不绕过）。`renderSelfHealPlan()` 提供“未执行、未派发”的明确文案。

### 2.3 `verify-api.ts` 行 + `tools.ts`

- 行 `boop-verify`（`cordis.patch.yml` + `build.mjs` 各加一项；`./lib/verify-api.js` 相对锚定），namespace `boopVerify`：`verify` / `previewHeal` / `status`，每方法一个 `request`、单层 `result.value`；业务拒绝在 value 内（`ok/code`）。
- verify 行零写入；`previewHeal` 只在 **preview** 意义上审计（`repo.audit` → `audit_event`，sink=ledger；不可写时 memory 回退并如实报告）。
- `tools.ts` 保持纯函数式插件，新增 `boop_verify` 工具（只读、不执行命令）；与 `boopVerifyRules` 共享同一 attempt ledger。

## 3. 真实宿主实测（fixture 种入，结论如实）

| 场景 | 实测 |
|---|---|
| TASK_A + 2 条 passed 检查 + 证据 `session:session-e05-02-a#seq:5` | `passed`，`coverage 2/2`，`gates` 全 true，`evidence.versionMatchesTask=true`，`ledgerWrites: 0` |
| TASK_B（task v2，证据 v1） | `stale`，`reason=EVIDENCE_VERSION_MISMATCH:evidence v1 != task v2`，`recommendedVerification=pending` |
| TASK_C（旧 generation 证据） | `stale`，`reason=EVIDENCE_GENERATION_MOVED...` |
| TASK_A + claim「我已经完成并且全部测试通过」 | `unknown`（claim 记录在 evidence 中且 `agentClaim=true`，不参与 coverage），`recommendedVerification=pending` |
| 不存在的 task | `unknown / TASK_NOT_FOUND`，`available:true`（账本可读，任务本来不存在） |
| 只读性 | verify 4 次调用前后 **13 张表行数完全相同**（`audit_event` 也不变） |
| AT-18 | 同一失败指纹连续 3 次：attempt 1→2→3，`limitReached` 在 2 起为 true，第 3 次 `halted:true / nextAction=stop-dispatch` |
| previewHeal（写模式关） | `ok:false, code:CAPABILITY_UNAVAILABLE, executed:false, dispatchAllowed:false, blockedByGates=[G03,G04,G05,G06,G08,G09]`，候选 ≥1 且 `requiresNewHypothesis:true`，`audit.sink=ledger`，`audit_event` 新增 `verify/preview-heal` 行 |
| previewHeal（指纹用尽） | `code:ATTEMPT_LIMIT_REACHED`，候选 `[]`，`executed:false` |
| 工具目录 | `boopVerify/status.tool.registered=true`（`boop_verify`），且修复后 `boop_catalog` 也真正注册（见 §5） |
| 行/鉴权/模式 | dump-config 中 `- id: boop-verify` 恰好 1 次；无激活告警；匿名 `/api/boopVerify/verify` → **401**；`writeMode.enabled=false` 全程保持 |

## 4. 保守验收语义（与冻结规则的映射）

| 规则 | 实现 |
|---|---|
| AT-16 口头完成且测试失败 → 不通过 | 有任何 `failed` 检查即 `failed`；claim 不进入 coverage，claim-only → `unknown`；任务 `lifecycle=cancelled/draft`、无标准、任务不存在均不绿 |
| AT-17 证据版本早于/晚于目标产物 → 提示不匹配、不能用过期证据完成 | 版本不等 → `stale` + `EVIDENCE_VERSION_MISMATCH`；source generation 变化 → `stale`；版本不可证明 → gap `EVIDENCE_VERSION_UNPROVEN`，不通过 |
| AT-18 同一修复循环失败 → 达到 fingerprint 限制停止继续派发 | 稳定 fingerprint + 每 fingerprint attempt 预算 2；超限 `stop-dispatch` / `ATTEMPT_LIMIT_REACHED`，零候选、不派发、保留状态 |
| 用户豁免不显示为通过 | `verification=waived` → conclusion `unknown`，`recommendedVerification=waived` |
| 不执行任意测试命令 / 不读任意文件 / 另一模型评阅不算独立审计 | 端口只读账本；`checks` 由调用方提供；`limitations` 明示 |
| 写模式关闭时只出计划+审计、绝不派发 | previewHeal `CAPABILITY_UNAVAILABLE` + `executed:false` + ledger audit；`dispatchAllowed` 仅在 gate 开启且未超限时为 true（真正派发属 dispatcher） |

## 5. 真实验证发现并修复的缺陷（`src/host/tools.ts`，本任务写范围）

**M0 的 `boop_catalog` 工具自始未真正注册**：其 `defineTool` 输出 schema 使用了 harness 值 schema DSL 不支持的 `required` 关键字（输出 DSL 只接受 `properties`/布尔 `additionalProperties`/数组 `items`），且参数用了不被允许的显式 `required: false` 写法 —— `defineTool` 抛错后被 `try/catch` 静默吞掉（日志级别/通道不进入当前诊断），因此 `boop-tools` 行一直在“注册失败但主机正常”的状态。E05-02 修复了两个工具定义到受支持 DSL，并让 `boopVerify/status` 报告 `tool.registered` 与 `relatedTools.boop_catalog`；真实宿主断言两者均为 true（E00-01 回归 11/11 仍过）。

## 6. 与 G05 / G06 无关的结论（Lead 要求）

- **G05（审批/停止/恢复）**：E05-02 不包含审批决策、不执行停止/恢复、不写 `action/approval/outbox`；本任务的验收结论与自愈计划都是**只读/预览**，不改变 G05 所需的 E04-03 真实审批卡→停止→恢复端到端证据面。真实宿主实测 `writeMode.enabled=false` 且 verify 零写入；`previewHeal` 被 `CAPABILITY_UNAVAILABLE` 拒绝。因此 **E05-02 的通过不应也不能把 G05 标 PASS**；gates.ts 中 G05 仍应为 `NOT_RUN`（由 E04-03 owner 补齐）。
- **G06（记忆抽取/提交）**：E05-02 不调用 `MemoryExtractor`/`MemoryCommitter`、不写 `fact/fact_evidence/memory_snapshot/source_cursor`（in-host 行数前后一致）。因此 E05-02 与 G06 无关；G06 状态仍由 g06-e2e owner 的真实抽取+提交证据决定，保持 `NOT_RUN`。
- E05-02 自身证据可支撑的场景是 **AT-16/AT-17/AT-18**（issue 关联 G02/G05 中的验收部分）；建议 Lead 在 STATUS 中按“E05-02 PASS（AT-16/17/18 证据；G05/G06 不受影响）”表述，而不要据此改变 G05/G06 状态。

## 7. 复现命令

```powershell
node --test --test-force-exit tests/unit/e05-02-verifier.test.mjs
node --test --test-concurrency=1 --test-force-exit tests/host/e05-02-verify-in-host.test.mjs
$env:BOOP_EVIDENCE_DIR="docs/development/evidence/e05-02"   # 可选：写出本目录 JSON
node --test --test-force-exit tests/unit/*.mjs             # 262/262 无回归
node build.mjs
```

无需真实模型环境变量（本任务无模型调用；真实模型 repair 文案版本未实现，模板化已覆盖，故无 SKIP 项）。

## 8. 未覆盖 / NOT_RUN

1. **模型生成的修复说明**：按要求优先模板化无模型版本（确定性、可测试）；用真实模型生成 repair 说明属可选优化 → NOT_RUN（模板已满足“新可验证假设/不扩范围”约束）。
2. **自愈实际执行链路**：写模式关闭，只验证 preview 与 gate 拒绝；真正的 repair 派发必须经 dispatcher（G03/G04/G05 未 PASS）→ 不在本任务范围，保持 NOT_RUN。
3. **跨进程失败指纹持久化**：attempt ledger 为进程内（与 E05-01 scheduler 一致）；重启后计数清零。冻结规则只要求“同 fingerprint 达到上限停止并保留状态”，跨重启持久化未要求 → 如实记录。
4. **UI 展示**：验收结论/为什么显示这样/证据下钻的界面属 E04 客户端后续批次。
5. **真实用户任务端到端**：本 in-host fixture 直接种入真实账本行（已披露），不依赖真实 Agent 产出的验收证据链；端到端验收（真实任务→证据→验收）待 G03/G05 写路径通过后由 E07 回归覆盖。

## 9. 建议 STATUS 措辞（供 Lead，不直接改 STATUS.md）

> **E05-02 证据验收与有限自愈：PASS。** 新增 `src/host/verify/verifier.ts`（只读证据链验收：用户验收标准→产物 taskVersion→durable 证据→未覆盖项；结论 passed/failed/partial/unknown/stale；Agent 口头完成不算通过 AT-16、证据版本/来源世代不匹配为 stale AT-17、无法判定为 unknown，绝不伪造绿；失败指纹稳定 + 每指纹最多 2 次尝试，超限停止继续派发/自愈 AT-18）、`src/host/verify/self-heal.ts`（有限自愈预览：新假设/不扩范围/不绕过 dispatcher；写模式关闭只出计划+审计、executed:false、不派发）、`src/host/verify/verify-api.ts` 行 `boop-verify`（namespace `boopVerify`：verify/previewHeal/status，单层 result.value）与 `boop_verify` 只读工具。测试：单元 23/23（全单元 262/262）、in-host 7/7（行唯一、无告警、真实结论、verify 前后账本 13 表行数不变、previewHeal `CAPABILITY_UNAVAILABLE`+审计、AT-18 指纹上限、匿名 401、写模式仍 false、工具已注册）、E00-01 回归 11/11、`node build.mjs` 通过；证据 `docs/development/evidence/e05-02/`。顺带修复 M0 `boop_catalog` 因 schema DSL 误用而从未真正注册的缺陷。**G05/G06 不受影响**（E05-02 零写入、不审批/不恢复/不记忆），两门仍由各自 owner 的真实证据决定。NOT_RUN：模型生成修复说明（模板化已覆盖）、自愈实际执行（写模式关闭，需 dispatcher）、指纹跨进程持久化、UI 展示。
