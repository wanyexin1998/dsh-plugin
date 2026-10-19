# E03-02 · 模型侧记忆抽取（真实 Qwen + 单并发许可 + committer 提交）报告

> 运行时间：2026-10-17T19:50–19:53Z（本地 2026-10-18 03:50–03:53）
> 执行：`tests/host/e03-02-extraction-real.test.mjs`（本报告同目录 JSON 由该测试真实运行写出）
> 结论：**PASS** — 真实宿主 Session → 真实 Qwen 受限抽取 → 候选校验 → 既有 committer（CAS/证据窗口/权威顺序）提交，全链路真实、无 mock 冒充。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| `src/host/model/permits.ts`：单并发许可 + 45s 软超时 + 取消传播 + 退避（可注入 now/timer） | **PASS**（单元 5 项：FIFO 串行、排队取消、软超时、取消/异常释放、退避可取消） |
| `src/host/memory/extractor.ts`：一次模型调用的受限抽取 job | **PASS**（单元 25/25；真实 5/5 ×4 连续） |
| 真实模型路由 | `providerId=qwen-local` / `modelId=qwen3.8-27b`，vLLM `http://172.26.0.49:8000/v1`，**无凭证（none）**，每次调用审计实际 provider/model |
| 真实抽取调用 | **3.8–4.7s**（2000 输出预算、输入估算 ~420 tokens、真实 usage prompt=497/completion=237） |
| 提交结果 | `status=committed`，version 1，3 条事实全部带**真实证据地址**（seq 8 = 真实 `user/message`） |
| 覆盖水位 | snapshot coverage `throughSeq=17` = durable head 17；cursor `throughSeq=17,state=dirty`；**不越过 durable 边界** |
| 第二次运行 | `status=no-op`，**0 次模型调用**，快照版本与事实行数不变（不重复提交） |
| 失败策略（真实账本） | 空输出 → `invalid-output`，**0 事实、水位回滚 -1**；连续 2 次格式失败停批（单元证明）、超时/取消不推进水位（单元证明） |
| 不写用户 Session | Session JSONL 文件 SHA-256 前后一致；无隐藏 Session/Agent 产生 |
| 模型调用预算 | 每次运行恰好 **2 次**短调用（宿主 Agent turn 1 + 抽取 1） |
| 测试稳定性 | 真实宿主 5/5 PASS **连续 4 次**；失败策略用例本地 stub（不耗模型） |
| 回归 | 全部单元 **197/197**；`node build.mjs` 成功；E03-01 in-host **7/7** |

原始 JSON（两次真实运行，均为 5/5 PASS）：
- 最终运行（提示词 v2）：[real-extraction-2026-10-17T19-52-56-063Z.json](real-extraction-2026-10-17T19-52-56-063Z.json)
- 首轮运行（提示词 v1，用于对照）：[real-extraction-2026-10-17T19-50-31-854Z.json](real-extraction-2026-10-17T19-50-31-854Z.json)

## 1. 环境（隔离，绝不触碰用户 ~/.dsh）

| 项 | 值 |
|---|---|
| 宿主 | DSH Desktop `0.2.1-rc.2`（payload `.work/test-host/payload-0.2.1/dsh`） |
| Node / OS | v24.18.0 · win32 x64 |
| DSH_HOME | `.work/test-runs/e03-02-<epoch>/dsh-home`（每次新建；profile `boop-mem-real`） |
| BOOP 账本 | `<DSH_HOME>/boop/boop.sqlite`（真实 SQLite + 真实 `BoopRepository`/`MemoryCommitter`） |
| Session 日志 | `<DSH_HOME>/sessions/**/session.v4.jsonl`（本测试 profile 显式 `compression: none`，只为把 durable 日志按原文读回取证；**生产配置未改**） |
| 模型服务 | vLLM `http://172.26.0.49:8000/v1`，`qwen3.8-27b`，`max_model_len=196608`，4bit，无凭证 |
| 凭证 | BOOP 侧 `credentialRef: 'none'`（服务无凭证）；宿主侧占位 env `BOOP_QWEN_KEY`（pi-ai 需要 key 字段，占位值非真实密钥） |

## 2. 交付接口

### 2.1 `src/host/model/permits.ts`（E05-01 直接复用）

