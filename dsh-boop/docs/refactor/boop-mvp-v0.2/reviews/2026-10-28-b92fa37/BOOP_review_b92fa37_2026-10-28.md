# BOOP v0.2 三轮对抗性代码审查报告

**结论：Request changes。当前分支不应作为“已完成的 MVP”合并到 main。**

问题已超过视觉打磨：真实工具返回会被宿主拒绝，自动委派和结果回传缺少生产驱动，原生适配器没有真实执行事实。修好这些入口之后，仍有授权、撤权、停止、重复投递和约束继承问题必须一并修复。前端虽然有独立页面，但选目标、继续处理、自动更新、查看结果四个核心动作尚未闭环。

本轮给出 **25 项发现**。其中 **21 个独立故障场景已通过定向探针复现**，另外 4 项以完整静态调用链确认（R02、R20、R23、R24）。“探针通过”表示成功复现错误，不表示产品通过验收。这里包含功能、可靠性、隐私边界及交互缺陷，不能把 25 项一概称为安全漏洞。

## 1. 范围、版本与方法

| 项目 | 固定范围 |
| --- | --- |
| 仓库 | `wanyexin1998/dsh-plugin` |
| 分支 | `cursor/boop-mvp-v0.2-f3d6` |
| 审查提交 | `b92fa37ed67182916e133e5e60b4b970a858d5e8` |
| main 基线 | `6f9c046681e58a1304704baf165dce5de2a49f4f` |
| 日期 | 2026-10-28 |
| 差异 | 62 个文件，新增 5,137 行、删除 348 行，含 7 张提交内截图 |
| 环境 | Linux、Node v24.22.1、pnpm 11.25.0、冻结锁文件安装的正式 DSH 0.2.1-rc.2 依赖 |
| 操作边界 | 只读审查产品代码；本地生成测试/报告；没有修改产品源码、提交、推送或发 GitHub 评论 |

审查结束前重新读取远端分支，仍指向上述 head。本报告只对该固定提交负责；后续修复应按新 SHA 复审。审查范围以 diff 为核心，并追踪必要的旧实现、宿主官方包和调用上下游，不宣称审查了仓库全部历史功能。

没有找到适用于根目录或 dsh-boop 的 AGENTS.md/SECURITY.md。`codex-security:security-diff-scan` 所需预检资源/组件不可用，因此按手工差异审查、正式接口核对和定向验证完成本次工作，**没有宣称专用安全扫描流程成功执行**。

### 三轮分别做了什么

| 轮次 | 方法 | 目的与产物 |
| --- | --- | --- |
| 第一轮 | 前端、持久化/身份、运行时三条独立审读；主审核对配置、工具、文档及截图 | 找出具体调用链断点，形成三个 round1 报告；覆盖 62 个变更文件 |
| 第二轮 | 真实 SQLite/v1 迁移、真实注册工具、正式宿主 parser/inbox/input 方法、错误与时序注入 | 排除仅凭命名或 mock 推断的问题，得到 21 个独立复现场景；跑构建、类型、292 项单元及客户端测试 |
| 第三轮 | 交换问题交叉反证，检查宿主是否提供补偿、前置条件是否真实、影响是否夸大 | 强化旧身份/真实租约接管/引用读取证据；把投递复现修正为“已消费后重投”；把执行缺陷明确标为接线后的潜伏问题 |

### 证据和优先级怎么读

- **当前可达**：已接入的生产入口或数据库升级路径存在错误，不需要假设未来功能上线。
- **服务层潜伏缺陷**：真实产品类或正式边界方法已复现错误，但完整用户路径被其他未完成部分阻断。必须在接通自动执行前修复，不能说真实用户已经遭遇该后果。
- **静态确认**：全调用链存在明确缺失；未把它包装为真实浏览器实测。
- **P1**：阻断核心闭环，或可能违反明确的人类约束、身份/读取边界、停止与去重保证；应在合并前处理。
- **P2**：影响正常使用、状态可信度或可访问性；需在本版交付前落实，不等于可忽略。

## 2. 发现总览

| ID | 级别 | 问题 | 主要证据 |
| --- | --- | --- | --- |
| R01 | P1 | 真实工具运行时拒绝新版 catalog/context 返回值 | 正式运行时方法复现 |
| R02 | P1 | 生产代码没有调用委派驱动 tick() 和结果发布 deliver() | 完整生产调用链审读 |
| R03 | P1 | 原生适配器仍用占位事实，无法可靠读取上下文和跟踪执行 | 实际适配器＋正式契约对照复现 |
| R04 | P1 | v1 升级后产生两个互相矛盾的 BOOP 主会话身份 | 真实 v1 数据库迁移复现＋独立加强复现 |
| R05 | P1 | 实际 HomeService 装配漏接写入租约隔离检查 | 实际 apply 装配＋真实接管复现 |
| R06 | P1 | 新读取路径忽略用户原有排除和忘记规则 | 真实规则/游标＋生产 policy 复现 |
| R07 | P1 | 被拒绝引用的 label 可被原生解析器再次解释成可读取 URI | 正式原生 prepare/readSurface 边界复现 |
| R08 | P2 | 拒绝引用时插入不合法消息，正式快照读取会拒绝 | 正式原生 append 接受/snapshot 拒绝的对照复现 |
| R09 | P1 | 候选点击使用错误的输入 API，原生引用插入会被拒绝 | 实际 BOOP bundle＋正式原生方法复现 |
| R10 | P1 | “继续处理”覆盖用户尚未发送的草稿和引用 | 实际 bundle 回调＋正式 setDraft 契约复现 |
| R11 | P1 | 任务与结果没有自动刷新，重连和打开工作抽屉也不刷新 | 实际 HomeController 复现 |
| R12 | P1 | 把普通 tool callId 当成人类授权，且不校验 BOOP 主身份 | 实际注册工具＋真实数据库复现 |
| R13 | P1 | 旧上下文被新水位重新盖章，漏掉目标中新的人类限制 | 实际 DelegationService 复现 |
| R14 | P1 | 排队后撤销来源权限仍可派发，副作用前缺少重新核验 | 真实策略更新＋控制器/准入代码复现 |
| R15 | P1 | 修订后的停止只停新队列，旧执行仍在运行却返回已停止 | 实际控制器＋精确归属 port 复现 |
| R16 | P1 | 结果已被原生消费后丢响应，未知投递会再次发送 | 正式 ReactLoopInbox 方法＋故障注入复现 |
| R17 | P1 | 混合人类/BOOP 消息批次可重复准入同一命令 | 真实 runtimeGatePortOf＋SQLite 准入记录复现 |
| R18 | P2 | 仅授权工作区时，读取允许但委派被拒绝 | 实际 selected-workspace policy 复现 |
| R19 | P2 | 新的用户消息不会使旧候选失效 | 实际候选解析/控制器复现 |
| R20 | P2 | “查看详情”没有详情，产物和验证证据无法评估 | 完整前端调用链审读 |
| R21 | P2 | 停止/确认失败被吞掉，刷新失败会清空最后已知事实 | 实际 HomeController 错误路径复现 |
| R22 | P2 | 主页 ready 后仍显示“数据域不可用” | 实际 bundle/store 复现＋提交截图一致 |
| R23 | P2 | 抽屉关闭恢复焦点没有实际绑定，窄屏键盘路径不完整 | 静态组件/事件路径审读 |
| R24 | P2 | 曾打开 BOOP 的标记不清除，刷新普通 DSH 会话会抢回 BOOP | 静态写入/恢复全路径审读 |
| R25 | P1 | 一次小修订会因省略可选字段而清空既有约束 | 真实数据库/控制器双对照复现；语义判断已注明 |

