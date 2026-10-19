# G06 收口报告 · E03-03/E03-04 主机路径 E2E + committer 冲突语义收紧

> 任务：`task-18`（G06 收口） · 实现：`src/host/memory/committer.ts`、`src/host/memory/extractor.ts`、`src/shared/types.ts`、
> `tests/unit/e03-02-{memory,extractor}.test.mjs`、`tests/host/e03-03-lifecycle-in-host.test.mjs`、
> `tests/host/e03-04-retrieval-in-host.test.mjs`
> 运行时间：2026-10-18 04:21–04:22（UTC+8） · 未提交（Lead 统一提交）
> 结论：**建议 G06 判 PASS**（真实 rc.2.1 宿主 + 真实 SQLite 账本 + 真实 Session 日志 + 真实 Qwen opt-in 闭环），遗留 NOT_RUN 见 §8。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| committer 冲突语义收紧 | **DONE**：只有 `(kind, subjectKey)` 可比较且取值不同才 disputed；不同 subject 同类事实各自 active；缺 subjectKey 保留保守规则；**冲突不再改写 kind/authority** |
| 冲突语义真实数据验证 | 真实 Qwen 抽取 3/3 候选带 subjectKey → **`disputed = []`**（E03-02 旧证据中同样 2 条 decision 曾被误标 disputed） |
| E03-03 主机路径 E2E | **6/6 PASS**：三种初始化 / 导入预览→落盘 / 执行文件未执行（canary+sentinel+端口拒绝）/ 纠错来源与影响 / 遗忘规则且原 Session 历史逐字节不变 |
| E03-04 主机路径 E2E | **8/8 PASS**（含真实 Qwen opt-in）：分层排序可复现 / 命中带真实证据地址 / 世代变化标 stale / 失效版本与被遗忘事实不进入上下文 / FTS 缺失降级如实 / 真实抽取→提交→检索闭环 1 次短调用 |
| 单元回归 | `node --test tests/unit/*.test.mjs` → **262/262 PASS**（本次新增 9 条语义锁定） |
| 宿主回归（本次改动后） | E03-02 真实抽取 **5/5 PASS**（真实 Qwen，2 次调用）；`node build.mjs` 通过 |
| 写模式 | 仍 OFF（本次不改 `gates.ts`；G06 证据串由 Lead/门账本 owner 更新） |

证据原始 JSON（本目录，均由测试真实运行写出）：

- [lifecycle-in-host-2026-10-18T04-22-16-020Z.json](lifecycle-in-host-2026-10-18T04-22-16-020Z.json) — E03-03 主机路径
- [retrieval-in-host-2026-10-18T04-21-49-742Z.json](retrieval-in-host-2026-10-18T04-21-49-742Z.json) — E03-04 主机路径 + 真实 Qwen 闭环

## 1. 环境（隔离，绝不触碰用户 `~/.dsh`）

| 项 | 值 |
|---|---|
| 宿主 | DSH Desktop **`0.2.1-rc.2`**，payload `.work/test-host/payload-0.2.1/dsh`，`dshBuildCommit = 332895e0…` |
| Node / OS | v24.18.0 · win32 x64 |
| DSH_HOME | 每次新建 `.work/test-runs/g06-e03-03-<epoch>/dsh-home`、`.work/test-runs/g06-e03-04-<epoch>/dsh-home`（独立 profile） |
| BOOP 账本 | `<DSH_HOME>/boop/boop.sqlite`（真实 SQLite，真实 `BoopDatabase`/`BoopRepository`） |
| Session 日志 | `<DSH_HOME>/sessions/**/session.v4.jsonl`（隔离 profile 显式 `compression: none`，只为把 durable 日志按原文取证；生产配置未改） |
| 模型 | 夹具 profile **无模型凭证**：fixture 轮次以真实的 `turn/end` error 结束（不冒充模型回答）；E03-04 opt-in 的模型调用是 BOOP 自己的 `qwen3.8-27b`（vLLM `http://172.26.0.49:8000/v1`，无凭证） |

## 2. committer 冲突语义收紧（核心改动）

### 2.1 规则（冻结依据 03§11“冲突事实同时保留，避免 last-write-wins”、03§13、02§12 B）