- `ModelPermits`：**全局 1 个许可**，FIFO 排队；`acquire()` 可取消（排队中取消不消耗许可）；`withPermit(task, {label, signal})` 在许可内执行任务并施加：
  - **45s 首次软超时**（默认，可配置）：到点 abort 客户端请求、丢弃结果并抛 `PermitTimeoutError`；任务 settle 后才释放许可（不会与下一个调用重叠）；
  - **取消传播**：外部 `AbortSignal` → `PermitCancelledError`；任务抛错也保证释放；
  - **退避**：`backoffDelayMs(attempt)` = 500ms×2^(n-1)，上限 8s（确定性、无抖动，便于测试），`delay(ms,{signal})` 可取消。
- `TimerApi` 注入（`now/setTimeout/clearTimeout`）：单元测试用确定性假时钟，无需实际等待。审计事件 `queued/acquired/released/soft-timeout/cancelled`。

### 2.2 `src/host/memory/extractor.ts`

- `MemoryExtractor.extract({sessionId, baselineVersion?, signal?})`：
  1. 只读读取一个窗口：`BatchReader`（宿主即 `SourceObserver.readBatch`），窗口绑定 `scopeId/sessionId/fromSeq/toSeq/baselineVersion`；
  2. 输入 cap **~12k tokens 保守估算**（0.6 tokens/字符按 E05-00 实测中文速率，ASCII 按 1/4，仅估算不宣称精确）；超预算只处理**最旧前缀**并把未处理尾部留到下一批（水位只到已处理 seq）；
  3. 调用：`QwenClient.chat()` + `response_format: json_schema(strict)`（facts[]: text/kind/confidence/evidenceSeq/authority/supersedesFactIds）；`temperature=0`、输出预算 2048（2k–4k 可配）、默认 `enable_thinking=false`（机械 JSON 抽取不需要思考稿；保持开启时仍分离 reasoning 并拒绝混入）；
  4. 校验：`admitCandidates()` 纯函数——kind/authority 枚举、confidence∈[0,1]、text 非空且 ≤500 字符、**evidenceSeq 必须是本次真的读到的 seq 且落在窗口内**、疑似凭证/密钥文本拒绝、重复候选去重、条数上限；
  5. 提交：交给既有 `MemoryCommitter.commit()`（CAS/证据窗口/权威顺序/disputed 全部沿用，**不绕过**）；快照 version/coverage 来自 committer；
  6. 观测水位：成功后 `commitRead(processed boundary)`；失败/超时/取消/gap/输入超限 → **恢复读取前水位**；全为结构性/注入事件时视为「无变化」，标记已处理范围但不写事实。
- 冻结失败策略：`TRUNCATED_OUTPUT`（finish=length，即使 JSON 可解析也拒绝）、`EMPTY_OUTPUT`、`THINKING_LEAKED`、`NOT_JSON_DOCUMENT/JSON_PARSE_ERROR`、`UNEXPECTED_TOOL_CALL`、`NO_ADMISSIBLE_CANDIDATES` → **不提交、不推进水位**；同窗口**连续 2 次格式失败** → 批次停止（`halted`，第三次不再调用模型），需 `resetBatch()` 人工重试；模型不可用：仅对 `MODEL_UNAVAILABLE` 做 1 次退避重试，**绝不换供应商**；4xx/配置错误不重试。
- 审计：`ExtractionAuditEvent`（`extract/start`、`model/attempt|completed|failed`、`extract/committed|rejected|invalid-output|...`、`watermark/...`），每次模型调用含实际 `providerId/modelId/usage/finishReason/reasoningSeparated`；可通过 `onAudit` 写 `repo.audit`。
- 不创建隐藏 Agent/Session、不向原 Session 写任何内容（只 `session.append` 之外的全是 BOOP 自己的账本/水位）。

## 3. 真实模型路由配置（脱敏，测试 profile）