## 3. 逐项发现与修复验收

### R01 · P1 · 真实工具运行时拒绝新版 catalog/context 返回值

**代码位置：** [dsh-boop/src/host/tools.ts:77–93](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/tools.ts#L77-L93)；[dsh-boop/src/host/tools.ts:103–125](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/tools.ts#L103-L125)；[dsh-boop/src/host/tools.ts:243–277](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/tools.ts#L243-L277)。

**触发与可达性：** 当前生产接口可达；不依赖执行循环接线。

**实际问题：** 工具已经返回 schemaVersion/kind/ok/data 的 v2 envelope，output.schema 却仍是禁止额外属性的旧结构。正式 ToolRuntime 在 render 之前校验返回值，新增字段全部被拒绝；修改 render 为 JSON.stringify 不能绕开校验。

**证据：** `runtime-probes.mjs` 的 R-SCHEMA 使用实际注册的工具定义、正式 rc.2 ToolRuntime.createSuccessResult。catalog 和 context 均产生四个 undeclared-property 违规。

**用户后果与边界：** 模型拿不到正常候选和下一步委派所需 context token，主流程在真实工具边界就断了。

**修复方向：** 给成功/失败 envelope 注册与真实返回值一致的 schema；若保留旧模式，明确区分兼容分支。

**验收条件：** 使用正式 ToolRuntime 跑 catalog 各模式与 context 的成功、拒绝、无数据返回，全部通过 schema 校验且最终文本能被 readWorkChoice/模型消费。不能只测 execute() 返回对象。

原始审查编号：`runtime R1 / R-SCHEMA`。

### R02 · P1 · 生产代码没有调用委派驱动 tick() 和结果发布 deliver()

**代码位置：** [dsh-boop/src/host/index.ts:148–169](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/index.ts#L148-L169)；[dsh-boop/src/host/index.ts:266–291](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/index.ts#L266-L291)；[dsh-boop/src/host/delegation/service.ts:449–475](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L449-L475)；[dsh-boop/src/host/delegation/service.ts:648–681](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L648-L681)。

**触发与可达性：** 当前装配缺失，独立阻断 MVP。

**实际问题：** 启动只构造服务并执行 bootRecover/inheritAccess。prepare 写出 planned action/outbox 后，没有生命周期内的 timer、事件订阅或旧 scheduler 桥接来调用 tick/deliver。测试中手动调用它们不等于生产接线。

**证据：** 逐项搜索全部 src/host 和构建产物并核对调用链；调用仅存在于服务定义和测试。旧 Dispatcher 仅有默认关闭的 PoC 入口，不能推进新 action。

**用户后果与边界：** 即使修好 R01，用户委派也只会排队，不能自动到目标会话执行，也不能自动回传结果。

**修复方向：** 接入有生命周期、可唤醒、可取消的驱动：接收委派/修订，观察活动执行，推进结果 outbox；绑定本进程写租约并在卸载时清理。先修后述边界问题再开启执行。

**验收条件：** 从真实工具入口发起任务，由生产事件/驱动自行到原会话执行、观察终态、回到 BOOP；测试不得手动调用 tick/deliver 来补齐缺失的产品行为。

原始审查编号：`runtime R2`。

### R03 · P1 · 原生适配器仍用占位事实，无法可靠读取上下文和跟踪执行

**代码位置：** [dsh-boop/src/host/home/native-session.ts:124–175](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/native-session.ts#L124-L175)；[dsh-boop/src/host/home/native-session.ts:178–220](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/native-session.ts#L178-L220)。

**触发与可达性：** 读取路径已接线；执行/终态后果受 R02 阻断。

**实际问题：** pendingHuman/pendingMessage/turnTerminal 固定 false，turnId/summary 为 null，ownership 为 unknown，checks/artifacts 为空；visible 永远 false、mainIdle 永远 true。busy、subagent 使用的字段不符合正式 SessionObservation/SessionHeader。listEvents 返回轻量事件索引，surface 是字符串；代码把 event.type 当正文，beforeSeq 也未落实。

**证据：** R-NATIVE 向真实适配器提供正式结构的事件：上下文仅得到 user/message、turn/end 等类型名，终态/归属/结果事实仍为空。另直接核对正式 rc.2 source/header/cursor/events/projections、parentSession/origin 字段。

**用户后果与边界：** BOOP 读不到用户实际要求与限制；接通驱动后，忙碌让路、精确停止、完成判定和结果回传仍没有可靠依据。不能靠在测试 port 内手填这些事实作为完成证明。

**修复方向：** 按正式宿主接口实现 action→消息→turn→终态/产物的关联，读取真正语义正文与有效水位、人工接管/审批/归属事实，并查询真实 pending/历史可见性。

**验收条件：** 直接测试生产适配器：真实忙碌、空闲、人工接管、子会话、主会话、终态及产物；上下文包含原始要求与限制，旧水位不会被误当当前上下文。

原始审查编号：`runtime R3 / R-NATIVE`。

### R04 · P1 · v1 升级后产生两个互相矛盾的 BOOP 主会话身份

**代码位置：** [dsh-boop/src/host/home/service.ts:150–166](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/service.ts#L150-L166)。

**触发与可达性：** 已有非空旧绑定用户升级即可触发。

**实际问题：** binding 只查新 history；迁移没有回填旧 scopes.main_session_id。旧绑定不空时，bind 的条件 UPDATE 更新 0 行，代码仍插入新 UUID history 并返回 ready。

**证据：** PERSIST-1 用基线真实 v1 库建立 boop-main 后执行实际迁移。scopes 仍是旧 ID，history/ensureHome 返回新 ID。第三轮提供真实存在且 preset/cwd 兼容的旧 Session，代码仍不检查它；mainSessionFacts 与 ensureHome 不一致。

**用户后果与边界：** 固定身份和旧聊天继承失效，不同 API 使用不同主会话。没有证明旧聊天被删除，也不能说所有结果必然回旧会话。

**修复方向：** 迁移时验证并复用旧合法绑定，或明确转成历史；以一个事务/CAS 同步权威绑定，UPDATE 0 行必须拒绝或恢复，不能宣称 ready。

**验收条件：** 旧绑定存在、缺失、不兼容、冲突四种升级场景下，scopes/current history/home API 一致，旧聊天和历史保留，不强停旧会话。

原始审查编号：`PERSIST-1`。

### R05 · P1 · 实际 HomeService 装配漏接写入租约隔离检查

**代码位置：** [dsh-boop/src/host/index.ts:154–161](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/index.ts#L154-L161)；[dsh-boop/src/host/home/service.ts:54–67](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/service.ts#L54-L67)。

**触发与可达性：** 旧进程失去租约后仍可到达 ensureHome。

**实际问题：** HomeService 的 fenceOk 默认 true，而生产构造未传 storage.checkWrite。启动曾经可写不能证明稍后仍持有写租约。

**证据：** PERSIST-4 运行实际 apply；第三轮用第二个真实 BoopStorage.start 接管过期租约。旧 checkWrite 已 false，旧 ensureHome 仍发生 1 次 native create 并返回 ready。

**用户后果与边界：** 休眠、阻塞和租约接管后，旧进程仍能创建主会话、争写绑定。存储层本身有 fence 并不能保护没有调用它的路径。

**修复方向：** 生产注入本进程 holder/token 校验，await 返回后、原生副作用前、绑定事务提交前重新检查；已创建但失去租约的情况保存不确定证据并恢复。

**验收条件：** 在入口前及 create/flush 等等待期间接管租约：旧进程不启动后续副作用，不提交 ready；恢复不盲目再创建一份主会话。

原始审查编号：`PERSIST-4`。

### R06 · P1 · 新读取路径忽略用户原有排除和忘记规则

**代码位置：** [dsh-boop/src/host/home/native-session.ts:178–179](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/native-session.ts#L178-L179)。

**触发与可达性：** 默认 inheritAccess 后即可影响旧用户。

**实际问题：** 生产 excluded() 固定 false，hostCanRead() 固定 true；旧 forget_rule 和 excluded source_cursor 没进入新访问判定。新 source_access 默认 all_authorized，不能代表用户撤销了旧限制。

**证据：** PERSIST-2 在真实库保留 exclude_source 规则和 excluded 游标，正常 inheritAccess 后 canRead 仍 allow，正式 native parser 仍会把引用作为读取对象。

**用户后果与边界：** 用户已经排除的来源重新进入新候选/上下文/引用路径。这里证明的是 BOOP 自身规则失效，未证明跨账户宿主 ACL 绕过。

**修复方向：** 统一新旧 policy，保留权威排除/忘记记录，所有目录、上下文、派发及原生引用使用同一判定。

**验收条件：** 用真实旧库和新库分别覆盖 exclude_source/exclude_scope/excluded cursor；被排除项不出候选、不进入正文、引用不触发读取。仅用户明确撤销才恢复。

原始审查编号：`PERSIST-2`。

### R07 · P1 · 被拒绝引用的 label 可被原生解析器再次解释成可读取 URI

**代码位置：** [dsh-boop/src/host/home/reference-guard.ts:68–77](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/reference-guard.ts#L68-L77)。

**触发与可达性：** 需要 deny/selected/unknown 限制策略；当前范围设置 UI 尚未接线。

**实际问题：** guard 把被拒绝 mention 降级成保留 label 的文本。label 内还可以放另一个 dsh-session URI；正式原生 resolver 在后续阶段再次解析，从降级结果中得到被禁止的来源。

**证据：** PERSIST-3 的 deny-all 输入是外层 blocked-outer、label 内 secret-session。加强复现执行正式 prepareDirectMessages/prepare/预算/规范化，仅在最终 readSurface 捕获并终止；确实出现 readSurface(secret-session)。

**用户后果与边界：** BOOP 自己的限制层无法保证“拒绝后不预读取”。R08 的后续格式错误也尚未完整追踪到模型阶段；本轮没有读取真实私密数据，没有证明模型收到或外传内容，也没有跨账户利用结论。

**修复方向：** 降级文本中的隐藏 canonical scheme 也必须不可再解析；以正式原生 parser 做最终不读取的后置校验，保持正常文字和附件。

**验收条件：** bare URI、mention、嵌套 label、转义 label 在 deny-all 下均不触发任何被拒绝 readSurface；允许引用仍正常读取。不能只断言 guard 输出字符串变了。

原始审查编号：`PERSIST-3`。

### R08 · P2 · 拒绝引用时插入不合法消息，正式快照读取会拒绝

**代码位置：** [dsh-boop/src/host/home/reference-guard.ts:84–87](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/reference-guard.ts#L84-L87)。

**触发与可达性：** 存在受限引用时；后续快照读取可失败，即时聊天后果未证实。

**实际问题：** 追加提示只有 source/content，没有 id/role。原生 AgentLoop 会把这些消息逐个追加到会话事件。

**证据：** PERSIST-5 使用正式 snapshotSessionEvent：原始用户消息通过，guard notice 被拒绝为 lacks an identified message。收尾反证另外执行正式 Session.create/append：两个消息都能 append，之后 notice 的快照校验才失败。因此撤回“append 当场失败”的推断。

**用户后果与边界：** guard 会产生可写入但不符合原生完整消息规范的事件，后续正式快照/读取路径无法处理。未追踪到最终模型 serializer，不证明每次受限引用都立即中断聊天。

**修复方向：** 使用正式消息构造方法，或向已有合法消息安全追加说明；避免自己拼不完整对象。

**验收条件：** 受限引用经过原生 prepare、append、snapshot、读取/恢复及模型请求准备，说明消息始终合法；不读取被拒来源、不丢用户原文。

原始审查编号：`PERSIST-5`。

### R09 · P1 · 候选点击使用错误的输入 API，原生引用插入会被拒绝

**代码位置：** [dsh-boop/src/client/index.tsx:65–77](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L65-L77)。

**触发与可达性：** 候选一旦显示即可触发；正常生成候选还受 R01 阻断。

**实际问题：** captureInsertion 位于实际 actions 接口，不在当前 facade 调用位置。代码回退为没有 draftRev 的 {start:0,end:0}；正式 insertReference 检查草稿版本时拒绝该 span。

**证据：** FE-02 使用构建后的实际适配函数和正式 rc.2 insertReference；BOOP 参数失败，正式 actions.captureInsertion 参数作为对照成功。

**用户后果与边界：** “选这个会话”这一关键交互无法可靠生成引用，用户不能顺畅完成委派对象选择。

**修复方向：** 从正式 InputActions 捕获插入点/版本并插入，处理过期草稿版本；点击只编辑草稿，仍由用户发送。

**验收条件：** 在真实原生输入框中用中文、已有文字、引用、选区和光标点击候选：正确插入一个 chip，原草稿保留，不自动发送。

原始审查编号：`FE-02`。

### R10 · P1 · “继续处理”覆盖用户尚未发送的草稿和引用

**代码位置：** [dsh-boop/src/client/index.tsx:82–89](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L82-L89)；[dsh-boop/src/client/home/controller.ts:175–177](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/controller.ts#L175-L177)。

**触发与可达性：** 已有任务卡且草稿非空时。

**实际问题：** 继续处理把模板文字交给 setDraft；该正式接口替换整个草稿及引用，而不是追加。

**证据：** FE-03 先准备含“不要部署”和目标引用的草稿，再点继续处理：草稿只剩模板“继续处理…还要补充”。已证明文字/引用丢失；未把未测附件或 IME 行为算作事实。

**用户后果与边界：** 用户正在补充的要求和限制会被静默抹掉。没有证明发生自动发送或部署，但这已是实质性数据丢失。

**修复方向：** 使用非破坏的原生插入或独立补充意图；保留现有文字、引用与用户光标，正确绑定任务，不自动执行。

**验收条件：** 已有草稿及限制时点击继续，所有原内容仍在，任务引用准确；中文输入进行中不重置输入根或误发送。

原始审查编号：`FE-03`。

### R11 · P1 · 任务与结果没有自动刷新，重连和打开工作抽屉也不刷新

**代码位置：** [dsh-boop/src/client/home/controller.ts:91–93](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/controller.ts#L91-L93)；[dsh-boop/src/client/home/controller.ts:132–157](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/controller.ts#L132-L157)。

**触发与可达性：** 打开主页后后台/另一窗口状态变化。

**实际问题：** refresh 仅在挂载和少数操作后调用；连接订阅只改连接状态字符串，打开抽屉只改 drawer。没有任务事件订阅或轮询。

**证据：** FE-01 改远端工作状态后打开抽屉、断开再连接：列表仍旧；显式调用内部 refresh 才看到新状态。第三轮独立复现一致。

**用户后果与边界：** 用户无法从页面及时知道新委托、完成和待确认结果。真实自动执行完成还受 R02 阻断；已有任务与多窗口更新已受影响。

**修复方向：** 实现作用域明确的更新订阅/刷新机制及重连补拉，按版本丢弃过时响应；更新卡片不要重建输入框。

**验收条件：** 不刷新整页、不点击停止/确认，另一个窗口或后台新增/完成任务后页面自动出现正确状态；离线重连补齐且草稿保持。

原始审查编号：`FE-01`。

### R12 · P1 · 把普通 tool callId 当成人类授权，且不校验 BOOP 主身份

**代码位置：** [dsh-boop/src/host/tools.ts:36–54](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/tools.ts#L36-L54)；[dsh-boop/src/host/tools.ts:326–332](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/tools.ts#L326-L332)。

**触发与可达性：** 服务层授权缺陷；当前完整自动派发受 R01/R02 阻断。

**实际问题：** trustedCall 取到 home 却不用，任意 agent.session 都可当 mainSession；origin 回退到 callId，originKind 固定 user，bindingVersion 固定 1。正式 ToolRunContext 的 callId 不是直接人类消息凭证。

**证据：** R-PROVENANCE 使用 ordinary-session、仅提供 model-call-with-no-direct-user 的 callId，实际 context/dispatch execute 创建 action，并持久化这两个值为 main_session_id/origin_message_id。

**用户后果与边界：** 接通自动执行后，普通会话或结果/自动消息引起的模型调用可能被冒充成人类直接委派；当前没有证明未认证远程访问或真实原会话派发。

**修复方向：** 从正式根调用和持久化消息追溯直接人类来源，核对当前 canonical home/preset/binding version；拒绝结果、自动化和非主页来源。

**验收条件：** 直接主页人类指令可委派；普通会话、结果消息、自动消息和伪造 callId 均不能获得人类 provenance；结果仍回正确主绑定。

原始审查编号：`runtime R4 / R-PROVENANCE`。

### R13 · P1 · 旧上下文被新水位重新盖章，漏掉目标中新的人类限制

**代码位置：** [dsh-boop/src/host/delegation/service.ts:407–425](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L407-L425)；[dsh-boop/src/host/delegation/service.ts:452–455](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L452-L455)；[dsh-boop/src/host/delegation/service.ts:503–508](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L503-L508)。

**触发与可达性：** 服务层潜伏缺陷；执行受 R02 阻断。

**实际问题：** prepare 未核对 snapshot 的 origin/generation/head/直接人类水位，而把最新观察值写入 action。tick 对比的是新值与新值，无法发现指令实际来自旧上下文。

**证据：** R-CONTEXT 在 user seq=3 读取 context，目标新增 seq=8 的限制后，用另一主消息 origin prepare，再手动 tick，仍发送一次；未重读新要求。

**用户后果与边界：** 后来的“先别改”“不要部署”等人工要求可能未进入执行指令。不能只证明 token 没过 TTL 就认为上下文仍有效。

**修复方向：** 接受任务前核对原始 snapshot 的来源、水位和 generation；遇新人工指令重新读取有效上下文，并按需要要求重新确认，禁止静默改验证基准。

**验收条件：** 读 context 后原会话新增限制、重建或切换 origin：旧 token 被拒绝/重新读取，最终执行包含最新有效限制。

原始审查编号：`runtime R5 / R-CONTEXT`。

### R14 · P1 · 排队后撤销来源权限仍可派发，副作用前缺少重新核验

**代码位置：** [dsh-boop/src/host/delegation/service.ts:500–542](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L500-L542)；[dsh-boop/src/host/gate/pre-step.ts:494–500](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/gate/pre-step.ts#L494-L500)。

**触发与可达性：** 服务层潜伏缺陷；当前 setAccess 也没有 UI/remote 调用入口。

**实际问题：** prepare 时通过检查不代表排队等待后仍有效。tick/admission 未完整重验当前 policy epoch、目标资格、停止/版本和写租约；等待后的状态变化可能穿过旧判断。

**证据：** R-REVOKE 在目标忙时排队，再 setAccess(none) 把 epoch 提到 2；目标空闲后 tick 仍发出 epoch=1 的指令。这里只对撤权场景作动态确认，其余缺核验项来自代码路径。

**用户后果与边界：** 接入范围编辑与驱动后，用户撤销读取范围不能阻止已排队任务进入目标。

**修复方向：** 在 claim、外部副作用、原生准入的准确边界重新核验访问、身份、版本、stop、holder/token；await 后不能继续使用过期判断。

**验收条件：** 排队期间撤权、目标归档/变子会话、人工接管、停止、租约接管分别阻断旧 action；恢复权限不自动复活已失效请求。

原始审查编号：`runtime R6 / R-REVOKE`。

### R15 · P1 · 修订后的停止只停新队列，旧执行仍在运行却返回已停止

**代码位置：** [dsh-boop/src/host/delegation/service.ts:692–707](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L692-L707)；[dsh-boop/src/host/delegation/service.ts:737–787](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L737-L787)；[dsh-boop/src/host/delegation/service.ts:1068–1071](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L1068-L1071)。

**触发与可达性：** 服务层潜伏缺陷；支持 v1 运行中创建 v2 的序列。

**实际问题：** stop 只选 latestAction。v1 已占槽运行、v2 等待 previous_action 时，它停止 planned v2，未处理槽内 v1，仍投影 stopped。

**证据：** R-STOP-REVISION 使用能正确证明 v1 为 BOOP 独占的 port：stop(v2) 返回 stopped，v1 仍 running、槽仍 held，cancelCalls=0。不依赖 R03 的 unknown 归属。

**用户后果与边界：** 用户以为已经停止，旧任务仍可能继续改文件。当前审查没有真实模型执行，只确认控制器错误。

**修复方向：** 分开处理取消未来 action 和停止实际持槽 action；仅取消确认归属的原生 turn，等待可观察确认后才显示停止。

**验收条件：** 运行中修订再停止，旧执行和新队列均按授权停止；人工接管时只阻止未来 BOOP 动作，不误停人类回合，状态如实显示。

原始审查编号：`runtime R7 / R-STOP-REVISION`。

### R16 · P1 · 结果已被原生消费后丢响应，未知投递会再次发送

**代码位置：** [dsh-boop/src/host/delegation/service.ts:650–679](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L650-L679)；[dsh-boop/src/host/home/native-session.ts:208–208](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/home/native-session.ts#L208)。

**触发与可达性：** 发布服务潜伏缺陷；deliver 尚未接线。

**实际问题：** 发布前不先持久化 sending；unknown 后只查恒 false 的 visible，再调用 followup。原生 inbox 只拒绝当前 pending 中重复 ID，不是历史去重。

**证据：** 第三轮修正了过宽数组 mock：使用正式 ReactLoopInbox。对照组同 ID 同时 pending 被拒绝；主场景第一次已 claim 后丢响应，第二次同 ID 再次入队。结果是 1 次已消费＋1 次新 pending，并非两个相同 ID 同时 pending。

**用户后果与边界：** 接线后可能重复把同一结果加入主会话并额外唤起模型。没有声称真实用户已收到重复结果。

**修复方向：** 副作用前持久化发送意图；按稳定消息 ID 同时查询 pending 与 durable history；unknown 先核对再恢复，串行化 publisher，不盲重投。

**验收条件：** 覆盖发送前崩溃、成功后丢响应、消费后丢响应、flush 失败、重复唤醒：每个结果最多产生一次用户可见交付及一次相应处理。

原始审查编号：`runtime R8 / R-DELIVERY`。

### R17 · P1 · 混合人类/BOOP 消息批次可重复准入同一命令

**代码位置：** [dsh-boop/src/host/gate/pre-step.ts:413–456](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/gate/pre-step.ts#L413-L456)；[dsh-boop/src/host/gate/pre-step.ts:494–515](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/gate/pre-step.ts#L494-L515)。

**触发与可达性：** 需存在重放/重复投递；未证明宿主必然主动重放。

**实际问题：** 混批分支未将命令加入 consumed；v2AdmissionAllows 只看 action 状态，不检查已准入历史，记录冲突 ON CONFLICT DO NOTHING 后仍允许。

**证据：** R-MIXED 使用真实 gate port、action 和 admission。第一次记录 turn:1，第二个混批仍 enter，记录还停在 turn:1、consumed 为空；纯 BOOP 对照第二次正确 reject。

**用户后果与边界：** 恢复、重试或重复消息存在时，同一授权可能进入多个执行回合；共享 gate 的混批语义弱于纯 BOOP。不能把普通文本直接伪造 durable action 当成已验证。

**修复方向：** 统一两种批次的原子准入/消费，校验 action/message/target/turn/scope/写租约；已准入命令拒绝，保留同批人类消息。

**验收条件：** 相同 message ID 在纯批和混批均最多准入一次；历史记录写失败时不放行 BOOP，合法人类消息不丢失。

原始审查编号：`runtime R9 / R-MIXED`。

### R18 · P2 · 仅授权工作区时，读取允许但委派被拒绝

**代码位置：** [dsh-boop/src/host/delegation/service.ts:418–425](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L418-L425)；[dsh-boop/src/host/delegation/service.ts:225–237](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L225-L237)。

**触发与可达性：** 服务层缺陷；完整入口还受 R01 和设置未接线影响。

**实际问题：** readContext 用目标真实 workspaceId 检查权限，prepare 却在观察前把 workspaceId=null 传给 canRead。仅选工作区、不单独选 Session 时必然不匹配。

**证据：** R-WORKSPACE 授权 workspace=ws、sessionIds=[]：context 成功，同目标 dispatch 返回 SCOPE_DENIED。

**用户后果与边界：** 用户明明授权了整个工作区，却无法委派其中会话，访问范围呈现自相矛盾的行为。

**修复方向：** 先观察 canonical target，再统一使用真实工作区进行读/派发/准入检查。

**验收条件：** selected-workspace、selected-session、none、all_authorized 的目录、context、prepare 和最终准入判定一致。

原始审查编号：`runtime R10 / R-WORKSPACE`。

### R19 · P2 · 新的用户消息不会使旧候选失效

**代码位置：** [dsh-boop/src/client/home/read-work-choice.ts:29–55](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/read-work-choice.ts#L29-L55)；[dsh-boop/src/client/home/TargetCandidates.tsx:13–27](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/TargetCandidates.tsx#L13-L27)。

**触发与可达性：** 候选已出现且用户继续对话。

**实际问题：** 从消息末尾向前搜索 work_choice 时跨过较新的人类消息，未绑定当前 origin/sourceSeq；输入恢复 plain 后旧卡又可操作。

**证据：** FE-04 在候选后追加新直接用户消息，仍得到同一旧候选且可选；第三轮独立验证。

**用户后果与边界：** 用户改变目标后仍可能点到上一轮候选。这里是错误且过时的可操作 UI，没有证明点击自动执行。

**修复方向：** 候选绑定当前人类意图/来源水位，后续人类消息应失效旧建议；选择状态结合真实草稿引用，而不是永远记住点击过的 key。

**验收条件：** 新指令、草稿引用删除、重新询问目标后候选状态正确；过时卡片不再能向当前意图插入目标。

原始审查编号：`FE-04`。

### R20 · P2 · “查看详情”没有详情，产物和验证证据无法评估

**代码位置：** [dsh-boop/src/client/home/index.tsx:20–26](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/index.tsx#L20-L26)；[dsh-boop/src/client/home/BoopSession.tsx:89–95](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/BoopSession.tsx#L89-L95)；[dsh-boop/src/client/home/WorkCard.tsx:24–39](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/WorkCard.tsx#L24-L39)。

**触发与可达性：** 当前已存在的按钮路径。

**实际问题：** view 动作只是 setDrawer(work)，没有 selectedTask、detailV2 或结果详情组件；在抽屉内再点详情基本没有变化。

**证据：** 核对按钮回调、controller、RPC 使用和渲染：没有由详情入口展示版本、产物、检查、证据及结果历史的完整路径。

**用户后果与边界：** 用户不能在 BOOP 内判断交付是否满足要求，就被要求确认收下；这直接违背页面应该帮助用户理解工作的目标。

**修复方向：** 实现选中任务的真实详情，展示产物入口、验证结论、失败/缺失项和对应版本；旧结果保持不可变且可追溯。

**验收条件：** 从主会话卡片和抽屉两处点详情都打开对应结果，能区分“有产物”“验证失败”“用户已收下”，不能把确认改写成测试通过。

原始审查编号：`FE-05`。

### R21 · P2 · 停止/确认失败被吞掉，刷新失败会清空最后已知事实

**代码位置：** [dsh-boop/src/client/home/controller.ts:145–152](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/controller.ts#L145-L152)；[dsh-boop/src/client/home/controller.ts:185–206](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/controller.ts#L185-L206)；[dsh-boop/src/client/index.tsx:30–35](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L30-L35)。

**触发与可达性：** RPC 业务拒绝或连接失败时。

**实际问题：** 控制操作不检查失败 envelope，随后列表请求失败又被转换成空 tasks，而不是保留旧快照并说明未确认状态。

**证据：** `review-error-path.mjs`：原先 1 个 running task；stop 业务冲突＋refresh 连接错误后，tasks=0、notice=null、phase=ready。

**用户后果与边界：** 用户可能把任务消失理解成停止或处理完成，而系统只是拿不到状态。

**修复方向：** 区分成功、拒绝和未知；失败保留最后事实，明确可重试/需刷新/版本冲突，不因网络错误伪造空列表。

**验收条件：** 停止冲突、确认冲突、断网和超时均给出准确反馈；列表保留最后已知状态，刷新恢复后收敛，不重复发有副作用请求。

原始审查编号：`FE-06`。

### R22 · P2 · 主页 ready 后仍显示“数据域不可用”

**代码位置：** [dsh-boop/src/client/index.tsx:38–38](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L38)；[dsh-boop/src/client/index.tsx:123–125](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L123-L125)；[dsh-boop/src/client/index.tsx:153–158](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L153-L158)。

**触发与可达性：** 主页完成初始化时。

**实际问题：** 新初始化只把 mainSessionId/phase 写回旧 mainStore，没有 host；侧栏仍复用旧状态格式，host=null 被解释成数据域不可用。

**证据：** FE-08 在 ready home 后观察 store.host=null 和侧栏文案；第三轮复现，分支提交的 ready 截图也可见同类警告。

**用户后果与边界：** 可用页面持续给用户故障信号，且保留了用户已经明确不喜欢的技术状态语言。

**修复方向：** 以 v2 HomeView 生成可理解的当前状态，不把缺少旧存储字段当产品故障。

**验收条件：** ready、无模型、连接失败、需要恢复各自显示准确、可操作文案；正常 ready 不显示数据域不可用。

原始审查编号：`FE-08`。

### R23 · P2 · 抽屉关闭恢复焦点没有实际绑定，窄屏键盘路径不完整

**代码位置：** [dsh-boop/src/client/home/index.tsx:19–57](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/index.tsx#L19-L57)；[dsh-boop/src/client/home/Header.tsx:4–23](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/Header.tsx#L4-L23)；[dsh-boop/src/client/home/WorkDrawer.tsx:23–32](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/WorkDrawer.tsx#L23-L32)。

**触发与可达性：** 键盘使用工作抽屉及窄屏覆盖面板。

**实际问题：** 关闭时试图 focus workButtonRef，但 ref 没绑到实际按钮；窄屏覆盖层也没有 Escape/相应焦点管理路径。

**证据：** 完整读取 Header/WorkDrawer/SettingsPanel 和传参，未找到绑定和补偿监听。本项未做物理键盘/屏幕阅读器测试，保留为明确静态实现缺陷。

**用户后果与边界：** 键盘用户关闭面板后失去可预测的焦点位置；窄屏覆盖时可能继续操作被遮挡内容。

**修复方向：** 把真实触发按钮 ref 接通；依据桌面非模态/窄屏模态语义管理 Escape、焦点归还和焦点边界。

**验收条件：** 真实宿主仅用键盘完成打开、操作、关闭；焦点回原按钮，窄屏模态不落入背景，普通输入法 Esc 行为不被误拦。

原始审查编号：`FE-07`。

### R24 · P2 · 曾打开 BOOP 的标记不清除，刷新普通 DSH 会话会抢回 BOOP

**代码位置：** [dsh-boop/src/client/index.tsx:97–99](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L97-L99)；[dsh-boop/src/client/index.tsx:143–145](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx#L143-L145)。

**触发与可达性：** 同一标签曾打开 BOOP，随后回普通 DSH 并重载。

**实际问题：** HOME_INTENT_KEY 只写 1，未随用户切换面板清除或更新；下一次初始化见 1 就 selectPanel(boop.home)。

**证据：** 检索标记所有读写和面板监听，无清除路径。本项为确定代码路径，未声称真实浏览器导航测试通过。

**用户后果与边界：** BOOP 干扰用户正常 DSH 会话的恢复位置，不满足独立页面对普通聊天的隔离要求。

**修复方向：** 恢复“当前选择的页面”，而非“历史上打开过 BOOP”；采用正式布局持久化或在离开时更新状态。

**验收条件：** BOOP→普通会话→刷新仍在普通会话；在 BOOP 刷新才恢复 BOOP，插件卸载后不残留抢占导航。

原始审查编号：`FE-09`。

### R25 · P1 · 一次小修订会因省略可选字段而清空既有约束

**代码位置：** [dsh-boop/src/host/delegation/service.ts:762–779](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L762-L779)；[dsh-boop/src/host/delegation/service.ts:535–536](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/service.ts#L535-L536)；[dsh-boop/src/shared/mvp-contract.ts:206–211](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/shared/mvp-contract.ts#L206-L211)。

**触发与可达性：** 服务层潜伏缺陷；当前受 R01/R02 阻断。

**实际问题：** criteria/exclusions 是可选参数；revise 省略时写为 []，新 action 只保存原始参数，派发又以缺失值默认 []。goal 有继承，而限制没有。

**证据：** R-REVISION-CONSTRAINTS 两个真实库都先有“标题不溢出/不要部署”。只传“再改页脚”的分支把 task 两列清空、action 不带约束；显式携带完整数组的对照分支保留。没有真实派发。

**用户后果与边界：** 用户只改一部分需求会意外撤销之前未撤销的限制。方案要求持久约束和完整 revision 快照，但未逐字规定 undefined 继承；本结论是据此作出的语义判断，不伪造原文。

**修复方向：** 规范化完整有效 revision 后再 hash/落库/派发。省略字段应继承，或拒绝不完整替换并要求重建；撤销限制必须有新的明确人类意图。

**验收条件：** “不要部署”仍有效时请求“再改页脚”，task、revision、action、最终指令四处都保留该限制；显式完整参数对照仍正确；合法撤销有可追溯来源。

原始审查编号：`runtime R11 / R-REVISION-CONSTRAINTS`。

## 4. 前端与产品判断

当前有值得保留的结构：独立 `boop.home` 主面板已经注册，主聊天通过正式 SessionProvider/原生 conversation slot 复用；生产代码没有为了独立页面重新造一个聊天输入器；样式有 BOOP 作用域及卸载清理；候选点击没有直接自动执行；结果验证与“用户收下”的状态被分开。这些是真实的实现进展。见 [页面注册与原生接入](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/index.tsx)、[主会话组件](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/client/home/BoopSession.tsx)、[结果投影](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/src/host/delegation/projection.ts)。

但用户要的是一个看得懂、能把工作交给别人并收到结果的波波。当前页面在关键节点会让人困惑：点击候选插不进去，继续处理擦掉草稿，任务进展不更新，查看详情没有详情，失败被隐藏，正常页仍写“数据域不可用”。**前端目前完成了入口和一部分结构，尚未把高保真原型落实为完整可用体验。** 这些问题不是换配色、边距或卡片圆角就能解决的。

设置页的范围编辑、历史等也未形成完整交互闭环；实施台账 T21 自己标为 PARTIAL。因此不能把内部存在 setAccess 方法等同于用户已经能管理范围。R07/R14/R18 对范围策略的验证均保留这个前提。

我检查了提交内 7 张截图。4 张是组件画廊，含替代输入区；3 张是宿主/引导截图。它们能说明局部布局和入口，不能证明真实输入法、附件、长对话、审批、工作详情及委派结果全流程已通过。没有做像素差异、真实对比度测量、屏幕阅读器或本机桌面视觉验收。提交自己的 [验收记录](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/docs/refactor/boop-mvp-v0.2/evidence/acceptance.json) 也明确承认组件截图不等于宿主验收。

## 5. 构建、测试和交付门禁

| 检查 | 本次实测 | 判断 |
| --- | --- | --- |
| 冻结安装 | pnpm install --frozen-lockfile --ignore-scripts 成功，609 packages | 依赖可按锁文件还原；没有执行安装生命周期脚本 |
| 构建 | node build.mjs 成功，19 个输出 | 证明可打包编译，不证明类型和宿主集成正确 |
| 类型检查 | head 231 条诊断；同依赖基线 194 条；按路径/代码/消息去掉行号变化后新增 40、消失 3 | 两边都失败；不能把 231 条全算本分支新问题，也不能当类型检查通过 |
| 单元测试 | 24 文件、292/292 通过，无跳过 | 服务内部测试有效，但没有覆盖真实工具 schema、生产驱动接线和适配器语义 |
| 客户端测试 | 7 个已加载文件中 79 项：76 通过、3 失败；另 1 文件加载失败 | 3 个断言仍期待旧入口/旧主 bundle API，需要迁移；加载失败为已有 companion 测试 bundle 缺失 |
| 21 个定向场景 | 全部成功复现各自断言的错误 | 是缺陷证据，不是 21 项产品验收 PASS |
| 包装门禁 | 产出 26 文件 tgz，但命令 exit 1 | 旧脚本要求 client.js >100,000 bytes，新 bundle 为 77,716 bytes；应修验收规则，不要塞代码凑大小 |
| 原有 42 条验收 | 0 PASS、24 BLOCKED、18 NOT_RUN | 真实完整 MVP 尚无验收证据 |

### 如何解释失败，避免误判

首次受限环境构建超时，允许构建子进程后约 3 秒成功；初始 localhost transport 测试被沙箱阻断、心跳在并发负载下有一次失败，隔离复跑与最终逐文件运行均通过。**这些环境/运行方式问题没有记为产品缺陷。** 证据包保留初次与最终日志，最终结论采用 `build-authorized-result.json`、`unit-direct-results.json`。

类型新增诊断包括 `.ts/.tsx` 导入与 tsconfig 的不匹配，以及 native adapter 未定义 `cwdFingerprint`、未知类型的 session.id、HomeService 比较和 TasksApi 私有 ctx 类型冲突。构建工具转译能成功不代表 tsc 通过。基线的 194 条历史问题应单独建立清理范围；本次新增问题先修，不需把历史债务全算到这一次重构。

客户端 3 个失败分别要求旧 `BOOP 主聊天` label、旧 `boopTasks/detail` 与旧 `boopControl/state` 出现在主 bundle。独立页面设计本身不因此被否定；需要把正确的产品约束迁移到新入口测试，不能只删测试。另一个 `e04-01-companion.test.mjs` 找不到构建脚本未生成的 `lib/companion.test.bundle.cjs`，分支台账已经注明这项原有不一致。

包装脚本的 `lib/client.js is missing or too small` 是把存在但更小的 bundle 判失败。包确实生成，不能说文件丢失，也不能因生成 tgz 就说安装/发布验收通过。此次没有安装到真实用户 DSH、没有发布包。

分支自己的 [29 项实施台账](https://github.com/wanyexin1998/dsh-plugin/blob/b92fa37ed67182916e133e5e60b4b970a858d5e8/dsh-boop/docs/refactor/boop-mvp-v0.2/evidence/implementation-ledger.md) 为 9 DONE、17 PARTIAL、3 BLOCKED，已经坦率标出了环境和未完成功能，不应指控它伪造全部通过。不过 T06 的 fresh identity 幂等单测不足以支撑旧用户迁移/失租约可用；T12/T16/T17 的服务层 DONE 也不能代替生产接线及本次发现的修订/停止/约束边界验证。

## 6. 交给开发 agent 的修复顺序

不要先把 tick 接到定时器上就结束。那会让本轮确认的潜伏边界问题变成真实副作用。建议在当前开发分支或专门修复分支按下面的可验收单元推进。

| 修复包 | 包含发现 | 应提交的具体成果 | 退出条件 |
| --- | --- | --- | --- |
| A：身份、来源与读取边界 | R04–R08、R12、R18 | 统一主绑定迁移；生产注入写租约检查；统一旧/新读取限制；合法消息与不可二次解释的引用；真实人类来源 | 真实 v1 非空绑定升级、真实接管、正式 parser/消息验证和非主页调用的回归全部通过 |
| B：正式宿主接口 | R01、R03 | 完整 schema；真实上下文读取；消息/turn/产物/人工接管/归属适配 | 通过正式 ToolRuntime 和生产 adapter 测试，不靠测试手填结果字段 |
| C：执行与恢复 | R13–R17、R25，再接 R02 | 有效约束快照、等待后重新授权、精确停止、原子准入、投递核对，再装配生命周期驱动 | 真实入口能执行一次、回传一次；旧上下文/撤权/停止/崩溃/重放均不能越过边界 |
| D：可用前端 | R09–R11、R19–R24 | 原生正确插入、非破坏草稿、后台同步、结果详情、可靠错误反馈、状态/焦点/导航修正；补齐 T21 范围入口 | 在真实宿主逐项操作，用户能选对象、继续、看进展、看证据、停止、确认；普通 DSH 不受干扰 |
| E：交付验证 | 类型、客户端旧断言、包装规则、42 条验收 | 新增有效集成回归，清理新增诊断，迁移旧测试，替换大小阈值；填写真实证据 | 指定目标环境可安装；主路径和故障路径实跑；BLOCKED 有具体原因，不用截图代替流程 |

A 与 B、D 的纯 UI 部分可以并行；C 的自动执行上线依赖 A/B 的边界成立。每个提交附修复的 R 编号、复现前结果、修复后安全行为、执行命令与证据。不要把本报告中“断言错误发生”的脚本原样变成 CI 通过条件；修复后应改为断言错误不再发生，并保留正常对照场景。

### 下一轮复审的最低验收门槛

1. **真实主路径**：打开固定 BOOP 主页面 → 人类提出委派 → 获得真实候选和上下文 → 用户选择目标 → 原会话执行 → 真实产物与检查 → 恰好一次回到主会话 → 用户确认。流程从公开入口触发，不能靠手动调用控制器补步骤。
2. **约束主导**：上下文读取后新增的人类限制、原有“不要部署”、撤销范围、人工接管和停止均能改变后续动作。未知状态不能被展示为已停止/已完成。
3. **身份与恢复**：旧用户升级保留唯一主身份和历史；第二进程接管后旧进程不可继续写；成功后丢响应不会重派/重投；准入记录阻断混批重放。
4. **原生输入与信息完整**：已有草稿、中文输入、引用、附件不被替换；任务变化可见；用户能看到具体交付、失败检查和依据再决定收下。
5. **交付证据**：正式目标 DSH 版本与桌面环境实际安装运行；42 条 A 用例逐条记录 PASS/FAIL/BLOCKED、步骤、版本和证据。当前没配置模型/没有 Windows 的限制继续如实记录，不能把未测项改成 PASS。

## 7. 尚未验证及未升级为发现的事项

- 没有真实模型端点、真实用户资料或真实目标会话执行；不存在本次审查替用户部署/修改项目的情况。
- 未跑 Windows Desktop、rc.3、真实中文输入法、屏幕阅读器、长对话渲染、宿主完整审批/杀进程演练。
- 引用 guard 的安装生命周期/重复注册、modelAvailable 与正式模型目录差异、同毫秒 latestAction 排序、若干并发 CAS 窗口存在后续核验价值；本轮未把缺少充分复现的影响另算确证问题。
- 没有把发现概括成任意远程代码执行、跨账户 ACL 绕过或实际私密信息外传；没有这样的证据。
- 结果/验收分离、参数化 SQL、作用域 CSS 等已实现的正确部分应保留，修复不需要重新推翻整个仓库。

## 8. 证据包与复核说明

同目录交付 `BOOP_review_evidence_b92fa37_2026-10-28.zip`，包含本报告、`findings.json`、`review-manifest.json`、三轮中间报告、6 份定向/交叉验证脚本及其输出、构建/类型/测试/包装日志、完整覆盖清单和 SHA256 文件清单。没有打包 node_modules、产品仓库、真实用户数据库、截图或候选发行包。

证据包 README 给出固定 SHA 的克隆与复现步骤。前两轮报告保留当时的编号与结论，第三轮有进一步校准；**本报告 R01–R25 和最新探针/日志是最终裁定**，尤其 R16 应使用正式 inbox 加强版本，R25 为最终新增确认项。前端交叉复现输出名已分开，避免两个审查者覆盖同名 JSON。

完整 62 文件覆盖见 `review-manifest.json`：前端 20、持久化/身份 16、运行时 7、主审 19。主审的 19 项为配置/工具/辅助测试/5 份文档和 7 张提交截图；“截图已看”不等于对应页面交互已实测。