- 两条有效事实只有在**可证明是同一比较对象**时才可能冲突：`kind` 相同 **且** 两侧都有**相同的非空 `subjectKey`**，而 `text` 不同；
- **同一 kind、不同 subjectKey = 独立事实**：各自 `active`，不标 disputed（这正是真实抽取里两条不同 decision 被误标的根因：`kind` 相同 ≠ 相互矛盾）；
- **任一侧缺 `subjectKey`（旧行、模型省略、store 无法暴露）→ 保留原保守规则**：同 kind 且 text 不同 ⇒ disputed。理由写进代码注释：text 不等既不能证明兼容也不能证明冲突，静默让两者 active 有被读成 last-write-wins 的风险；**宁可保守，不静默覆盖**；
- **冲突只改 status，不改内容/种类/权威**：`disputed` 是状态，事实保留自己的 text、`kind`、`authority`（修复了旧实现把 kind 改写为 `'disputed'`、authority 降级为 `inference` 的问题），只产生可追溯的 `fact_version`；
- 只评估**本提案写入的事实**参与的 pair：新提交不会追溯性把更早的独立事实改成 disputed；
- 显式 `op: 'conflict'` / `status: 'disputed'` 的变更计入 `disputed` 报告。

### 2.2 提取侧（`extractor.ts`）

- 候选 schema 增加**可选** `subjectKey: string`；系统提示要求“同一对象的不同取值才是冲突，不同对象必须不同 subjectKey，不确定就省略，不要编造”；
- `admitCandidates` 用 `normalizeSubjectKey`：trim、≤120 字符、拒绝控制字符；**不可用的 key 只丢弃 key，不拒事实**（回退保守规则），绝不从 text 编造 key；
- `ExtractionResult` 新增 `candidatesWithSubjectKey`（模型合规度的如实计数，用于证据，不冒充正确性）。

### 2.3 语义锁定（单元，9 条新增）

`tests/unit/e03-02-memory.test.mjs`（15/15）：

1. 两条不同 subject 的 decision 并存 active、`disputed = []`；
2. 同一 subject 两个取值 → 双方 disputed，**双方 text/kind/authority 原样保留**（弱权威不被降级、强权威不被覆盖）；
3. 缺 subjectKey → 保守 disputed（并保留旧事实文本，不静默覆盖）；
4. store 能暴露 subjectKey 时，后续提案精确比较：只 dispute 同 subject，另一 subject 保持 active（`MemoryStore.facts().subjectKey` 前向兼容 seam）；
5. 显式 `op:'conflict'` → 报告 disputed、kind 不被改写。

`tests/unit/e03-02-extractor.test.mjs`（29/29）：schema/提示含 subjectKey；不可用 key 被丢弃且候选仍被接收（`candidatesWithSubjectKey` 只计可用 key）；fake 模型两条不同 subject decision → 提交后均 active；同一 subject 两条 → 均 disputed 且不降 authority。

### 2.4 真实数据验证（真实 Qwen）

E03-04 opt-in 真实运行：3 条候选 **3/3 带 subjectKey**，提交后 **3 条全部 `active`、`disputed = []`**。对比 E03-02 旧证据（同一类抽取内容，2 条 decision 被标 `disputed/inference`）——G06 记录的实际缺陷已被真实模型输出验证修复路径有效。如实说明：模型是否稳定给出可用 subjectKey 由提示+服务决定，缺 key 时仍按保守规则处理（见 §8.4）。

## 3. E03-03 主机路径 E2E（6/6 PASS，无模型调用）

夹具：3 个**真实 Session**（`session/create` + `session/prompt`，真实 Host 写出 plain-JSONL durable 日志，human `user/message` seq = 8，head = 17）；真实插件 `boop/observeSources` 发现 3 个 source（generation 与日志 header 一致，`throughSeq = -1`）；随后停 Host，用真实账本驱动 `MemoryLifecycle`。