```yaml
- id: session-persistence-jsonl   # 仅测试 profile：以便按原文读取 durable 日志
  config:
    root: '<DSH_HOME>/sessions'
    compression: none
- id: session-title-llm           # 关掉标题 LLM，省一次模型调用
  disabled: true
- id: llm-pi-ai                   # 仅为宿主 Agent 生成 fixture 会话（抽取走 BOOP 自己的 client）
  config:
    providers:
      qwen-local:
        api: openai-completions
        baseURL: http://172.26.0.49:8000/v1
        apiKeyEnv: BOOP_QWEN_KEY          # 占位 env，无真实密钥
        models: [{ id: qwen3.8-27b, name: Qwen 3.8 27B, contextWindow: 196608 }]
- id: agent-default-model
  config: { provider: qwen-local, model: qwen3.8-27b }
```

BOOP 抽取侧不经过宿主 Agent 路由：直接 `createQwenClient({providerId:'qwen-local', modelId:'qwen3.8-27b', credentialRef:'none', baseUrl:'http://172.26.0.49:8000/v1', contextWindowTokens:196608, ...})`。

## 4. 真实运行实测（最终运行，session `session-69dccca7…`）

fixture：真实宿主 `session/create` + `session/prompt`（1 次真实模型 turn，回复 `OK`），durable log head seq **17**，用户消息 seq **8**，assistant seq **15**。

| 断言 | 实测值 |
|---|---|
| 抽取状态 | `committed` |
| 模型调用 | 1 次；provider=`qwen-local`，model=`qwen3.8-27b`；`finish=stop`；usage prompt=497 / completion=237；elapsed **3827ms**（客户端整体 3979ms） |
| 窗口 | fromSeq=-1 → toSeq=17（= durable head，未越界） |
| 事实 | 3 条：`decision`×2（“本阶段不部署生产环境”“下周五前完成 E03-02 验收”）、`open_item`×1（“当前唯一阻塞是共享 GPU 排队”）；其中 open_item 为 `active/user_confirmed`，两条 decision 为 `disputed/inference`（见 §6 风险 1） |
| 证据地址 | 3 条 `fact_evidence`：`sessionId` 正确、`seq=8`（真实 `user/message`）、`source_hash=<generation>#8`；全部落在窗口且是真实语义事件 |
| 快照 | version 1；coverage `...@4:1792266794177` → `throughSeq=17`；body 含事实文本 |
| 水位 | cursor `throughSeq=17`、`state=dirty`；`result.toSeq=17 ≤ head 17` |
| 用户 Session | JSONL SHA-256 前后一致；仍只有 1 个 Session 文件（无隐藏 Session） |
| 第二次运行 | `no-op`，0 模型调用，version/事实数不变 |
| 同事实重复提议 | `committed`，事实行数不变（stable factId 去重），快照产生新版本（可追溯，非重复事实） |
| 空输出失败 | `invalid-output/EMPTY_OUTPUT`，0 事实、snapshot 为空、水位恢复 -1 |

4 次连续真实运行均为 5/5 PASS；抽取调用耗时 3.9–4.7s（关闭思考）。对照：首轮未关闭思考时 15.2s / 23.3s、facts 4–5 条（提示词 v1 未要求 authority/kind 指引 → 全部落 `inference`+同 kind）。

## 5. 复现命令

```powershell
$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
$env:BOOP_QWEN_MODEL="qwen3.8-27b"
$env:BOOP_QWEN_KEY="boop-local-placeholder-not-a-secret"      # 宿主侧占位；BOOP 客户端用 none
$env:BOOP_EVIDENCE_DIR="docs/development/evidence/e03-02"     # 可选：写出本目录 JSON

node --test --test-force-exit tests/unit/e03-02-extractor.test.mjs        # 25/25
node --test --test-force-exit tests/host/e03-02-extraction-real.test.mjs  # 5/5（2 次真实调用）
node --test --test-force-exit tests/unit/*.mjs                            # 197/197 无回归
node build.mjs
```

无 env 时：真实测试 5 个全部 **SKIP**（原因写明，绝不 fake PASS）。

## 6. 发现的问题 / 风险（如实记录）

1. **committer 的 disputed 判定过宽（不在本任务写范围，`committer.ts` 只调用）**：`MemoryCommitter` 对「同 kind 且 text 不同」的有效事实一律标 `disputed`。真实一次抽取提出 2 条不同内容的 `decision`（不部署 / 截止日期）→ 两条都变成 `disputed`。它们并非互相矛盾。建议 commit 层 owner 收紧判定（仅真正不可同时成立或模型显式 `op:'conflict'` 时才 disputed），本任务未改动 committer。
2. **committer 的 coverage generation 占位**：快照 coverage key 为 `<sessionId>#current`（`currentGenerationOf` 在无历史快照时返回 `'current'`），而非真实 `sourceGeneration`；这会让「世代变化」在快照覆盖上不可见（水位 cursor 本身带真实 generation，不受影响）。建议 commit 层 owner 修。
3. **authority 完全依赖模型输出**：缺省/非法一律降级为最弱 `inference`（安全但降低保真度）。提示词已显式要求 `authority` 并把其设为 schema required；真实服务仍可能对部分条目不遵守（vLLM structured output 未完全强制 optional 语义），建议后续用金标集回归 authority 映射。
4. **抽取延迟受共享 GPU 影响**：关闭思考后 3.9–4.7s，远低于 45s 软超时；若部署保持思考开启，实测 15–23s，仍低于 45s 但余量变小。软超时是硬上限且不推进水位，不会写脏数据。
5. **测试 profile 把 Session 持久化改成 `compression: none`**：仅为把 durable 日志按原文读回作证据（生产为 zstd，不受影响）。该配置只存在于 `.work/test-runs/**` 的隔离 profile。
6. **账本 id 源需进程内全局唯一**：测试里两次打开真实账本时若用「每实例从 1 计数」的 id 工厂会撞 `fact_evidence.id`（测试夹具问题，非产品缺陷）；测试改为 `randomUUID`。真实 Host 的 id 工厂本身唯一。

## 7. 未覆盖 / NOT_RUN

1. **Host 内调度接线**：抽取 job 目前**未**挂到 DSH Host 的常驻调度/端点（profile 未挂载）。本测试在宿主停止后，进程内以宿主自己的 durable 产物（真实 SQLite 账本 + 真实 Session JSONL）驱动同一模块；真正「Host 进程内定时/触发抽取 + 取消/暂停」属 E05-01 调度接线 → **NOT_RUN**。
2. **连续格式失败的跨进程持久化**：格式失败计数在抽取器实例内（批次级）。进程重启后重新计数；冻结规则只要求「停止该批次并保留水位」，未要求跨重启持久化 → 如实标注。
3. **真实并发压测**：单并发许可在单元测试（确定性假时钟）中证明串行；真实服务侧未做并发/抢占压测（共享 GPU 上 BOOP 只负责自身调用，不声称控制服务端）。
4. **UI 侧的「记忆中/已整理」展示**：不属本任务（E04 客户端）。
5. **导入/纠错/遗忘的执行接线**：属 E03-03，本任务只做抽取→提交。

## 8. 建议 STATUS 措辞（供 Lead，不直接改 STATUS.md）

> **E03-02 模型侧记忆抽取：PASS（真实 Qwen）。** 新增 `src/host/model/permits.ts`（BOOP 自管模型调用单并发许可 + 45s 软超时 + 取消 + 退避，E05-01 复用）与 `src/host/memory/extractor.ts`（一次调用受限抽取：~12k 输入估算 cap / 2k–4k 输出 / json_schema 约束 / reasoning 分离 / 候选必须引用窗口内真实 seq / 交既有 MemoryCommitter 提交）。真实宿主 Session（真实 Agent turn 产出 durable 证据）→ 真实 `qwen3.8-27b` 抽取一次（3.8–4.7s，1 次调用）→ 3 条事实提交、证据 seq=8 真实、coverage throughSeq=17=durable head、水位 17、Session 零写入；第二次运行 no-op 零模型调用、同事实重复提议不新增事实行；空输出失败 0 提交且水位回滚。冻结失败策略（截断/空/思考混入/JSON 失败不提交；连续 2 次停批；超时/取消不推进水位；不换供应商；每次调用审计 provider/model）全部单测覆盖。测试：单元 25/25（全部单元 197/197）、真实宿主 5/5 ×4 连续、E03-01 in-host 7/7、`node build.mjs` 通过；证据 `docs/development/evidence/e03-02/`。存续风险：committer 同 kind 不同文本一律 disputed（真实运行 2 条 decision 被标 disputed）与 coverage generation 占位 —— 属 commit 层既有行为，留待 commit 层 owner 收紧；Host 内调度接线（E05-01）仍 NOT_RUN。