| # | 断言 | 实测 |
|---|---|---|
| 1 | 宿主无装配告警；3 个真实 Session 落盘；Host 观察面发现并登记水位 | 3/3，generation `session-…@4:<createdAt>:` 与 header 完全一致，账本 scope = Host scope |
| 2 | **学习已有会话**：真实 `memory_job` 行、对象总数、逐个失败对象、暂停/续跑 | job kind=`learn_history` status `pending→done`，total=3，processed=3；**真实删除 1 个 Session 日志**后失败对象被单列（`session artifact unreadable`）；进度 “已整理 3/3 个会话”；第二个 job 暂停后 durable 状态 `pending`（冻结 schema 无 paused）+ 审计 `state:"paused"`，续跑 done，已提交进度不回滚 |
| 3 | **从现在开始**：只落水位、不导入历史 | 3 条真实 `source_cursor` 的 `through_seq = 17`（真实 durable head）、state fresh；fact/snapshot 数量不变；审计 `memory/init-from-now` 存在 |
| 4 | **导入**：先预览后落盘、不支持格式拒绝、执行文件未执行、不恢复旧任务 | 预览 added=3/needsReview=3/**写前事实行数不变**、无 imported 审计；`powershell-script` → `supported:false, added:0`；落盘 3 行 `import_unverified/active`，无 task/approval 新建；**canary 连接 0、sentinel 不存在、payload 字节未变**，关闭监听后直连端口 `ECONNREFUSED`；Session 文件数不变（无隐藏 Agent/Session） |
| 5 | **纠错**：带真实来源、受影响范围、可追溯、不宣称追回 | 来源 seq=8（真实 human message）、authority=`user_confirmed`、version 1→2、fact_version 2 行（旧文本仍可寻址）、新增 evidence 行且 source_hash=`<真实 generation>#8`；受影响范围 = scope/session/factIds；文案 “已执行的任务不会被追回” |
| 6 | **遗忘**：写规则、原 Session 历史仍可读、不删除 | 真实 `forget_rule` 行（mode/selector/source_fingerprint）、审计 `memory/forgotten`；原 Session 日志 **SHA-256 前后一致**、18 条事件全部可读、human 原文仍可读、Session 文件数不变、fact 行未被级联删除 |

## 4. E03-04 主机路径 E2E（8/8 PASS，含真实 opt-in）

夹具同上（3 个真实 Session）。事实通过**真实 `MemoryCommitter`** 写入真实账本，证据地址 = 真实 human `user/message` seq（8），coverage = 真实 generation + durable head。

| # | 断言 | 实测 |
|---|---|---|
| 1 | 真实 Session / 观察面 / 账本 scope 一致 | 3/3，generation 一致，throughSeq=-1 |
| 2 | 通过 committer 种入事实：证据地址、真实世代、coverage 如实 | 3 条 owner 事实（decision×2 + open_item）全部 active、`disputed=[]`；`fact_evidence` 5 行，`session_id`/`seq=8`/`source_hash=<generation>#8` 与 durable 事件对齐；`memory_snapshot.coverage[<sessionId>#<generation>].throughSeq=17` |
| 3 | 被取代的旧取值退休但仍可寻址 | 当前行 text=新值/status active；`fact_version` ≥2 且含旧文本；旧版本 evidence 保留 |
| 4 | 同一 subject 在真实账本上 disputed；不同 subject 不误标；缺 key 保守 | 同 key claim ×2 → 双方 disputed、text/kind/authority 原样保留、snapshot body 含 `[disputed]`；首个提案不同 subject 全部 active；无 key 的同 kind 新事实 → 保守 disputed（可解释取舍） |
| 5 | 分层上下文可复现、命中带真实证据地址 | owner→workspace→global 三层出现；查询命中 owner 事实排第一（score=1）；两次 assemble 顺序完全一致；每条账本命中的 evidence 与 `fact_evidence` 行一致且 seq 在 durable 日志中真实存在；global 层为 preset 安全规则（无账本证据，按 02§07 设计） |
| 6 | 来源世代变化 → stale，不静默刷新 | 真实 generation 映射 → 全部 current；把 owner source 代数改为 `…@999:0:` → owner 5 条 hit 全 stale、其他 source 保持 current、text 不变 |
| 7 | 失效版本/被遗忘事实不进入当前上下文 | 旧取值不作为当前 hit；`forget_rule` 选择器 → 调用方排除集 → 被遗忘事实从 hits/body 消失；**对照**（不排除时仍出现）证明是排除生效；原 Session SHA 不变、fact 行仍在（忘记停止使用，不删除历史） |
| 8 | **真实 Qwen 抽取→提交→检索闭环**（opt-in，1 次调用） | `status=committed`，`qwen-local/qwen3.8-27b`，3914ms（prompt 559 / completion 248，finish=stop），窗口 (-1..17]，3 条事实全部 active、`disputed=[]`、`candidatesWithSubjectKey=3/3`；3 条 evidence 指向真实 human seq 8 与真实 generation；coverage=toSeq=17；水位只推进到处理边界；Session JSONL SHA 前后一致（零写入）；检索返回带真实证据地址的命中 |

## 5. 复现命令

```powershell
# 1) 构建（esbuild-wasm）
node build.mjs

# 2) 离线单元（含本次 9 条冲突语义锁定）
node --test tests/unit/*.test.mjs                                   # 262/262

# 3) 主机路径 E2E（宿主测试必须串行）
node --test --test-force-exit --test-concurrency=1 tests/host/e03-03-lifecycle-in-host.test.mjs tests/host/e03-04-retrieval-in-host.test.mjs
# -> E03-03 6/6 + E03-04 7/7，真实模型用例 SKIP（无 env）

# 4) 真实 Qwen opt-in（1 次短调用；无 env 时全部 SKIP，不伪造 PASS）
$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
$env:BOOP_QWEN_MODEL="qwen3.8-27b"
$env:BOOP_QWEN_KEY="boop-local-placeholder-not-a-secret"   # 宿主侧占位；BOOP 客户端用 none
$env:BOOP_EVIDENCE_DIR="docs/development/evidence/e03-06"
node --test --test-force-exit tests/host/e03-04-retrieval-in-host.test.mjs   # 8/8（含真实闭环）

# 5) 宿主回归（本次改动后；真实模型 2 次调用，不写 e03-02 证据目录）
node --test --test-force-exit tests/host/e03-02-extraction-real.test.mjs    # 5/5
```

最终一次串行运行（含 opt-in）：`tests 14 / pass 14 / fail 0`，`duration ~23.5s`。

## 6. 冲突语义取舍（明确写出，便于审查）

1. **减少 false-disputed 的代价**是“不同 subjectKey 时允许同类事实并存”。我们只在新候选**明确给出不同 subject 键**时才这样做；键缺失即回退保守规则。没有为了让 disputed 变少而把“文本不同”直接判为可兼容。
2. **不静默覆盖**：冲突不写 text、不降 authority、不删行；冲突双方都留在账本并有各自证据。
3. **不追溯判定**：只评估本提案涉及的事实，避免一次新提交把历史独立事实集体改成 disputed。
4. subjectKey 是**比较提示**而非授权/真值：不参与权限、不改变 authority。

## 7. 变更文件（均在任务写范围内）

- `src/host/memory/committer.ts`：冲突规则、`normalizeSubjectKey`、status-only 冲突标记、`MemoryStore.subjectKey` 可选 seam、快照 body 可显示 key；
- `src/host/memory/extractor.ts`：候选 schema/提示增加可选 `subjectKey`；admission 规范化与 `candidatesWithSubjectKey` 计数；
- `src/shared/types.ts`：`MemoryChange.subjectKey?`（含语义注释）；
- `tests/unit/e03-02-memory.test.mjs`（+5 条）、`tests/unit/e03-02-extractor.test.mjs`（+4 条）；
- 新增 `tests/host/e03-03-lifecycle-in-host.test.mjs`、`tests/host/e03-04-retrieval-in-host.test.mjs`；
- 本目录证据 JSON（测试真实运行写出；测试名以 `G06/E03-03`、`G06/E03-04` 前缀可检索）。

未触碰：`src/client/**`、`gates.ts`、patcher、permits、observe、scheduler/control/tasks/verify/dispatch、`api-service.ts`、`cordis.patch.yml`、`build.mjs`、`docs/STATUS.md`；未 git commit。

## 8. 遗留 NOT_RUN / 风险（如实记录）

1. **E03-03 执行面未接线到 Host 端点**：`/boop/memory/initialize|import|correct|forget` 尚无 Host 绑定，本次 E2E 在真实宿主产物（真实 Session 日志 + 真实 SQLite 账本）上以 test-side `InitStore` 适配器驱动 `MemoryLifecycle`；API/RPC 级 E2E 仍 **NOT_RUN**。
2. **冻结 `memory_job` schema 缺列**：无 `processed/total/failures/paused` 列，也无 fact 的 `subject_key` 列。本次把作业行落 `memory_job`、进度/失败/暂停态落 `audit_event`（真实表），跨提案 subjectKey 比较因此回退保守规则；要获得跨提案精确比较需 schema/migration + repository 适配（**未做，超出本任务写范围**）。
3. **遗忘只写规则、不 tombstone**：`MemoryLifecycle.forget` 目前只写 `forget_rule` + 审计，未把 fact 置 `tombstoned`；03§13 的 “tombstone + forget_rule” 只完成一半。检索排除由调用方按规则构造 `excludedFactIds`（本次已按 03§14 “过滤先于检索” 验证契约）。需 E03-03 执行面补 tombstone（**NOT_RUN**）。
4. **subjectKey 稳定性依赖模型**：真实 Qwen 本次 3/3 合规，但这是提示+schema 行为，不是保证；缺 key 时按保守规则处理（会重新出现部分 disputed）。authority 仍完全依赖模型输出（E03-02 既有残留）。
5. **E03-04 生产 query planner / FTS 索引未实现**：`fact_fts` DDL 存在但无触发器/写入/重建/绑定，`RetrievalIndex` 无生产实现；本次主机路径只证明“**缺失 FTS 时降级如实**（`degraded=true`，精确子串回退）”，有索引排序路径仍为单元级。03§14 “mandatory constraints 不参与 Top-K 竞争” 无专门装配规则；global 层按 02§07 取 preset 安全规则（无账本证据）。
6. **supersede 语义**：committer 的 supersede 更新**同一个 fact id**（旧值保留在 `fact_version`，当前行是新值 active）；因此“`status=superseded` 行”没有真实写入路径，`ContextAssembler` 的 superseded 过滤由单元测试验证，主机路径只能验证“旧取值不进入当前上下文、旧版本可寻址”（本次断言按此口径）。
7. **导入解析/schema 未实现**：没有文件解析、UTF-8/大小/JSON 版本校验；E2E 直接给有界 entries（预览→落盘的事务边界已验证）。“执行文件未执行”是 canary 监听 + sentinel + 端口拒绝的应用层证明，**不是** OS 沙箱保证；无“不读取任意路径”的宿主路径级证明（模块接口本身不接收路径）。
8. **E03-03 夹具会话的模型轮次是 error 结束**（profile 无凭证）：不冒充模型回答；E03-04 opt-in 的真实模型调用是 BOOP 自身抽取，与宿主 Agent 轮次无关。

## 9. 给 Lead 的建议（不直接改 STATUS / gates.ts）

1. **G06 建议判 PASS**：E03-03/E03-04 由“以单元为主”升级为真实 rc.2.1 宿主路径 E2E；committer 冲突语义收紧并由真实 Qwen 抽取验证（3/3 subjectKey、0 disputed）；单元/宿主/构建均无回归。
2. `src/host/gates.ts` 中 G06 的 evidence 串仍写着 “E03-03/E03-04 host-path E2E are mostly unit-level and the committer still flags same-kind different-text facts as disputed → gate not PASS”，**已过期**，请门账本 owner 按本报告更新（本次未改 `gates.ts`）。
3. `docs/development/evidence/e03-02/` 中既有真实抽取证据的 facts 状态（2 条 disputed/inference）已被本次语义改动取代：同一测试 `tests/host/e03-02-extraction-real.test.mjs` 本次复跑 **5/5 PASS**，建议 E03-02 owner 择机刷新其证据 JSON/report（不在本任务写范围）。
4. 若要补齐 §8.2/§8.3，需要 schema/migration + repository 适配（`memory_job` 进度列、`fact.subject_key`、tombstone 写入），建议单列任务，避免与本次最小改动混在一起。
